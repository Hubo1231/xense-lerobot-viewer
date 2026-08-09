/**
 * `GET /api/local-datasets/<encodedPath>/parquet`
 *
 * Lists every parquet file in a dataset (stat only — no parsing), so the
 * Parquet tab can render a file picker. `?episode=N` additionally resolves
 * where that episode's rows live, for the "jump to this episode" shortcut.
 */

import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import { locateEpisodeRows } from "@/lib/parquet-server";
import {
  classifyParquetPath,
  compareParquetEntries,
} from "@/utils/parquetBrowser";
import type {
  ParquetFileEntry,
  ParquetFilesResponse,
} from "@/types/parquet-browser.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SCAN_DEPTH = 6;
const MAX_FILES = 5000;
const IGNORE_DIRS = new Set([
  ".cache",
  ".git",
  "node_modules",
  "__pycache__",
  "videos",
  "images",
]);

async function collectParquetFiles(
  root: string,
  dir: string,
  depth: number,
  out: ParquetFileEntry[],
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_FILES) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      await collectParquetFiles(root, absolute, depth + 1, out);
      continue;
    }

    if (
      !entry.isFile() ||
      path.extname(entry.name).toLowerCase() !== ".parquet"
    ) {
      continue;
    }

    let size = 0;
    try {
      size = Number((await fs.stat(absolute)).size);
    } catch {
      continue;
    }

    const relPath = path.relative(root, absolute).split(path.sep).join("/");
    out.push({ relPath, group: classifyParquetPath(relPath), size });
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
) {
  const { encodedPath } = await ctx.params;
  const root = resolveDatasetRoot(encodedPath);
  if (!root) return new Response("Not found", { status: 404 });

  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return new Response("Not found", { status: 404 });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const files: ParquetFileEntry[] = [];
  await collectParquetFiles(root, root, 0, files);
  files.sort(compareParquetEntries);

  const episodeParam = req.nextUrl.searchParams.get("episode");
  const episodeIndex = episodeParam === null ? null : Number(episodeParam);
  const episodeLocator =
    episodeIndex !== null && Number.isInteger(episodeIndex) && episodeIndex >= 0
      ? await locateEpisodeRows(root, episodeIndex).catch(() => null)
      : null;

  const payload: ParquetFilesResponse = { files, episodeLocator };
  return Response.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
