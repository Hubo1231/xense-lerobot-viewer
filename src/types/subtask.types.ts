/**
 * Pi-style subtask segmentation.
 *
 * Mirrors the `meta/annotations.json` JSONL shape some datasets already ship
 * (one record per episode):
 *
 *     {
 *       "episode_index": 0,
 *       "high_level_instruction": "Assemble the packaging …",
 *       "instruction_segments": [
 *         { "segment_id": 0, "skill": "Pick", "instruction": "Pick up …",
 *           "paraphrases": ["Grasp …"], "start_frame_index": 0,
 *           "success_frame_index": 1007, "end_frame_index": 1185 }, …
 *       ],
 *       "key_frames": { … }        // vendor tracks — preserved verbatim
 *     }
 *
 * Segments are **contiguous** in frame-index space: the `end_frame_index` of one
 * segment equals the `start_frame_index` of the next, so at any frame exactly one
 * segment is active — "persist until the next subtask" (see `activeSegmentAt`).
 * This is the authoring source of truth; `scripts/export_subtasks.py` compiles it
 * into lerobot-native per-frame `subtask_index` + `meta/subtasks.parquet`.
 *
 * All helpers here are pure and unit-tested (`__tests__/subtask.types.test.ts`).
 */

export interface SubtaskSegment {
  segment_id: number;
  skill: string;
  instruction: string;
  paraphrases: string[];
  start_frame_index: number;
  /** Frame where the subtask is considered achieved; null when unmarked. */
  success_frame_index: number | null;
  end_frame_index: number;
}

export interface EpisodeSubtaskAnnotation {
  episode_index: number;
  high_level_instruction: string;
  instruction_segments: SubtaskSegment[];
  /**
   * Anything else present in the on-disk record (e.g. vendor `key_frames`
   * bbox / task-frame tracks). Preserved verbatim on read-modify-write so we
   * never clobber annotations produced by another pipeline.
   */
  key_frames?: unknown;
  [extra: string]: unknown;
}

// --- coercion -------------------------------------------------------------

function toInt(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Math.trunc(Number(v));
  }
  return fallback;
}

function toStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function toStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Coerce an unknown value into a `SubtaskSegment` (before normalization). */
export function coerceSegment(raw: unknown): SubtaskSegment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const instruction = toStr(r.instruction).trim();
  if (!instruction) return null;
  const start = Math.max(0, toInt(r.start_frame_index, 0));
  const end = Math.max(start, toInt(r.end_frame_index, start));
  const successRaw = r.success_frame_index;
  const success =
    successRaw === null || successRaw === undefined
      ? null
      : Math.max(0, toInt(successRaw, 0));
  return {
    segment_id: toInt(r.segment_id, 0),
    skill: toStr(r.skill).trim(),
    instruction,
    paraphrases: toStrArray(r.paraphrases),
    start_frame_index: start,
    success_frame_index: success,
    end_frame_index: end,
  };
}

// --- normalization --------------------------------------------------------

/**
 * Sort by start frame, drop empties, make ends contiguous (each segment ends
 * where the next begins; the last ends at `lastFrame`), renumber `segment_id`,
 * and clamp/void `success_frame_index` to the recomputed `[start, end]` range.
 * The earliest segment is pinned to frame 0 for full episode coverage (no
 * unlabeled head).
 *
 * On colliding start frames the later entry wins (so a freshly inserted subtask
 * replaces an existing boundary at the same frame).
 */
export function normalizeSegments(
  segments: SubtaskSegment[],
  lastFrame: number,
): SubtaskSegment[] {
  const cap = Math.max(0, Math.trunc(lastFrame));
  // Stable sort by start; dedupe equal starts keeping the last occurrence.
  const sorted = segments
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      a.s.start_frame_index !== b.s.start_frame_index
        ? a.s.start_frame_index - b.s.start_frame_index
        : a.i - b.i,
    )
    .map(({ s }) => s);

  const deduped: SubtaskSegment[] = [];
  for (const seg of sorted) {
    const start = Math.min(cap, Math.max(0, Math.trunc(seg.start_frame_index)));
    const prev = deduped[deduped.length - 1];
    if (prev && prev.start_frame_index === start) {
      deduped[deduped.length - 1] = { ...seg, start_frame_index: start };
    } else {
      deduped.push({ ...seg, start_frame_index: start });
    }
  }

  // Full coverage: the earliest subtask is pinned to frame 0, so there is never
  // an unlabeled head — the first subtask persists from the very start of the
  // episode until the next one.
  if (deduped.length > 0) {
    deduped[0] = { ...deduped[0], start_frame_index: 0 };
  }

  return deduped.map((seg, idx) => {
    const start = seg.start_frame_index;
    const end =
      idx + 1 < deduped.length ? deduped[idx + 1].start_frame_index : cap;
    const endClamped = Math.max(start, end);
    const success =
      seg.success_frame_index != null &&
      seg.success_frame_index >= start &&
      seg.success_frame_index <= endClamped
        ? seg.success_frame_index
        : null;
    return {
      ...seg,
      segment_id: idx,
      start_frame_index: start,
      end_frame_index: endClamped,
      success_frame_index: success,
    };
  });
}

// --- queries --------------------------------------------------------------

/**
 * Index of the segment active at `frameIndex` (the last one whose start is
 * ≤ frameIndex) — "persist until the next subtask". Returns -1 when the frame
 * precedes the first segment (unlabeled head) or there are no segments.
 * Assumes `segments` is normalized (sorted by start).
 */
export function activeSegmentIndexAt(
  segments: SubtaskSegment[],
  frameIndex: number,
): number {
  let idx = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].start_frame_index > frameIndex) break;
    idx = i;
  }
  return idx;
}

