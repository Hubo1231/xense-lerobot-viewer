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
  /** First non-null thumbnail among the group's datasets, used as the card art. */
  thumbnailVideoUrl: string | null;
};

/**
 * Bucket datasets by prefix, aggregating per-group health counts and episode
 * totals, and picking the first available thumbnail as the category art.
 * Groups are returned sorted by prefix (locale-aware).
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
        thumbnailVideoUrl: null,
      };
      groups.set(prefix, group);
    }

    group.datasets.push(ds);
    group.totalEpisodes += ds.total_episodes;
    if (ds.integrity.status === "ok") group.counts.ok += 1;
    else if (ds.integrity.status === "empty") group.counts.empty += 1;
    else group.counts.incomplete += 1;
    if (!group.thumbnailVideoUrl && ds.thumbnailVideoUrl) {
      group.thumbnailVideoUrl = ds.thumbnailVideoUrl;
    }
  }

  return Array.from(groups.values()).sort((a, b) =>
    a.prefix.localeCompare(b.prefix),
  );
}
