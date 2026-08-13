import {
  countStandardizedJumps,
  formatNumber,
  maxConsecutiveEqualRows,
  mean,
  median,
  minMax,
  numericMatrix,
  populationStd,
  summaryStandardDeviations,
  valueKind,
  valueShape,
} from "../math";
import {
  getColumnDiffSummary,
  getColumnMatrices,
  getColumnSummary,
} from "../analysis";
import {
  DoctorCheckBuilder,
  isRecord,
  numberValue,
  type DoctorEpisodeData,
  type LoadedDoctorDataset,
} from "../model";

const SKIP_COLUMNS = new Set([
  "timestamp",
  "frame_index",
  "episode_index",
  "index",
  "task_index",
]);

const BINARY_COLUMNS = new Set(["next.done", "next.success", "next.reward"]);

export function actionColumns(dataset: LoadedDoctorDataset): string[] {
  const columns = Object.keys(dataset.episodesData[0]?.columns ?? {});
  const explicit = columns.filter((name) => name.startsWith("action"));
  return explicit.length > 0
    ? explicit
    : columns.filter((name) => !SKIP_COLUMNS.has(name));
}

function numericColumns(dataset: LoadedDoctorDataset): string[] {
  const sample = dataset.episodesData[0];
  if (!sample) return [];
  return Object.entries(sample.columns)
    .filter(
      ([name, values]) => !SKIP_COLUMNS.has(name) && numericMatrix(values),
    )
    .map(([name]) => name);
}

function matrixForEpisode(
  episode: DoctorEpisodeData,
  columnName: string,
): number[][] | null {
  const values = episode.columns[columnName];
  return values ? numericMatrix(values) : null;
}

function list(values: number[], limit = 10): string {
  const shown = values.slice(0, limit).join(", ");
  return `[${shown}${values.length > limit ? ", ..." : ""}]`;
}

export function checkMetadata(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Metadata & Format Compliance");
  if (!dataset.info) {
    result.fail(dataset.infoError ?? "info.json could not be loaded");
    return result.build();
  }
  const info = dataset.info;
  result.pass("info.json loaded successfully");
  if (info.formatVersion) {
    result.pass(
      `Detected LeRobot Dataset ${info.formatVersion} format (${info.codebaseVersion ?? info.formatVersion})`,
    );
  } else if (info.codebaseVersion) {
    result.warn(
      `Codebase version is ${info.codebaseVersion}; only v2.x and v3.x are explicitly supported`,
    );
  } else {
    result.warn(
      "Could not detect LeRobot dataset format version from info.json or layout",
    );
  }

  const required = [
    "codebase_version",
    "fps",
    "total_episodes",
    "total_frames",
    "features",
    "data_path",
  ];
  const missing = required.filter((name) => !(name in info.raw));
  if (missing.length > 0) {
    result.fail(`info.json missing required fields: [${missing.join(", ")}]`);
  } else {
    result.pass("All required fields present in info.json");
  }
  if (
    info.codebaseVersion &&
    !info.codebaseVersion.startsWith("v2") &&
    !info.codebaseVersion.startsWith("v3")
  ) {
    result.warn(
      `Codebase version is ${info.codebaseVersion}, expected v2.x or v3.x`,
    );
  }
  if (info.fps !== null && info.fps <= 0) {
    result.fail(`fps must be positive, got ${info.fps}`);
  }

  const dataParquets = dataset.inventory.entries.filter(
    (entry) =>
      entry.relPath.startsWith("data/") && entry.relPath.endsWith(".parquet"),
  );
  if (dataParquets.length === 0) result.fail("No parquet files found in data/");
  else result.pass(`Found ${dataParquets.length} data parquet file(s)`);

  const episodeParquets = dataset.inventory.entries.filter(
    (entry) =>
      entry.relPath.startsWith("meta/episodes/") &&
      entry.relPath.endsWith(".parquet"),
  );
  if (episodeParquets.length > 0) {
    result.pass(`Found ${episodeParquets.length} episode metadata file(s)`);
  } else if (
    dataset.inventory.entries.some(
      (entry) => entry.relPath === "meta/episodes.jsonl",
    )
  ) {
    result.pass("Found v2 episode metadata: meta/episodes.jsonl");
  } else {
    result.warn(
      "Episode metadata not found (expected meta/episodes/*.parquet for v3 or meta/episodes.jsonl for v2)",
    );
  }

  if ((info.totalTasks ?? 0) > 0) {
    if (!dataset.tasks) {
      result.fail(
        dataset.tasksError ??
          `total_tasks=${info.totalTasks} but task metadata not found`,
      );
    } else if (dataset.tasks.length !== info.totalTasks) {
      result.warn(
        `total_tasks=${info.totalTasks} but task metadata has ${dataset.tasks.length} rows`,
      );
    }
  }

  const partial = dataset.maxEpisodesApplied !== null;
  if (
    !partial &&
    dataset.episodesData.length > 0 &&
    info.totalFrames !== null
  ) {
    const actualFrames = dataset.episodesData.reduce(
      (sum, episode) => sum + episode.length,
      0,
    );
    if (
      dataset.episodesData.length === (info.totalEpisodes ?? 0) &&
      actualFrames !== info.totalFrames
    ) {
      result.fail(
        `total_frames=${info.totalFrames} but actual frame count is ${actualFrames}`,
      );
    }
  }
  if (dataset.totalEpisodeMetaEntries > 0) {
    if (partial) {
      result.pass(
        `Skipped total_episodes check (loaded partial subset via maxEpisodes=${dataset.maxEpisodesApplied})`,
      );
    } else if (
      info.totalEpisodes !== null &&
      dataset.totalEpisodeMetaEntries !== info.totalEpisodes
    ) {
      result.fail(
        `total_episodes=${info.totalEpisodes} but found ${dataset.totalEpisodeMetaEntries} episode metadata entries`,
      );
    } else {
      result.pass(`Episode count matches: ${info.totalEpisodes}`);
    }
  }

  const dataColumns = new Set(
    Object.keys(dataset.episodesData[0]?.columns ?? {}),
  );
  for (const [featureName, spec] of Object.entries(info.features)) {
    if (!dataColumns.has(featureName) && spec.dtype !== "video") {
      result.warn(
        `Feature '${featureName}' declared in info.json but not in data parquet`,
      );
    }
  }
  for (const warning of dataset.loadWarnings.slice(0, 10)) result.warn(warning);
  if (dataset.loadWarnings.length > 10) {
    result.warn(
      `...and ${dataset.loadWarnings.length - 10} more data loading warnings`,
    );
  }
  return result.build();
}

