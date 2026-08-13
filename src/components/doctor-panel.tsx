"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFlaggedEpisodes } from "@/context/flagged-episodes-context";
import {
  DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS,
  MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD,
  extractAffectedDoctorEpisodeIds,
  extractDoctorEpisodeIdsFromMessage,
  type DoctorCheckResult,
  type DoctorDimensionJumpThresholds,
  type DoctorEpisodeRange,
  type DoctorProgress,
  type DoctorReport,
  type DoctorRunResponse,
  type DoctorSeverity,
} from "@/types/doctor.types";
import { runDatasetDoctor } from "@/utils/doctorClient";

const DEFAULT_MAX_EPISODES: number | null = null;
const DEFAULT_CUSTOM_RANGE: DoctorEpisodeRange = { start: 10, end: 100 };
const SAMPLE_OPTIONS = [
  { value: "10", label: "First 10 episodes" },
  { value: "25", label: "First 25 episodes" },
  { value: "50", label: "First 50 episodes" },
  { value: "100", label: "First 100 episodes" },
  { value: "all", label: "Full dataset" },
  { value: "custom", label: "Custom episode range" },
] as const;

type DoctorScopeOption = (typeof SAMPLE_OPTIONS)[number]["value"];

interface DoctorScope {
  maxEpisodes: number | null;
  episodeRange: DoctorEpisodeRange | null;
}

interface CachedDoctorRun {
  maxEpisodes: number | null;
  episodeRange: DoctorEpisodeRange | null;
  dimensionJumpThresholds?: DoctorDimensionJumpThresholds;
  result: DoctorRunResponse;
}

function scopeOptionFor(
  maxEpisodes: number | null,
  episodeRange: DoctorEpisodeRange | null,
): DoctorScopeOption {
  if (episodeRange) return "custom";
  if (maxEpisodes === null) return "all";
  return String(maxEpisodes) as DoctorScopeOption;
}

// Conditional tab content unmounts when the user switches tabs. Keep the last
// report in module memory so returning to Doctor (or changing episodes in the
// same dataset) does not launch another expensive scan without being asked.
const doctorRunCache = new Map<string, CachedDoctorRun>();

const SEVERITY_TONE: Record<
  DoctorSeverity,
  { badge: string; border: string; dot: string; text: string }
> = {
  PASS: {
    badge: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    border: "border-emerald-400/20",
    dot: "bg-emerald-400",
    text: "text-emerald-300",
  },
  WARN: {
    badge: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    border: "border-amber-400/20",
    dot: "bg-amber-400",
    text: "text-amber-300",
  },
  FAIL: {
    badge: "border-red-400/30 bg-red-400/10 text-red-300",
    border: "border-red-400/25",
    dot: "bg-red-400",
    text: "text-red-300",
  },
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}

function formatInteger(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}

function downloadReport(report: DoctorReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `lerobot-doctor-${report.dataset_name ?? "report"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyTextToClipboard(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the legacy path for HTTP/local-network deployments.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-80"
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

const INITIAL_PROGRESS: DoctorProgress = {
  phase: "loading",
  completed: 0,
  total: 1,
  percent: 0,
  overall_percent: 0,
  message: "Loading episode metadata and parquet data…",
};

function ProgressBar({ progress }: { progress: DoctorProgress }) {
  const displayedPercent =
    progress.phase === "loading"
      ? Math.max(4, progress.overall_percent)
      : progress.overall_percent;
  return (
    <div className="w-full max-w-xl" role="status" aria-live="polite">
      <div className="mb-2 flex items-center justify-between gap-4 text-xs">
        <span className="truncate text-slate-400">{progress.message}</span>
        <span className="shrink-0 tabular text-cyan-300">
          {progress.overall_percent}%
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-white/10"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.overall_percent}
        role="progressbar"
      >
        <div
          className={`h-full rounded-full bg-cyan-400 transition-[width] duration-300 ${
            progress.phase === "loading" ? "animate-pulse" : ""
          }`}
          style={{ width: `${displayedPercent}%` }}
        />
      </div>
      {progress.phase === "checks" && (
        <p className="mt-2 text-[11px] tabular text-slate-500">
          {progress.completed}/{progress.total} checks completed
        </p>
      )}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: DoctorSeverity }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${SEVERITY_TONE[severity].badge}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${SEVERITY_TONE[severity].dot}`}
      />
      {severity}
    </span>
  );
}

