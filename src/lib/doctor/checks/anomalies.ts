import {
  allClose,
  countStandardizedJumps,
  maxConsecutiveEqualRows,
  numericMatrix,
  summaryStandardDeviations,
} from "../math";
import {
  getColumnDiffSummary,
  getColumnSummary,
  summarizeDatasetColumn,
} from "../analysis";
import {
  DoctorCheckBuilder,
  type DoctorEpisodeData,
  type LoadedDoctorDataset,
} from "../model";
import { actionColumns } from "./core";

const SKIP_COLUMNS = new Set([
  "timestamp",
  "frame_index",
  "episode_index",
  "index",
  "task_index",
]);

function matrixFor(
  episode: DoctorEpisodeData,
  columnName: string,
): number[][] | null {
  const values = episode.columns[columnName];
  return values ? numericMatrix(values) : null;
}

export function checkAnomalies(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Anomaly Detection");
  if (dataset.episodesData.length === 0) {
    result.warn("No episode data loaded");
    return result.build();
  }

  const stuck = new Map<string, number[]>();
  for (const episode of dataset.episodesData) {
    for (const columnName of Object.keys(episode.columns)) {
      if (
        SKIP_COLUMNS.has(columnName) ||
        (!columnName.startsWith("action") && !columnName.includes("state"))
      ) {
        continue;
      }
      const matrix = matrixFor(episode, columnName);
      if (!matrix || matrix.length < 5) continue;
      for (let dim = 0; dim < matrix[0].length; dim += 1) {
        let count = 0;
        let center = 0;
        let m2 = 0;
        let staticCount = 0;
        for (let row = 0; row < matrix.length; row += 1) {
          const value = matrix[row][dim];
          count += 1;
          const delta = value - center;
          center += delta / count;
          m2 += delta * (value - center);
          if (row > 0 && value === matrix[row - 1][dim]) staticCount += 1;
        }
        if (m2 === 0) continue;
        const diffCount = matrix.length - 1;
        const staticPercent = staticCount / diffCount;
        if (staticPercent > 0.8 && diffCount > 10) {
          const key = `${columnName}[${dim}]`;
          (stuck.get(key) ?? stuck.set(key, []).get(key))?.push(
            episode.episodeIndex,
          );
        }
      }
    }
  }
  for (const [label, episodes] of [...stuck.entries()].slice(0, 5)) {
    if (episodes.length > dataset.episodesData.length * 0.8) {
      result.warn(
        `${label}: stuck/static in ${episodes.length}/${dataset.episodesData.length} episodes (>80% unchanged each) -- possible stuck actuator or unused DOF`,
      );
    }
  }

  const fingerprints: Array<[number, number[]]> = [];
  for (const episode of dataset.episodesData) {
    const action = Object.keys(episode.columns).find((name) =>
      name.startsWith("action"),
    );
    if (!action) continue;
    const matrix = matrixFor(episode, action);
    if (!matrix?.length) continue;
    const count = Math.min(10, matrix.length);
    const first: number[] = [];
    const last: number[] = [];
    for (let row = 0; row < count && first.length < 20; row += 1) {
      for (const value of matrix[row]) {
        if (first.length >= 20) break;
        first.push(value);
      }
    }
    for (
      let row = matrix.length - count;
      row < matrix.length && last.length < 20;
      row += 1
    ) {
      for (const value of matrix[row]) {
        if (last.length >= 20) break;
        last.push(value);
      }
    }
    fingerprints.push([
      episode.episodeIndex,
      [...first, ...last, matrix.length],
    ]);
  }
  const duplicates: Array<[number, number]> = [];
  for (let left = 0; left < fingerprints.length; left += 1) {
    for (let right = left + 1; right < fingerprints.length; right += 1) {
      if (allClose(fingerprints[left][1], fingerprints[right][1])) {
        duplicates.push([fingerprints[left][0], fingerprints[right][0]]);
      }
    }
  }
  if (duplicates.length > 0) {
    result.warn(
      `${duplicates.length} near-duplicate episode pair(s) detected: [${duplicates
        .slice(0, 5)
        .map(([left, right]) => `(${left}, ${right})`)
        .join(", ")}${duplicates.length > 5 ? ", ..." : ""}]`,
    );
  }

  if (dataset.episodesData.length >= 10) {
    const count = Math.floor(dataset.episodesData.length / 4);
    const first = dataset.episodesData.slice(0, count);
    const last = dataset.episodesData.slice(-count);
    for (const columnName of Object.keys(dataset.episodesData[0].columns)) {
      if (
        SKIP_COLUMNS.has(columnName) ||
        (!columnName.startsWith("action") && !columnName.includes("state"))
      ) {
        continue;
      }
      const firstSummary = summarizeDatasetColumn(dataset, columnName, first);
      const lastSummary = summarizeDatasetColumn(dataset, columnName, last);
      if (!firstSummary || !lastSummary) continue;
      let maximumShift = 0;
      let maximumDimension = 0;
      for (let dim = 0; dim < firstSummary.dimensions; dim += 1) {
        const firstDimension = firstSummary.dimensionsSummary[dim];
        const lastDimension = lastSummary.dimensionsSummary[dim];
        const deviation =
          Math.sqrt(firstDimension.m2 / firstDimension.count) || 1;
        const shift =
          Math.abs(lastDimension.mean - firstDimension.mean) / deviation;
        if (shift > maximumShift) {
          maximumShift = shift;
          maximumDimension = dim;
        }
      }
      if (maximumShift > 3) {
        result.warn(
          `${columnName}: distribution shift detected between first and last quarter of episodes (dim ${maximumDimension}: ${maximumShift.toFixed(1)} std shift). Could indicate environment changes or operator drift.`,
        );
      }
    }
  }

  for (const columnName of Object.keys(dataset.episodesData[0].columns)) {
    if (
      SKIP_COLUMNS.has(columnName) ||
      columnName.startsWith("action") ||
      columnName.startsWith("next.")
    ) {
      continue;
    }
    const summary = getColumnSummary(dataset, columnName);
    if (!summary) continue;
    const constants: Array<[number, number]> = [];
    for (let dim = 0; dim < summary.dimensions; dim += 1) {
      const dimension = summary.dimensionsSummary[dim];
      if (dimension.count > 0 && dimension.m2 === 0) {
        constants.push([dim, dimension.minimum]);
      }
    }
    if (constants.length === summary.dimensions) {
      result.warn(
        `${columnName}: ALL ${constants.length} dimensions constant across ALL episodes -- possible broken sensor or unused feature`,
      );
    } else if (constants.length > 0) {
      result.warn(
        `${columnName}: ${constants.length} constant dimension(s) across ALL episodes: ${constants
          .slice(0, 5)
          .map(([dim, value]) => `dim ${dim} (=${value.toFixed(4)})`)
          .join(", ")} -- possible stuck sensor`,
      );
    }
  }
  return result.build();
}