export function checkTemporal(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Temporal Consistency");
  if (!dataset.info) {
    result.fail("Cannot check temporal consistency: info.json not loaded");
    return result.build();
  }
  if (dataset.episodesData.length === 0) {
    result.warn("No episode data loaded, skipping temporal checks");
    return result.build();
  }
  const fps = dataset.info.fps;
  if (fps === null || fps <= 0) {
    result.fail(`Invalid fps=${fps}, cannot check temporal consistency`);
    return result.build();
  }
  const expectedInterval = 1 / fps;
  let totalDropped = 0;
  let totalDuplicates = 0;
  const issues: Array<{ episode: number; messages: string[] }> = [];

  for (const episode of dataset.episodesData) {
    const episodeIssues: string[] = [];
    const timestamps = matrixForEpisode(episode, "timestamp")?.map(
      (row) => row[0],
    );
    if (timestamps && timestamps.length > 1) {
      const diffs = timestamps
        .slice(1)
        .map((value, index) => value - timestamps[index]);
      const nonMonotonic = diffs
        .map((value, index) => (value <= 0 ? index : -1))
        .filter((index) => index >= 0);
      const gaps = diffs
        .map((value, index) => (value > expectedInterval * 1.5 ? index : -1))
        .filter((index) => index >= 0);
      if (nonMonotonic.length > 0) {
        totalDuplicates += nonMonotonic.length;
        episodeIssues.push(
          `${nonMonotonic.length} non-monotonic timestamp(s) at frame indices ${list(nonMonotonic, 5)}`,
        );
      }
      if (gaps.length > 0) {
        totalDropped += gaps.length;
        episodeIssues.push(
          `${gaps.length} dropped frame gap(s) at frame indices ${list(gaps, 5)}`,
        );
      }
      const positive = diffs.filter((value) => value > 0);
      if (positive.length > 0) {
        const interval = mean(positive);
        if (Math.abs(interval - expectedInterval) > expectedInterval * 0.1) {
          episodeIssues.push(
            `Mean interval ${interval.toFixed(4)}s differs from expected ${expectedInterval.toFixed(4)}s (fps=${fps})`,
          );
        }
      }
    }

    const frameIndices = matrixForEpisode(episode, "frame_index")?.map(
      (row) => row[0],
    );
    if (frameIndices) {
      const mismatches = frameIndices
        .map((value, index) => (value !== index ? index : -1))
        .filter((index) => index >= 0);
      if (mismatches.length > 0) {
        const first = mismatches[0];
        episodeIssues.push(
          `frame_index not sequential: ${mismatches.length} mismatches, first at position ${first} (got ${frameIndices[first]}, expected ${first})`,
        );
      }
    }
    if (episodeIssues.length > 0)
      issues.push({ episode: episode.episodeIndex, messages: episodeIssues });
  }

  const episodeIndices = dataset.episodesData.map(
    (episode) => episode.episodeIndex,
  );
  if (episodeIndices.length > 0) {
    const present = new Set(episodeIndices);
    const missing: number[] = [];
    const { minimum, maximum } = minMax(episodeIndices);
    for (let index = minimum; index <= maximum; index += 1) {
      if (!present.has(index)) missing.push(index);
    }
    if (missing.length > 0)
      result.warn(`Missing episode indices: ${list(missing)}`);
  }

  let firstGlobalIndex: number | null = null;
  let expectedGlobalIndex: number | null = null;
  let globalIndexMismatch = false;
  for (const episode of dataset.episodesData) {
    const indices = matrixForEpisode(episode, "index");
    if (!indices) continue;
    for (const row of indices) {
      const value = row[0];
      if (firstGlobalIndex === null) {
        firstGlobalIndex = value;
        expectedGlobalIndex = value;
      }
      if (value !== expectedGlobalIndex) globalIndexMismatch = true;
      expectedGlobalIndex = (expectedGlobalIndex ?? value) + 1;
    }
  }
  if (firstGlobalIndex !== null && globalIndexMismatch) {
    result.warn(
      dataset.maxEpisodesApplied === null || firstGlobalIndex === 0
        ? "Global index column is not sequential"
        : `Global index column is not sequential within sampled episodes (sample begins at ${firstGlobalIndex})`,
    );
  }

  if (issues.length === 0 && totalDropped === 0 && totalDuplicates === 0) {
    result.pass(
      `All ${dataset.episodesData.length} episodes have consistent timestamps and frame indices`,
    );
  } else {
    for (const issue of issues.slice(0, 10)) {
      for (const message of issue.messages)
        result.warn(`Episode ${issue.episode}: ${message}`);
    }
    if (issues.length > 10)
      result.warn(`...and ${issues.length - 10} more episodes with issues`);
    if (totalDropped > 0)
      result.warn(
        `Total dropped frame gaps across all episodes: ${totalDropped}`,
      );
    if (totalDuplicates > 0) {
      result.warn(
        `Total non-monotonic timestamps across all episodes: ${totalDuplicates}`,
      );
    }
  }
  return result.build();
}

