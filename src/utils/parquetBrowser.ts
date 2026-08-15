/**
 * Pure helpers for the Parquet browser tab.
 *
 * Split out from the route and the panel so the interesting rules — JSON
 * safety, cell formatting, file ordering — are testable without a filesystem
 * or a DOM.
 */

import {
  isBytesCell,
  isTruncatedListCell,
  type ParquetFileEntry,
  type ParquetFileGroup,
} from "@/types/parquet-browser.types";
import { formatBytes } from "@/utils/byteSize";

// Re-exported so the parquet panel and its tests keep importing it from here.
// The implementation moved to `@/utils/byteSize` when the homepage started
// showing storage figures — importing it from this module would have pulled the
// whole parquet browser into the homepage bundle.
export { formatBytes };

/** Lists longer than this are summarised rather than shipped whole. */
export const MAX_LIST_ITEMS = 2048;
/** Leading bytes kept as a hex preview for binary columns. */
export const BYTES_PREVIEW_LENGTH = 16;
/** List items shown inline in a table cell before the ellipsis. */
export const PREVIEW_LIST_ITEMS = 4;
/** Characters of a string shown inline in a table cell. */
export const PREVIEW_STRING_LENGTH = 72;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Columns worth showing first when a file has too many to display at once. */
const CORE_COLUMNS = new Set([
  "episode_index",
  "frame_index",
  "index",
  "timestamp",
  "task_index",
  "subtask_index",
  "tasks",
  "length",
]);

const GROUP_ORDER: Record<ParquetFileGroup, number> = {
  data: 0,
  episodes: 1,
  meta: 2,
  other: 3,
};

export function classifyParquetPath(relPath: string): ParquetFileGroup {
  if (relPath.startsWith("meta/episodes/")) return "episodes";
  if (relPath.startsWith("data/")) return "data";
  if (relPath.startsWith("meta/")) return "meta";
  return "other";
}

/**
 * Compare strings with embedded digit runs numerically, so `file-2` sorts
 * before `file-10` even when the padding is inconsistent.
 */
export function naturalCompare(a: string, b: string): number {
  const chunks = /(\d+)|(\D+)/g;
  const left = a.match(chunks) ?? [];
  const right = b.match(chunks) ?? [];

  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    const lNum = /^\d/.test(l);
    const rNum = /^\d/.test(r);

    if (lNum && rNum) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }

  return left.length - right.length;
}

export function compareParquetEntries(
  a: ParquetFileEntry,
  b: ParquetFileEntry,
): number {
  const byGroup = GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
  if (byGroup !== 0) return byGroup;
  return naturalCompare(a.relPath, b.relPath);
}

function hexPreview(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, BYTES_PREVIEW_LENGTH))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert a decoded parquet value into something `JSON.stringify` accepts.
 *
 * BigInt becomes a number when it fits exactly and a string when it doesn't
 * (int64 row counters near 2^53 would otherwise silently lose digits), typed
 * arrays become plain arrays, and byte columns collapse to a summary so a
 * single row can't ship megabytes.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  if (typeof value === "bigint") {
    return value <= MAX_SAFE && value >= -MAX_SAFE
      ? Number(value)
      : value.toString();
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "string" || typeof value === "boolean") return value;

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Uint8Array) {
    return {
      __kind: "bytes" as const,
      length: value.byteLength,
      preview: hexPreview(value),
    };
  }

  if (ArrayBuffer.isView(value)) {
    return toJsonSafe(Array.from(value as unknown as ArrayLike<number>));
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ITEMS) {
      return {
        __kind: "list" as const,
        length: value.length,
        items: value.slice(0, MAX_LIST_ITEMS).map(toJsonSafe),
      };
    }
    return value.map(toJsonSafe);
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = toJsonSafe(inner);
    }
    return out;
  }

  return String(value);
}

