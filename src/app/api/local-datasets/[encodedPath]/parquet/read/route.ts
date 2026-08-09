/**
 * `GET /api/local-datasets/<encodedPath>/parquet/read`
 *
 * Query params:
 *   path   — dataset-relative path to a `.parquet` file (required)
 *   meta   — `1` to return schema/metadata only, skipping the row decode
 *   offset — first row (default 0)
 *   limit  — rows to return (default 100, capped at MAX_LIMIT)
 *   col    — repeatable column projection; all columns when omitted
 */

import { NextRequest } from "next/server";
import { resolveDatasetRoot, statDatasetFile } from "@/lib/local-dataset-paths";
import { openParquet, readParquetPage } from "@/lib/parquet-server";
import type { ParquetReadResponse } from "@/types/parquet-browser.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parseCount(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
) {
  const { encodedPath } = await ctx.params;
  const params = req.nextUrl.searchParams;

  const relPath = params.get("path");
  if (!relPath) {
    return Response.json(
      { error: "Missing `path` parameter." },
      { status: 400 },
    );
  }
  if (!relPath.toLowerCase().endsWith(".parquet")) {
    return Response.json(
      { error: "Only .parquet files can be read here." },
      { status: 400 },
    );
  }

  // resolveDatasetRoot first so a bad encodedPath 404s before touching disk.
  if (!resolveDatasetRoot(encodedPath)) {
    return Response.json({ error: "Unknown dataset." }, { status: 404 });
  }

  const file = await statDatasetFile(encodedPath, relPath.split("/"));
  if (!file) {
    return Response.json(
      { error: `No such file: ${relPath}` },
      { status: 404 },
    );
  }

  try {
    const handle = await openParquet(
      file.absolutePath,
      relPath,
      file.size,
      file.mtimeMs,
    );

    if (params.get("meta") === "1") {
      const payload: ParquetReadResponse = { info: handle.info, page: null };
      return Response.json(payload, {
        headers: { "cache-control": "no-store" },
      });
    }

    const offset = parseCount(params.get("offset"), 0, Number.MAX_SAFE_INTEGER);
    const limit = parseCount(params.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
    const requested = params.getAll("col").filter(Boolean);

    const { columns, rows } = await readParquetPage(
      handle,
      offset,
      limit,
      requested,
    );

    const payload: ParquetReadResponse = {
      info: handle.info,
      page: { offset, limit, columns, rows },
    };
    return Response.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        error: `Failed to read ${relPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 500 },
    );
  }
}
