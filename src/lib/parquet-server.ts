/**
 * Server-side parquet reading for the Parquet browser tab.
 *
 * The browser never downloads these files. lerobot v3 packs many episodes into
 * one shared data parquet (100 MB by default, and often a single row group), so
 * paging client-side would re-download and re-decode the whole group for every
 * page. Here we read straight off disk with hyparquet's Node entry and ship
 * only the requested page as JSON.
 */

import fs from "node:fs/promises";
import {
  asyncBufferFromFile,
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema,
  type AsyncBuffer,
  type FileMetaData,
  type SchemaElement,
  type SchemaTree,
} from "hyparquet/src/node.js";
import { resolveInsideDataset } from "@/lib/local-dataset-paths";
import {
  buildV3DataPath,
  buildV3EpisodesMetadataPath,
} from "@/utils/stringFormatting";
import { bigIntToNumber } from "@/utils/typeGuards";
import { toJsonSafe } from "@/utils/parquetBrowser";
import type {
  EpisodeLocator,
  ParquetColumnInfo,
  ParquetFileInfo,
} from "@/types/parquet-browser.types";

/** Open files kept warm. Small: each entry pins a file handle-ish buffer + footer. */
const MAX_CACHED_FILES = 8;
/** Safety rails for the episode-metadata walk (v3 chunk/file directories). */
const MAX_EPISODE_CHUNKS = 64;
const MAX_FILES_PER_CHUNK = 4096;

interface ParquetHandle {
  file: AsyncBuffer;
  metadata: FileMetaData;
  info: ParquetFileInfo;
}

const handleCache = new Map<string, Promise<ParquetHandle>>();

function describePrimitive(element: SchemaElement): string {
  const logical = element.logical_type;
  if (logical) {
    switch (logical.type) {
      case "STRING":
        return "string";
      case "ENUM":
        return "enum";
      case "UUID":
        return "uuid";
      case "JSON":
        return "json";
      case "BSON":
        return "bson";
      case "DATE":
        return "date";
      case "FLOAT16":
        return "float16";
      case "DECIMAL":
        return `decimal(${logical.precision},${logical.scale})`;
      case "TIME":
        return `time[${logical.unit.toLowerCase()}]`;
      case "TIMESTAMP":
        return `timestamp[${logical.unit.toLowerCase()}]`;
      case "INTEGER":
        return `${logical.isSigned ? "" : "u"}int${logical.bitWidth}`;
      default:
        break;
    }
  }

  if (element.converted_type === "UTF8") return "string";

  switch (element.type) {
    case "BOOLEAN":
      return "bool";
    case "INT32":
      return "int32";
    case "INT64":
      return "int64";
    case "INT96":
      return "int96";
    case "FLOAT":
      return "float";
    case "DOUBLE":
      return "double";
    case "BYTE_ARRAY":
      return "binary";
    case "FIXED_LEN_BYTE_ARRAY":
      return `binary[${element.type_length ?? "?"}]`;
    default:
      return "unknown";
  }
}

/** Render a schema node as a compact type string, e.g. `list<float>`. */
function describeSchemaType(node: SchemaTree): string {
  const element = node.element;
  if (node.children.length === 0) return describePrimitive(element);

  const kind = element.logical_type?.type ?? element.converted_type;

  if (kind === "LIST") {
    // LIST wraps a repeated `list` group whose single child is `element`.
    const inner = node.children[0]?.children[0] ?? node.children[0];
    return `list<${inner ? describeSchemaType(inner) : "?"}>`;
  }

  if (kind === "MAP" || kind === "MAP_KEY_VALUE") {
    const keyValue = node.children[0];
    const key = keyValue?.children[0];
    const value = keyValue?.children[1];
    return `map<${key ? describeSchemaType(key) : "?"}, ${value ? describeSchemaType(value) : "?"}>`;
  }

  const fields = node.children.map((child) => child.element.name);
  const shown = fields.slice(0, 4).join(", ");
  return `struct<${shown}${fields.length > 4 ? ", …" : ""}>`;
}

function buildFileInfo(
  relPath: string,
  size: number,
  metadata: FileMetaData,
): ParquetFileInfo {
  const tree = parquetSchema(metadata);
  const columns: ParquetColumnInfo[] = tree.children.map((child) => ({
    name: child.element.name,
    type: describeSchemaType(child),
    optional: child.element.repetition_type !== "REQUIRED",
  }));

  const codecs = new Set(
    (metadata.row_groups[0]?.columns ?? [])
      .map((column) => column.meta_data?.codec)
      .filter((codec) => Boolean(codec)),
  );

  return {
    relPath,
    size,
    numRows: bigIntToNumber(metadata.num_rows, 0),
    numRowGroups: metadata.row_groups.length,
    createdBy: metadata.created_by ?? null,
    compression: codecs.size > 0 ? [...codecs].join(", ") : null,
    columns,
  };
}