/** Compact numeric rendering: integers verbatim, floats to 7 significant digits. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(7)));
}

export type CellKind =
  | "null"
  | "number"
  | "string"
  | "boolean"
  | "list"
  | "bytes"
  | "object";

export interface CellDescription {
  kind: CellKind;
  /** Single-line rendering that fits in a table cell. */
  preview: string;
  /** Complete rendering, shown when the cell is expanded and used for copy/CSV. */
  full: string;
  /** True when `preview` hides something, i.e. expanding is worthwhile. */
  expandable: boolean;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Describe one decoded cell for display. Accepts only JSON-safe values. */
export function describeCell(value: unknown): CellDescription {
  if (value === null || value === undefined) {
    return { kind: "null", preview: "null", full: "null", expandable: false };
  }

  if (typeof value === "number") {
    const text = formatNumber(value);
    return { kind: "number", preview: text, full: text, expandable: false };
  }

  if (typeof value === "boolean") {
    const text = String(value);
    return { kind: "boolean", preview: text, full: text, expandable: false };
  }

  if (typeof value === "string") {
    const oneLine = value.replace(/\s+/g, " ").trim();
    const preview = truncate(oneLine, PREVIEW_STRING_LENGTH);
    return {
      kind: "string",
      preview,
      full: value,
      expandable: preview !== value,
    };
  }

  if (isBytesCell(value)) {
    const text = `0x${value.preview}${value.length > BYTES_PREVIEW_LENGTH ? "…" : ""}`;
    return {
      kind: "bytes",
      preview: `${text} (${formatBytes(value.length)})`,
      full: `${value.length} bytes, starts with 0x${value.preview}`,
      expandable: false,
    };
  }

  if (isTruncatedListCell(value)) {
    const described = describeList(value.items, value.length);
    return {
      ...described,
      full: `${described.full}\n… ${value.length - value.items.length} more items not loaded`,
      expandable: true,
    };
  }

  if (Array.isArray(value)) {
    return describeList(value, value.length);
  }

  const json = JSON.stringify(value);
  const preview = truncate(json, PREVIEW_STRING_LENGTH);
  return {
    kind: "object",
    preview,
    full: JSON.stringify(value, null, 2),
    expandable: true,
  };
}

function describeList(items: unknown[], totalLength: number): CellDescription {
  const head = items.slice(0, PREVIEW_LIST_ITEMS).map(describeCell);
  const ellipsis = totalLength > head.length ? ", …" : "";
  const suffix = totalLength === 1 ? "" : ` ×${totalLength}`;

  return {
    kind: "list",
    preview: `[${head.map((cell) => cell.preview).join(", ")}${ellipsis}]${suffix}`,
    full: items.map((item) => describeCell(item).full).join(", "),
    // Expanding is only worth a click when the preview hides something: items
    // past the inline head, or a head item that is itself abbreviated.
    expandable:
      totalLength > head.length || head.some((cell) => cell.expandable),
  };
}

/**
 * Pick which columns to show when a file first opens. Files with a manageable
 * column count show everything; wide ones (episode metadata carries ~180
 * columns) fall back to the lerobot bookkeeping columns plus a prefix.
 */
export function defaultColumnSelection(names: string[], max = 16): string[] {
  if (names.length <= max) return [...names];

  const preferred = names.filter((name) => CORE_COLUMNS.has(name));
  const rest = names.filter((name) => !CORE_COLUMNS.has(name));
  const chosen = new Set([...preferred, ...rest].slice(0, max));

  // Keep schema order regardless of which bucket a column came from.
  return names.filter((name) => chosen.has(name));
}

function csvEscape(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serialise the visible page to CSV, using each cell's full (unabbreviated) text. */
export function rowsToCsv(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  const lines = [columns.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((column) => {
          const value = row[column];
          return csvEscape(
            value === null || value === undefined
              ? ""
              : describeCell(value).full,
          );
        })
        .join(","),
    );
  }
  return lines.join("\n");
}
