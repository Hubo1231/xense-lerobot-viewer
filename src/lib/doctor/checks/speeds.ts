import {
  DEFAULT_DOCTOR_SPEED_THRESHOLDS,
  type DoctorSpeedThresholds,
} from "@/types/doctor.types";
import { worldAngularVelocityDegreesPerSecond } from "@/utils/poseVelocity";
import { getColumnMatrices } from "../analysis";
import { numericMatrix } from "../math";
import {
  DoctorCheckBuilder,
  type DoctorEpisodeData,
  type LoadedDoctorDataset,
} from "../model";

const AXES = ["x", "y", "z"] as const;
const ROTATION_COMPONENTS = ["r1", "r2", "r3", "r4", "r5", "r6"] as const;
const SKIP_COLUMNS = new Set([
  "timestamp",
  "frame_index",
  "episode_index",
  "index",
  "task_index",
]);
const MAX_EVENTS_PER_EPISODE = 5;

type Axis = (typeof AXES)[number];
type RotationComponent = (typeof ROTATION_COMPONENTS)[number];

interface TcpPoseGroup {
  pose: string;
  positionIndices: Partial<Record<Axis, number>>;
  rotationIndices: Partial<Record<RotationComponent, number>>;
}

interface SpeedViolation {
  label: string;
  value: number;
  limit: number;
  unit: "m/s" | "deg/s";
}

interface SpeedLimitEvent {
  index: number;
  score: number;
  violations: SpeedViolation[];
}

