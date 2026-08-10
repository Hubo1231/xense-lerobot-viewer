/**
 * Wire format for the Parquet browser tab.
 *
 * The dataset's parquet files are parsed server-side (hyparquet on Node,
 * reading straight off disk) and only the requested page reaches the browser,
 * so these types describe JSON that has already been made safe: no BigInt, no
 * typed arrays. See `toJsonSafe` in `@/utils/parquetBrowser`.
 */

/** Which part of the lerobot layout a parquet file belongs to. */
export type ParquetFileGroup = "data" | "episodes" | "meta" | "other";

export interface ParquetFileEntry {
  /** Dataset-relative POSIX path, e.g. `data/chunk-000/file-000.parquet`. */
  relPath: string;
  group: ParquetFileGroup;
  size: number;
}

export interface ParquetColumnInfo {
  name: string;
  /** Human-readable type, e.g. `int64`, `list<float>`, `string`. */
  type: string;
  optional: boolean;
}

export interface ParquetFileInfo {
  relPath: string;
  size: number;
  numRows: number;
  numRowGroups: number;
  createdBy: string | null;
  /** Distinct codecs across the first row group, e.g. `SNAPPY`. */
  compression: string | null;
  columns: ParquetColumnInfo[];
}

export interface ParquetPage {
  offset: number;
  limit: number;
  /** Column names actually returned, in schema order. */
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface ParquetReadResponse {
  info: ParquetFileInfo;
  /** Null for metadata-only requests (`?meta=1`). */
  page: ParquetPage | null;
}

/** Where one episode's rows live, for the "jump to this episode" shortcut. */
export interface EpisodeLocator {
  episodeIndex: number;
  relPath: string;
  fromIndex: number;
  toIndex: number;
}

export interface ParquetFilesResponse {
  files: ParquetFileEntry[];
  episodeLocator: EpisodeLocator | null;
}

/** A byte column, summarised rather than shipped whole. */
export interface BytesCell {
  __kind: "bytes";
  length: number;
  /** Hex preview of the leading bytes. */
  preview: string;
}

/** A list column too long to ship whole. */
export interface TruncatedListCell {
  __kind: "list";
  length: number;
  items: unknown[];
}

export function isBytesCell(value: unknown): value is BytesCell {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as BytesCell).__kind === "bytes"
  );
}

export function isTruncatedListCell(
  value: unknown,
): value is TruncatedListCell {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as TruncatedListCell).__kind === "list"
  );
}