export function activeSegmentAt(
  segments: SubtaskSegment[],
  frameIndex: number,
): SubtaskSegment | null {
  const i = activeSegmentIndexAt(segments, frameIndex);
  return i >= 0 ? segments[i] : null;
}

// --- mutations (all return a new, normalized list) ------------------------

export interface NewSubtaskInput {
  startFrame: number;
  instruction: string;
  skill?: string;
  paraphrases?: string[];
}

/**
 * Start a new subtask at `startFrame`. If a segment already starts on that exact
 * frame its text is replaced; otherwise a new boundary is inserted. Contiguity is
 * recomputed so the previous segment now ends at `startFrame` and the new one runs
 * until the next boundary (or `lastFrame`).
 */
export function insertSubtaskAt(
  segments: SubtaskSegment[],
  input: NewSubtaskInput,
  lastFrame: number,
): SubtaskSegment[] {
  const start = Math.min(
    Math.max(0, Math.trunc(input.startFrame)),
    Math.max(0, Math.trunc(lastFrame)),
  );
  const instruction = input.instruction.trim();
  if (!instruction) return normalizeSegments(segments, lastFrame);

  const others = segments.filter((s) => s.start_frame_index !== start);
  const newSeg: SubtaskSegment = {
    segment_id: 0,
    skill: (input.skill ?? "").trim(),
    instruction,
    paraphrases: input.paraphrases ?? [],
    start_frame_index: start,
    success_frame_index: null,
    end_frame_index: start,
  };
  return normalizeSegments([...others, newSeg], lastFrame);
}

/** Patch a segment's text fields (not its boundaries) by `segment_id`. */
export function updateSegment(
  segments: SubtaskSegment[],
  segmentId: number,
  patch: Partial<
    Pick<
      SubtaskSegment,
      "instruction" | "skill" | "paraphrases" | "success_frame_index"
    >
  >,
  lastFrame: number,
): SubtaskSegment[] {
  const next = segments.map((s) =>
    s.segment_id === segmentId ? { ...s, ...patch } : s,
  );
  return normalizeSegments(next, lastFrame);
}

/** Move a segment's start boundary; clamped strictly between its neighbours. */
export function retimeSegmentStart(
  segments: SubtaskSegment[],
  segmentId: number,
  newStart: number,
  lastFrame: number,
): SubtaskSegment[] {
  const norm = normalizeSegments(segments, lastFrame);
  const idx = norm.findIndex((s) => s.segment_id === segmentId);
  if (idx <= 0) return norm; // segment 0 is pinned to its own start; no-op
  const lower = norm[idx - 1].start_frame_index + 1;
  const upper =
    idx + 1 < norm.length
      ? norm[idx + 1].start_frame_index - 1
      : Math.max(0, Math.trunc(lastFrame));
  const clamped = Math.min(Math.max(newStart, lower), Math.max(lower, upper));
  norm[idx] = { ...norm[idx], start_frame_index: clamped };
  return normalizeSegments(norm, lastFrame);
}

/** Delete a segment; the gap closes because ends recompute from the next start. */
export function removeSegment(
  segments: SubtaskSegment[],
  segmentId: number,
  lastFrame: number,
): SubtaskSegment[] {
  return normalizeSegments(
    segments.filter((s) => s.segment_id !== segmentId),
    lastFrame,
  );
}

// --- frame <-> time -------------------------------------------------------

/** Nearest frame index for a timestamp, using per-frame timestamps when known. */
export function nearestFrameIndex(
  frameTimestamps: number[],
  t: number,
): number {
  if (!frameTimestamps.length) return Math.max(0, Math.round(t));
  let best = 0;
  let dist = Math.abs(t - frameTimestamps[0]);
  for (let i = 1; i < frameTimestamps.length; i++) {
    const d = Math.abs(t - frameTimestamps[i]);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

/** Seconds → frame index. Prefers `frameTimestamps`; falls back to fps. */
export function timeToFrame(
  t: number,
  fps: number,
  frameTimestamps?: number[],
): number {
  if (frameTimestamps && frameTimestamps.length) {
    return nearestFrameIndex(frameTimestamps, t);
  }
  return Math.max(0, Math.round(t * (fps || 1)));
}

/** Frame index → seconds. Prefers `frameTimestamps`; falls back to fps. */
export function frameToTime(
  f: number,
  fps: number,
  frameTimestamps?: number[],
): number {
  if (frameTimestamps && f >= 0 && f < frameTimestamps.length) {
    return frameTimestamps[f];
  }
  return f / (fps || 1);
}

// --- whole-record helpers -------------------------------------------------

export function emptyAnnotation(
  episodeIndex: number,
  highLevelInstruction = "",
): EpisodeSubtaskAnnotation {
  return {
    episode_index: episodeIndex,
    high_level_instruction: highLevelInstruction,
    instruction_segments: [],
  };
}

/**
 * Coerce an unknown record (a parsed JSONL line or a PUT body) into a valid
 * `EpisodeSubtaskAnnotation`, preserving any extra keys (`key_frames`, …).
 */
export function normalizeAnnotation(
  raw: unknown,
  fallbackEpisodeIndex: number,
  lastFrame = Number.MAX_SAFE_INTEGER,
): EpisodeSubtaskAnnotation {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const segments = Array.isArray(r.instruction_segments)
    ? (r.instruction_segments
        .map(coerceSegment)
        .filter(Boolean) as SubtaskSegment[])
    : [];
  return {
    ...r,
    episode_index: toInt(r.episode_index, fallbackEpisodeIndex),
    high_level_instruction: toStr(r.high_level_instruction),
    instruction_segments: normalizeSegments(segments, lastFrame),
  };
}
