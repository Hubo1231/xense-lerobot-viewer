/**
 * Deleting a local dataset.
 *
 * Deletion is a rename into `<LOCAL_DATASET_ROOT>/.xense-viewer/trash/`, not an
 * `rm`: a mis-click costs a `mv` to undo instead of a re-download of tens of
 * gigabytes over a link that measures in hundreds of kB/s. The trash lives
 * under the same `.xense-viewer` directory as the corpus history, and the
 * dataset scanner already skips dot-directories, so a trashed dataset drops out
 * of the grid without any extra filtering.
 *
 * The flip side of a rename is that space is not reclaimed until the trash is
 * emptied — `emptyTrash` is the only call here that actually destroys data.
 *
 * Guards, in order: the target must resolve inside the local root, must not be
 * the root itself, must be a directory, must carry `meta/info.json` (so a stray
 * encoded path cannot rename an arbitrary directory), and must still be inside
 * the root after `realpath` (so a symlinked dataset cannot move its target).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { isInsideRoot, resolveDatasetRoot } from "@/lib/local-dataset-paths";
import { decodeLocalDatasetPath } from "@/utils/datasetRoute";
import { trashEntryName, type TrashEntry } from "@/utils/datasetTrash";

const STORE_DIR = ".xense-viewer";
const TRASH_DIR = "trash";
const MANIFEST_SUFFIX = ".json";

export function trashRootPath(root?: string): string {
  return path.join(root ?? resolveLocalDatasetRoot(), STORE_DIR, TRASH_DIR);
}

/** Total bytes below `dir`, following nothing. Missing entries count as 0. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await directorySize(full);
      } else if (entry.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch {
          /* vanished mid-walk — not worth failing the whole delete over */
        }
      }
    }),
  );
  return total;
}

export type TrashOutcome =
  | { ok: true; entry: TrashEntry }
  | { ok: false; status: number; error: string };

/** Move one dataset into the trash. */
export async function trashDataset(
  encodedPath: string,
  now = new Date(),
): Promise<TrashOutcome> {
  let root: string;
  try {
    root = path.resolve(resolveLocalDatasetRoot());
  } catch (err) {
    return { ok: false, status: 500, error: String(err) };
  }

  const datasetDir = resolveDatasetRoot(encodedPath);
  if (!datasetDir || !isInsideRoot(root, datasetDir)) {
    return {
      ok: false,
      status: 400,
      error: "Path is outside the dataset root",
    };
  }

  try {
    if (!(await fs.stat(datasetDir)).isDirectory()) {
      return { ok: false, status: 404, error: "Not a dataset directory" };
    }
    // The marker that makes this a dataset rather than any directory that
    // happens to sit under the root.
    await fs.access(path.join(datasetDir, "meta", "info.json"));
  } catch {
    return {
      ok: false,
      status: 404,
      error: "No dataset with meta/info.json at this path",
    };
  }

  try {
    const [realRoot, realDataset] = await Promise.all([
      fs.realpath(root),
      fs.realpath(datasetDir),
    ]);
    if (!isInsideRoot(realRoot, realDataset)) {
      return {
        ok: false,
        status: 400,
        error: "Dataset resolves outside the dataset root",
      };
    }
  } catch {
    return { ok: false, status: 500, error: "Could not resolve dataset path" };
  }

  let relativePath: string;
  try {
    relativePath = decodeLocalDatasetPath(encodedPath);
  } catch {
    relativePath = path.relative(root, datasetDir).split(path.sep).join("/");
  }

  const bytes = await directorySize(datasetDir);
  const trashRoot = trashRootPath(root);
  const name = trashEntryName(relativePath, now);
  const destination = path.join(trashRoot, name);
  const entry: TrashEntry = {
    name,
    relativePath,
    trashedAt: now.toISOString(),
    bytes,
  };

  try {
    await fs.mkdir(trashRoot, { recursive: true });
    // `rename` refuses to clobber a directory, so a same-second repeat of the
    // same dataset name would fail; the suffix loop keeps that from surfacing
    // as an error the user can do nothing about.
    let target = destination;
    for (let attempt = 2; ; attempt += 1) {
      try {
        await fs.access(target);
      } catch {
        break;
      }
      if (attempt > 50) {
        return { ok: false, status: 500, error: "Trash entry already exists" };
      }
      target = `${destination}-${attempt}`;
    }
    entry.name = path.basename(target);
    await fs.rename(datasetDir, target);
    await fs.writeFile(
      `${target}${MANIFEST_SUFFIX}`,
      JSON.stringify(entry, null, 2) + "\n",
      "utf-8",
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EXDEV") {
      return {
        ok: false,
        status: 500,
        error:
          "Dataset is on a different filesystem from the trash directory; " +
          "move or delete it manually.",
      };
    }
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Failed to move to trash",
    };
  }

  return { ok: true, entry };
}

/** Everything currently in the trash, newest first. */
export async function listTrash(): Promise<TrashEntry[]> {
  let trashRoot: string;
  try {
    trashRoot = trashRootPath();
  } catch {
    return [];
  }

  let names: import("node:fs").Dirent[];
  try {
    names = await fs.readdir(trashRoot, { withFileTypes: true });
  } catch {
    return []; // no trash directory yet
  }

  const entries = await Promise.all(
    names
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<TrashEntry> => {
        const full = path.join(trashRoot, entry.name);
        try {
          const raw = await fs.readFile(`${full}${MANIFEST_SUFFIX}`, "utf-8");
          const parsed = JSON.parse(raw) as Partial<TrashEntry>;
          if (typeof parsed.relativePath === "string") {
            return {
              name: entry.name,
              relativePath: parsed.relativePath,
              trashedAt: parsed.trashedAt ?? "",
              bytes: typeof parsed.bytes === "number" ? parsed.bytes : 0,
            };
          }
        } catch {
          /* hand-moved or manifest lost — fall through to the walk below */
        }
        return {
          name: entry.name,
          relativePath: entry.name,
          trashedAt: "",
          bytes: await directorySize(full),
        };
      }),
  );

  return entries.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
}

/** Delete the trash's contents for real. The only destructive call here. */
export async function emptyTrash(): Promise<{
  removed: number;
  bytes: number;
}> {
  const entries = await listTrash();
  let trashRoot: string;
  try {
    trashRoot = trashRootPath();
  } catch {
    return { removed: 0, bytes: 0 };
  }

  let removed = 0;
  let bytes = 0;
  for (const entry of entries) {
    const full = path.join(trashRoot, entry.name);
    // Paranoia: `name` comes off the filesystem, but it ends up in an rm.
    if (!isInsideRoot(trashRoot, path.resolve(full))) continue;
    try {
      await fs.rm(full, { recursive: true, force: true });
      await fs.rm(`${full}${MANIFEST_SUFFIX}`, { force: true });
      removed += 1;
      bytes += entry.bytes;
    } catch {
      /* leave the rest of the trash alone if one entry is stuck */
    }
  }
  return { removed, bytes };
}