/**
 * Open a parquet file and parse its footer, reusing a warm handle when the file
 * hasn't changed. Keyed on mtime + size so an export that rewrites the parquet
 * (`scripts/export_subtasks.py`) invalidates the entry.
 */
export function openParquet(
  absolutePath: string,
  relPath: string,
  size: number,
  mtimeMs: number,
): Promise<ParquetHandle> {
  const key = `${absolutePath}:${mtimeMs}:${size}`;
  const cached = handleCache.get(key);
  if (cached) {
    // Refresh LRU position.
    handleCache.delete(key);
    handleCache.set(key, cached);
    return cached;
  }

  const pending = (async () => {
    const file = await asyncBufferFromFile(absolutePath);
    const metadata = await parquetMetadataAsync(file);
    return { file, metadata, info: buildFileInfo(relPath, size, metadata) };
  })();

  handleCache.set(key, pending);
  pending.catch(() => handleCache.delete(key));

  while (handleCache.size > MAX_CACHED_FILES) {
    const oldest = handleCache.keys().next();
    if (oldest.done) break;
    handleCache.delete(oldest.value);
  }

  return pending;
}

/**
 * Read one page of rows. `columns` is a projection — hyparquet silently ignores
 * names the file doesn't have, and dropping unread columns is the main lever on
 * decode time for wide files.
 */
export async function readParquetPage(
  handle: ParquetHandle,
  offset: number,
  limit: number,
  columns: string[],
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const rows = (await parquetReadObjects({
    file: handle.file,
    metadata: handle.metadata,
    columns: columns.length > 0 ? columns : undefined,
    rowStart: offset,
    rowEnd: offset + limit,
  })) as Record<string, unknown>[];

  const safeRows = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = toJsonSafe(value);
    }
    return out;
  });

  // Report the columns actually present, in schema order.
  const present = new Set(safeRows.length > 0 ? Object.keys(safeRows[0]) : []);
  const known = handle.info.columns.map((column) => column.name);
  const resolved =
    safeRows.length > 0
      ? known.filter((name) => present.has(name))
      : columns.length > 0
        ? known.filter((name) => columns.includes(name))
        : known;

  return { columns: resolved, rows: safeRows };
}

async function statFileOrNull(
  absolutePath: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return null;
    return { size: Number(stat.size), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

const LOCATOR_COLUMNS = [
  "episode_index",
  "data/chunk_index",
  "data/file_index",
  "dataset_from_index",
  "dataset_to_index",
];

/**
 * Find which data parquet holds an episode and which row range it occupies.
 *
 * Walks `meta/episodes/chunk-{N}/file-{M}.parquet` in order — episode metadata
 * can span several chunks once the episode count exceeds `chunks_size`, so this
 * must not stop at chunk-000. Returns null for v2.x datasets (no such tree) or
 * when the episode isn't listed.
 */
export async function locateEpisodeRows(
  datasetRoot: string,
  episodeIndex: number,
): Promise<EpisodeLocator | null> {
  for (let chunk = 0; chunk < MAX_EPISODE_CHUNKS; chunk += 1) {
    let sawFile = false;

    for (let file = 0; file < MAX_FILES_PER_CHUNK; file += 1) {
      const relPath = buildV3EpisodesMetadataPath(chunk, file);
      const absolutePath = resolveInsideDataset(datasetRoot, relPath);
      if (!absolutePath) return null;

      const stat = await statFileOrNull(absolutePath);
      if (!stat) break;
      sawFile = true;

      const handle = await openParquet(
        absolutePath,
        relPath,
        stat.size,
        stat.mtimeMs,
      );
      const rows = (await parquetReadObjects({
        file: handle.file,
        metadata: handle.metadata,
        columns: LOCATOR_COLUMNS,
      })) as Record<string, unknown>[];

      for (const row of rows) {
        if (bigIntToNumber(row["episode_index"], -1) !== episodeIndex) continue;
        return {
          episodeIndex,
          relPath: buildDataPathFromRow(row),
          fromIndex: bigIntToNumber(row["dataset_from_index"], 0),
          toIndex: bigIntToNumber(row["dataset_to_index"], 0),
        };
      }
    }

    if (!sawFile) return null;
  }

  return null;
}

function buildDataPathFromRow(row: Record<string, unknown>): string {
  return buildV3DataPath(
    bigIntToNumber(row["data/chunk_index"], 0),
    bigIntToNumber(row["data/file_index"], 0),
  );
}