function signalColumns(dataset: LoadedDoctorDataset): string[] {
  return Object.keys(dataset.episodesData[0]?.columns ?? {}).filter(
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

function discoverTcpPoseGroups(
  dataset: LoadedDoctorDataset,
  columnName: string,
  dimensions: number,
): TcpPoseGroup[] {
  const names = dataset.info?.features[columnName]?.names;
  if (!Array.isArray(names)) return [];

  const groups = new Map<string, TcpPoseGroup>();
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    const name = names[dimension];
    if (typeof name !== "string") continue;
    const match = /^(.+)\.(x|y|z|r[1-6])$/.exec(name);
    if (!match) continue;
    const pose = match[1];
    const component = match[2];
    const group = groups.get(pose) ?? {
      pose,
      positionIndices: {},
      rotationIndices: {},
    };
    if (AXES.includes(component as Axis)) {
      group.positionIndices[component as Axis] = dimension;
    } else {
      group.rotationIndices[component as RotationComponent] = dimension;
    }
    groups.set(pose, group);
  }

  return [...groups.values()]
    .filter(
      (group) =>
        AXES.every((axis) => group.positionIndices[axis] !== undefined) ||
        ROTATION_COMPONENTS.every(
          (component) => group.rotationIndices[component] !== undefined,
        ),
    )
    .sort((left, right) => left.pose.localeCompare(right.pose));
}

function hasPosition(group: TcpPoseGroup): boolean {
  return AXES.every((axis) => group.positionIndices[axis] !== undefined);
}

function hasRotation(group: TcpPoseGroup): boolean {
  return ROTATION_COMPONENTS.every(
    (component) => group.rotationIndices[component] !== undefined,
  );
}

function deltaSeconds(
  timestamps: number[][] | null,
  index: number,
  fps: number | null | undefined,
): number | null {
  const current = timestamps?.[index]?.[0];
  const previous = timestamps?.[index - 1]?.[0];
  if (
    typeof current === "number" &&
    Number.isFinite(current) &&
    typeof previous === "number" &&
    Number.isFinite(previous) &&
    current > previous
  ) {
    return current - previous;
  }
  return typeof fps === "number" && Number.isFinite(fps) && fps > 0
    ? 1 / fps
    : null;
}

function collectViolations(
  previous: number[],
  current: number[],
  delta: number,
  group: TcpPoseGroup,
  thresholds: DoctorSpeedThresholds,
): SpeedViolation[] {
  const violations: SpeedViolation[] = [];

  if (hasPosition(group)) {
    for (const axis of AXES) {
      const dimension = group.positionIndices[axis];
      if (dimension === undefined) continue;
      const value = (current[dimension] - previous[dimension]) / delta;
      if (
        Number.isFinite(value) &&
        Math.abs(value) > thresholds.linearMetersPerSecond
      ) {
        violations.push({
          label: `v${axis}`,
          value,
          limit: thresholds.linearMetersPerSecond,
          unit: "m/s",
        });
      }
    }
  }

  if (hasRotation(group)) {
    const previousRotation = ROTATION_COMPONENTS.map(
      (component) => previous[group.rotationIndices[component]!],
    );
    const currentRotation = ROTATION_COMPONENTS.map(
      (component) => current[group.rotationIndices[component]!],
    );
    const angularVelocity = worldAngularVelocityDegreesPerSecond(
      previousRotation,
      currentRotation,
      delta,
    );
    if (angularVelocity) {
      for (const [axisIndex, axis] of AXES.entries()) {
        const value = angularVelocity[axisIndex];
        if (
          Number.isFinite(value) &&
          Math.abs(value) > thresholds.angularDegreesPerSecond
        ) {
          violations.push({
            label: `ω${axis}`,
            value,
            limit: thresholds.angularDegreesPerSecond,
            unit: "deg/s",
          });
        }
      }
    }
  }

  return violations;
}

function keepMostSevere(
  events: SpeedLimitEvent[],
  event: SpeedLimitEvent,
): void {
  events.push(event);
  events.sort((left, right) => right.score - left.score);
  if (events.length > MAX_EVENTS_PER_EPISODE) events.pop();
}

function formatEvent(
  episode: DoctorEpisodeData,
  columnName: string,
  pose: string,
  event: SpeedLimitEvent,
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
  const details = event.violations.map((violation) => {
    const digits = violation.unit === "m/s" ? 3 : 1;
    return `${violation.label} ${violation.value.toFixed(digits)} ${violation.unit} (limit ${violation.limit} ${violation.unit})`;
  });
  return `${columnName} ${pose} ${frameLabel}${timeLabel}: ${details.join(", ")}`;
}

/** Check per-axis TCP translation and world-frame angular speed limits. */
export function checkSpeedLimits(
  dataset: LoadedDoctorDataset,
  thresholds: DoctorSpeedThresholds = DEFAULT_DOCTOR_SPEED_THRESHOLDS,
) {
  const result = new DoctorCheckBuilder("TCP Speed Limit Detection");
  if (dataset.episodesData.length === 0) {
    result.warn("No episode data loaded");
    return result.build();
  }

  const byEpisode = new Map<number, string[]>();
  let discoveredGroups = 0;
  let evaluatedTransitions = 0;
  let totalEvents = 0;

  for (const columnName of signalColumns(dataset)) {
    const matrices = getColumnMatrices(dataset, columnName);
    const dimensions = matrices[0]?.matrix[0]?.length ?? 0;
    const poseGroups = discoverTcpPoseGroups(dataset, columnName, dimensions);
    discoveredGroups += poseGroups.length;

    for (const group of poseGroups) {
      let groupTransitions = 0;

      for (const { episode, matrix } of matrices) {
        if (matrix.length < 2) continue;
        const timestamps = matrixFor(episode, "timestamp");
        let episodeEvents = 0;
        const mostSevere: SpeedLimitEvent[] = [];

        for (let index = 1; index < matrix.length; index += 1) {
          const delta = deltaSeconds(timestamps, index, dataset.info?.fps);
          if (!delta) continue;
          groupTransitions += 1;
          evaluatedTransitions += 1;
          const violations = collectViolations(
            matrix[index - 1],
            matrix[index],
            delta,
            group,
            thresholds,
          );
          if (violations.length === 0) continue;

          episodeEvents += 1;
          totalEvents += 1;
          keepMostSevere(mostSevere, {
            index,
            score: Math.max(
              ...violations.map(
                (violation) => Math.abs(violation.value) / violation.limit,
              ),
            ),
            violations,
          });
        }

        if (episodeEvents === 0) continue;
        const details = mostSevere.map((event) =>
          formatEvent(episode, columnName, group.pose, event),
        );
        if (episodeEvents > MAX_EVENTS_PER_EPISODE) {
          details.push(`…and ${episodeEvents - MAX_EVENTS_PER_EPISODE} more`);
        }
        const existing = byEpisode.get(episode.episodeIndex) ?? [];
        existing.push(details.join("; "));
        byEpisode.set(episode.episodeIndex, existing);
      }

      if (groupTransitions === 0) {
        result.warn(
          `${columnName} ${group.pose}: speed limits could not be evaluated because valid frame timing was unavailable`,
        );
      }
    }
  }

  if (discoveredGroups === 0) {
    result.pass(
      "No complete TCP xyz or r1-r6 feature groups found; no speed checks needed",
    );
    return result.build();
  }

  for (const [episodeIndex, details] of [...byEpisode.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    result.warn(`Episode ${episodeIndex}: ${details.join(" | ")}`);
  }

  if (evaluatedTransitions === 0) {
    result.warn("No TCP speed transitions could be evaluated");
  } else if (totalEvents === 0) {
    result.pass(
      `No directional TCP speed limits exceeded (linear ${thresholds.linearMetersPerSecond} m/s; angular ${thresholds.angularDegreesPerSecond} deg/s)`,
    );
  }
  return result.build();
}
