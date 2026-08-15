/**
 * On-disk size formatting, shared by the parquet file picker and the homepage
 * storage figures.
 *
 * Binary units (1024), because these numbers are read against `du` / the file
 * manager rather than against a vendor's marketing size. The labels stay KB/MB/
 * GB rather than KiB/MiB/GiB — the same convention the parquet tab already
 * shipped, and the one most people read fluently.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
