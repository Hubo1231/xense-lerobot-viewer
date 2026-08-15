/**
 * Daily corpus snapshots — the basis for "new today".
 *
 * The viewer computes every number from the filesystem, so it is stateless by
 * construction and cannot tell growth from a standing total. This module is the
 * one piece of remembered state: one row per day per source, written on
 * homepage render and diffed against the previous recorded day.
 *
 * Deltas are measured against the **most recent earlier day on record**, not
 * against "yesterday". Nobody opens the page every day, and a gap should read
 * as "grown by this much since you last looked", never as a phantom zero.
 *
 * Everything here is pure; the filesystem side lives in
 * `src/lib/corpus-history-store.ts`.
 */

import { formatBytes } from "@/utils/byteSize";

export type SourceSnapshot = {
  tasks: number;
  episodes: number;
  frames: number;
  hours: number;
  /**
   * Bytes on disk. **Optional, and the absence is load-bearing**: rows written
   * before storage tracking existed have no `bytes`, and a missing baseline
   * must read as "unknown" rather than zero — otherwise the first render after
   * the upgrade would report the entire corpus as growth.
   *
   * Added without bumping `version`, deliberately: a bump makes `parseHistory`
   * discard the file, throwing away months of real history to add one column
   * that every consumer already treats as optional.
   */
  bytes?: number;
};

export type DaySnapshot = {
  capturedAt: string;
  sources: Record<string, SourceSnapshot>;
};

export type CorpusHistory = {
  version: 1;
  days: Record<string, DaySnapshot>;
};

export type SourceDelta = {
  tasks: number;
  episodes: number;
  frames: number;
  hours: number;
  /** Byte growth, or null when the baseline predates storage tracking. */
  bytes: number | null;
};

export type DailyDelta = {
  /** Day the comparison is against, or null when there is no earlier record. */
  since: string | null;
  /** Whole days between `since` and today. 1 = yesterday. */
  spanDays: number | null;
  /** Per-source growth. A source absent from the baseline counts as all-new. */
  bySource: Record<string, SourceDelta>;
  total: SourceDelta;
};

export const HISTORY_VERSION = 1;
/** Days of history retained. Past this the oldest entries are dropped so the
 *  file cannot grow without bound on a machine that runs for years. */
export const RETENTION_DAYS = 180;

export function emptyHistory(): CorpusHistory {
  return { version: HISTORY_VERSION, days: {} };
}

/**
 * Build today's row from the current scan. Takes a structural shape rather than
 * importing the stats module, so this file stays dependency-free and testable
 * on its own.
 */
export function snapshotFromSources(
  sources: readonly {
    prefix: string;
    tasks: number;
    episodes: number;
    frames: number;
    hours: number;
    bytes?: number;
  }[],
  capturedAt: string,
): DaySnapshot {
  const out: Record<string, SourceSnapshot> = {};
  for (const s of sources) {
    out[s.prefix] = {
      tasks: s.tasks,
      episodes: s.episodes,
      frames: s.frames,
      // Stored rounded: the raw float carries meaningless precision and would
      // make every same-day rewrite look like a change.
      hours: Math.round(s.hours * 1000) / 1000,
      // Written only when measured, so "absent" keeps meaning "never recorded"
      // and a caller that cannot measure size does not fabricate a zero.
      ...(Number.isFinite(s.bytes) ? { bytes: s.bytes } : {}),
    };
  }
  return { capturedAt, sources: out };
}

/** Local-time YYYY-MM-DD. Local, not UTC: "today" has to mean the operator's
 *  today, or an evening capture in UTC+8 would land on the next day. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

const ZERO: SourceDelta = {
  tasks: 0,
  episodes: 0,
  frames: 0,
  hours: 0,
  bytes: 0,
};

/**
 * Byte growth for one source, or null when it cannot be known.
 *
 * The three cases that matter:
 *   - baseline recorded bytes  → plain difference, negative if data was deleted
 *   - source absent from the baseline entirely → genuinely new, so all of it
 *     counts (this is how tasks/episodes already treat a new source)
 *   - baseline exists but has no `bytes` → **unknown**, not zero and not "all
 *     new". Reporting 49 GB of growth the day after upgrading would be a lie.
 */
function bytesDelta(
  now: SourceSnapshot | undefined,
  before: SourceSnapshot | undefined,
): number | null {
  if (!before) return now?.bytes ?? null;
  if (!Number.isFinite(before.bytes)) return null;
  return (now?.bytes ?? 0) - (before.bytes as number);
}

/**
 * Insert (or overwrite) today's row and trim anything past the retention
 * window. Same-day re-renders overwrite rather than append, so the stored row
 * is always the latest reading for that day.
 */
export function withDaySnapshot(
  history: CorpusHistory,
  key: string,
  snapshot: DaySnapshot,
  retentionDays = RETENTION_DAYS,
): CorpusHistory {
  const days: Record<string, DaySnapshot> = {
    ...history.days,
    [key]: snapshot,
  };
  const kept = Object.keys(days).sort().slice(-Math.max(1, retentionDays));
  const trimmed: Record<string, DaySnapshot> = {};
  for (const day of kept) trimmed[day] = days[day];
  return { version: HISTORY_VERSION, days: trimmed };
}

/** The latest recorded day strictly before `key`, or null. */
export function previousDay(
  history: CorpusHistory,
  key: string,
): string | null {
  const earlier = Object.keys(history.days)
    .filter((d) => d < key)
    .sort();
  return earlier.length > 0 ? earlier[earlier.length - 1] : null;
}