export function checkActions(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Action Quality");
  if (dataset.episodesData.length === 0) {
    result.warn("No episode data loaded, skipping action checks");
    return result.build();
  }
  const columns = actionColumns(dataset);
  if (columns.length === 0) {
    result.warn("No action columns found");
    return result.build();
  }
  result.pass(`Found action columns: [${columns.join(", ")}]`);

  for (const columnName of columns) {
    const perEpisode = getColumnMatrices(dataset, columnName);
    const summary = getColumnSummary(dataset, columnName);
    if (!summary) continue;
    if (summary.nanCount > 0) {
      result.fail(`${columnName}: ${summary.nanCount} NaN values detected`);
    }
    if (summary.infCount > 0) {
      result.fail(`${columnName}: ${summary.infCount} Inf values detected`);
    }

    for (let dim = 0; dim < summary.dimensions; dim += 1) {
      const dimension = summary.dimensionsSummary[dim];
      if (dimension.minimum === dimension.maximum || dimension.count <= 10) {
        continue;
      }
      const atMinimum = dimension.atMinimum / dimension.count;
      const atMaximum = dimension.atMaximum / dimension.count;
      const label =
        summary.dimensions > 1 ? `${columnName}[${dim}]` : columnName;
      if (atMinimum > 0.99) {
        result.fail(
          `${label}: ${(atMinimum * 100).toFixed(1)}% of values at minimum (${formatNumber(dimension.minimum)}) -- clipping detected`,
        );
      } else if (atMinimum > 0.5) {
        result.warn(
          `${label}: ${(atMinimum * 100).toFixed(1)}% of values at minimum (${formatNumber(dimension.minimum)})`,
        );
      }
      if (atMaximum > 0.99) {
        result.fail(
          `${label}: ${(atMaximum * 100).toFixed(1)}% of values at maximum (${formatNumber(dimension.maximum)}) -- clipping detected`,
        );
      } else if (atMaximum > 0.5) {
        result.warn(
          `${label}: ${(atMaximum * 100).toFixed(1)}% of values at maximum (${formatNumber(dimension.maximum)})`,
        );
      }
    }

    const frozen: Array<[number, number]> = [];
    for (const { episode, matrix } of perEpisode) {
      if (matrix.length < 2) continue;
      const percent = (maxConsecutiveEqualRows(matrix) / matrix.length) * 100;
      if (percent >= 5) frozen.push([episode.episodeIndex, percent]);
    }
    for (const [episode, percent] of frozen.slice(0, 5)) {
      result.warn(
        `${columnName}: ${percent.toFixed(0)}% of episode ${episode} is consecutive identical actions (frozen)`,
      );
    }
    if (frozen.length > 5) {
      result.warn(
        `${columnName}: ...and ${frozen.length - 5} more episodes with frozen actions`,
      );
    }

    const diffSummary = getColumnDiffSummary(dataset, columnName);
    if (diffSummary) {
      const standardDeviations = summaryStandardDeviations(diffSummary, 1);
      const jumps: Array<[number, number]> = [];
      for (const { episode, matrix } of perEpisode) {
        if (matrix.length < 3) continue;
        const count = countStandardizedJumps(matrix, standardDeviations);
        if (count > 0) jumps.push([episode.episodeIndex, count]);
      }
      for (const [episode, count] of jumps.slice(0, 5)) {
        result.warn(
          `${columnName}: Episode ${episode} has ${count} sudden large action jumps (>8 std mean across dims)`,
        );
      }
      if (jumps.length > 5) {
        result.warn(
          `${columnName}: ...and ${jumps.length - 5} more episodes with large action jumps`,
        );
      }
    }
  }
  return result.build();
}

