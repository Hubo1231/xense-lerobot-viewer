import LocalDatasetGrid from "./local-dataset-grid";
import { discoverLocalDatasets } from "@/lib/local-datasets-discovery";
import { recordDaySnapshot } from "@/lib/corpus-history-store";
import { computeCorpusStats } from "@/utils/corpusStats";
import { groupDatasetsByPrefix } from "@/utils/datasetGrouping";
import {
  computeDailyDelta,
  snapshotFromSources,
  type DailyDelta,
} from "@/utils/corpusHistory";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { root, datasets, errors } = await discoverLocalDatasets();

  // Record today's totals and diff against the last day on record. This is the
  // only write the browse path performs; `recordDaySnapshot` swallows its own
  // failures, so a read-only root just means no "new today" figures.
  const stats = computeCorpusStats(groupDatasetsByPrefix(datasets));
  const today = snapshotFromSources(stats.segments, new Date().toISOString());
  const { history, todayKey } = await recordDaySnapshot(today);
  const delta: DailyDelta = computeDailyDelta(history, today, todayKey);

  return (
    <LocalDatasetGrid
      root={root}
      datasets={datasets}
      errors={errors}
      delta={delta}
    />
  );
}
