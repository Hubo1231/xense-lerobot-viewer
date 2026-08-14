import { NextRequest } from "next/server";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manual Hugging Face sync — the viewer's only outbound network path.
 *
 * Browsing stays entirely local; this runs when someone presses Sync and
 * nowhere else. Transfers go through hf-mirror (see `scripts/sync_hf_dataset.py`).
 *
 * Two shapes:
 *   POST { source }                  → fast listing, transfers nothing
 *   POST { source, confirm: true }   → NDJSON stream of the actual download
 *
 * The listing step is not optional politeness. `lerobot` is a public HF org with
 * ~188 datasets against 5 held locally; syncing it unprompted would pull
 * hundreds of gigabytes. The caller has to see the count and come back.
 */

/** Org names become a path segment under the dataset root, so anything that
 *  could climb out of it is rejected outright. */
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const HF_MIRROR = "https://hf-mirror.com";
const LIST_TIMEOUT_MS = 120_000;

/** One sync at a time, process-wide: concurrent runs would write the same files. */
let activeSync: { source: string; startedAt: number } | null = null;

type SyncResult = {
  org: string;
  endpoint: string;
  repos: string[];
  downloaded: number;
  failed: { repo: string; error: string }[];
  listOnly: boolean;
};

function scriptPath(): string {
  return path.join(process.cwd(), "scripts", "sync_hf_dataset.py");
}

function spawnSync(args: string[]): ChildProcessWithoutNullStreams {
  const py = process.env.PYTHON_BIN || "python3";
  return spawn(py, [scriptPath(), ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Belt and braces: the script also defaults this, but setting it here
      // means the mirror holds even if the script is run through a wrapper.
      HF_ENDPOINT: process.env.HF_ENDPOINT || HF_MIRROR,
    },
  });
}

/** Run the script to completion, returning its parsed `result` event. */
function runToCompletion(
  args: string[],
  timeoutMs: number,
): Promise<{ result: SyncResult | null; error: string | null }> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnSync(args);
    } catch (err) {
      resolve({ result: null, error: `Failed to launch Python: ${err}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (payload: {
      result: SyncResult | null;
      error: string | null;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ result: null, error: `Timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      finish({
        result: null,
        error: `Failed to launch Python: ${err.message}. Is python3 installed?`,
      }),
    );
    child.on("close", () => {
      let result: SyncResult | null = null;
      let error: string | null = null;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "result") result = event.result as SyncResult;
          else if (event.type === "error") error = String(event.error);
        } catch {
          // A partial line is not fatal; the result event is what matters.
        }
      }
      finish({
        result,
        error:
          error ??
          (result ? null : stderr.trim().split(/\r?\n/).pop() || "Sync failed"),
      });
    });
  });
}

/** Pipe the script's NDJSON straight through to the client as it arrives. */
function streamDownload(source: string, root: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (obj: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already torn down */
          }
        };

        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawnSync(["--org", source, "--root", root]);
        } catch (err) {
          send({ type: "error", error: `Failed to launch Python: ${err}` });
          activeSync = null;
          close();
          return;
        }

        // The script reports its own failures as an error event and then exits
        // non-zero. Track that, or the generic exit-code message below would
        // land second and overwrite the diagnosis the user actually needs.
        let sentError = false;

        // The script emits one JSON object per line; hold a buffer because a
        // chunk boundary can land mid-line.
        let buffer = "";
        const forward = (line: string) => {
          if (!line.trim()) return;
          try {
            const event = JSON.parse(line);
            if (event?.type === "error") sentError = true;
            send(event);
          } catch {
            /* ignore an unparseable line rather than killing the stream */
          }
        };
        child.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) forward(line);
        });

        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d.toString()));

        child.on("error", (err) => {
          send({ type: "error", error: `Python failed: ${err.message}` });
          activeSync = null;
          close();
        });

        child.on("close", (code) => {
          forward(buffer);
          // Only synthesise an error when the script died without explaining
          // itself — a crash or a kill. Otherwise its own message stands.
          if (code !== 0 && !sentError) {
            send({
              type: "error",
              error:
                stderr.trim().split(/\r?\n/).pop() ||
                `Sync exited with code ${code} and no output.`,
            });
          }
          activeSync = null;
          close();
        });
      },
      cancel() {
        // Client navigated away; the child keeps running to completion so a
        // half-written dataset directory isn't left behind.
        activeSync = null;
      },
    }),
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store, no-transform",
      },
    },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: { source?: unknown; confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!source || !SOURCE_PATTERN.test(source)) {
    return Response.json(
      { error: "`source` must be a plain Hugging Face org name." },
      { status: 400 },
    );
  }

  let root: string;
  try {
    root = resolveLocalDatasetRoot();
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }

  if (activeSync) {
    return Response.json(
      { error: `A sync of ${activeSync.source} is already running.` },
      { status: 409 },
    );
  }

  // Listing pass — cheap, transfers nothing, and always runs first.
  if (body.confirm !== true) {
    const { result, error } = await runToCompletion(
      ["--org", source, "--root", root, "--list-only"],
      LIST_TIMEOUT_MS,
    );
    if (!result) {
      return Response.json(
        { error: error ?? "Listing failed" },
        { status: 502 },
      );
    }
    return Response.json({
      source,
      endpoint: result.endpoint,
      repos: result.repos,
      count: result.repos.length,
      confirmRequired: true,
    });
  }

  activeSync = { source, startedAt: Date.now() };
  return streamDownload(source, root);
}
