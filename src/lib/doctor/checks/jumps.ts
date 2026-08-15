import {
  findStandardizedDimensionJumps,
  numericMatrix,
  summaryStandardDeviations,
} from "../math";
import { getColumnDiffSummary, getColumnMatrices } from "../analysis";
import {
  DoctorCheckBuilder,
  type DoctorEpisodeData,
  type LoadedDoctorDataset,
} from "../model";
import {
  DOCTOR_DIMENSION_JUMP_REPORT_Z_THRESHOLD,
  DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS,
  type DoctorDimensionJumpThresholds,
} from "@/types/doctor.types";

const SKIP_COLUMNS = new Set([
  "timestamp",
  "frame_index",
  "episode_index",
  "index",
  "task_index",
]);

const MIN_COORDINATED_DIMENSIONS = 2;
const MAX_EVENTS_PER_EPISODE = 5;

function maximum(values: number[]): number {
  let value = Number.NEGATIVE_INFINITY;
  for (const candidate of values) {
    if (candidate > value) value = candidate;
  }
  return value;
}

function signalColumns(dataset: LoadedDoctorDataset): string[] {
  const columns = Object.keys(dataset.episodesData[0]?.columns ?? {});
  return columns.filter(
    (name) =>
      !SKIP_COLUMNS.has(name) &&
      (name.startsWith("action") || name.includes("state")),
  );
}

function matrixFor(
  episode: DoctorEpisodeData,
  columnName: string,
): number[][] | null {
  const values = episode.columns[columnName];
  return values ? numericMatrix(values) : null;
}

function featureNames(
  dataset: LoadedDoctorDataset,
  columnName: string,
  dimensions: number,
): string[] {
  const names = dataset.info?.features[columnName]?.names;
  return Array.from({ length: dimensions }, (_, dimension) => {
    const name = Array.isArray(names) ? names[dimension] : undefined;
    return typeof name === "string" && name.trim() !== ""
      ? name
      : `${columnName}[${dimension}]`;
  });
}

function formatEvent(
  dataset: LoadedDoctorDataset,
  episode: DoctorEpisodeData,
  columnName: string,
  matrix: number[][],
  event: ReturnType<typeof findStandardizedDimensionJumps>[number],
): string {
  const timestamps = matrixFor(episode, "timestamp");
  const frameIndices = matrixFor(episode, "frame_index");
  const timestamp = timestamps?.[event.index]?.[0];
  const frameIndex = frameIndices?.[event.index]?.[0];
  const frameLabel = Number.isFinite(frameIndex)
    ? `frame ${frameIndex}`
    : `row ${event.index}`;
  const timeLabel =
    typeof timestamp === "number" && Number.isFinite(timestamp)
      ? ` @${timestamp.toFixed(2)}s`
      : "";
  const names = featureNames(dataset, columnName, matrix[0]?.length ?? 0);
  const dimensions = event.dimensions.map(
    (dimension) =>
      `${names[dimension]} (${event.zScores[dimension].toFixed(1)}σ)`,
  );
  return `${columnName} ${frameLabel}${timeLabel}: ${dimensions.join(", ")}`;
}

/**
 * Additional continuity check for coordinated, dimension-level jumps.
 *
 * The existing Action Quality check intentionally remains Python-compatible
 * and uses the mean z-score across all dimensions. This check catches a
 * different failure mode: a small subset of coordinates jumping together,
 * which the mean can hide in a high-dimensional vector.
 */
export function checkDimensionJumps(
  dataset: LoadedDoctorDataset,
  thresholds: DoctorDimensionJumpThresholds = DEFAULT_DOCTOR_DIMENSION_JUMP_THRESHOLDS,
) {
  const result = new DoctorCheckBuilder("Dimension-Level Jump Detection");
  if (dataset.episodesData.length === 0) {
    result.warn("No episode data loaded");
    return result.build();
  }

  const columns = signalColumns(dataset);
  if (columns.length === 0) {
    result.pass(
      "No action/state vectors found; no dimension jump checks needed",
    );
    return result.build();
  }

  const byEpisode = new Map<number, string[]>();
  let totalEvents = 0;
  let totalFlaggedEpisodes = 0;

  for (const columnName of columns) {
    const diffSummary = getColumnDiffSummary(dataset, columnName);
    if (!diffSummary) continue;
    const standardDeviations = summaryStandardDeviations(diffSummary, 1);
    let columnEvents = 0;
    let columnEpisodes = 0;

    for (const { episode, matrix } of getColumnMatrices(dataset, columnName)) {
      if (matrix.length < 2) continue;
      const events = findStandardizedDimensionJumps(
        matrix,
        standardDeviations,
        {
          threshold: thresholds.dimensionZThreshold,
          minDimensions: MIN_COORDINATED_DIMENSIONS,
          extremeThreshold: thresholds.extremeSingleDimensionZ,
          reportThreshold: DOCTOR_DIMENSION_JUMP_REPORT_Z_THRESHOLD,
        },
      );
      if (events.length === 0) continue;

      columnEpisodes += 1;
      columnEvents += events.length;
      const details = [...events]
        .sort((left, right) => maximum(right.zScores) - maximum(left.zScores))
        .slice(0, MAX_EVENTS_PER_EPISODE)
        .map((event) =>
          formatEvent(dataset, episode, columnName, matrix, event),
        );
      if (events.length > MAX_EVENTS_PER_EPISODE) {
        details.push(`…and ${events.length - MAX_EVENTS_PER_EPISODE} more`);
      }
      const existing = byEpisode.get(episode.episodeIndex) ?? [];
      existing.push(details.join("; "));
      byEpisode.set(episode.episodeIndex, existing);
    }

    if (columnEpisodes > 0) {
      totalEvents += columnEvents;
      totalFlaggedEpisodes += columnEpisodes;
      result.warn(
        `${columnName}: ${columnEpisodes}/${dataset.episodesData.length} episode(s) contain ${columnEvents} severe dimension-level jump event(s) (>=${MIN_COORDINATED_DIMENSIONS} dimensions >${thresholds.dimensionZThreshold}σ or one >${thresholds.extremeSingleDimensionZ}σ)`,
      );
    } else {
      result.pass(`${columnName}: no dimension-level jumps detected`);
    }
  }

  for (const [episode, details] of [...byEpisode.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    result.warn(`Episode ${episode}: ${details.join(" | ")}`);
  }

  if (totalEvents === 0) {
    result.pass(
      "No dimension-level discontinuities detected in action/state data",
    );
  } else if (totalFlaggedEpisodes > 0) {
    result.warn(
      `Detected dimension-level discontinuities in ${byEpisode.size} episode(s); inspect the episode/time/feature details above`,
    );
  }
  return result.build();
}
