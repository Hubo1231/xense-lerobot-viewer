import { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  decodeLocalDatasetPath,
  resolveServerLocalDatasetPath,
} from "@/utils/datasetRoute";
import {
  PythonUnavailableError,
  pythonSpawnEnv,
  resolvePython,
  type ResolvedPython,
} from "@/lib/python-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compile the Pi-style `meta/annotations.json` into lerobot-native per-frame
 * `subtask_index` + `meta/subtasks.parquet` by invoking the Python exporter
 * (`scripts/export_subtasks.py`) — pyarrow is used because it round-trips the
 * `list<float>` action/state columns faithfully, which the JS writer can't.
 */

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

interface PyResult {
  ok: boolean;
  message?: string;
  error?: string;
  path?: string | null;
}

async function runExporter(datasetDir: string): Promise<{
  code: number | null;
  result: PyResult | null;
  stderr: string;
}> {
  // pandas/pyarrow rarely live in the first `python3` on PATH, so the
  // interpreter is resolved instead of assumed (see `@/lib/python-runtime`).
  let python: ResolvedPython;
  try {
    python = await resolvePython(["pandas", "pyarrow"]);
  } catch (err) {
    return {
      code: null,
      result: {
        ok: false,
        error:
          err instanceof PythonUnavailableError ? err.message : String(err),
      },
      stderr: "",
    };
  }

  return new Promise((resolve) => {
    const script = path.join(process.cwd(), "scripts", "export_subtasks.py");
    const py = python.bin;
    const child = spawn(py, [script, datasetDir, "--yes", "--json"], {
      cwd: process.cwd(),
      env: pythonSpawnEnv(),
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      resolve({
        code: null,
        result: {
          ok: false,
          error: `Failed to launch ${py}: ${err.message}. Is Python installed?`,
        },
        stderr,
      });
    });
    child.on("close", (code) => {
      // The script prints a single JSON summary line on stdout (--json).
      let result: PyResult | null = null;
      const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (lastLine && lastLine.startsWith("{")) {
        try {
          result = JSON.parse(lastLine) as PyResult;
        } catch {
          result = null;
        }
      }
      resolve({ code, result, stderr });
    });
  });
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const datasetDir = await resolveDatasetDir(encodedPath);
  if (!datasetDir) {
    return Response.json({ error: "Dataset not found" }, { status: 404 });
  }

  const { code, result, stderr } = await runExporter(datasetDir);

  if (result?.ok) {
    return Response.json({ message: result.message, path: result.path });
  }

  const error =
    result?.error ||
    (stderr.trim().split(/\r?\n/).pop() ?? `Export failed (exit ${code}).`);
  return Response.json({ error }, { status: 500 });
}
