/**
 * Client for the dataset trash routes. Deleting a dataset moves it to
 * `<root>/.xense-viewer/trash/`; emptying the trash is what frees the disk.
 */

import type { TrashEntry } from "@/utils/datasetTrash";
import { tStandalone } from "@/i18n/standalone";

const TRASH_URL = "/api/local-datasets/trash";

export type TrashSummary = {
  entries: TrashEntry[];
  count: number;
  bytes: number;
};

/** Move one dataset to the trash. Resolves with the recorded entry. */
export async function trashDataset(
  encodedPath: string,
  signal?: AbortSignal,
): Promise<TrashEntry> {
  const response = await fetch(`/api/local-datasets/${encodedPath}/trash`, {
    method: "POST",
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Delete failed (${response.status})`);
  }
  return payload.trashed as TrashEntry;
}

export async function fetchTrash(signal?: AbortSignal): Promise<TrashSummary> {
  const response = await fetch(TRASH_URL, { signal });
  if (!response.ok)
    throw new Error(
      tStandalone("err.trashListFailed", { status: response.status }),
    );
  return (await response.json()) as TrashSummary;
}

/** Permanently delete everything in the trash. */
export async function emptyTrash(
  signal?: AbortSignal,
): Promise<{ removed: number; bytes: number }> {
  const response = await fetch(TRASH_URL, { method: "DELETE", signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error || `Empty trash failed (${response.status})`,
    );
  }
  return payload as { removed: number; bytes: number };
}
