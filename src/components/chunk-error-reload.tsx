"use client";

import { useEffect } from "react";

/**
 * Self-heal for `ChunkLoadError`.
 *
 * When Next.js rebuilds (a dev recompile/restart, or a production redeploy) the
 * hashed `_next/static/chunks/*` filenames change. A browser tab opened against
 * the previous build still references the old chunk names, so the next lazy
 * chunk load (e.g. navigating into the heavy episode route) 404s and throws
 * `ChunkLoadError`. A single full reload fetches the current manifest and fixes
 * it. Guarded against reload loops via a short sessionStorage cooldown so a
 * genuinely broken chunk surfaces the normal error UI instead of looping.
 */
const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading chunk [^\s]+ failed|Loading CSS chunk [^\s]+ failed|Failed to fetch dynamically imported module/i;
const RELOAD_GUARD_KEY = "__chunk_reload_at";
const RELOAD_COOLDOWN_MS = 10_000;

function isChunkError(message?: string | null, name?: string | null): boolean {
  if (name === "ChunkLoadError") return true;
  return !!message && CHUNK_ERROR_RE.test(message);
}

function reloadOnce(): void {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? "0");
  } catch {
    // sessionStorage unavailable (private mode etc.) — proceed to reload once.
  }
  if (Date.now() - last < RELOAD_COOLDOWN_MS) return; // avoid reload loops
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // ignore
  }
  window.location.reload();
}

export default function ChunkErrorReload() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (isChunkError(e.message || e.error?.message, e.error?.name)) {
        reloadOnce();
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const message = typeof reason === "string" ? reason : reason?.message;
      if (isChunkError(message, reason?.name)) {
        reloadOnce();
      }
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