export function checkStatistics(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Data Distribution");
  if (dataset.episodesData.length === 0) {
    result.warn("No episode data loaded, skipping statistics checks");
    return result.build();
  }
  const columns = numericColumns(dataset);
  if (columns.length === 0) {
    result.warn("No numeric columns found for statistics checks");
    return result.build();
  }
  for (const columnName of columns) {
    const matrices = getColumnMatrices(dataset, columnName);
    const summary = getColumnSummary(dataset, columnName);
    if (!summary) continue;
    if (summary.nanCount > 0) {
      result.fail(`${columnName}: ${summary.nanCount} NaN values`);
    }
    if (summary.infCount > 0) {
      result.fail(`${columnName}: ${summary.infCount} Inf values`);
    }
    if (summary.finiteRows === 0) continue;
    for (let dim = 0; dim < summary.dimensions; dim += 1) {
      const dimension = summary.dimensionsSummary[dim];
      const deviation = Math.sqrt(dimension.m2 / dimension.count);
      const label =
        summary.dimensions > 1 ? `${columnName}[${dim}]` : columnName;
      if (deviation === 0) {
        result.warn(
          `${label}: zero variance (constant value ${formatNumber(dimension.minimum)})`,
        );
      } else if (
        !BINARY_COLUMNS.has(columnName) &&
        !columnName.startsWith("next.")
      ) {
        let extreme = 0;
        for (const { matrix } of matrices) {
          for (const row of matrix) {
            if (
              row.every(Number.isFinite) &&
              Math.abs((row[dim] - dimension.mean) / deviation) > 10
            ) {
              extreme += 1;
            }
          }
        }
        if (extreme > 0)
          result.warn(
            `${label}: ${extreme} extreme outlier(s) (>10 std from mean)`,
          );
      }
    }
  }

  if (dataset.statsError) result.warn(dataset.statsError);
  else if (!dataset.stats) {
    result.warn(
      "stats.json not found -- cannot compare computed vs stored statistics",
    );
  } else {
    result.pass("stats.json found and loaded for comparison");
    const dataColumns = new Set(columns);
    const statsFeatures = new Set(Object.keys(dataset.stats));
    const missing = [...dataColumns].filter((name) => !statsFeatures.has(name));
    if (missing.length > 0) {
      result.warn(
        `Features in data but not in stats.json: [${missing.slice(0, 5).join(", ")}]`,
      );
    }
  }
  return result.build();
}

