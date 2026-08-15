import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";

/**
 * Group datasets on the homepage by the first segment of their relative path
 * (the "org"/prefix, e.g. `Xense` in `Xense/pack_6_cosmetic_bottles_into_carton`).
 * Datasets are discovered from disk as `<prefix>/<task_name>[/...]`; the prefix
 * becomes a top-level browsing category and the remainder is the task name.
 */

/** Bucket for datasets whose relative path has no `/` (directly under root). */
export const UNGROUPED_PREFIX = "Ungrouped";

/** First path segment of a dataset relative path, or `UNGROUPED_PREFIX`. */
export function getDatasetPrefix(relativePath: string): string {
  const idx = relativePath.indexOf("/");
  if (idx === -1) return UNGROUPED_PREFIX;
  return relativePath.slice(0, idx);
}

/**
 * Everything after the first path segment — the human-facing task name.
 * `Xense/pack` → `pack`, `Xense/a/b` → `a/b`, single-segment → the path itself.
 */
export function getDatasetTaskName(relativePath: string): string {
  const idx = relativePath.indexOf("/");
  if (idx === -1) return relativePath;
  return relativePath.slice(idx + 1);
}

export type DatasetGroup = {
  prefix: string;
  datasets: LocalDatasetSummary[];
  counts: { ok: number; empty: number; incomplete: number };
  totalEpisodes: number;
  totalFrames: number;
  /** First non-null thumbnail among the group's datasets, used as the card art. */
  thumbnailVideoUrl: string | null;
};

/**
 * Card ordering: biggest first, so the top-left of every grid is the most
 * substantial dataset.
 *
 * Frames lead because they are the honest measure of how much data a dataset
 * holds — an episode is an arbitrary slice, and sources differ by an order of
 * magnitude in episode length (see `avgEpisodeSeconds` in `corpusStats`), so
 * episode count alone would rank a pile of short calibration clips above a
 * long teleoperation corpus. Episode count breaks frame ties (datasets whose
 * `info.json` reports no frames still sort sensibly), and the path breaks the
 * rest so the order is stable across renders.
 */
export function compareDatasetsBySize(
  a: LocalDatasetSummary,
  b: LocalDatasetSummary,
): number {
  return (
    (b.total_frames || 0) - (a.total_frames || 0) ||
    (b.total_episodes || 0) - (a.total_episodes || 0) ||
    a.relativePath.localeCompare(b.relativePath)
  );
}

/**
 * Bucket datasets by prefix, aggregating per-group health counts and episode
 * totals, and picking the first available thumbnail as the category art.
 *
 * Both levels are ordered largest-first (`compareDatasetsBySize`): groups by
 * their summed frames/episodes, and each group's datasets among themselves —
 * which also means the category art comes from the group's biggest dataset
 * that has a thumbnail.
 */
export function groupDatasetsByPrefix(
  datasets: LocalDatasetSummary[],
): DatasetGroup[] {
  const groups = new Map<string, DatasetGroup>();

  for (const ds of datasets) {
    const prefix = getDatasetPrefix(ds.relativePath);
    let group = groups.get(prefix);
    if (!group) {
      group = {
        prefix,
        datasets: [],
        counts: { ok: 0, empty: 0, incomplete: 0 },
        totalEpisodes: 0,
        totalFrames: 0,
        thumbnailVideoUrl: null,
      };
      groups.set(prefix, group);
    }

    group.datasets.push(ds);
    group.totalEpisodes += ds.total_episodes || 0;
    group.totalFrames += ds.total_frames || 0;
    if (ds.integrity.status === "ok") group.counts.ok += 1;
    else if (ds.integrity.status === "empty") group.counts.empty += 1;
    else group.counts.incomplete += 1;
  }

  const ordered = Array.from(groups.values());
  for (const group of ordered) {
    group.datasets.sort(compareDatasetsBySize);
    group.thumbnailVideoUrl =
      group.datasets.find((ds) => ds.thumbnailVideoUrl)?.thumbnailVideoUrl ??
      null;
  }

  return ordered.sort(
    (a, b) =>
      b.totalFrames - a.totalFrames ||
      b.totalEpisodes - a.totalEpisodes ||
      a.prefix.localeCompare(b.prefix),
  );
}
