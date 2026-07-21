import { describe, expect, test } from "bun:test";
import {
  activeSegmentAt,
  activeSegmentIndexAt,
  coerceSegment,
  frameToTime,
  insertSubtaskAt,
  nearestFrameIndex,
  normalizeAnnotation,
  normalizeSegments,
  removeSegment,
  retimeSegmentStart,
  timeToFrame,
  updateSegment,
  type SubtaskSegment,
} from "@/types/subtask.types";

function seg(partial: Partial<SubtaskSegment>): SubtaskSegment {
  return {
    segment_id: 0,
    skill: "",
    instruction: "x",
    paraphrases: [],
    start_frame_index: 0,
    success_frame_index: null,
    end_frame_index: 0,
    ...partial,
  };
}

describe("normalizeSegments", () => {
  test("makes ends contiguous, renumbers ids, sorts by start", () => {
    const out = normalizeSegments(
      [
        seg({ instruction: "b", start_frame_index: 100 }),
        seg({ instruction: "a", start_frame_index: 0 }),
        seg({ instruction: "c", start_frame_index: 250 }),
      ],
      400,
    );
    expect(out.map((s) => s.instruction)).toEqual(["a", "b", "c"]);
    expect(out.map((s) => s.segment_id)).toEqual([0, 1, 2]);
    expect(out.map((s) => [s.start_frame_index, s.end_frame_index])).toEqual([
      [0, 100],
      [100, 250],
      [250, 400],
    ]);
  });

  test("colliding start frames keep the last entry", () => {
    const out = normalizeSegments(
      [
        seg({ instruction: "old", start_frame_index: 50 }),
        seg({ instruction: "new", start_frame_index: 50 }),
      ],
      200,
    );
    expect(out).toHaveLength(1);
    expect(out[0].instruction).toBe("new");
    expect(out[0].end_frame_index).toBe(200);
  });

  test("voids success frame outside the recomputed range", () => {
    const out = normalizeSegments(
      [
        seg({ start_frame_index: 0, success_frame_index: 500 }),
        seg({ start_frame_index: 100 }),
      ],
      300,
    );
    // segment 0 is [0,100]; success 500 is out of range -> null
    expect(out[0].success_frame_index).toBeNull();
  });

  test("keeps a success frame inside the range", () => {
    const out = normalizeSegments(
      [seg({ start_frame_index: 0, success_frame_index: 80 })],
      300,
    );
    expect(out[0].success_frame_index).toBe(80);
  });

  test("pins the earliest segment to frame 0 (full coverage)", () => {
    const out = normalizeSegments(
      [
        seg({ instruction: "late", start_frame_index: 50 }),
        seg({ instruction: "b", start_frame_index: 200 }),
      ],
      400,
    );
    expect(out[0].start_frame_index).toBe(0);
    expect(out[0].end_frame_index).toBe(200);
    expect(activeSegmentAt(out, 10)?.instruction).toBe("late");
  });
});

describe("activeSegmentIndexAt / activeSegmentAt", () => {
  const segs = normalizeSegments(
    [
      seg({ instruction: "a", start_frame_index: 0 }),
      seg({ instruction: "b", start_frame_index: 100 }),
      seg({ instruction: "c", start_frame_index: 250 }),
    ],
    400,
  );

  test("persists until the next subtask", () => {
    expect(activeSegmentAt(segs, 0)?.instruction).toBe("a");
    expect(activeSegmentAt(segs, 99)?.instruction).toBe("a");
    expect(activeSegmentAt(segs, 100)?.instruction).toBe("b");
    expect(activeSegmentAt(segs, 249)?.instruction).toBe("b");
    expect(activeSegmentAt(segs, 250)?.instruction).toBe("c");
    expect(activeSegmentAt(segs, 9999)?.instruction).toBe("c");
  });

  test("activeSegmentIndexAt (raw query) returns -1 before the first start / when empty", () => {
    // The pure query itself is head-aware; normalizeSegments pins the first
    // segment to 0, so in practice a normalized list has no head gap.
    const raw = [seg({ instruction: "only", start_frame_index: 50 })];
    expect(activeSegmentIndexAt(raw, 10)).toBe(-1);
    expect(activeSegmentIndexAt(raw, 50)).toBe(0);
    expect(activeSegmentIndexAt([], 0)).toBe(-1);
  });
});

