/**
 * Filesystem side of the daily corpus history.
 *
 * Lives at `<LOCAL_DATASET_ROOT>/.xense-viewer/corpus-history.json` — corpus
 * level rather than inside any one dataset's `meta/`, because it spans sources.
 *
 * Every function here is failure-tolerant by design. The homepage renders from
 * a read-only scan; history is an enhancement layered on top, and a root mounted
 * read-only, a full disk, or a hand-mangled file must degrade to "no history"
 * rather than take the page down with it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import {
  dayKey,
  emptyHistory,
  parseHistory,
  withDaySnapshot,
  type CorpusHistory,
  type DaySnapshot,
} from "@/utils/corpusHistory";

const STORE_DIR = ".xense-viewer";
const STORE_FILE = "corpus-history.json";

export function historyFilePath(root?: string): string {
  const base = root ?? resolveLocalDatasetRoot();
  return path.join(base, STORE_DIR, STORE_FILE);
}

/** Read the stored history, or an empty one when absent/unreadable/corrupt. */
export async function readCorpusHistory(root?: string): Promise<CorpusHistory> {
  let file: string;
  try {
    file = historyFilePath(root);
  } catch {
    return emptyHistory();
  }
  try {
    const raw = await fs.readFile(file, "utf-8");
    return parseHistory(JSON.parse(raw));
  } catch {
    // Missing file on first run is the common case; a parse failure means
    // someone edited it by hand. Both start over rather than surface an error.
    return emptyHistory();
  }
}

/**
 * Merge today's snapshot in and persist, returning the updated history.
 *
 * Writes `tmp` then renames, matching the tags/annotations routes — a crash
 * mid-write leaves the previous file intact instead of a truncated one. On any
 * failure the in-memory result is still returned, so the caller renders the
 * correct numbers even though nothing reached disk.
 */
export async function recordDaySnapshot(
  snapshot: DaySnapshot,
  options: { root?: string; now?: Date } = {},
): Promise<{ history: CorpusHistory; todayKey: string; persisted: boolean }> {
  const todayKey = dayKey(options.now ?? new Date());
  const existing = await readCorpusHistory(options.root);
  const updated = withDaySnapshot(existing, todayKey, snapshot);

  let persisted = false;
  try {
    const file = historyFilePath(options.root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(updated, null, 2), "utf-8");
    await fs.rename(tmp, file);
    persisted = true;
  } catch {
    // Read-only root, full disk, permissions — the page must still render.
    persisted = false;
  }

  return { history: existing, todayKey, persisted };
}
