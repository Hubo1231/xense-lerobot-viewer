"use client";

/**
 * Parquet browser tab — inspect the raw contents of any parquet file in the
 * dataset as a table.
 *
 * Parsing happens server-side (`/api/local-datasets/<enc>/parquet/read`); this
 * component only ever holds one page of already-JSON-safe rows. On open it
 * jumps straight to the current episode's rows in its own data file, which for
 * lerobot v3 is otherwise a chunk/file/row-range lookup done by hand.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchParquetFiles,
  fetchParquetInfo,
  fetchParquetPage,
} from "@/utils/parquetBrowserClient";
import {
  defaultColumnSelection,
  describeCell,
  formatBytes,
  rowsToCsv,
  type CellKind,
} from "@/utils/parquetBrowser";
import type {
  EpisodeLocator,
  ParquetFileEntry,
  ParquetFileGroup,
  ParquetFileInfo,
} from "@/types/parquet-browser.types";

const PAGE_SIZES = [25, 50, 100, 250, 500];
const DEFAULT_PAGE_SIZE = 50;

const GROUP_LABELS: Record<ParquetFileGroup, string> = {
  data: "Data",
  episodes: "Episode metadata",
  meta: "Meta",
  other: "Other",
};

const GROUP_ORDER: ParquetFileGroup[] = ["data", "episodes", "meta", "other"];

const CELL_TONE: Record<CellKind, string> = {
  null: "text-slate-600 italic",
  number: "text-slate-200",
  string: "text-slate-300",
  boolean: "text-slate-200",
  list: "text-cyan-200/80",
  bytes: "text-amber-200/80",
  object: "text-cyan-200/80",
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

interface ParquetTablePanelProps {
  /** base64url dataset path, or null when the dataset isn't local. */
  encodedPath: string | null;
  episodeId: number;
}

