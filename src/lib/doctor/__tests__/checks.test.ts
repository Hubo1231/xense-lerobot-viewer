import { describe, expect, it } from "bun:test";
import type { LoadedDoctorDataset } from "../model";
import {
  checkActions,
  checkEpisodes,
  checkMetadata,
  checkTemporal,
} from "../checks/core";
import { checkPerEpisode } from "../checks/anomalies";
import { checkDimensionJumps } from "../checks/jumps";
import { checkSpeedLimits } from "../checks/speeds";
import { getColumnDiffSummary, getColumnMatrices } from "../analysis";
import { countStandardizedJumps, summaryStandardDeviations } from "../math";

function datasetFixture(): LoadedDoctorDataset {
  const rows = Array.from({ length: 10 }, (_, frame) => ({
    timestamp: frame / 10,
    frame_index: frame,
    episode_index: 0,
    index: frame,
    task_index: 0,
    action: [frame / 10, frame / 20],
    "observation.state": [frame, frame + 1],
  }));
  return {
    root: "/tmp/dataset",
    displayPath: "/tmp/dataset",
    info: {
      raw: {
        codebase_version: "v3.0",
        fps: 10,
        total_episodes: 1,
        total_frames: 10,
        features: {},
        data_path: "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
      },
      codebaseVersion: "v3.0",
      formatVersion: "v3",
      fps: 10,
      totalEpisodes: 1,
      totalFrames: 10,
      totalTasks: 1,
      chunksSize: 1000,
      features: {
        timestamp: { dtype: "float32", shape: [1] },
        frame_index: { dtype: "int64", shape: [1] },
        episode_index: { dtype: "int64", shape: [1] },
        index: { dtype: "int64", shape: [1] },
        task_index: { dtype: "int64", shape: [1] },
        action: { dtype: "float32", shape: [2] },
        "observation.state": { dtype: "float32", shape: [2] },
      },
      dataPath: "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
      videoPath: null,
      splits: { train: "0:1" },
      robotType: "test",
    },
    infoError: null,
    episodesMeta: [{ episodeIndex: 0, length: 10, raw: rows[0] }],
    sampledEpisodesMeta: [{ episodeIndex: 0, length: 10, raw: rows[0] }],
    totalEpisodeMetaEntries: 1,
    episodesData: [
      {
        episodeIndex: 0,
        length: rows.length,
        columns: Object.fromEntries(
          Object.keys(rows[0]).map((name) => [
            name,
            rows.map((row) => row[name as keyof typeof row]),
          ]),
        ),
      },
    ],
    tasks: [{ task_index: 0, task: "test" }],
    tasksError: null,
    stats: {
      action: { mean: [0, 0], std: [1, 1] },
      "observation.state": { mean: [0, 0], std: [1, 1] },
    },
    statsError: null,
    inventory: {
      entries: [
        {
          relPath: "meta/info.json",
          size: 100,
          mtimeMs: 1,
          readable: true,
          symlink: false,
        },
        {
          relPath: "meta/episodes/chunk-000/file-000.parquet",
          size: 100,
          mtimeMs: 1,
          readable: true,
          symlink: false,
        },
        {
          relPath: "data/chunk-000/file-000.parquet",
          size: 100,
          mtimeMs: 1,
          readable: true,
          symlink: false,
        },
      ],
      totalSize: 300,
      truncated: false,
    },
    maxEpisodesApplied: null,
    episodeRangeApplied: null,
    loadWarnings: [],
  };
}

