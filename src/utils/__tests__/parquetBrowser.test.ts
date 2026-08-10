import { describe, expect, it } from "bun:test";
import {
  classifyParquetPath,
  compareParquetEntries,
  defaultColumnSelection,
  describeCell,
  formatBytes,
  formatNumber,
  MAX_LIST_ITEMS,
  naturalCompare,
  rowsToCsv,
  toJsonSafe,
} from "../parquetBrowser";
import type { ParquetFileEntry } from "@/types/parquet-browser.types";

const entry = (relPath: string): ParquetFileEntry => ({
  relPath,
  group: classifyParquetPath(relPath),
  size: 0,
});

describe("classifyParquetPath", () => {
  it("separates data, episode metadata and other meta files", () => {
    expect(classifyParquetPath("data/chunk-000/file-000.parquet")).toBe("data");
    expect(
      classifyParquetPath("meta/episodes/chunk-000/file-000.parquet"),
    ).toBe("episodes");
    expect(classifyParquetPath("meta/tasks.parquet")).toBe("meta");
    expect(classifyParquetPath("scratch/dump.parquet")).toBe("other");
  });
});

describe("naturalCompare", () => {
  it("orders embedded numbers numerically", () => {
    expect(naturalCompare("file-2", "file-10")).toBeLessThan(0);
    expect(naturalCompare("file-010", "file-9")).toBeGreaterThan(0);
    expect(naturalCompare("file-003", "file-003")).toBe(0);
  });
});

describe("compareParquetEntries", () => {
  it("groups data first, then episode metadata, then meta", () => {
    const sorted = [
      entry("meta/tasks.parquet"),
      entry("meta/episodes/chunk-000/file-000.parquet"),
      entry("data/chunk-000/file-010.parquet"),
      entry("data/chunk-000/file-002.parquet"),
    ]
      .sort(compareParquetEntries)
      .map((file) => file.relPath);

    expect(sorted).toEqual([
      "data/chunk-000/file-002.parquet",
      "data/chunk-000/file-010.parquet",
      "meta/episodes/chunk-000/file-000.parquet",
      "meta/tasks.parquet",
    ]);
  });
});