export function checkPerEpisode(dataset: LoadedDoctorDataset) {
  const result = new DoctorCheckBuilder("Per-Episode Summary");
  if (dataset.episodesData.length === 0) {
    result.warn("No episode data loaded");
    return result.build();
  }
  const fps = dataset.info?.fps || 1;
  const actions = actionColumns(dataset);
  const diffStd = new Map<string, number[]>();
  for (const columnName of actions) {
    const summary = getColumnDiffSummary(dataset, columnName);
    if (summary) {
      diffStd.set(columnName, summaryStandardDeviations(summary, 1));
    }
  }
  const flagged = new Map<number, string[]>();

  for (const episode of dataset.episodesData) {
    const reasons: string[] = [];
    const shortThreshold = Math.max(5, fps);
    if (episode.length < shortThreshold) {
      reasons.push(
        `too short (${episode.length} frames, <${(shortThreshold / fps).toFixed(1)}s)`,
      );
    }
    if (episode.length <= 1) reasons.push("single frame (unusable)");
    const timestamps = matrixFor(episode, "timestamp")?.map((row) => row[0]);
    if (timestamps && timestamps.length > 1) {
      const diffs = timestamps
        .slice(1)
        .map((value, index) => value - timestamps[index]);
      if (diffs.some((value) => value <= 0))
        reasons.push("non-monotonic timestamps");
      const gaps = diffs.filter((value) => value > (1 / fps) * 2.5);
      if (gaps.length > 0) reasons.push(`${gaps.length} dropped frame(s)`);
    }
    for (const columnName of actions) {
      const matrix = matrixFor(episode, columnName);
      if (!matrix) continue;
      let hasNan = false;
      let hasInf = false;
      for (const row of matrix) {
        for (const value of row) {
          if (Number.isNaN(value)) hasNan = true;
          else if (!Number.isFinite(value)) hasInf = true;
        }
      }
      if (hasNan) reasons.push(`NaN in ${columnName}`);
      if (hasInf) reasons.push(`Inf in ${columnName}`);
      if (matrix.length < 2) continue;
      const percent = (maxConsecutiveEqualRows(matrix) / matrix.length) * 100;
      if (percent >= 5) {
        reasons.push(
          `${percent.toFixed(0)}% of ${columnName} frozen (consecutive identical)`,
        );
      }
      const standardDeviations = diffStd.get(columnName);
      if (standardDeviations && matrix.length >= 3) {
        const jumps = countStandardizedJumps(matrix, standardDeviations);
        if (jumps > 0) reasons.push(`${jumps} action jump(s) in ${columnName}`);
      }
    }
    if (reasons.length > 0) flagged.set(episode.episodeIndex, reasons);
  }
  if (flagged.size === 0) {
    result.pass(`All ${dataset.episodesData.length} episodes look clean`);
    return result.build();
  }
  result.warn(
    `${flagged.size}/${dataset.episodesData.length} episode(s) flagged`,
  );
  for (const [episode, reasons] of [...flagged.entries()].slice(0, 20)) {
    result.warn(`Episode ${episode}: ${reasons.join("; ")}`);
  }
  if (flagged.size > 20)
    result.warn(`...and ${flagged.size - 20} more flagged episodes`);
  return result.build();
}
