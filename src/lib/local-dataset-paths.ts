/**
 * Server-side path resolution for local datasets.
 *
 * Every route that serves a file out of a dataset directory has to answer the
 * same two questions: where does this `encodedPath` live on disk, and does the
 * requested sub-path stay inside it. Keeping that in one place means the
 * traversal check is written (and tested) once.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  decodeLocalDatasetPath,
  resolveServerLocalDatasetPath,
} from "@/utils/datasetRoute";

/**
 * Resolve a base64url-encoded dataset path to an absolute directory.
 * Returns null when the encoding is malformed or no root can be resolved.
 */
export function resolveDatasetRoot(encodedPath: string): string | null {
  try {
    return path.resolve(
      resolveServerLocalDatasetPath(decodeLocalDatasetPath(encodedPath)),
    );
  } catch {
    return null;
  }
}

/**
 * True when `target` sits strictly below `root`. Both must already be absolute
 * and normalized; this compares paths only, it never touches the filesystem.
 */
export function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/**
 * Join `segments` onto `datasetRoot`, rejecting anything that escapes it
 * (`..`, absolute segments) or resolves to the root itself.
 *
 * Pure — no filesystem access — so the traversal rules stay unit-testable.
 * This catches only *lexical* escapes; symlinks are checked in
 * `statDatasetFile`, which is the layer that can afford to hit the disk.
 */
export function resolveInsideDataset(
  datasetRoot: string,
  ...segments: string[]
): string | null {
  const root = path.resolve(datasetRoot);
  const requested = path.resolve(root, ...segments);

  return isInsideRoot(root, requested) ? requested : null;
}

export interface LocalFileStat {
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

/**
 * Stat a file inside a dataset. Null for traversal attempts, misses and
 * non-files.
 *
 * `resolveInsideDataset` only rules out escapes spelled out in the path, so a
 * symlink planted in the dataset (a downloaded archive can carry one) would
 * still read whatever it points at. Re-checking the resolved target closes
 * that. The dataset directory is resolved too, so a dataset reached through a
 * symlinked root still works — only links that leave the dataset are refused,
 * which does mean a deliberately out-of-tree `videos/` symlink is refused too.
 */
export async function statDatasetFile(
  encodedPath: string,
  segments: string[],
): Promise<LocalFileStat | null> {
  const root = resolveDatasetRoot(encodedPath);
  if (!root) return null;

  const absolutePath = resolveInsideDataset(root, ...segments);
  if (!absolutePath) return null;

  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  try {
    const [realRoot, realTarget] = await Promise.all([
      fs.realpath(root),
      fs.realpath(absolutePath),
    ]);
    if (!isInsideRoot(realRoot, realTarget)) return null;
  } catch {
    return null;
  }

  return {
    absolutePath,
    size: Number(stat.size),
    mtimeMs: stat.mtimeMs,
  };
}
