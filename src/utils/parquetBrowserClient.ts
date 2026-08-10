/**
 * Client for the Parquet browser routes
 * (`/api/local-datasets/<encodedPath>/parquet` and `…/parquet/read`).
 */

import type {
  ParquetFilesResponse,
  ParquetReadResponse,
} from "@/types/parquet-browser.types";

function parquetBase(encodedPath: string): string {
  return `/api/local-datasets/${encodedPath}/parquet`;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { cache: "no-store", signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** List the dataset's parquet files; `episode` also resolves that episode's row range. */
export function fetchParquetFiles(
  encodedPath: string,
  episode?: number,
  signal?: AbortSignal,
): Promise<ParquetFilesResponse> {
  const query =
    episode === undefined || !Number.isInteger(episode)
      ? ""
      : `?episode=${episode}`;
  return getJson<ParquetFilesResponse>(
    `${parquetBase(encodedPath)}${query}`,
    signal,
  );
}

/** Read one file's schema and row count without decoding any rows. */
export function fetchParquetInfo(
  encodedPath: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<ParquetReadResponse> {
  const query = new URLSearchParams({ path: relPath, meta: "1" });
  return getJson<ParquetReadResponse>(
    `${parquetBase(encodedPath)}/read?${query}`,
    signal,
  );
}

export function fetchParquetPage(
  encodedPath: string,
  relPath: string,
  options: {
    offset: number;
    limit: number;
    columns: string[];
    signal?: AbortSignal;
  },
): Promise<ParquetReadResponse> {
  const query = new URLSearchParams({
    path: relPath,
    offset: String(options.offset),
    limit: String(options.limit),
  });
  for (const column of options.columns) query.append("col", column);

  return getJson<ParquetReadResponse>(
    `${parquetBase(encodedPath)}/read?${query}`,
    options.signal,
  );
}