export function checkEpisodes(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Episode Health");
  if (!dataset.info) {
    result.fail("Cannot check episodes: info.json not loaded");
    return result.build();
  }
  if (dataset.episodesData.length === 0) {
    result.warn("No episode data loaded");
    return result.build();
  }
  const fps = dataset.info.fps || 1;
  const lengths = dataset.episodesData.map((episode) => episode.length);
  const { minimum, maximum } = minMax(lengths);
  const average = mean(lengths);
  const deviation = populationStd(lengths, average);
  result.pass(
    `Episode lengths: min=${minimum}, max=${maximum}, mean=${average.toFixed(0)}, median=${median(lengths).toFixed(0)}, std=${deviation.toFixed(1)}`,
  );
  result.pass(
    `Episode durations: min=${(minimum / fps).toFixed(1)}s, max=${(maximum / fps).toFixed(1)}s, mean=${(average / fps).toFixed(1)}s`,
  );
  const shortThreshold = Math.max(5, fps);
  const short = dataset.episodesData.filter(
    (episode) => episode.length < shortThreshold,
  );
  if (short.length > 0) {
    result.warn(
      `${short.length} episode(s) shorter than ${shortThreshold} frames (<${(shortThreshold / fps).toFixed(1)}s): ${list(short.map((episode) => episode.episodeIndex))}`,
    );
  }
  const single = dataset.episodesData.filter((episode) => episode.length <= 1);
  if (single.length > 0) {
    result.fail(
      `${single.length} episode(s) with <=1 frame (can't compute statistics): ${list(single.map((episode) => episode.episodeIndex))}`,
    );
  }
  const empty = dataset.episodesData.filter((episode) => episode.length === 0);
  if (empty.length > 0) {
    result.fail(
      `${empty.length} empty episode(s): ${list(empty.map((episode) => episode.episodeIndex))}`,
    );
  }
  if (average > 0 && deviation / average > 1) {
    result.warn(
      `High episode length variance: std/mean ratio = ${(deviation / average).toFixed(2)}. This can hurt training stability.`,
    );
  }
  if (deviation > 0) {
    const shortOutliers = dataset.episodesData.filter(
      (episode) => episode.length < average - 3 * deviation,
    );
    const longOutliers = dataset.episodesData.filter(
      (episode) => episode.length > average + 3 * deviation,
    );
    if (shortOutliers.length > 0) {
      result.warn(
        `${shortOutliers.length} abnormally short episode(s) (>3 std below mean): ${list(
          shortOutliers.map((episode) => episode.episodeIndex),
          5,
        )}`,
      );
    }
    if (longOutliers.length > 0) {
      result.warn(
        `${longOutliers.length} abnormally long episode(s) (>3 std above mean): ${list(
          longOutliers.map((episode) => episode.episodeIndex),
          5,
        )}`,
      );
    }
  }
  for (const chunkSize of [10, 16, 20, 50, 100]) {
    const tooShort = dataset.episodesData.filter(
      (episode) => episode.length < chunkSize,
    );
    if (tooShort.length > dataset.episodesData.length * 0.1) {
      result.warn(
        `${tooShort.length}/${dataset.episodesData.length} episodes shorter than chunk_size=${chunkSize} (used by ACT/Diffusion policies)`,
      );
      break;
    }
  }

  const metaByIndex = new Map(
    dataset.sampledEpisodesMeta.map((meta) => [meta.episodeIndex, meta]),
  );
  const mismatches = dataset.episodesData.filter((episode) => {
    const metadata = metaByIndex.get(episode.episodeIndex);
    return metadata && metadata.length !== episode.length;
  });
  if (mismatches.length > 0) {
    result.fail(
      `${mismatches.length} episode(s) have data/metadata length mismatch: ${mismatches
        .slice(0, 5)
        .map((episode) => {
          const metadata = metaByIndex.get(episode.episodeIndex);
          return `(episode ${episode.episodeIndex}, data=${episode.length}, meta=${metadata?.length})`;
        })
        .join(", ")}`,
    );
  } else if (dataset.sampledEpisodesMeta.length > 0) {
    result.pass("All episode lengths match metadata");
  }

  const taskCounts = new Map<number, number>();
  for (const episode of dataset.episodesData) {
    const tasks = new Set<number>();
    for (const value of episode.columns.task_index ?? []) {
      const task = numberValue(value, null);
      if (task !== null) tasks.add(Math.trunc(task));
    }
    for (const task of tasks)
      taskCounts.set(task, (taskCounts.get(task) ?? 0) + 1);
  }
  if (taskCounts.size > 1) {
    result.pass(
      `Task distribution across episodes: {${[...taskCounts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([task, count]) => `${task}: ${count}`)
        .join(", ")}}`,
    );
    const counts = [...taskCounts.values()];
    const { minimum: least, maximum: most } = minMax(counts);
    if (most > 10 * least) {
      result.warn(
        `Severe task imbalance: most common task has ${(most / least).toFixed(1)}x more episodes than least common (${most} vs ${least})`,
      );
    }
  }
  return result.build();
}

