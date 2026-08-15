"use client";

import React, { useCallback, useEffect, useState } from "react";
import { formatBytes, type TrashEntry } from "@/utils/datasetTrash";
import {
  emptyTrash,
  fetchTrash,
  trashDataset,
} from "@/utils/datasetTrashClient";

/**
 * Delete confirmation and the trash strip that goes with it.
 *
 * Deleting moves the dataset to `<root>/.xense-viewer/trash/`, so the dialog's
 * job is to be honest about two things: this is reversible, and it does not
 * free the disk until the trash is emptied. The genuinely destructive control
 * is the one on the strip, which is why that one asks a second time.
 */

type DeleteDialogProps = {
  relativePath: string;
  encodedPath: string;
  episodes: number;
  onClose: () => void;
  onDeleted: (entry: TrashEntry) => void;
};

export function DeleteDatasetDialog({
  relativePath,
  encodedPath,
  episodes,
  onClose,
  onDeleted,
}: DeleteDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onDeleted(await trashDataset(encodedPath));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Delete dataset"
        className="panel-raised w-full max-w-lg overflow-hidden rounded-lg border border-red-500/30"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-white/10 bg-[var(--surface-1)]/60 px-5 py-3">
          <h2 className="text-sm font-semibold text-red-200">Delete dataset</h2>
          <p
            className="mt-0.5 truncate font-mono text-xs text-slate-400"
            title={relativePath}
          >
            {relativePath}
          </p>
        </header>

        <div className="space-y-3 px-5 py-4 text-sm text-slate-300">
          <p>
            Moves the whole directory
            {episodes > 0 && (
              <>
                {" "}
                — <span className="tabular">{episodes}</span> episode
                {episodes === 1 ? "" : "s"}, including video
              </>
            )}{" "}
            into{" "}
            <span className="font-mono text-xs text-slate-200">
              .xense-viewer/trash/
            </span>
            .
          </p>
          <p className="text-xs text-slate-400">
            Reversible: move the directory back out of the trash to restore it.
            The disk space is only freed once you empty the trash.
          </p>
          {error && (
            <p className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-white/10 bg-[var(--surface-1)]/40 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-white/10 px-3.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:text-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="rounded-md bg-red-500/90 px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Moving…" : "Move to trash"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * One line showing what is recoverable and what it costs in disk. Renders
 * nothing when the trash is empty, which is the normal state.
 */
export function TrashStrip({ refreshKey }: { refreshKey: number }) {
  const [summary, setSummary] = useState<{
    count: number;
    bytes: number;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchTrash(signal);
      setSummary({ count: data.count, bytes: data.bytes });
    } catch {
      setSummary(null); // a trash we cannot read is not worth a red banner
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload, refreshKey]);

  if (!summary || summary.count === 0) return null;

  const purge = async () => {
    setBusy(true);
    setError(null);
    try {
      await emptyTrash();
      setConfirming(false);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-white/10 bg-[var(--surface-1)]/40 px-3 py-2 text-xs text-slate-400">
      <span>
        Trash: <span className="tabular text-slate-200">{summary.count}</span>{" "}
        dataset{summary.count === 1 ? "" : "s"} ·{" "}
        <span className="tabular text-slate-200">
          {formatBytes(summary.bytes)}
        </span>{" "}
        still on disk
      </span>
      {confirming ? (
        <span className="flex items-center gap-2">
          <span className="text-red-300">Delete permanently?</span>
          <button
            type="button"
            onClick={purge}
            disabled={busy}
            className="rounded border border-red-500/50 bg-red-500/15 px-2 py-0.5 text-red-200 transition-colors hover:bg-red-500/25 disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Yes, empty it"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="rounded border border-white/10 px-2 py-0.5 transition-colors hover:text-slate-200 disabled:opacity-50"
          >
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded border border-white/10 px-2 py-0.5 transition-colors hover:border-red-400/50 hover:text-red-200"
        >
          Empty trash
        </button>
      )}
      {error && <span className="text-red-300">{error}</span>}
    </div>
  );
}
