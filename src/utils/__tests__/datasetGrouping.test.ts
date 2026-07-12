import { describe, expect, test } from "bun:test";
import type {
  DatasetIntegrity,
  LocalDatasetSummary,
} from "@/lib/local-datasets-discovery";
import {
  UNGROUPED_PREFIX,
  getDatasetPrefix,
  getDatasetTaskName,
  groupDatasetsByPrefix,
} from "@/utils/datasetGrouping";

const INTEGRITY: Record<DatasetIntegrity["status"], DatasetIntegrity> = {
  ok: { hasData: true, hasVideos: true, hasEpisodes: true, status: "ok" },
  empty: {
    hasData: true,
    hasVideos: true,
    hasEpisodes: false,
    status: "empty",
  },
  incomplete: {
    hasData: false,
    hasVideos: true,
    hasEpisodes: true,
    status: "incomplete",
  },
};

function makeDataset(
  relativePath: string,
  overrides: Partial<LocalDatasetSummary> = {},
): LocalDatasetSummary {
  return {
    relativePath,
    encodedPath: `enc(${relativePath})`,
    codebase_version: "v3.0",
    robot_type: "so101_follower",
    total_episodes: 1,
    total_frames: 100,
    fps: 30,
    thumbnailVideoUrl: null,
    integrity: INTEGRITY.ok,
    tags: { task: null, scene: null, objects: [] },
    ...overrides,
  };
}

describe("getDatasetPrefix", () => {
  test("returns the first path segment", () => {
    expect(getDatasetPrefix("Xense/pack_bottles")).toBe("Xense");
    expect(getDatasetPrefix("TacVerse/a/b/c")).toBe("TacVerse");
  });

  test("falls back to UNGROUPED_PREFIX for single-segment paths", () => {
    expect(getDatasetPrefix("loose_dataset")).toBe(UNGROUPED_PREFIX);
  });
});

describe("getDatasetTaskName", () => {
  test("returns everything after the first segment", () => {
    expect(getDatasetTaskName("Xense/pack_bottles")).toBe("pack_bottles");
    expect(getDatasetTaskName("Xense/nested/task")).toBe("nested/task");
  });

  test("returns the whole path for single-segment paths", () => {
    expect(getDatasetTaskName("loose_dataset")).toBe("loose_dataset");
  });
});

describe("groupDatasetsByPrefix", () => {
  test("buckets datasets by prefix and sorts groups by name", () => {
    const groups = groupDatasetsByPrefix([
      makeDataset("Xense/two"),
      makeDataset("TacVerse/one"),
      makeDataset("Xense/one"),
    ]);
    expect(groups.map((g) => g.prefix)).toEqual(["TacVerse", "Xense"]);
    expect(groups[1].datasets.map((d) => d.relativePath)).toEqual([
      "Xense/two",
      "Xense/one",
    ]);
  });

  test("aggregates health counts and total episodes per group", () => {
    const groups = groupDatasetsByPrefix([
      makeDataset("Xense/a", { total_episodes: 5, integrity: INTEGRITY.ok }),
      makeDataset("Xense/b", {
        total_episodes: 3,
        integrity: INTEGRITY.incomplete,
      }),
      makeDataset("Xense/c", { total_episodes: 0, integrity: INTEGRITY.empty }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].counts).toEqual({ ok: 1, empty: 1, incomplete: 1 });
    expect(groups[0].totalEpisodes).toBe(8);
  });

  test("picks the first non-null thumbnail as the group art", () => {
    const groups = groupDatasetsByPrefix([
      makeDataset("Xense/a", { thumbnailVideoUrl: null }),
      makeDataset("Xense/b", { thumbnailVideoUrl: "/api/thumb/b.mp4" }),
      makeDataset("Xense/c", { thumbnailVideoUrl: "/api/thumb/c.mp4" }),
    ]);
    expect(groups[0].thumbnailVideoUrl).toBe("/api/thumb/b.mp4");
  });

  test("groups single-segment datasets under UNGROUPED_PREFIX", () => {
    const groups = groupDatasetsByPrefix([makeDataset("loose_dataset")]);
    expect(groups[0].prefix).toBe(UNGROUPED_PREFIX);
    expect(groups[0].datasets).toHaveLength(1);
  });

  test("returns an empty array for no datasets", () => {
    expect(groupDatasetsByPrefix([])).toEqual([]);
  });
});
