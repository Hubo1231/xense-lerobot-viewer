import path from "node:path";
import {
  DOCTOR_CHECK_IDS,
  type DoctorCheckId,
  type DoctorCheckResult,
  type DoctorReport,
  type DoctorRunResponse,
  type DoctorSeverity,
} from "@/types/doctor.types";
import { loadDoctorDataset } from "./loader";
import { throwIfDoctorAborted, type LoadedDoctorDataset } from "./model";
import { checkAnomalies, checkPerEpisode } from "./checks/anomalies";
import {
  checkActions,
  checkConsistency,
  checkEpisodes,
  checkMetadata,
  checkStatistics,
  checkTemporal,
  checkTraining,
} from "./checks/core";
import { checkPortability, checkVideos } from "./checks/files";

export const TYPESCRIPT_DOCTOR_VERSION = "1.0.0-ts";

export interface RunDoctorOptions {
  maxEpisodes: number | null;
  checks?: DoctorCheckId[] | null;
  signal?: AbortSignal;
}

const CHECKS: Record<
  DoctorCheckId,
  (
    dataset: LoadedDoctorDataset,
  ) => DoctorCheckResult | Promise<DoctorCheckResult>
> = {
  metadata: checkMetadata,
  temporal: checkTemporal,
  actions: checkActions,
  videos: checkVideos,
  statistics: checkStatistics,
  episodes: checkEpisodes,
  consistency: checkConsistency,
  training: checkTraining,
  anomalies: checkAnomalies,
  portability: checkPortability,
  per_episode: checkPerEpisode,
};

function worstSeverity(checks: DoctorCheckResult[]): DoctorSeverity {
  if (checks.some((check) => check.severity === "FAIL")) return "FAIL";
  if (checks.some((check) => check.severity === "WARN")) return "WARN";
  return "PASS";
}

function countSeverity(
  checks: DoctorCheckResult[],
): Record<DoctorSeverity, number> {
  const counts: Record<DoctorSeverity, number> = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const check of checks) counts[check.severity] += 1;
  return counts;
}

export async function runTypeScriptDoctor(
  datasetRoot: string,
  options: RunDoctorOptions,
): Promise<DoctorRunResponse> {
  const startedAt = performance.now();
  const dataset = await loadDoctorDataset(datasetRoot, {
    maxEpisodes: options.maxEpisodes,
    signal: options.signal,
  });
  const selected = options.checks?.length
    ? options.checks
    : [...DOCTOR_CHECK_IDS];
  const checks: DoctorCheckResult[] = [];
  for (const checkId of selected) {
    throwIfDoctorAborted(options.signal);
    checks.push(await CHECKS[checkId](dataset));
    // Let request cancellation and the route timeout run between CPU-bound checks.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const info = dataset.info;
  const report: DoctorReport = {
    version: TYPESCRIPT_DOCTOR_VERSION,
    dataset_path: dataset.displayPath,
    dataset_name: path.basename(datasetRoot) || null,
    codebase_version: info?.codebaseVersion ?? null,
    format_version: info?.formatVersion ?? null,
    total_episodes: info?.totalEpisodes ?? null,
    total_frames: info?.totalFrames ?? null,
    fps: info?.fps ?? null,
    overall_severity: worstSeverity(checks),
    checks,
    summary: countSeverity(checks),
  };
  return {
    ok: true,
    report,
    execution: {
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      requested_max_episodes: options.maxEpisodes,
      loaded_episode_count: dataset.episodesData.length,
      loaded_episode_indices: dataset.episodesData.map(
        (episode) => episode.episodeIndex,
      ),
      engine: "typescript",
      cache_hit: false,
    },
  };
}
