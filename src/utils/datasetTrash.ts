/**
 * Naming for trashed datasets. Pure — the filesystem side lives in
 * `src/lib/local-dataset-trash.ts`.
 *
 * A trashed dataset keeps its identity in its directory name so the trash is
 * legible with `ls` alone, and carries a sidecar JSON with the exact original
 * path. The directory name is lossy on purpose (separators flattened, exotic
 * characters folded) — it is a label, not the restore instruction.
 */

export type TrashEntry = {
  /** Directory name inside the trash root. */
  name: string;
  /** Dataset path relative to the local root, as it was before deletion. */
  relativePath: string;
  trashedAt: string;
  bytes: number;
};

/** Timestamp prefix: sortable, filesystem-safe, second resolution. */
export function trashStamp(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}` +
    `-${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}`
  );
}

const MAX_SLUG = 80;

/**
 * `Xense/pack_bottles` → `20260815-110203__Xense__pack_bottles`.
 *
 * Anything outside `[A-Za-z0-9._-]` folds to `-` so the name cannot introduce a
 * separator, a leading dot (which the dataset scanner skips), or a `..`.
 */
export function trashEntryName(relativePath: string, when: Date): string {
  const slug = relativePath
    .replace(/\//g, "__")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    // A `..` inside a single name cannot traverse anywhere, but a trash entry
    // called `..__..__etc__passwd` should not have to be reasoned about.
    .replace(/\.{2,}/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, MAX_SLUG);
  // Anything with no alphanumeric left is a label nobody can read.
  return `${trashStamp(when)}__${/[A-Za-z0-9]/.test(slug) ? slug : "dataset"}`;
}

/** Human-readable size for the confirmation dialog and the trash strip. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} kB`;
  return `${bytes} B`;
}