describe("native Doctor checks", () => {
  it("accepts a minimal healthy metadata/data fixture", () => {
    const dataset = datasetFixture();
    expect(checkMetadata(dataset).severity).toBe("PASS");
    expect(checkTemporal(dataset).severity).toBe("PASS");
    const episodes = checkEpisodes(dataset);
    expect(episodes.severity).toBe("WARN");
    expect(
      episodes.messages.some((message) =>
        message.message.includes("chunk_size=16"),
      ),
    ).toBe(true);
  });

  it("reports bad timestamps and frame indices with episode references", () => {
    const dataset = datasetFixture();
    dataset.episodesData[0].columns.timestamp[4] = 0.1;
    dataset.episodesData[0].columns.frame_index[5] = 99;
    const result = checkTemporal(dataset);
    expect(result.severity).toBe("WARN");
    expect(
      result.messages.some((message) => message.message.includes("Episode 0")),
    ).toBe(true);
    expect(
      result.messages.some((message) =>
        message.message.includes("frame_index not sequential"),
      ),
    ).toBe(true);
  });

  it("fails NaN actions and exposes the episode in the summary", () => {
    const dataset = datasetFixture();
    dataset.episodesData[0].columns.action[3] = [Number.NaN, 0];
    expect(checkActions(dataset).severity).toBe("FAIL");
    const perEpisode = checkPerEpisode(dataset);
    expect(
      perEpisode.messages.some((message) =>
        message.message.includes("NaN in action"),
      ),
    ).toBe(true);
    expect(
      perEpisode.messages.some((message) =>
        message.message.includes("Episode 0"),
      ),
    ).toBe(true);
  });

  it("fails a data/metadata length mismatch", () => {
    const dataset = datasetFixture();
    dataset.sampledEpisodesMeta[0].length = 9;
    expect(checkEpisodes(dataset).severity).toBe("FAIL");
  });

  it("runs action statistics over more values than the JS argument limit", () => {
    const dataset = datasetFixture();
    const frameCount = 150_000;
    dataset.episodesData[0] = {
      episodeIndex: 0,
      length: frameCount,
      columns: {
        action: Array.from({ length: frameCount }, (_, index) => [index % 97]),
      },
    };
    let result: ReturnType<typeof checkActions> | undefined;
    expect(() => {
      result = checkActions(dataset);
    }).not.toThrow();
    expect(result?.severity).not.toBe("FAIL");
  });

  it("lists every affected episode in action and per-episode checks", () => {
    const dataset = datasetFixture();
    dataset.episodesData = Array.from({ length: 30 }, (_, episodeIndex) => ({
      episodeIndex,
      length: 40,
      columns: {
        action: Array.from({ length: 40 }, (_, frame) => [
          frame === 20 && episodeIndex % 3 !== 0
            ? episodeIndex % 2 === 0
              ? 100
              : -100
            : frame / 100,
        ]),
      },
    }));
    const diffSummary = getColumnDiffSummary(dataset, "action");
    const deviations = summaryStandardDeviations(diffSummary!, 1);
    const expected = getColumnMatrices(dataset, "action").filter(
      ({ matrix }) => countStandardizedJumps(matrix, deviations) > 0,
    ).length;

    const action = checkActions(dataset);
    const actionEpisodes = action.messages.filter((message) =>
      message.message.includes("sudden large action jumps"),
    );
    expect(actionEpisodes).toHaveLength(expected);
    expect(
      action.messages.some((message) => message.message.startsWith("...and ")),
    ).toBe(false);

    const perEpisode = checkPerEpisode(dataset);
    expect(
      perEpisode.messages.filter((message) =>
        /Episode \d+: .*action jump/.test(message.message),
      ),
    ).toHaveLength(expected);
    expect(
      perEpisode.messages.some((message) =>
        message.message.includes("more flagged episodes"),
      ),
    ).toBe(false);
  });

  it("reports coordinated state jumps without changing the action check", () => {
    const dataset = datasetFixture();
    dataset.info!.features["observation.state"] = {
      dtype: "float32",
      shape: [2],
      names: ["left_tcp.x", "left_tcp.y"],
    };
    dataset.episodesData[0].columns["observation.state"] = Array.from(
      { length: 5_000 },
      (_, frame) => (frame === 2_500 ? [100, 100] : [0, 0]),
    );

    const result = checkDimensionJumps(dataset);
    expect(result.severity).toBe("WARN");
    expect(
      result.messages.some(
        (message) =>
          message.message.includes("Episode 0") &&
          message.message.includes("left_tcp.x") &&
          message.message.includes("left_tcp.y"),
      ),
    ).toBe(true);
  });

  it("uses configurable thresholds for dimension-level jumps", () => {
    const dataset = datasetFixture();
    dataset.episodesData[0].columns.action = Array.from(
      { length: 5_000 },
      () => [0, 0],
    );
    dataset.episodesData[0].columns["observation.state"] = Array.from(
      { length: 5_000 },
      (_, frame) => (frame === 2_500 ? [100, 100] : [0, 0]),
    );

    const strict = checkDimensionJumps(dataset, {
      dimensionZThreshold: 60,
      extremeSingleDimensionZ: 70,
    });
    expect(strict.severity).toBe("PASS");

    const sensitive = checkDimensionJumps(dataset, {
      dimensionZThreshold: 45,
      extremeSingleDimensionZ: 70,
    });
    expect(sensitive.severity).toBe("WARN");
    expect(
      sensitive.messages.some((message) =>
        message.message.includes(">45σ or one >70σ"),
      ),
    ).toBe(true);
  });

  it("detects per-axis TCP linear and world-frame angular speed limits", () => {
    const dataset = datasetFixture();
    dataset.info!.features.action = {
      dtype: "float32",
      shape: [9],
      names: [
        "left_tcp.x",
        "left_tcp.y",
        "left_tcp.z",
        "left_tcp.r1",
        "left_tcp.r2",
        "left_tcp.r3",
        "left_tcp.r4",
        "left_tcp.r5",
        "left_tcp.r6",
      ],
    };
    dataset.episodesData[0] = {
      episodeIndex: 0,
      length: 2,
      columns: {
        timestamp: [0, 0.25],
        frame_index: [0, 1],
        action: [
          [0, 0, 0, 1, 0, 0, 0, 1, 0],
          [0.5, 0, 0, 0, 1, 0, -1, 0, 0],
        ],
      },
    };

    const result = checkSpeedLimits(dataset);
    expect(result.severity).toBe("WARN");
    expect(
      result.messages.some(
        (message) =>
          message.message.includes("Episode 0") &&
          message.message.includes("vx 2.000 m/s") &&
          message.message.includes("ωz 360.0 deg/s") &&
          message.message.includes("limit 270 deg/s") &&
          message.message.includes("@0.25s"),
      ),
    ).toBe(true);
    expect(
      result.messages.some((message) =>
        message.message.includes("episode(s) contain"),
      ),
    ).toBe(false);
    expect(
      result.messages.some((message) => message.message.startsWith("Detected")),
    ).toBe(false);

    const relaxed = checkSpeedLimits(dataset, {
      linearMetersPerSecond: 2.1,
      angularDegreesPerSecond: 370,
    });
    expect(relaxed.severity).toBe("PASS");
    expect(relaxed.messages).toHaveLength(1);
  });
});