function SummaryCard({
  severity,
  count,
  active,
  onClick,
}: {
  severity: DoctorSeverity;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border p-4 text-left transition-colors ${
        active
          ? `${SEVERITY_TONE[severity].border} bg-white/[0.055]`
          : "border-white/10 bg-[var(--surface-1)]/55 hover:border-white/20"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${SEVERITY_TONE[severity].dot}`}
        />
        <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
          {severity}
        </span>
      </div>
      <p
        className={`mt-2 text-2xl font-semibold tabular ${SEVERITY_TONE[severity].text}`}
      >
        {count}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-500">checks</p>
    </button>
  );
}

function CheckCard({
  check,
  dimensionJumpThresholds,
  expanded,
  onToggle,
}: {
  check: DoctorCheckResult;
  dimensionJumpThresholds: DoctorDimensionJumpThresholds;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { addMany } = useFlaggedEpisodes();
  const episodeIds = useMemo(() => {
    const ids = new Set<number>();
    for (const item of check.messages) {
      if (item.severity === "PASS") continue;
      for (const id of extractDoctorEpisodeIdsFromMessage(item.message)) {
        ids.add(id);
      }
    }
    return [...ids].sort((a, b) => a - b);
  }, [check.messages]);
  const issueCount = check.messages.filter(
    (message) => message.severity !== "PASS",
  ).length;

  return (
    <section
      className={`overflow-hidden rounded-lg border bg-[var(--surface-1)]/50 ${SEVERITY_TONE[check.severity].border}`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${expanded ? "rotate-90" : ""}`}
            aria-hidden
          >
            <path d="m7 5 5 5-5 5V5z" />
          </svg>
          <SeverityBadge severity={check.severity} />
          <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
            <h3 className="truncate text-sm font-medium text-slate-200">
              {check.name}
            </h3>
            {check.name === "Dimension-Level Jump Detection" && (
              <p className="mt-0.5 text-[10px] leading-4 text-slate-500 sm:mt-0">
                Condition: ≥2 dimensions &gt;
                {dimensionJumpThresholds.dimensionZThreshold}σ or 1 dimension
                &gt;{dimensionJumpThresholds.extremeSingleDimensionZ}σ
              </p>
            )}
          </div>
          <span className="ml-auto shrink-0 text-[11px] tabular text-slate-500">
            {issueCount > 0
              ? `${issueCount} issue${issueCount === 1 ? "" : "s"}`
              : "clean"}
          </span>
        </button>
        {episodeIds.length > 0 && (
          <button
            type="button"
            onClick={() => addMany(episodeIds)}
            title={`Flag episodes ${episodeIds.join(", ")}`}
            className="shrink-0 rounded-md border border-orange-400/25 bg-orange-400/10 px-2 py-1 text-[10px] font-medium text-orange-300 transition-colors hover:border-orange-400/50 hover:bg-orange-400/15"
          >
            Flag {episodeIds.length}
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-white/5 px-4 py-3">
          {check.messages.length === 0 ? (
            <p className="text-xs text-slate-500">No detail messages.</p>
          ) : (
            check.messages.map((message, index) => (
              <div
                key={`${message.severity}-${index}-${message.message}`}
                className="flex items-start gap-2.5 text-xs leading-5"
              >
                <span
                  className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_TONE[message.severity].dot}`}
                />
                <p className="min-w-0 whitespace-pre-wrap break-words text-slate-300">
                  {message.message}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

interface DoctorPanelProps {
  encodedPath: string | null;
  datasetName: string;
}

export default function DoctorPanel({
  encodedPath,
  datasetName,
}: DoctorPanelProps) {
  const { addMany } = useFlaggedEpisodes();
  const cached = encodedPath ? doctorRunCache.get(encodedPath) : undefined;
  const [scopeOption, setScopeOption] = useState<DoctorScopeOption>(
    scopeOptionFor(
      cached ? cached.maxEpisodes : DEFAULT_MAX_EPISODES,
      cached?.episodeRange ?? null,
    ),
  );
  const [customStart, setCustomStart] = useState(
    String(cached?.episodeRange?.start ?? DEFAULT_CUSTOM_RANGE.start),
  );
  const [customEnd, setCustomEnd] = useState(
    String(cached?.episodeRange?.end ?? DEFAULT_CUSTOM_RANGE.end),
  );
  const [dimensionZThreshold, setDimensionZThreshold] = useState(
    String(
      cached?.dimensionJumpThresholds?.dimensionZThreshold ??
        DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.dimensionZThreshold,
    ),
  );
  const [extremeSingleDimensionZ, setExtremeSingleDimensionZ] = useState(
    String(
      cached?.dimensionJumpThresholds?.extremeSingleDimensionZ ??
        DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.extremeSingleDimensionZ,
    ),
  );
  const [result, setResult] = useState<DoctorRunResponse | null>(
    cached?.result ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DoctorProgress>(INITIAL_PROGRESS);
  const [severityFilter, setSeverityFilter] = useState<"ALL" | DoctorSeverity>(
    "ALL",
  );
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedAffectedIds, setCopiedAffectedIds] = useState(false);
  const [copiedDoctorDetails, setCopiedDoctorDetails] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (
      scope: DoctorScope,
      dimensionJumpThresholds: DoctorDimensionJumpThresholds,
      refresh = false,
    ) => {
      if (!encodedPath) {
        setError("Doctor is available for local datasets only.");
        return;
      }
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setRunning(true);
      setProgress(INITIAL_PROGRESS);
      setError(null);
      try {
        const next = await runDatasetDoctor(encodedPath, {
          maxEpisodes: scope.maxEpisodes,
          episodeRange: scope.episodeRange,
          dimensionJumpThresholds,
          signal: controller.signal,
          refresh,
          onProgress: (nextProgress) => {
            if (!controller.signal.aborted) setProgress(nextProgress);
          },
        });
        if (controller.signal.aborted) return;
        setResult(next);
        doctorRunCache.set(encodedPath, {
          ...scope,
          dimensionJumpThresholds,
          result: next,
        });
        setExpanded(
          new Set(
            next.report.checks
              .filter((check) => check.severity !== "PASS")
              .map((check) => check.name),
          ),
        );
      } catch (runError) {
        if (isAbortError(runError)) return;
        setError(
          runError instanceof Error ? runError.message : String(runError),
        );
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setRunning(false);
        }
      }
    },
    [encodedPath],
  );

  useEffect(() => {
    const previous = encodedPath ? doctorRunCache.get(encodedPath) : undefined;
    if (previous) {
      setScopeOption(
        scopeOptionFor(previous.maxEpisodes, previous.episodeRange),
      );
      if (previous.episodeRange) {
        setCustomStart(String(previous.episodeRange.start));
        setCustomEnd(String(previous.episodeRange.end));
      }
      setDimensionZThreshold(
        String(
          previous.dimensionJumpThresholds?.dimensionZThreshold ??
            DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.dimensionZThreshold,
        ),
      );
      setExtremeSingleDimensionZ(
        String(
          previous.dimensionJumpThresholds?.extremeSingleDimensionZ ??
            DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.extremeSingleDimensionZ,
        ),
      );
      setResult(previous.result);
      setError(null);
      setExpanded(
        new Set(
          previous.result.report.checks
            .filter((check) => check.severity !== "PASS")
            .map((check) => check.name),
        ),
      );
    } else {
      setScopeOption(scopeOptionFor(DEFAULT_MAX_EPISODES, null));
      setCustomStart(String(DEFAULT_CUSTOM_RANGE.start));
      setCustomEnd(String(DEFAULT_CUSTOM_RANGE.end));
      setDimensionZThreshold(
        String(DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.dimensionZThreshold),
      );
      setExtremeSingleDimensionZ(
        String(
          DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS.extremeSingleDimensionZ,
        ),
      );
      setResult(null);
      setError(null);
      setProgress(INITIAL_PROGRESS);
      setExpanded(new Set());
    }
    return () => controllerRef.current?.abort();
  }, [encodedPath]);

  const report = result?.report ?? null;
  const parsedCustomStart = Number(customStart);
  const parsedCustomEnd = Number(customEnd);
  const customRangeValid =
    /^\d+$/.test(customStart) &&
    /^\d+$/.test(customEnd) &&
    Number.isSafeInteger(parsedCustomStart) &&
    Number.isSafeInteger(parsedCustomEnd) &&
    parsedCustomEnd >= parsedCustomStart;
  const parsedDimensionZThreshold = Number(dimensionZThreshold);
  const parsedExtremeSingleDimensionZ = Number(extremeSingleDimensionZ);
  const dimensionJumpThresholdsValid =
    dimensionZThreshold.trim() !== "" &&
    extremeSingleDimensionZ.trim() !== "" &&
    Number.isFinite(parsedDimensionZThreshold) &&
    Number.isFinite(parsedExtremeSingleDimensionZ) &&
    parsedDimensionZThreshold > 0 &&
    parsedExtremeSingleDimensionZ > 0 &&
    parsedDimensionZThreshold <= MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD &&
    parsedExtremeSingleDimensionZ <= MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD;
  const selectedDimensionJumpThresholds: DoctorDimensionJumpThresholds = {
    dimensionZThreshold: parsedDimensionZThreshold,
    extremeSingleDimensionZ: parsedExtremeSingleDimensionZ,
  };
  const selectedScope: DoctorScope = {
    maxEpisodes:
      scopeOption === "all" || scopeOption === "custom"
        ? null
        : Number(scopeOption),
    episodeRange:
      scopeOption === "custom" && customRangeValid
        ? { start: parsedCustomStart, end: parsedCustomEnd }
        : null,
  };
  const affectedEpisodeIds = useMemo(
    () => (report ? extractAffectedDoctorEpisodeIds(report) : []),
    [report],
  );
  const activeDimensionJumpThresholds =
    result?.execution.dimension_jump_thresholds ??
    DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS;
  const doctorScopeLabel = useMemo(() => {
    const execution = result?.execution;
    if (!execution) return "—";
    if (execution.requested_episode_range) {
      return `episodes ${execution.requested_episode_range.start}-${execution.requested_episode_range.end}`;
    }
    if (execution.requested_max_episodes === null) return "full dataset";
    return `first ${execution.requested_max_episodes} episodes`;
  }, [result?.execution]);
  const doctorDetailsCopyText = useMemo(() => {
    if (!report) return "";
    const name = datasetName.trim() || report.dataset_name || "Unknown dataset";
    const { dimensionZThreshold, extremeSingleDimensionZ } =
      activeDimensionJumpThresholds;
    const summary = (["PASS", "WARN", "FAIL"] as const)
      .map((severity) => `${severity} ${report.summary[severity] ?? 0}`)
      .join(" · ");
    const checks = report.checks
      .map((check) => {
        const messages =
          check.messages.length > 0
            ? check.messages
                .map((message) => `  [${message.severity}] ${message.message}`)
                .join("\n")
            : "  (no messages)";
        return `[${check.severity}] ${check.name}\n${messages}`;
      })
      .join("\n\n");
    return [
      `Dataset: ${name}`,
      `Dataset path: ${report.dataset_path}`,
      `Doctor scope: ${doctorScopeLabel}`,
      `Overall severity: ${report.overall_severity}`,
      `Summary: ${summary}`,
      `Flagged episodes (${affectedEpisodeIds.length}): ${affectedEpisodeIds.join(", ")}`,
      `Loaded episodes: ${result?.execution.loaded_episode_count ?? "—"}`,
      `Duration: ${result ? formatDuration(result.execution.duration_ms) : "—"}`,
      "Doctor parameters:",
      `  Coordinated z: ${dimensionZThreshold}σ`,
      `  Single-dimension z: ${extremeSingleDimensionZ}σ`,
      `  Trigger: ≥2 dimensions >${dimensionZThreshold}σ or 1 dimension >${extremeSingleDimensionZ}σ`,
      "  Report related dimensions: >8σ",
      "  Display limit: 5 events per episode and signal",
      "",
      "Checks:",
      checks,
    ].join("\n");
  }, [
    activeDimensionJumpThresholds,
    affectedEpisodeIds,
    datasetName,
    doctorScopeLabel,
    report,
    result,
  ]);
  const copyAffectedEpisodeIds = useCallback(async () => {
    if (affectedEpisodeIds.length === 0) return;
    const copied = await copyTextToClipboard(affectedEpisodeIds.join(", "));
    if (copied) {
      setCopiedAffectedIds(true);
      window.setTimeout(() => setCopiedAffectedIds(false), 1500);
    } else {
      setCopiedAffectedIds(false);
    }
  }, [affectedEpisodeIds]);
  const copyDoctorDetails = useCallback(async () => {
    if (!doctorDetailsCopyText) return;
    const copied = await copyTextToClipboard(doctorDetailsCopyText);
    if (copied) {
      setCopiedDoctorDetails(true);
      window.setTimeout(() => setCopiedDoctorDetails(false), 1500);
    } else {
      setCopiedDoctorDetails(false);
    }
  }, [doctorDetailsCopyText]);
  const visibleChecks = useMemo(() => {
    if (!report) return [];
    const normalizedQuery = query.trim().toLowerCase();
    return report.checks.filter((check) => {
      if (severityFilter !== "ALL" && check.severity !== severityFilter) {
        return false;
      }
      if (!normalizedQuery) return true;
      return (
        check.name.toLowerCase().includes(normalizedQuery) ||
        check.messages.some((message) =>
          message.message.toLowerCase().includes(normalizedQuery),
        )
      );
    });
  }, [query, report, severityFilter]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-bold text-slate-100">Doctor</h2>
            <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500">
              read-only
            </span>
            {report && <SeverityBadge severity={report.overall_severity} />}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Native TypeScript dataset quality diagnostics. Checks metadata,
            timing, actions, videos, statistics, episode consistency, training
            readiness, anomalies, dimension-level jumps, and portability without
            a Python runtime.
          </p>
          <p
            className="mt-1 truncate text-xs text-slate-500"
            title={datasetName}
          >
            {datasetName}
          </p>
        </div>

        <div className="flex basis-full flex-wrap items-center justify-end gap-2">
          {scopeOption === "custom" && (
            <div className="flex items-center gap-1.5">
              <label className="sr-only" htmlFor="doctor-range-start">
                Start episode index
              </label>
              <input
                id="doctor-range-start"
                type="number"
                min={0}
                step={1}
                value={customStart}
                disabled={running}
                onChange={(event) => setCustomStart(event.target.value)}
                aria-invalid={!customRangeValid}
                className="w-20 rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-2 text-xs tabular text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50"
                placeholder="Start"
              />
              <span className="text-xs text-slate-500">to</span>
              <label className="sr-only" htmlFor="doctor-range-end">
                End episode index
              </label>
              <input
                id="doctor-range-end"
                type="number"
                min={0}
                step={1}
                value={customEnd}
                disabled={running}
                onChange={(event) => setCustomEnd(event.target.value)}
                aria-invalid={!customRangeValid}
                className="w-20 rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-2 text-xs tabular text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50"
                placeholder="End"
              />
            </div>
          )}
          <label className="sr-only" htmlFor="doctor-scope">
            Diagnostic scope
          </label>
          <select
            id="doctor-scope"
            value={scopeOption}
            disabled={running}
            onChange={(event) =>
              setScopeOption(event.target.value as DoctorScopeOption)
            }
            className="rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-xs text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50"
          >
            {SAMPLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {report && (
            <button
              type="button"
              onClick={() => downloadReport(report)}
              className="rounded-md border border-white/10 px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:border-white/20 hover:text-slate-200"
            >
              Download JSON
            </button>
          )}
          <button
            type="button"
            disabled={
              running ||
              !encodedPath ||
              !dimensionJumpThresholdsValid ||
              (scopeOption === "custom" && !customRangeValid)
            }
            onClick={() =>
              void run(selectedScope, selectedDimensionJumpThresholds, true)
            }
            className="inline-flex min-w-28 items-center justify-center gap-2 rounded-md bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running && <Spinner />}
            {running ? "Diagnosing…" : result ? "Run again" : "Run Doctor"}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-[var(--surface-1)]/45 px-4 py-3">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(22rem,auto)] md:items-center">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-300">
              Dimension-Level Jump Detection
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Triggers when at least 2 dimensions exceed the coordinated
              threshold, or 1 dimension exceeds the single-dimension threshold;
              reports triggered dimensions above 8σ.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1 text-[11px] text-slate-400">
              <span>Coordinated z</span>
              <input
                type="number"
                min="0.1"
                max={MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD}
                step="0.1"
                value={dimensionZThreshold}
                disabled={running}
                onChange={(event) => setDimensionZThreshold(event.target.value)}
                aria-invalid={!dimensionJumpThresholdsValid}
                className="w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-xs tabular text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50 sm:w-24"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[11px] text-slate-400">
              <span>Single-dimension z</span>
              <input
                type="number"
                min="0.1"
                max={MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD}
                step="0.1"
                value={extremeSingleDimensionZ}
                disabled={running}
                onChange={(event) =>
                  setExtremeSingleDimensionZ(event.target.value)
                }
                aria-invalid={!dimensionJumpThresholdsValid}
                className="w-full rounded-md border border-white/10 bg-[var(--surface-1)] px-2 py-1.5 text-xs tabular text-slate-300 outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50 sm:w-24"
              />
            </label>
            <p className="text-[11px] tabular text-cyan-300/80 sm:col-span-2">
              ≥2 dims &gt;{dimensionZThreshold || "?"}σ or 1 dim &gt;
              {extremeSingleDimensionZ || "?"}σ
            </p>
          </div>
        </div>
      </div>

      {scopeOption === "custom" && !customRangeValid && !running && (
        <div
          className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs text-red-200/80"
          role="alert"
        >
          Enter non-negative episode indices with the end greater than or equal
          to the start. Both endpoints are included.
        </div>
      )}

      {!dimensionJumpThresholdsValid && !running && (
        <div
          className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs text-red-200/80"
          role="alert"
        >
          Enter dimension-jump z-score thresholds greater than 0 and no more
          than {MAX_DOCTOR_DIMENSION_JUMP_Z_THRESHOLD}.
        </div>
      )}

      {scopeOption === "all" && !running && (
        <div className="rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/80">
          Full-dataset checks load every episode parquet and can use substantial
          time and memory on large datasets.
        </div>
      )}

      {running && (
        <div
          className={`panel flex items-center justify-center gap-4 px-6 ${
            report ? "min-h-28" : "min-h-52"
          }`}
        >
          <Spinner />
          <ProgressBar progress={progress} />
        </div>
      )}

      {!running && !report && !error && (
        <div className="panel flex min-h-52 items-center justify-center px-6 text-center">
          <div>
            <p className="text-sm font-medium text-slate-300">
              Ready to diagnose
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Choose an episode range, then click Run Doctor.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div
          className="rounded-lg border border-red-400/30 bg-red-400/5 p-4"
          role="alert"
        >
          <p className="text-sm font-medium text-red-300">
            Doctor could not complete the diagnosis
          </p>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-red-200/75">
            {error}
          </p>
        </div>
      )}

      {report && result && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="col-span-2 rounded-lg border border-white/10 bg-[var(--surface-1)]/55 p-4 sm:col-span-3 lg:col-span-3">
              <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    Episodes
                  </p>
                  <p className="mt-1 text-sm font-medium tabular text-slate-200">
                    {formatInteger(report.total_episodes)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    Frames
                  </p>
                  <p className="mt-1 text-sm font-medium tabular text-slate-200">
                    {formatInteger(report.total_frames)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    FPS
                  </p>
                  <p className="mt-1 text-sm font-medium tabular text-slate-200">
                    {formatInteger(report.fps)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    Version
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-200">
                    {report.codebase_version ?? report.format_version ?? "—"}
                  </p>
                </div>
              </div>
              <p className="mt-3 border-t border-white/5 pt-3 text-[11px] text-slate-500">
                Loaded {result.execution.loaded_episode_count.toLocaleString()}{" "}
                episode
                {result.execution.loaded_episode_count === 1 ? "" : "s"} for
                data-backed checks ·{" "}
                {formatDuration(result.execution.duration_ms)} · TypeScript
                engine v{report.version}
                {result.execution.cache_hit ? " · cached" : ""}
              </p>
            </div>
            {(["PASS", "WARN", "FAIL"] as const).map((severity) => (
              <SummaryCard
                key={severity}
                severity={severity}
                count={report.summary[severity] ?? 0}
                active={severityFilter === severity}
                onClick={() =>
                  setSeverityFilter((current) =>
                    current === severity ? "ALL" : severity,
                  )
                }
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-56 flex-1">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
              >
                <path
                  fillRule="evenodd"
                  d="M9 3a6 6 0 1 0 3.8 10.64l3.78 3.78 1.42-1.42-3.78-3.78A6 6 0 0 0 9 3Zm-4 6a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
                  clipRule="evenodd"
                />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search checks and messages…"
                className="w-full rounded-md border border-white/10 bg-[var(--surface-1)]/60 py-2 pl-9 pr-3 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-cyan-400/50"
              />
            </div>
            {severityFilter !== "ALL" && (
              <button
                type="button"
                onClick={() => setSeverityFilter("ALL")}
                className="text-xs text-slate-500 transition-colors hover:text-slate-300"
              >
                Clear {severityFilter} filter
              </button>
            )}
            {report && (
              <>
                {affectedEpisodeIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => addMany(affectedEpisodeIds)}
                    title={`Flag episodes ${affectedEpisodeIds.join(", ")}`}
                    className="rounded-md border border-orange-400/25 bg-orange-400/10 px-3 py-2 text-xs font-medium text-orange-300 transition-colors hover:border-orange-400/50 hover:bg-orange-400/15"
                  >
                    Flag all affected ({affectedEpisodeIds.length})
                  </button>
                )}
                {affectedEpisodeIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void copyAffectedEpisodeIds()}
                    title="Copy affected episode IDs"
                    aria-label="Copy affected episode IDs"
                    className="inline-flex items-center gap-1.5 rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-300 transition-colors hover:border-cyan-400/50 hover:bg-cyan-400/15"
                  >
                    {copiedAffectedIds ? (
                      <>
                        <svg
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className="h-3.5 w-3.5"
                          aria-hidden
                        >
                          <path d="m7.5 13.5-3-3L3 12l4.5 4.5L17 7l-1.5-1.5z" />
                        </svg>
                        Copied IDs
                      </>
                    ) : (
                      <>
                        <svg
                          viewBox="0 0 20 20"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="h-3.5 w-3.5"
                          aria-hidden
                        >
                          <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
                          <path d="M13.5 6.5V5A1.5 1.5 0 0 0 12 3.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5" />
                        </svg>
                        Copy IDs
                      </>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  disabled={!doctorDetailsCopyText}
                  onClick={() => void copyDoctorDetails()}
                  title="Copy dataset, affected episodes, and Doctor parameters"
                  aria-label="Copy dataset, affected episodes, and Doctor parameters"
                  className="inline-flex items-center gap-1.5 rounded-md border border-violet-400/25 bg-violet-400/10 px-3 py-2 text-xs font-medium text-violet-300 transition-colors hover:border-violet-400/50 hover:bg-violet-400/15"
                >
                  {copiedDoctorDetails ? "Copied details" : "Copy details"}
                </button>
              </>
            )}
          </div>

          <div className="space-y-2">
            {visibleChecks.map((check) => (
              <CheckCard
                key={check.name}
                check={check}
                dimensionJumpThresholds={
                  result.execution.dimension_jump_thresholds ??
                  DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS
                }
                expanded={expanded.has(check.name)}
                onToggle={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(check.name)) next.delete(check.name);
                    else next.add(check.name);
                    return next;
                  })
                }
              />
            ))}
            {visibleChecks.length === 0 && (
              <div className="rounded-lg border border-white/10 p-8 text-center text-sm text-slate-500">
                No checks match this filter.
              </div>
            )}
          </div>

          <p className="text-[11px] leading-5 text-slate-600">
            Sample limits apply to parquet-backed checks. Dataset metadata and
            file-layout checks may still inspect the complete directory. Doctor
            does not modify dataset files.
          </p>
        </>
      )}
    </div>
  );
}
