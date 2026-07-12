"use client";

import React, { useEffect } from "react";

const RELOAD_GUARD_KEY = "__chunk_reload_at";
const RELOAD_COOLDOWN_MS = 10_000;

function isChunkError(error: Error): boolean {
  return (
    error.name === "ChunkLoadError" ||
    /Loading chunk [^\s]+ failed|Loading CSS chunk [^\s]+ failed/i.test(
      error.message,
    )
  );
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // A stale client chunk (after a rebuild/redeploy) can bubble to this
  // boundary during navigation. Recover with a single guarded reload rather
  // than showing a scary error for something a refresh fixes.
  useEffect(() => {
    if (!isChunkError(error)) return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? "0");
    } catch {
      // ignore
    }
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return;
    try {
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch {
      // ignore
    }
    window.location.reload();
  }, [error]);

  return (
    <div className="flex h-screen items-center justify-center bg-slate-950 text-red-400">
      <div className="max-w-xl p-8 rounded bg-slate-900 border border-red-500 shadow-lg">
        <h2 className="text-2xl font-bold mb-4">Something went wrong</h2>
        <p className="text-lg font-mono whitespace-pre-wrap mb-4">
          {error.message}
        </p>
        <button
          className="mt-4 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
          onClick={() => reset()}
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
