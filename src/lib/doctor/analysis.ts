import type { DoctorEpisodeData, LoadedDoctorDataset } from "./model";
import {
  numericMatrix,
  summarizeMatrices,
  summarizeMatrixDiffs,
  type NumericMatrixSummary,
} from "./math";

export interface DoctorEpisodeMatrix {
  episode: DoctorEpisodeData;
  matrix: number[][];
}

interface CachedColumnAnalysis {
  episodes: DoctorEpisodeMatrix[];
  summary?: NumericMatrixSummary | null;
  diffSummary?: NumericMatrixSummary | null;
}

const analysisCache = new WeakMap<
  LoadedDoctorDataset,
  Map<string, CachedColumnAnalysis>
>();

function columnCache(
  dataset: LoadedDoctorDataset,
): Map<string, CachedColumnAnalysis> {
  let cache = analysisCache.get(dataset);
  if (!cache) {
    cache = new Map();
    analysisCache.set(dataset, cache);
  }
  return cache;
}

export function getColumnMatrices(
  dataset: LoadedDoctorDataset,
  columnName: string,
): DoctorEpisodeMatrix[] {
  const cache = columnCache(dataset);
  let analysis = cache.get(columnName);
  if (!analysis) {
    const episodes: DoctorEpisodeMatrix[] = [];
    for (const episode of dataset.episodesData) {
      const values = episode.columns[columnName];
      if (!values) continue;
      const matrix = numericMatrix(values);
      if (matrix) episodes.push({ episode, matrix });
    }
    analysis = { episodes };
    cache.set(columnName, analysis);
  }
  return analysis.episodes;
}

export function getColumnSummary(
  dataset: LoadedDoctorDataset,
  columnName: string,
): NumericMatrixSummary | null {
  const cache = columnCache(dataset);
  getColumnMatrices(dataset, columnName);
  const analysis = cache.get(columnName);
  if (!analysis) return null;
  if (!("summary" in analysis)) {
    analysis.summary = summarizeMatrices(
      analysis.episodes.map((item) => item.matrix),
    );
  }
  return analysis.summary ?? null;
}

export function summarizeDatasetColumn(
  dataset: LoadedDoctorDataset,
  columnName: string,
  episodes: DoctorEpisodeData[],
): NumericMatrixSummary | null {
  const selected = new Set(episodes);
  return summarizeMatrices(
    getColumnMatrices(dataset, columnName)
      .filter((item) => selected.has(item.episode))
      .map((item) => item.matrix),
  );
}

export function getColumnDiffSummary(
  dataset: LoadedDoctorDataset,
  columnName: string,
): NumericMatrixSummary | null {
  const cache = columnCache(dataset);
  getColumnMatrices(dataset, columnName);
  const analysis = cache.get(columnName);
  if (!analysis) return null;
  if (!("diffSummary" in analysis)) {
    analysis.diffSummary = summarizeMatrixDiffs(
      analysis.episodes.map((item) => item.matrix),
    );
  }
  return analysis.diffSummary ?? null;
}