export function checkConsistency(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Feature Consistency");
  if (dataset.episodesData.length === 0) {
    result.warn("No episode data loaded");
    return result.build();
  }
  if (dataset.episodesData.length < 2) {
    result.pass(
      "Only 1 episode loaded, cross-episode consistency check skipped",
    );
    return result.build();
  }
  const reference = dataset.episodesData[0];
  const referenceColumns = new Set(Object.keys(reference.columns));
  const referenceShape = new Map<string, string>();
  const referenceKind = new Map<string, string>();
  for (const [name, values] of Object.entries(reference.columns)) {
    if (SKIP_COLUMNS.has(name) || values.length === 0) continue;
    referenceShape.set(name, JSON.stringify(valueShape(values[0])));
    referenceKind.set(name, valueKind(values[0]));
  }
  const missing: Array<[number, string[]]> = [];
  const extra: Array<[number, string[]]> = [];
  const shapeMismatches: Array<[number, string, string, string]> = [];
  const kindMismatches: Array<[number, string, string, string]> = [];
  for (const episode of dataset.episodesData.slice(1)) {
    const columns = new Set(Object.keys(episode.columns));
    const missingNames = [...referenceColumns].filter(
      (name) => !columns.has(name) && !SKIP_COLUMNS.has(name),
    );
    const extraNames = [...columns].filter(
      (name) => !referenceColumns.has(name) && !SKIP_COLUMNS.has(name),
    );
    if (missingNames.length > 0)
      missing.push([episode.episodeIndex, missingNames]);
    if (extraNames.length > 0) extra.push([episode.episodeIndex, extraNames]);
    for (const name of [...referenceColumns].filter((columnName) =>
      columns.has(columnName),
    )) {
      if (SKIP_COLUMNS.has(name) || episode.columns[name].length === 0)
        continue;
      const shape = JSON.stringify(valueShape(episode.columns[name][0]));
      const kind = valueKind(episode.columns[name][0]);
      if (referenceShape.has(name) && shape !== referenceShape.get(name)) {
        shapeMismatches.push([
          episode.episodeIndex,
          name,
          referenceShape.get(name) ?? "unknown",
          shape,
        ]);
      }
      if (referenceKind.has(name) && kind !== referenceKind.get(name)) {
        kindMismatches.push([
          episode.episodeIndex,
          name,
          referenceKind.get(name) ?? "unknown",
          kind,
        ]);
      }
    }
  }
  if (missing.length > 0) {
    result.fail(
      `${missing.length} episode(s) missing features present in episode ${reference.episodeIndex}: ${missing
        .slice(0, 5)
        .map(
          ([episode, names]) => `(episode ${episode}, [${names.join(", ")}])`,
        )
        .join(", ")}`,
    );
  }
  if (extra.length > 0) {
    result.warn(
      `${extra.length} episode(s) have extra features not in episode ${reference.episodeIndex}: ${extra
        .slice(0, 5)
        .map(
          ([episode, names]) => `(episode ${episode}, [${names.join(", ")}])`,
        )
        .join(", ")}`,
    );
  }
  if (shapeMismatches.length > 0) {
    result.fail(
      `${shapeMismatches.length} shape mismatch(es) across episodes: ${shapeMismatches
        .slice(0, 5)
        .map(
          ([episode, name, expected, actual]) =>
            `(episode ${episode}, ${name}, ${expected}->${actual})`,
        )
        .join(", ")}`,
    );
  }
  if (kindMismatches.length > 0) {
    result.warn(
      `${kindMismatches.length} dtype mismatch(es) across episodes: ${kindMismatches
        .slice(0, 5)
        .map(
          ([episode, name, expected, actual]) =>
            `(episode ${episode}, ${name}, ${expected}->${actual})`,
        )
        .join(", ")}`,
    );
  }
  if (
    missing.length === 0 &&
    extra.length === 0 &&
    shapeMismatches.length === 0 &&
    kindMismatches.length === 0
  ) {
    result.pass(
      `All ${dataset.episodesData.length} episodes have consistent features (${[...referenceColumns].filter((name) => !SKIP_COLUMNS.has(name)).length} data columns)`,
    );
  }
  for (const episode of dataset.episodesData.slice(0, 10)) {
    for (const [name, values] of Object.entries(episode.columns)) {
      if (SKIP_COLUMNS.has(name) || values.length < 2) continue;
      const shapes = new Set(
        values.slice(0, 5).map((value) => JSON.stringify(valueShape(value))),
      );
      if (shapes.size > 1) {
        result.fail(
          `Episode ${episode.episodeIndex}, feature '${name}': inconsistent shapes within episode: ${[...shapes].join(", ")}`,
        );
      }
    }
  }
  return result.build();
}

