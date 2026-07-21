/**
 * Client for the Pi-style subtask sidecar (`meta/annotations.json`).
 *
 * Talks to `/api/local-datasets/<encodedPath>/subtasks` (read/write the JSONL
 * segmentation) and `/subtasks/export` (compile to lerobot-native
 * `subtask_index` + `meta/subtasks.parquet` via the Python script).
 */

import type { EpisodeSubtaskAnnotation } from "@/types/subtask.types";
import { normalizeAnnotation } from "@/types/subtask.types";

function subtasksBase(encodedPath: string): string {
  return `/api/local-datasets/${encodedPath}/subtasks`;
}

/** Fetch one episode's annotation record, or null when none exists yet. */
export async function fetchEpisodeSubtasks(
  encodedPath: string,
  episode: number,
): Promise<EpisodeSubtaskAnnotation | null> {
  try {
    const res = await fetch(`${subtasksBase(encodedPath)}?episode=${episode}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { annotation?: unknown };
    if (!data.annotation) return null;
    return normalizeAnnotation(data.annotation, episode);
  } catch {
    return null;
  }
}

/** Persist one episode's annotation (merged server-side into the JSONL file). */
export async function saveEpisodeSubtasks(
  encodedPath: string,
  ann: EpisodeSubtaskAnnotation,
  lastFrame: number,
): Promise<{ path: string | null }> {
  const res = await fetch(subtasksBase(encodedPath), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...ann, last_frame_index: lastFrame }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => `${res.status}`);
    throw new Error(text || `save subtasks: ${res.status}`);
  }
  const data = (await res.json().catch(() => ({}))) as { path?: string | null };
  return { path: data.path ?? null };
}

export interface ExportResult {
  ok: boolean;
  message: string;
  path?: string | null;
}

/**
 * Trigger the Python compile → `subtask_index` (data parquet) +
 * `meta/subtasks.parquet`. Optionally scoped to a single episode.
 */
export async function exportSubtasksToDataset(
  encodedPath: string,
  episode?: number,
): Promise<ExportResult> {
  try {
    const res = await fetch(`${subtasksBase(encodedPath)}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(episode != null ? { episode } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      path?: string | null;
    };
    if (!res.ok) {
      return {
        ok: false,
        message: data.error || `Export failed (${res.status})`,
      };
    }
    return {
      ok: true,
      message: data.message || "Exported subtasks to dataset.",
      path: data.path ?? null,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