export default function ParquetTablePanel({
  encodedPath,
  episodeId,
}: ParquetTablePanelProps) {
  const [files, setFiles] = useState<ParquetFileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [locator, setLocator] = useState<EpisodeLocator | null>(null);
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<string | null>(null);
  const [info, setInfo] = useState<ParquetFileInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  const [columns, setColumns] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [columnSearch, setColumnSearch] = useState("");

  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [pageColumns, setPageColumns] = useState<string[]>([]);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Offset to apply once the *next* file's metadata lands. Selecting a file
  // resets the offset, so an episode jump has to survive that reset.
  const pendingOffsetRef = useRef<number | null>(null);

  // ── Load the file list ────────────────────────────────────────────────
  useEffect(() => {
    if (!encodedPath) return;
    const controller = new AbortController();
    setFilesLoading(true);
    setFilesError(null);

    fetchParquetFiles(encodedPath, episodeId, controller.signal)
      .then((res) => {
        setFiles(res.files);
        setLocator(res.episodeLocator);
        if (res.episodeLocator) {
          pendingOffsetRef.current = res.episodeLocator.fromIndex;
        }
        setSelected(
          (prev) =>
            prev ??
            res.episodeLocator?.relPath ??
            res.files.find((file) => file.group === "data")?.relPath ??
            res.files[0]?.relPath ??
            null,
        );
      })
      .catch((error) => {
        if (isAbortError(error)) return;
        setFilesError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setFilesLoading(false);
      });

    return () => controller.abort();
  }, [encodedPath, episodeId]);

  // ── Load the selected file's schema ───────────────────────────────────
  useEffect(() => {
    if (!encodedPath || !selected) return;
    const controller = new AbortController();
    setInfo(null);
    setInfoError(null);
    setPageError(null);
    setRows([]);
    setPageColumns([]);
    setExpanded(new Set());

    fetchParquetInfo(encodedPath, selected, controller.signal)
      .then((res) => {
        const names = res.info.columns.map((column) => column.name);
        setInfo(res.info);
        setColumns(defaultColumnSelection(names));
        const pending = pendingOffsetRef.current;
        pendingOffsetRef.current = null;
        setOffset(pending ?? 0);
      })
      .catch((error) => {
        if (isAbortError(error)) return;
        setInfoError(errorMessage(error));
      });

    return () => controller.abort();
  }, [encodedPath, selected]);

  // ── Load the current page ─────────────────────────────────────────────
  useEffect(() => {
    if (!encodedPath || !selected || !info) return;
    if (columns.length === 0) {
      setRows([]);
      setPageColumns([]);
      return;
    }

    const controller = new AbortController();
    setPageLoading(true);
    setPageError(null);

    fetchParquetPage(encodedPath, selected, {
      offset,
      limit,
      columns,
      signal: controller.signal,
    })
      .then((res) => {
        setRows(res.page?.rows ?? []);
        setPageColumns(res.page?.columns ?? []);
        setExpanded(new Set());
      })
      .catch((error) => {
        if (isAbortError(error)) return;
        setPageError(errorMessage(error));
        setRows([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPageLoading(false);
      });

    return () => controller.abort();
  }, [encodedPath, selected, info, columns, offset, limit]);

  // Close the column picker on an outside click.
  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [pickerOpen]);

  const columnTypes = useMemo(() => {
    const map = new Map<string, string>();
    for (const column of info?.columns ?? []) map.set(column.name, column.type);
    return map;
  }, [info]);

  const groupedFiles = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const visible = needle
      ? files.filter((file) => file.relPath.toLowerCase().includes(needle))
      : files;
    return GROUP_ORDER.map((group) => ({
      group,
      entries: visible.filter((file) => file.group === group),
    })).filter((bucket) => bucket.entries.length > 0);
  }, [files, search]);

  const numRows = info?.numRows ?? 0;
  const maxOffset = numRows > 0 ? Math.floor((numRows - 1) / limit) * limit : 0;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(numRows / limit));

  const toggleColumn = useCallback((name: string) => {
    setColumns((prev) =>
      prev.includes(name)
        ? prev.filter((column) => column !== name)
        : [...prev, name],
    );
  }, []);

  // Keep the projection in schema order so the table doesn't reshuffle
  // whenever a column is toggled back on.
  const orderedColumns = useMemo(() => {
    const chosen = new Set(columns);
    return (info?.columns ?? [])
      .map((column) => column.name)
      .filter((name) => chosen.has(name));
  }, [columns, info]);

  const jumpToEpisode = useCallback(() => {
    if (!locator) return;
    if (selected === locator.relPath) {
      setOffset(locator.fromIndex);
    } else {
      pendingOffsetRef.current = locator.fromIndex;
      setSelected(locator.relPath);
    }
  }, [locator, selected]);

  const toggleCell = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (!encodedPath) {
    return (
      <div className="panel p-6 text-sm text-slate-400">
        Raw parquet browsing is only available for local datasets.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      {/* ── File picker ─────────────────────────────────────────────── */}
      <aside className="panel flex w-64 shrink-0 flex-col overflow-hidden">
        <div className="border-b border-white/5 p-2">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter files…"
            className="w-full rounded bg-black/30 px-2 py-1 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:ring-1 focus:ring-[var(--accent-ring)]"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {filesLoading && (
            <p className="p-3 text-xs text-slate-500">Scanning dataset…</p>
          )}
          {filesError && (
            <p className="p-3 text-xs text-red-300">{filesError}</p>
          )}
          {!filesLoading && !filesError && files.length === 0 && (
            <p className="p-3 text-xs text-slate-500">
              No parquet files found in this dataset.
            </p>
          )}

          {groupedFiles.map(({ group, entries }) => (
            <div key={group} className="pb-2">
              <p className="sticky top-0 bg-[var(--surface-0)] px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                {GROUP_LABELS[group]}
              </p>
              {entries.map((file) => {
                const active = file.relPath === selected;
                return (
                  <button
                    key={file.relPath}
                    onClick={() => setSelected(file.relPath)}
                    title={file.relPath}
                    className={`flex w-full items-baseline justify-between gap-2 px-3 py-1 text-left text-xs transition-colors ${
                      active
                        ? "bg-cyan-400/10 text-cyan-200"
                        : "text-slate-400 hover:bg-white/[0.03] hover:text-slate-200"
                    }`}
                  >
                    <span className="truncate font-mono">
                      {baseName(file.relPath)}
                    </span>
                    <span className="tabular shrink-0 text-[10px] text-slate-600">
                      {formatBytes(file.size)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      {/* ── Table ───────────────────────────────────────────────────── */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <header className="panel shrink-0 px-3 py-2">
          <p
            className="truncate font-mono text-sm text-slate-200"
            title={selected ?? undefined}
          >
            {selected ?? "No file selected"}
          </p>
          <div className="tabular mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
            {info ? (
              <>
                <span>
                  <span className="text-slate-300">
                    {info.numRows.toLocaleString()}
                  </span>{" "}
                  rows
                </span>
                <span>
                  <span className="text-slate-300">{info.columns.length}</span>{" "}
                  columns
                </span>
                <span>
                  <span className="text-slate-300">{info.numRowGroups}</span>{" "}
                  row groups
                </span>
                <span>{formatBytes(info.size)}</span>
                {info.compression && <span>{info.compression}</span>}
                {info.createdBy && (
                  <span className="truncate" title={info.createdBy}>
                    {info.createdBy}
                  </span>
                )}
              </>
            ) : (
              <span>{infoError ? "" : "Reading schema…"}</span>
            )}
            {locator && (
              <button
                onClick={jumpToEpisode}
                className="rounded border border-cyan-400/30 px-2 py-0.5 text-cyan-300 transition-colors hover:bg-cyan-400/10"
                title={`${locator.relPath} rows ${locator.fromIndex}–${locator.toIndex}`}
              >
                Jump to episode {locator.episodeIndex} (rows{" "}
                {locator.fromIndex.toLocaleString()}–
                {locator.toIndex.toLocaleString()})
              </button>
            )}
          </div>
          {infoError && (
            <p className="mt-1 text-xs text-red-300">{infoError}</p>
          )}
        </header>

        {/* Toolbar */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
          <div className="relative" ref={pickerRef}>
            <button
              onClick={() => setPickerOpen((open) => !open)}
              disabled={!info}
              className="rounded border border-white/10 px-2 py-1 text-slate-300 transition-colors hover:bg-white/5 disabled:opacity-40"
            >
              Columns {orderedColumns.length}/{info?.columns.length ?? 0} ▾
            </button>

            {pickerOpen && info && (
              // Opaque on purpose: `.panel-raised` is translucent and the table
              // scrolls underneath this menu.
              <div className="absolute left-0 top-full z-30 mt-1 flex max-h-96 w-80 flex-col rounded-md border border-white/10 bg-[var(--surface-2)] shadow-xl shadow-black/50">
                <div className="flex items-center gap-1 border-b border-white/5 p-2">
                  <input
                    value={columnSearch}
                    onChange={(event) => setColumnSearch(event.target.value)}
                    placeholder="Filter columns…"
                    className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 text-xs text-slate-200 outline-none placeholder:text-slate-600"
                  />
                  <button
                    onClick={() =>
                      setColumns(info.columns.map((column) => column.name))
                    }
                    className="rounded px-1.5 py-1 text-[11px] text-slate-400 hover:text-slate-100"
                  >
                    All
                  </button>
                  <button
                    onClick={() => setColumns([])}
                    className="rounded px-1.5 py-1 text-[11px] text-slate-400 hover:text-slate-100"
                  >
                    None
                  </button>
                  <button
                    onClick={() =>
                      setColumns(
                        defaultColumnSelection(
                          info.columns.map((column) => column.name),
                        ),
                      )
                    }
                    className="rounded px-1.5 py-1 text-[11px] text-slate-400 hover:text-slate-100"
                  >
                    Reset
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto py-1">
                  {info.columns
                    .filter((column) =>
                      column.name
                        .toLowerCase()
                        .includes(columnSearch.trim().toLowerCase()),
                    )
                    .map((column) => (
                      <label
                        key={column.name}
                        className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-white/[0.03]"
                      >
                        <input
                          type="checkbox"
                          checked={columns.includes(column.name)}
                          onChange={() => toggleColumn(column.name)}
                          className="accent-cyan-400"
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">
                          {column.name}
                        </span>
                        <span className="shrink-0 text-[10px] text-slate-600">
                          {column.type}
                        </span>
                      </label>
                    ))}
                </div>
              </div>
            )}
          </div>

          <label className="flex items-center gap-1 text-slate-500">
            Rows
            <select
              value={limit}
              onChange={(event) => {
                const next = Number(event.target.value);
                setLimit(next);
                setOffset((prev) => Math.floor(prev / next) * next);
              }}
              className="rounded border border-white/10 bg-[var(--surface-1)] px-1 py-1 text-slate-300 outline-none"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setOffset((prev) => Math.max(0, prev - limit))}
              disabled={offset <= 0}
              className="rounded border border-white/10 px-2 py-1 text-slate-300 transition-colors hover:bg-white/5 disabled:opacity-30"
            >
              ‹ Prev
            </button>
            <span className="tabular px-1 text-slate-500">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() =>
                setOffset((prev) => Math.min(maxOffset, prev + limit))
              }
              disabled={offset >= maxOffset}
              className="rounded border border-white/10 px-2 py-1 text-slate-300 transition-colors hover:bg-white/5 disabled:opacity-30"
            >
              Next ›
            </button>
          </div>

          <label className="flex items-center gap-1 text-slate-500">
            Go to row
            <input
              type="number"
              min={0}
              max={Math.max(0, numRows - 1)}
              value={offset}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (!Number.isFinite(next)) return;
                setOffset(Math.min(maxOffset, Math.max(0, Math.floor(next))));
              }}
              className="tabular w-24 rounded border border-white/10 bg-[var(--surface-1)] px-2 py-1 text-slate-300 outline-none"
            />
          </label>

          <button
            onClick={() =>
              downloadCsv(
                `${baseName(selected ?? "rows").replace(/\.parquet$/, "")}_${offset}-${offset + rows.length}.csv`,
                rowsToCsv(pageColumns, rows),
              )
            }
            disabled={rows.length === 0}
            className="rounded border border-white/10 px-2 py-1 text-slate-300 transition-colors hover:bg-white/5 disabled:opacity-30"
          >
            Export page CSV
          </button>

          {pageLoading && <span className="text-slate-500">Reading…</span>}
        </div>

        {pageError && (
          <p className="panel shrink-0 p-3 text-xs text-red-300">{pageError}</p>
        )}

        <div className="panel min-h-0 flex-1 overflow-auto">
          {orderedColumns.length === 0 ? (
            <p className="p-4 text-xs text-slate-500">
              {info
                ? "No columns selected — pick some in the Columns menu."
                : "Select a parquet file to inspect."}
            </p>
          ) : (
            <table className="min-w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-20 border-b border-r border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-right font-normal text-slate-500">
                    #
                  </th>
                  {pageColumns.map((column) => (
                    <th
                      key={column}
                      className="sticky top-0 z-10 border-b border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-left align-bottom"
                    >
                      <span className="block font-mono font-medium text-slate-200">
                        {column}
                      </span>
                      <span className="block text-[10px] font-normal text-slate-600">
                        {columnTypes.get(column) ?? ""}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const rowIndex = offset + index;
                  return (
                    <tr key={rowIndex} className="group">
                      <td className="tabular sticky left-0 z-10 border-b border-r border-white/5 bg-[var(--surface-0)] px-2 py-1 text-right text-slate-600">
                        {rowIndex}
                      </td>
                      {pageColumns.map((column) => {
                        const key = `${rowIndex}:${column}`;
                        return (
                          <ParquetCell
                            key={column}
                            value={row[column]}
                            expanded={expanded.has(key)}
                            onToggle={() => toggleCell(key)}
                          />
                        );
                      })}
                    </tr>
                  );
                })}
                {rows.length === 0 && !pageLoading && (
                  <tr>
                    <td
                      colSpan={pageColumns.length + 1}
                      className="px-3 py-4 text-slate-500"
                    >
                      No rows in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function ParquetCell({
  value,
  expanded,
  onToggle,
}: {
  value: unknown;
  expanded: boolean;
  onToggle: () => void;
}) {
  const cell = useMemo(() => describeCell(value), [value]);

  return (
    <td
      onClick={cell.expandable ? onToggle : undefined}
      title={cell.expandable ? "Click to expand" : undefined}
      className={`tabular border-b border-white/5 px-2 py-1 align-top group-hover:bg-white/[0.02] ${
        CELL_TONE[cell.kind]
      } ${cell.expandable ? "cursor-pointer" : ""}`}
    >
      {expanded ? (
        <span className="block max-w-[560px] whitespace-pre-wrap break-all font-mono text-[11px]">
          {cell.full}
        </span>
      ) : (
        <span className="block max-w-[560px] truncate whitespace-nowrap">
          {cell.preview}
        </span>
      )}
    </td>
  );
}
