"use client";

import React, { useCallback, useRef, useState } from "react";
import type { CorpusSegment } from "@/utils/corpusStats";
import {
  formatCompact,
  formatEpisodeLength,
  formatHours,
  tapeColor,
} from "@/utils/corpusStats";
import {
  formatDelta,
  isFlatDelta,
  type SourceDelta,
} from "@/utils/corpusHistory";
import {
  listSyncCandidates,
  runSync,
  type SyncProgress,
} from "@/utils/syncClient";

type SourcePanelProps = {
  segment: CorpusSegment;
  colorIndex: number;
  counts: { ok: number; empty: number; incomplete: number };
  delta: SourceDelta | null;
  since: string | null;
  spanDays: number | null;
  onOpen: (prefix: string) => void;
};

type SyncState =
  | { kind: "idle" }
  | { kind: "listing" }
  | { kind: "confirm"; repos: string[]; endpoint: string }
  | { kind: "running"; progress: SyncProgress }
  | { kind: "done"; downloaded: number; failed: number }
  | { kind: "error"; message: string };

/** Transferred volume, at the precision the magnitude deserves. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1000)} kB`;
}

/** Growth since the last recorded day, or an explanation of why there is none. */
function TodayStrip({
  delta,
  since,
  spanDays,
}: {
  delta: SourceDelta | null;
  since: string | null;
  spanDays: number | null;
}) {
  if (!delta || since === null) {
    return (
      <p className="text-xs text-[var(--text-faint)]">
        No earlier snapshot yet — growth appears the next day this page is
        opened.
      </p>
    );
  }
  if (isFlatDelta(delta)) {
    return (
      <p className="text-xs text-[var(--text-faint)]">
        Unchanged since {since}
        {spanDays !== null && spanDays > 1 ? ` (${spanDays} days ago)` : ""}.
      </p>
    );
  }

  const items = [
    { label: "Hours", value: formatDelta(delta.hours, " h") },
    { label: "Episodes", value: formatDelta(delta.episodes) },
    { label: "Tasks", value: formatDelta(delta.tasks) },
  ];
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-7 gap-y-2">
        {items.map((item) => (
          <div key={item.label}>
            <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)]">
              {item.label}
            </p>
            <p className="tabular mt-0.5 text-lg font-semibold text-emerald-300">
              {item.value}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-[var(--text-faint)]">
        Since {since}
        {spanDays !== null && spanDays > 1 ? ` · ${spanDays} days` : " · 1 day"}
      </p>
    </div>
  );
}

export default function SourcePanel({
  segment,
  colorIndex,
  counts,
  delta,
  since,
  spanDays,
  onOpen,
}: SourcePanelProps) {
  const [sync, setSync] = useState<SyncState>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const startListing = useCallback(async () => {
    setSync({ kind: "listing" });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const listing = await listSyncCandidates(
        segment.prefix,
        controller.signal,
      );
      if (listing.count === 0) {
        setSync({ kind: "error", message: "No datasets found on the Hub." });
        return;
      }
      setSync({
        kind: "confirm",
        repos: listing.repos,
        endpoint: listing.endpoint,
      });
    } catch (err) {
      setSync({ kind: "error", message: (err as Error).message });
    }
  }, [segment.prefix]);

  const startDownload = useCallback(async () => {
    setSync({ kind: "running", progress: { phase: "listing" } });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await runSync(
        segment.prefix,
        (progress) => setSync({ kind: "running", progress }),
        controller.signal,
      );
      setSync({
        kind: "done",
        downloaded: result.downloaded,
        failed: result.failed.length,
      });
    } catch (err) {
      setSync({ kind: "error", message: (err as Error).message });
    }
  }, [segment.prefix]);

  const headline = formatHours(segment.hours);
  const issues = counts.incomplete + counts.empty;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div>
          <p className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text-faint)]">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: tapeColor(colorIndex) }}
            />
            {segment.prefix}
          </p>
          <p className="mt-1.5 flex items-baseline gap-1.5">
            <span className="tabular text-[clamp(2.2rem,6vw,3rem)] font-semibold leading-[0.85] tracking-[-0.035em] text-[var(--text-primary)]">
              {headline.value}
            </span>
            <span className="text-base font-medium text-[var(--text-muted)]">
              {headline.unit}
            </span>
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:items-end sm:gap-x-8">
          {[
            { label: "Episodes", value: formatCompact(segment.episodes) },
            { label: "Tasks", value: formatCompact(segment.tasks) },
            {
              label: "Per episode",
              value: formatEpisodeLength(segment.avgEpisodeSeconds),
            },
            {
              label: "Share",
              value: `${Math.round(segment.share * 100)}%`,
            },
          ].map((item) => (
            <div key={item.label}>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)]">
                {item.label}
              </dt>
              <dd className="tabular mt-1 text-base font-medium text-[var(--text-primary)]">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-md border border-white/5 bg-[var(--surface-1)]/40 px-4 py-3.5">
        <p className="mb-2.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text-faint)]">
          Collected since last snapshot
        </p>
        <TodayStrip delta={delta} since={since} spanDays={spanDays} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="inline-flex items-center gap-1.5 text-emerald-300/90">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="tabular">{counts.ok}</span> healthy
        </span>
        {issues > 0 && (
          <span className="inline-flex items-center gap-1.5 text-amber-300/90">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            <span className="tabular">{issues}</span> need attention
          </span>
        )}
        <button
          type="button"
          onClick={() => onOpen(segment.prefix)}
          className="ml-auto rounded-md border border-white/10 px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        >
          Browse {segment.tasks} tasks
        </button>
      </div>

      {/* Sync. Listing always precedes transfer — an org can hold far more on
          the Hub than locally, and the count is the only warning you get. */}
      <div className="border-t border-white/5 pt-4">
        <SyncBlock
          state={sync}
          source={segment.prefix}
          localTasks={segment.tasks}
          onList={startListing}
          onConfirm={startDownload}
          onCancel={() => {
            abortRef.current?.abort();
            setSync({ kind: "idle" });
          }}
        />
      </div>
    </div>
  );
}