describe("toJsonSafe", () => {
  it("narrows BigInt to number when it is exactly representable", () => {
    expect(toJsonSafe(42n)).toBe(42);
    expect(toJsonSafe(-42n)).toBe(-42);
    expect(toJsonSafe(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("keeps oversized BigInt as a string rather than losing digits", () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    expect(toJsonSafe(huge)).toBe(huge.toString());
  });

  it("summarises byte columns instead of shipping them", () => {
    expect(toJsonSafe(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual({
      __kind: "bytes",
      length: 4,
      preview: "89504e47",
    });
  });

  it("converts typed arrays to plain arrays", () => {
    expect(toJsonSafe(new Float32Array([1, 2]))).toEqual([1, 2]);
  });

  it("truncates lists past the ship limit", () => {
    const long = Array.from({ length: MAX_LIST_ITEMS + 5 }, (_, i) => i);
    const result = toJsonSafe(long) as {
      __kind: string;
      length: number;
      items: unknown[];
    };
    expect(result.__kind).toBe("list");
    expect(result.length).toBe(MAX_LIST_ITEMS + 5);
    expect(result.items).toHaveLength(MAX_LIST_ITEMS);
  });

  it("recurses through structs and lists", () => {
    expect(toJsonSafe({ a: [1n, { b: 2n }], c: null })).toEqual({
      a: [1, { b: 2 }],
      c: null,
    });
  });

  it("stringifies non-finite numbers so JSON survives them", () => {
    expect(toJsonSafe(Number.NaN)).toBe("NaN");
    expect(toJsonSafe(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });

  it("serialises to JSON without throwing", () => {
    expect(() =>
      JSON.stringify(toJsonSafe({ n: 1n, bytes: new Uint8Array([1]) })),
    ).not.toThrow();
  });
});

describe("formatNumber", () => {
  it("leaves integers alone and trims float noise", () => {
    expect(formatNumber(1000)).toBe("1000");
    expect(formatNumber(33.33333206176758)).toBe("33.33333");
    expect(formatNumber(Number.NaN)).toBe("NaN");
  });
});

describe("formatBytes", () => {
  it("scales to the nearest unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(7 * 1024 * 1024)).toBe("7.0 MB");
  });
});

describe("describeCell", () => {
  it("renders nulls, numbers and booleans inline", () => {
    expect(describeCell(null)).toMatchObject({
      kind: "null",
      preview: "null",
      expandable: false,
    });
    expect(describeCell(1.5)).toMatchObject({ kind: "number", preview: "1.5" });
    expect(describeCell(true)).toMatchObject({
      kind: "boolean",
      preview: "true",
    });
  });

  it("abbreviates a list and keeps the count", () => {
    const cell = describeCell([1, 2, 3, 4, 5, 6]);
    expect(cell.kind).toBe("list");
    expect(cell.preview).toBe("[1, 2, 3, 4, …] ×6");
    expect(cell.full).toBe("1, 2, 3, 4, 5, 6");
  });

  it("flags a truncated string as expandable and keeps the original", () => {
    const long = "x".repeat(200);
    const cell = describeCell(long);
    expect(cell.expandable).toBe(true);
    expect(cell.full).toBe(long);
    expect(cell.preview.endsWith("…")).toBe(true);
  });

  it("notes the items a truncated list never shipped", () => {
    const cell = describeCell({ __kind: "list", length: 10, items: [1, 2] });
    expect(cell.kind).toBe("list");
    expect(cell.full).toContain("8 more items not loaded");
    expect(cell.expandable).toBe(true);
  });

  it("does not offer to expand a list the preview already shows whole", () => {
    expect(describeCell([1, 2]).expandable).toBe(false);
    expect(describeCell([]).expandable).toBe(false);
    // Five items: the fifth is hidden behind the ellipsis, so expanding helps.
    expect(describeCell([1, 2, 3, 4, 5]).expandable).toBe(true);
  });

  it("offers to expand a short list whose own items are abbreviated", () => {
    expect(describeCell(["x".repeat(200)]).expandable).toBe(true);
  });

  it("summarises byte cells", () => {
    const cell = describeCell({
      __kind: "bytes",
      length: 4,
      preview: "89504e47",
    });
    expect(cell.kind).toBe("bytes");
    expect(cell.preview).toContain("0x89504e47");
  });
});

describe("defaultColumnSelection", () => {
  it("keeps every column when the file is narrow enough", () => {
    const names = ["a", "b", "c"];
    expect(defaultColumnSelection(names)).toEqual(names);
  });

  it("prefers lerobot bookkeeping columns but preserves schema order", () => {
    const names = [
      ...Array.from({ length: 20 }, (_, i) => `stats/action/${i}`),
      "episode_index",
      "length",
    ];
    const selected = defaultColumnSelection(names, 4);

    expect(selected).toHaveLength(4);
    expect(selected).toContain("episode_index");
    expect(selected).toContain("length");
    // Schema order: the stats columns come before the preferred ones.
    expect(selected.indexOf("stats/action/0")).toBeLessThan(
      selected.indexOf("episode_index"),
    );
  });
});

describe("rowsToCsv", () => {
  it("writes full cell text and quotes separators", () => {
    const csv = rowsToCsv(
      ["frame_index", "action", "task"],
      [
        { frame_index: 0, action: [1, 2], task: 'say "hi", now' },
        { frame_index: 1, action: null, task: null },
      ],
    );

    expect(csv.split("\n")).toEqual([
      "frame_index,action,task",
      '0,"1, 2","say ""hi"", now"',
      "1,,",
    ]);
  });
});