/**
 * Growth between the previous recorded day and `today`.
 *
 * Negative values are preserved rather than clamped: data really can be deleted
 * locally, and hiding that behind a floor of zero would make the dashboard lie
 * about what happened.
 */
export function computeDailyDelta(
  history: CorpusHistory,
  today: DaySnapshot,
  todayKey: string,
): DailyDelta {
  const since = previousDay(history, todayKey);
  if (since === null) {
    return { since: null, spanDays: null, bySource: {}, total: { ...ZERO } };
  }

  const baseline = history.days[since].sources;
  const bySource: Record<string, SourceDelta> = {};
  const total: SourceDelta = { ...ZERO };

  const names = new Set([
    ...Object.keys(today.sources),
    ...Object.keys(baseline),
  ]);
  for (const name of names) {
    const now = today.sources[name];
    const before = baseline[name];
    // A source present today but absent from the baseline is entirely new; one
    // that vanished contributes its negative so the totals stay honest.
    const delta: SourceDelta = {
      tasks: (now?.tasks ?? 0) - (before?.tasks ?? 0),
      episodes: (now?.episodes ?? 0) - (before?.episodes ?? 0),
      frames: (now?.frames ?? 0) - (before?.frames ?? 0),
      hours: (now?.hours ?? 0) - (before?.hours ?? 0),
      bytes: bytesDelta(now, before),
    };
    bySource[name] = delta;
    total.tasks += delta.tasks;
    total.episodes += delta.episodes;
    total.frames += delta.frames;
    total.hours += delta.hours;
    // One unmeasurable source poisons the total: a partial sum presented as
    // "+X GB" would read as the whole corpus's growth. Unknown beats wrong.
    if (delta.bytes === null) total.bytes = null;
    else if (total.bytes !== null) total.bytes += delta.bytes;
  }

  return { since, spanDays: daysBetween(since, todayKey), bySource, total };
}

/** True when nothing measurable changed — used to show "no change" instead of a
 *  row of zeroes dressed up as a result. */
export function isFlatDelta(delta: SourceDelta): boolean {
  return (
    delta.tasks === 0 &&
    delta.episodes === 0 &&
    delta.frames === 0 &&
    Math.abs(delta.hours) < 0.005 &&
    // An unknown byte delta is not evidence of change — the other four fields
    // decide. A known non-zero one is: a re-encode or a deleted video moves
    // bytes without moving any count.
    (delta.bytes === null || delta.bytes === 0)
  );
}

/**
 * Signed, compact rendering for a delta figure: 0 → "—", 12 → "+12".
 *
 * `fractionDigits` pins the precision for quantities that are always fractional
 * — hours, where "+7 h" and "+7.4 h" are different claims and the rounded one
 * reads as suspiciously round. Counts leave it unset and stay integers.
 */
export function formatDelta(
  value: number,
  unit = "",
  fractionDigits?: number,
): string {
  if (!Number.isFinite(value) || value === 0) return "—";
  const sign = value > 0 ? "+" : "−";
  const magnitude = Math.abs(value);
  const shown =
    fractionDigits !== undefined
      ? magnitude.toLocaleString("en-US", {
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        })
      : magnitude >= 1000
        ? magnitude.toLocaleString("en-US", { maximumFractionDigits: 0 })
        : magnitude % 1 === 0
          ? String(magnitude)
          : magnitude.toFixed(1);
  return `${sign}${shown}${unit}`;
}

/**
 * Signed storage delta: 0 → "—", null → "n/a" (baseline predates tracking).
 *
 * Kept separate from `formatDelta` because bytes need unit scaling, and because
 * "no change" and "never recorded" have to stay visibly different — collapsing
 * them would hide the one-day gap after the upgrade behind a plausible dash.
 */
export function formatDeltaBytes(value: number | null): string {
  if (value === null) return "n/a";
  if (!Number.isFinite(value) || value === 0) return "—";
  return `${value > 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`;
}

/**
 * Only `bytes` is validated, because only `bytes` carries meaning in its
 * absence: a garbage value there has to collapse back to "never recorded", or
 * the delta math turns into NaN and the UI shows "+NaN GB". The count fields
 * keep the module's existing permissive handling.
 */
function normalizeSources(raw: unknown): Record<string, SourceSnapshot> {
  const sources = raw as Record<string, SourceSnapshot>;
  const out: Record<string, SourceSnapshot> = {};
  for (const [name, snapshot] of Object.entries(sources)) {
    if (!snapshot || typeof snapshot !== "object") continue;
    if (Number.isFinite(snapshot.bytes)) {
      out[name] = snapshot;
    } else {
      const rest = { ...snapshot };
      delete rest.bytes;
      out[name] = rest;
    }
  }
  return out;
}

/** Accepts only a well-formed history document; anything else starts fresh
 *  rather than throwing, so a hand-edited or truncated file cannot break the
 *  homepage. */
export function parseHistory(raw: unknown): CorpusHistory {
  if (!raw || typeof raw !== "object") return emptyHistory();
  const candidate = raw as Partial<CorpusHistory>;
  if (candidate.version !== HISTORY_VERSION) return emptyHistory();
  if (!candidate.days || typeof candidate.days !== "object") {
    return emptyHistory();
  }
  const days: Record<string, DaySnapshot> = {};
  for (const [key, value] of Object.entries(candidate.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const day = value as Partial<DaySnapshot>;
    if (!day || typeof day !== "object") continue;
    if (!day.sources || typeof day.sources !== "object") continue;
    days[key] = {
      capturedAt: typeof day.capturedAt === "string" ? day.capturedAt : "",
      sources: normalizeSources(day.sources),
    };
  }
  return { version: HISTORY_VERSION, days };
}
