import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  decodeLocalDatasetPath,
  resolveServerLocalDatasetPath,
} from "@/utils/datasetRoute";
import {
  normalizeAnnotation,
  type EpisodeSubtaskAnnotation,
} from "@/types/subtask.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pi-style subtask segmentation sidecar.
 *
 * Stored as `meta/annotations.json` in **JSONL** form — one JSON object per
 * line, one per episode — matching the vendor format some datasets already
 * ship. This route is the authoring source of truth for the Episodes-tab
 * Subtask panel; `scripts/export_subtasks.py` compiles it into lerobot-native
 * per-frame `subtask_index` + `meta/subtasks.parquet`.
 *
 * PUT is a per-episode read-modify-write: only the target episode's record is
 * replaced, every other line (and unknown keys such as vendor `key_frames`) is
 * preserved. If the existing file can't be parsed we refuse to overwrite it.
 */

const ANNOTATIONS_FILENAME = "annotations.json";

async function resolveDatasetDir(encodedPath: string): Promise<string | null> {
  let absolute: string;
  try {
    absolute = path.resolve(
      resolveServerLocalDatasetPath(decodeLocalDatasetPath(encodedPath)),
    );
  } catch {
    return null;
  }
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return absolute;
}

function annotationsFilePath(datasetDir: string): string {
  return path.join(datasetDir, "meta", ANNOTATIONS_FILENAME);
}

type RawRecord = Record<string, unknown>;

interface ReadResult {
  /** null when the file doesn't exist yet (an empty dataset is fine to seed). */
  records: RawRecord[] | null;
  /** true when the file exists but couldn't be parsed (refuse to clobber). */
  parseError: boolean;
}

/**
 * Read `meta/annotations.json`. Accepts line-delimited JSON (the vendor / our
 * own format), a single JSON array, or a single JSON object. Preserves each
 * record verbatim as a plain object for round-tripping.
 */
async function readAnnotations(datasetDir: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(annotationsFilePath(datasetDir), "utf-8");
  } catch {
    return { records: null, parseError: false };
  }
  const text = raw.trim();
  if (!text) return { records: [], parseError: false };

  // Whole-file JSON first (array or single object) — covers non-JSONL variants.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return { records: parsed.filter(isObject), parseError: false };
    }
    if (isObject(parsed)) return { records: [parsed], parseError: false };
  } catch {
    /* fall through to line-delimited parsing */
  }

  // Line-delimited JSON.
  const records: RawRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (isObject(obj)) records.push(obj);
    } catch {
      return { records: null, parseError: true };
    }
  }
  return { records, parseError: false };
}

function isObject(v: unknown): v is RawRecord {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function recordEpisodeIndex(r: RawRecord): number | null {
  const v = r.episode_index;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Math.trunc(Number(v));
  }
  return null;
}

async function writeAnnotations(
  datasetDir: string,
  records: RawRecord[],
): Promise<void> {
  const metaDir = path.join(datasetDir, "meta");
  await fs.mkdir(metaDir, { recursive: true });
  const target = annotationsFilePath(datasetDir);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(tmp, payload, "utf-8");
  await fs.rename(tmp, target);
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const datasetDir = await resolveDatasetDir(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }
  const { records } = await readAnnotations(datasetDir);
  const list = records ?? [];

  const episodeParam = req.nextUrl.searchParams.get("episode");
  if (episodeParam !== null) {
    const target = Number(episodeParam);
    const found = list.find((r) => recordEpisodeIndex(r) === target) ?? null;
    return Response.json({ annotation: found });
  }
  return Response.json({ annotations: list });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const datasetDir = await resolveDatasetDir(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const b = body as RawRecord;
  const episodeIndex = recordEpisodeIndex(b);
  if (episodeIndex === null) {
    return Response.json(
      { error: "episode_index (number) is required" },
      { status: 400 },
    );
  }

  const { records, parseError } = await readAnnotations(datasetDir);
  if (parseError) {
    return Response.json(
      {
        error:
          "Existing meta/annotations.json is not valid JSON/JSONL; refusing to overwrite it.",
      },
      { status: 409 },
    );
  }
  const list = records ?? [];
  const existing =
    list.find((r) => recordEpisodeIndex(r) === episodeIndex) ?? null;

  // Preserve the last segment's end (client-computed) by normalizing against a
  // lastFrame that is at least the largest end / provided hint — normalizeSegments
  // otherwise pins the final segment's end to lastFrame.
  const provided =
    typeof b.last_frame_index === "number" ? b.last_frame_index : 0;
  const maxEnd = Array.isArray(b.instruction_segments)
    ? b.instruction_segments.reduce<number>((m, s) => {
        const e =
          isObject(s) && typeof s.end_frame_index === "number"
            ? s.end_frame_index
            : 0;
        return Math.max(m, e);
      }, 0)
    : 0;
  const lastFrame = Math.max(provided, maxEnd);

  const incoming: EpisodeSubtaskAnnotation = normalizeAnnotation(
    b,
    episodeIndex,
    lastFrame,
  );
  // Drop the transient hint so it never lands on disk.
  delete (incoming as RawRecord).last_frame_index;

  // Merge: keep the existing record's extra keys (e.g. vendor `key_frames`)
  // unless the incoming body overrides them.
  const merged: RawRecord = { ...(existing ?? {}), ...incoming };

  const nextList = existing
    ? list.map((r) => (recordEpisodeIndex(r) === episodeIndex ? merged : r))
    : [...list, merged];

  try {
    await writeAnnotations(datasetDir, nextList);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to write annotations file",
      },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    episode_index: episodeIndex,
    segments: incoming.instruction_segments.length,
    path: annotationsFilePath(datasetDir),
  });
}