export function checkTraining(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Training Readiness");
  if (!dataset.info) {
    result.fail("Cannot check training readiness: info.json not loaded");
    return result.build();
  }
  const features = dataset.info.features;
  const hasActions = Object.keys(features).some((name) =>
    name.startsWith("action"),
  );
  const hasState = Object.keys(features).some((name) => name.includes("state"));
  const hasImages = Object.values(features).some(
    (feature) => feature.dtype === "image" || feature.dtype === "video",
  );
  if (!hasActions) {
    result.fail("No action features found -- cannot train any policy");
    return result.build();
  }
  result.pass("Action features found");
  if (hasState) result.pass("State observation features found");
  if (hasImages) result.pass("Image/video features found");
  if (!hasState) {
    result.warn("ACT (Action Chunking Transformer): no state features");
    result.warn("Diffusion (Diffusion Policy): no state features");
  }
  if (!hasImages)
    result.warn("VLA (Vision-Language-Action): no image/video features");

  if (dataset.statsError) {
    result.fail(
      "stats.json exists but is invalid -- training will fail on normalization",
    );
  } else if (!dataset.stats) {
    result.warn(
      "No stats.json -- normalization will need to be computed before training",
    );
  } else {
    const actionStats = Object.entries(dataset.stats).filter(([name]) =>
      name.startsWith("action"),
    );
    if (actionStats.length === 0) {
      result.warn(
        "stats.json has no action statistics -- normalization may fail",
      );
    } else {
      for (const [name, raw] of actionStats) {
        if (!isRecord(raw)) {
          result.warn(`stats.json[${name}] is not an object`);
          continue;
        }
        const missing = ["mean", "std"].filter((field) => !(field in raw));
        if (missing.length > 0) {
          result.warn(
            `stats.json[${name}] missing [${missing.join(", ")}] -- some normalizers may fail`,
          );
          continue;
        }
        const standardDeviation = Array.isArray(raw.std) ? raw.std : [raw.std];
        const zeroDimensions = standardDeviation.filter(
          (value) => numberValue(value, null) === 0,
        ).length;
        if (zeroDimensions > 0) {
          result.warn(
            `stats.json[${name}]: ${zeroDimensions} dimension(s) have zero std -- normalization will produce NaN/Inf`,
          );
        }
      }
      result.pass("Normalization statistics available for actions");
    }
  }

  const firstActionName = Object.keys(
    dataset.episodesData[0]?.columns ?? {},
  ).find((name) => name.startsWith("action"));
  if (firstActionName) {
    const matrix = matrixForEpisode(dataset.episodesData[0], firstActionName);
    if (matrix && matrix[0].length > 20) {
      result.warn(
        `${firstActionName}: ${matrix[0].length} dimensions is unusually large -- verify this is correct`,
      );
    }
  }
  if (dataset.info.fps && dataset.episodesData.length > 0) {
    const { minimum: shortest } = minMax(
      dataset.episodesData.map((episode) => episode.length),
    );
    for (const future of [1, 10, 16, 50, 100]) {
      if (shortest < future + 1) {
        if (future <= 16) {
          result.warn(
            `Shortest episode (${shortest} frames) is too short for delta_timestamps with ${future}-step prediction horizon`,
          );
        }
        break;
      }
    }
  }
  return result.build();
}
