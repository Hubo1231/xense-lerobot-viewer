import { describe, expect, test } from "bun:test";
import {
  computeDailyDelta,
  dayKey,
  emptyHistory,
  formatDelta,
  formatDeltaBytes,
  isFlatDelta,
  parseHistory,
  previousDay,
  snapshotFromSources,
  withDaySnapshot,
  HISTORY_VERSION,
  type CorpusHistory,
  type DaySnapshot,
} from "@/utils/corpusHistory";

const snap = (
  sources: Record<string, Partial<Record<string, number>>>,
): DaySnapshot => ({
  capturedAt: "2026-08-14T06:00:00.000Z",
  sources: Object.fromEntries(
    Object.entries(sources).map(([k, v]) => [
      k,
      { tasks: 0, episodes: 0, frames: 0, hours: 0, ...v },
    ]),
  ) as DaySnapshot["sources"],
});

const historyWith = (days: Record<string, DaySnapshot>): CorpusHistory => ({
  version: HISTORY_VERSION,
  days,
});

describe("dayKey", () => {
  test("formats local calendar date, not UTC", () => {
    // 23:30 local on the 14th must stay the 14th even where UTC has rolled over.
    const d = new Date(2026, 7, 14, 23, 30, 0);
    expect(dayKey(d)).toBe("2026-08-14");
  });

  test("zero-pads month and day", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("snapshotFromSources", () => {
  test("keys sources by prefix and carries every metric", () => {
    const s = snapshotFromSources(
      [{ prefix: "A", tasks: 3, episodes: 40, frames: 1200, hours: 2.5 }],
      "2026-08-14T06:00:00.000Z",
    );
    expect(s.capturedAt).toBe("2026-08-14T06:00:00.000Z");
    expect(s.sources.A).toEqual({
      tasks: 3,
      episodes: 40,
      frames: 1200,
      hours: 2.5,
    });
  });

  test("rounds hours so a same-day rewrite is not spurious change", () => {
    const s = snapshotFromSources(
      [{ prefix: "A", tasks: 1, episodes: 1, frames: 1, hours: 254.71666666 }],
      "x",
    );
    expect(s.sources.A.hours).toBe(254.717);
  });

  test("handles an empty scan", () => {
    expect(snapshotFromSources([], "x").sources).toEqual({});
  });

  test("stores bytes when measured", () => {
    const s = snapshotFromSources(
      [
        {
          prefix: "A",
          tasks: 1,
          episodes: 1,
          frames: 1,
          hours: 1,
          bytes: 4_096,
        },
      ],
      "x",
    );
    expect(s.sources.A.bytes).toBe(4_096);
  });

  test("omits bytes entirely when unmeasured, rather than writing 0", () => {
    const s = snapshotFromSources(
      [{ prefix: "A", tasks: 1, episodes: 1, frames: 1, hours: 1 }],
      "x",
    );
    // A stored 0 would later read as "the source held nothing", which is a
    // different claim from "nobody measured it".
    expect("bytes" in s.sources.A).toBe(false);
  });
});

describe("withDaySnapshot", () => {
  test("adds a day", () => {
    const h = withDaySnapshot(emptyHistory(), "2026-08-14", snap({ A: {} }));
    expect(Object.keys(h.days)).toEqual(["2026-08-14"]);
  });

  test("overwrites the same day rather than appending", () => {
    const first = withDaySnapshot(
      emptyHistory(),
      "2026-08-14",
      snap({ A: { episodes: 1 } }),
    );
    const second = withDaySnapshot(
      first,
      "2026-08-14",
      snap({ A: { episodes: 9 } }),
    );
    expect(Object.keys(second.days)).toHaveLength(1);
    expect(second.days["2026-08-14"].sources.A.episodes).toBe(9);
  });

  test("trims to the retention window, keeping the newest days", () => {
    let h = emptyHistory();
    for (const d of ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"]) {
      h = withDaySnapshot(h, d, snap({ A: {} }), 2);
    }
    expect(Object.keys(h.days).sort()).toEqual(["2026-08-12", "2026-08-13"]);
  });

  test("never trims below one day", () => {
    const h = withDaySnapshot(emptyHistory(), "2026-08-14", snap({ A: {} }), 0);
    expect(Object.keys(h.days)).toHaveLength(1);
  });
});

describe("previousDay", () => {
  test("returns the latest strictly-earlier recorded day", () => {
    const h = historyWith({
      "2026-08-01": snap({}),
      "2026-08-09": snap({}),
      "2026-08-14": snap({}),
    });
    expect(previousDay(h, "2026-08-14")).toBe("2026-08-09");
  });

  test("returns null when nothing is earlier", () => {
    expect(
      previousDay(historyWith({ "2026-08-14": snap({}) }), "2026-08-14"),
    ).toBeNull();
  });
});

describe("computeDailyDelta", () => {
  test("returns an empty delta on the very first run", () => {
    const delta = computeDailyDelta(
      emptyHistory(),
      snap({ A: { episodes: 5 } }),
      "2026-08-14",
    );
    expect(delta.since).toBeNull();
    expect(delta.spanDays).toBeNull();
    expect(delta.total.episodes).toBe(0);
  });

  test("diffs against the previous recorded day, not literal yesterday", () => {
    // Nobody opened the page for five days; growth must span the whole gap.
    const h = historyWith({
      "2026-08-09": snap({ A: { episodes: 100, hours: 10 } }),
    });
    const delta = computeDailyDelta(
      h,
      snap({ A: { episodes: 160, hours: 16 } }),
      "2026-08-14",
    );
    expect(delta.since).toBe("2026-08-09");
    expect(delta.spanDays).toBe(5);
    expect(delta.total.episodes).toBe(60);
    expect(delta.total.hours).toBeCloseTo(6, 6);
  });

  test("counts a brand-new source as fully new", () => {
    const h = historyWith({ "2026-08-13": snap({ A: { episodes: 10 } }) });
    const delta = computeDailyDelta(
      h,
      snap({ A: { episodes: 10 }, B: { episodes: 7, tasks: 2 } }),
      "2026-08-14",
    );
    expect(delta.bySource.B.episodes).toBe(7);
    expect(delta.bySource.B.tasks).toBe(2);
    expect(delta.total.episodes).toBe(7);
  });

  test("keeps deletions negative instead of clamping to zero", () => {
    // Local data really can be removed; hiding it would make the panel lie.
    const h = historyWith({ "2026-08-13": snap({ A: { episodes: 50 } }) });
    const delta = computeDailyDelta(
      h,
      snap({ A: { episodes: 20 } }),
      "2026-08-14",
    );
    expect(delta.total.episodes).toBe(-30);
  });

  test("a source that disappeared still contributes its loss", () => {
    const h = historyWith({
      "2026-08-13": snap({ A: { episodes: 10 }, B: { episodes: 4 } }),
    });
    const delta = computeDailyDelta(
      h,
      snap({ A: { episodes: 10 } }),
      "2026-08-14",
    );
    expect(delta.bySource.B.episodes).toBe(-4);
  });

  test("ignores same-day and future rows when picking a baseline", () => {
    const h = historyWith({
      "2026-08-14": snap({ A: { episodes: 999 } }),
      "2026-08-20": snap({ A: { episodes: 5 } }),
    });
    const delta = computeDailyDelta(
      h,
      snap({ A: { episodes: 1 } }),
      "2026-08-14",
    );
    expect(delta.since).toBeNull();
  });
});

describe("isFlatDelta", () => {
  test("treats sub-rounding hour drift as flat", () => {
    expect(
      isFlatDelta({
        tasks: 0,
        episodes: 0,
        frames: 0,
        hours: 0.001,
        bytes: 0,
      }),
    ).toBe(true);
  });

  test("is not flat when anything moved", () => {
    expect(
      isFlatDelta({ tasks: 0, episodes: 1, frames: 0, hours: 0, bytes: 0 }),
    ).toBe(false);
  });

  test("an unknown byte delta alone is not a change", () => {
    expect(
      isFlatDelta({ tasks: 0, episodes: 0, frames: 0, hours: 0, bytes: null }),
    ).toBe(true);
  });

  test("bytes moving with every count unchanged still counts as a change", () => {
    // A re-encode or a deleted video shifts bytes without touching a count.
    expect(
      isFlatDelta({
        tasks: 0,
        episodes: 0,
        frames: 0,
        hours: 0,
        bytes: -4_000,
      }),
    ).toBe(false);
  });
});

describe("storage deltas", () => {
  const today = "2026-08-16";

  test("differences bytes against a baseline that recorded them", () => {
    const history = historyWith({
      "2026-08-14": snap({ A: { bytes: 1_000 } }),
    });
    const delta = computeDailyDelta(
      history,
      snap({ A: { bytes: 3_500 } }),
      today,
    );
    expect(delta.bySource.A.bytes).toBe(2_500);
    expect(delta.total.bytes).toBe(2_500);
  });

  test("preserves a negative delta when data was deleted", () => {
    const history = historyWith({
      "2026-08-14": snap({ A: { bytes: 5_000 } }),
    });
    const delta = computeDailyDelta(
      history,
      snap({ A: { bytes: 1_000 } }),
      today,
    );
    expect(delta.bySource.A.bytes).toBe(-4_000);
  });

  test("reports unknown — not the whole corpus — when the baseline predates tracking", () => {
    const history = historyWith({ "2026-08-14": snap({ A: {} }) });
    const delta = computeDailyDelta(
      history,
      snap({ A: { bytes: 52_000_000_000 } }),
      today,
    );
    expect(delta.bySource.A.bytes).toBeNull();
    expect(delta.total.bytes).toBeNull();
  });

  test("counts a source absent from the baseline as entirely new", () => {
    const history = historyWith({
      "2026-08-14": snap({ A: { bytes: 100 } }),
    });
    const delta = computeDailyDelta(
      history,
      snap({ A: { bytes: 100 }, B: { bytes: 900 } }),
      today,
    );
    expect(delta.bySource.B.bytes).toBe(900);
    expect(delta.total.bytes).toBe(900);
  });

  test("a source that vanished contributes its negative", () => {
    const history = historyWith({
      "2026-08-14": snap({ A: { bytes: 100 }, B: { bytes: 900 } }),
    });
    const delta = computeDailyDelta(
      history,
      snap({ A: { bytes: 100 } }),
      today,
    );
    expect(delta.bySource.B.bytes).toBe(-900);
  });

  test("one unmeasurable source makes the total unknown, not a partial sum", () => {
    const history = historyWith({
      "2026-08-14": snap({ A: { bytes: 100 }, B: {} }),
    });
    const delta = computeDailyDelta(
      history,
      snap({ A: { bytes: 300 }, B: { bytes: 900 } }),
      today,
    );
    expect(delta.bySource.A.bytes).toBe(200);
    expect(delta.bySource.B.bytes).toBeNull();
    expect(delta.total.bytes).toBeNull();
  });
});

describe("formatDeltaBytes", () => {
  test("distinguishes no change from never recorded", () => {
    expect(formatDeltaBytes(0)).toBe("—");
    expect(formatDeltaBytes(null)).toBe("n/a");
  });

  test("signs and scales", () => {
    expect(formatDeltaBytes(3 * 1024 * 1024 * 1024)).toBe("+3.0 GB");
    expect(formatDeltaBytes(-2 * 1024 * 1024)).toBe("−2.0 MB");
  });
});

describe("formatDelta", () => {
  test("renders an em dash for no change", () => {
    expect(formatDelta(0)).toBe("—");
  });

  test("signs positives and negatives", () => {
    expect(formatDelta(12)).toBe("+12");
    expect(formatDelta(-3)).toBe("−3");
  });

  test("keeps one decimal for fractional values and appends the unit", () => {
    expect(formatDelta(6.25, " h")).toBe("+6.3 h");
  });

  test("groups thousands", () => {
    expect(formatDelta(15368)).toBe("+15,368");
  });

  test("pins the precision when fractionDigits is given", () => {
    // Hours always carry a tenth: "+7 h" and "+7.4 h" are different claims.
    expect(formatDelta(7, " h", 1)).toBe("+7.0 h");
    expect(formatDelta(7.44, " h", 1)).toBe("+7.4 h");
    expect(formatDelta(-1234.56, " h", 1)).toBe("−1,234.6 h");
    expect(formatDelta(0, " h", 1)).toBe("—");
  });
});

describe("parseHistory", () => {
  test("round-trips a valid document", () => {
    const h = withDaySnapshot(
      emptyHistory(),
      "2026-08-14",
      snap({ A: { tasks: 3 } }),
    );
    expect(parseHistory(JSON.parse(JSON.stringify(h)))).toEqual(h);
  });

  test("starts fresh on a version mismatch instead of throwing", () => {
    expect(
      parseHistory({ version: 99, days: { "2026-08-14": snap({}) } }),
    ).toEqual(emptyHistory());
  });

  test("starts fresh on garbage input", () => {
    expect(parseHistory(null)).toEqual(emptyHistory());
    expect(parseHistory("nope")).toEqual(emptyHistory());
    expect(parseHistory({ version: 1 })).toEqual(emptyHistory());
  });

  test("keeps a pre-storage document instead of discarding it", () => {
    // The `bytes` field was added without a version bump precisely so that
    // months of existing history survive the upgrade.
    const parsed = parseHistory({
      version: 1,
      days: {
        "2026-08-14": {
          capturedAt: "2026-08-14T06:00:00.000Z",
          sources: { A: { tasks: 3, episodes: 9, frames: 90, hours: 1 } },
        },
      },
    });
    expect(parsed.days["2026-08-14"].sources.A.tasks).toBe(3);
    expect(parsed.days["2026-08-14"].sources.A.bytes).toBeUndefined();
  });

  test("round-trips bytes when present", () => {
    const h = withDaySnapshot(
      emptyHistory(),
      "2026-08-14",
      snap({ A: { bytes: 2_048 } }),
    );
    expect(parseHistory(JSON.parse(JSON.stringify(h)))).toEqual(h);
  });

  test("drops a non-numeric bytes back to unrecorded rather than NaN", () => {
    const parsed = parseHistory({
      version: 1,
      days: {
        "2026-08-14": {
          capturedAt: "x",
          sources: {
            A: { tasks: 1, episodes: 1, frames: 1, hours: 1, bytes: "huge" },
          },
        },
      },
    });
    expect(parsed.days["2026-08-14"].sources.A.bytes).toBeUndefined();
    expect(parsed.days["2026-08-14"].sources.A.tasks).toBe(1);
  });

  test("drops malformed day keys and entries", () => {
    const parsed = parseHistory({
      version: 1,
      days: {
        "not-a-date": snap({ A: {} }),
        "2026-08-14": snap({ A: {} }),
        "2026-08-15": { capturedAt: "x" },
      },
    });
    expect(Object.keys(parsed.days)).toEqual(["2026-08-14"]);
  });
});