describe("insertSubtaskAt", () => {
  test("truncates the previous segment and appends the new one", () => {
    let s = insertSubtaskAt([], { startFrame: 0, instruction: "a" }, 400);
    s = insertSubtaskAt(
      s,
      { startFrame: 150, instruction: "b", skill: "Pick" },
      400,
    );
    expect(s).toHaveLength(2);
    expect(s.map((x) => [x.start_frame_index, x.end_frame_index])).toEqual([
      [0, 150],
      [150, 400],
    ]);
    expect(s[1].skill).toBe("Pick");
  });

  test("replaces text when inserting on an existing boundary", () => {
    let s = insertSubtaskAt([], { startFrame: 0, instruction: "a" }, 400);
    s = insertSubtaskAt(s, { startFrame: 100, instruction: "b" }, 400);
    s = insertSubtaskAt(s, { startFrame: 100, instruction: "b-fixed" }, 400);
    expect(s).toHaveLength(2);
    expect(s[1].instruction).toBe("b-fixed");
  });

  test("ignores an empty instruction", () => {
    const s = insertSubtaskAt([], { startFrame: 0, instruction: "   " }, 400);
    expect(s).toHaveLength(0);
  });

  test("pins the first subtask to frame 0 regardless of where it is added", () => {
    const s = insertSubtaskAt([], { startFrame: 300, instruction: "a" }, 400);
    expect(s[0].start_frame_index).toBe(0);
    expect(s[0].end_frame_index).toBe(400);
  });

  test("clamps a later subtask's startFrame into [0, lastFrame]", () => {
    let s = insertSubtaskAt([], { startFrame: 0, instruction: "a" }, 400);
    s = insertSubtaskAt(s, { startFrame: 9999, instruction: "b" }, 400);
    expect(s[1].start_frame_index).toBe(400);
  });
});

describe("updateSegment / removeSegment / retimeSegmentStart", () => {
  const base = insertSubtaskAt(
    insertSubtaskAt([], { startFrame: 0, instruction: "a" }, 400),
    { startFrame: 200, instruction: "b" },
    400,
  );

  test("updateSegment patches text without moving boundaries", () => {
    const s = updateSegment(
      base,
      1,
      { instruction: "b2", skill: "Place" },
      400,
    );
    expect(s[1].instruction).toBe("b2");
    expect(s[1].skill).toBe("Place");
    expect(s[1].start_frame_index).toBe(200);
  });

  test("removeSegment closes the gap", () => {
    const s = removeSegment(base, 1, 400);
    expect(s).toHaveLength(1);
    expect(s[0].end_frame_index).toBe(400);
  });

  test("retimeSegmentStart clamps between neighbours and is a no-op for segment 0", () => {
    const s = retimeSegmentStart(base, 1, 999, 400);
    expect(s[1].start_frame_index).toBe(400); // last segment clamps to lastFrame
    const pinned = retimeSegmentStart(base, 0, 100, 400);
    expect(pinned[0].start_frame_index).toBe(0);
  });
});

describe("frame <-> time", () => {
  test("timeToFrame/frameToTime use fps when no timestamps", () => {
    expect(timeToFrame(2, 30)).toBe(60);
    expect(frameToTime(60, 30)).toBeCloseTo(2, 6);
  });

  test("nearestFrameIndex snaps to the closest timestamp", () => {
    const ts = [0, 0.033, 0.066, 0.1];
    expect(nearestFrameIndex(ts, 0.07)).toBe(2);
    expect(timeToFrame(0.099, 30, ts)).toBe(3);
    expect(frameToTime(1, 30, ts)).toBeCloseTo(0.033, 6);
  });
});

describe("coerceSegment / normalizeAnnotation", () => {
  test("coerceSegment drops entries without an instruction", () => {
    expect(coerceSegment({ start_frame_index: 5 })).toBeNull();
    const s = coerceSegment({
      instruction: "grab",
      start_frame_index: "10",
      end_frame_index: 20,
      paraphrases: ["take", 5],
    });
    expect(s?.start_frame_index).toBe(10);
    expect(s?.paraphrases).toEqual(["take"]);
  });

  test("normalizeAnnotation preserves unknown keys and normalizes segments", () => {
    const ann = normalizeAnnotation(
      {
        episode_index: 3,
        high_level_instruction: "do the thing",
        key_frames: { single: [{ frame_index: 10 }] },
        instruction_segments: [
          { instruction: "b", start_frame_index: 100 },
          { instruction: "a", start_frame_index: 0 },
        ],
      },
      3,
      300,
    );
    expect(ann.episode_index).toBe(3);
    expect(ann.instruction_segments.map((s) => s.instruction)).toEqual([
      "a",
      "b",
    ]);
    expect(ann.key_frames).toEqual({ single: [{ frame_index: 10 }] });
  });

  test("normalizeAnnotation falls back to episode index and empty segments", () => {
    const ann = normalizeAnnotation({}, 7);
    expect(ann.episode_index).toBe(7);
    expect(ann.high_level_instruction).toBe("");
    expect(ann.instruction_segments).toEqual([]);
  });
});