function SyncBlock({
  state,
  source,
  localTasks,
  onList,
  onConfirm,
  onCancel,
}: {
  state: SyncState;
  source: string;
  localTasks: number;
  onList: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (state.kind === "idle" || state.kind === "error") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onList}
          className="rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        >
          Sync from Hugging Face
        </button>
        <span className="text-[11px] text-[var(--text-faint)]">
          Downloads {source} through hf-mirror. Shows what it would pull first.
        </span>
        {state.kind === "error" && (
          <p className="w-full text-xs text-red-300">{state.message}</p>
        )}
      </div>
    );
  }

  if (state.kind === "listing") {
    return (
      <p className="text-xs text-[var(--text-muted)]">
        Checking the Hub for {source}…
      </p>
    );
  }

  if (state.kind === "confirm") {
    const newCount = state.repos.length - localTasks;
    return (
      <div className="space-y-2.5">
        <p className="text-xs text-[var(--text-primary)]">
          <span className="tabular font-semibold">{state.repos.length}</span>{" "}
          datasets on the Hub for {source}
          {newCount > 0 && (
            <>
              {" — "}
              <span className="tabular font-semibold text-amber-300">
                {newCount} more
              </span>{" "}
              than the {localTasks} held locally
            </>
          )}
          .
        </p>
        <p className="text-[11px] text-[var(--text-faint)]">
          Transfers the full contents of each, including video. Via{" "}
          <span className="font-mono">{state.endpoint}</span>.
        </p>
        <div className="flex flex-wrap gap-2 pt-0.5">
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          >
            Download {state.repos.length} datasets
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-white/10 px-3.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "running") {
    const p = state.progress;
    const percent = Math.max(0, Math.min(100, p.percent ?? 0));
    const repoPercent = Math.max(0, Math.min(100, p.repoPercent ?? 0));
    // Files and bytes are what tell you a large repo is moving; the overall
    // percent barely shifts while one multi-gigabyte dataset transfers.
    const detail = [
      p.filesTotal ? `${p.filesDone ?? 0}/${p.filesTotal} files` : null,
      p.bytes ? formatBytes(p.bytes) : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="truncate text-[var(--text-primary)]">
            {p.phase === "listing" && "Preparing…"}
            {p.phase === "preflight" && "Checking the endpoint…"}
            {p.phase === "downloading" && `Downloading ${p.repo ?? ""}`}
            {p.phase === "failed" && `Skipped ${p.repo ?? ""}`}
            {p.phase === "complete" && "Finishing…"}
          </span>
          <span className="tabular shrink-0 text-[var(--text-muted)]">
            {p.index && p.total ? `${p.index}/${p.total} · ` : ""}
            {percent}%
          </span>
        </div>

        {/* Overall across the org. */}
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Overall sync progress"
          className="h-1.5 w-full overflow-hidden rounded-full bg-white/5"
        >
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>

        {/* Current repo, so a single large dataset still shows movement. */}
        {p.phase === "downloading" && (
          <>
            <div
              role="progressbar"
              aria-valuenow={repoPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Current dataset progress"
              className="h-1 w-full overflow-hidden rounded-full bg-white/5"
            >
              <div
                className="h-full rounded-full bg-[var(--accent)]/40 transition-[width] duration-300"
                style={{ width: `${repoPercent}%` }}
              />
            </div>
            {detail && (
              <p className="tabular text-[11px] text-[var(--text-muted)]">
                {detail}
              </p>
            )}
          </>
        )}

        <p className="text-[11px] text-[var(--text-faint)]">
          Leaving this page does not stop the transfer.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-emerald-300">
        Downloaded <span className="tabular">{state.downloaded}</span> datasets
        {state.failed > 0 && (
          <span className="text-amber-300">
            {" "}
            · <span className="tabular">{state.failed}</span> failed
          </span>
        )}
        .
      </p>
      <p className="text-[11px] text-[var(--text-faint)]">
        Reload the page to pick up the new datasets.
      </p>
    </div>
  );
}
