#!/usr/bin/env python3
"""Sync every dataset of a Hugging Face org into the local dataset root.

This is the one outbound network path in an otherwise local-only viewer, and it
only ever runs when someone presses Sync. Downloads go through **hf-mirror.com**
unless HF_ENDPOINT is already set in the environment.

Why Python rather than the JS side: `huggingface_hub.snapshot_download` gives
resumable, incremental, parallel transfers of multi-GB repos for free, and
already picks up the cached CLI token (`~/.cache/huggingface/token`) so private
org repos work with no extra secret handling. The same reasoning put
`export_subtasks.py` here.

Protocol: one JSON object per line on stdout, matching the viewer's other
streaming route:

    {"type":"progress","progress":{...}}
    {"type":"result","result":{...}}
    {"type":"error","error":"..."}

Usage:
    sync_hf_dataset.py --org TacVerse --root /path/to/lerobot [--list-only]
                       [--limit N] [--repo A --repo B]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

# Both must precede any huggingface_hub import — they are read at module load.
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# huggingface_hub 1.x prefers Xet-backed transfers, which hf-mirror does not
# proxy: every download fails with "cannot find the requested files in the local
# cache". Falling back to plain HTTP resolution is what makes the mirror usable.
# Only forced when we are actually pointed at a mirror, so a direct-to-Hub run
# (HF_ENDPOINT overridden) keeps the faster Xet path.
if "hf-mirror" in os.environ.get("HF_ENDPOINT", ""):
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def emit(obj: dict) -> None:
    """Write one NDJSON event and flush — the reader streams these live."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(**fields) -> None:
    emit({"type": "progress", "progress": fields})


def fail(message: str) -> int:
    emit({"type": "error", "error": message})
    return 1


def list_org_repos(org: str, limit: int | None) -> list[str]:
    from huggingface_hub import list_datasets

    # `direction=` was dropped in huggingface_hub 1.x; `sort` alone already
    # returns newest-first. Passing it would raise on the installed version.
    repos = [d.id for d in list_datasets(author=org, sort="lastModified")]
    return repos[:limit] if limit else repos


MIRROR_HINT = (
    "The endpoint answers requests with a 308 redirect to huggingface.co "
    "instead of serving files, and huggingface_hub refuses the redirect "
    "because it carries no X-Repo-Commit header. Listing works; downloading "
    "does not.\n"
    "  A China-facing mirror commonly does this when the request arrives from "
    "a foreign IP — check whether a VPN or transparent proxy is capturing the "
    "mirror's own hostname, and add it to the proxy's direct/bypass rules if "
    "so. While it redirects, the mirror also saves no proxy bandwidth: every "
    "byte still comes from huggingface.co.\n"
    "  To download now: HF_ENDPOINT=https://huggingface.co"
)


def make_reporter(repo_id: str, index: int, total: int):
    """A tqdm stand-in that emits NDJSON instead of drawing bars.

    Repo-level counting alone is useless here: a 313-repo org advances 0.3% per
    repo, and a single multi-GB repo can sit at the same number for minutes with
    no sign of life. `snapshot_download` drives one bar for the file count and
    one per file for bytes, so subclassing gives both without touching its
    internals.
    """
    from huggingface_hub.utils import tqdm as hf_tqdm

    state = {"bytes": 0, "files_done": 0, "files_total": 0, "last_emit": 0.0}

    class Reporter(hf_tqdm):  # type: ignore[misc]
        def __init__(self, *a, **kw):
            self._is_file_counter = "Fetching" in str(kw.get("desc") or "")
            if self._is_file_counter:
                state["files_total"] = kw.get("total") or 0
                state["files_done"] = 0
            super().__init__(*a, **kw)

        def update(self, n=1):
            if self._is_file_counter:
                state["files_done"] += n or 0
            else:
                # Byte-level bar for one file in flight.
                state["bytes"] += n or 0
            self._emit()
            return super().update(n)

        def _emit(self, force: bool = False) -> None:
            now = time.time()
            # Two updates a second is enough to look alive without flooding the
            # stream with thousands of events on a large transfer.
            if not force and now - state["last_emit"] < 0.5:
                return
            state["last_emit"] = now
            files_total = state["files_total"] or 0
            within = (state["files_done"] / files_total) if files_total else 0.0
            progress(
                phase="downloading",
                repo=repo_id,
                index=index,
                total=total,
                # Overall percent blends completed repos with progress inside
                # the current one, so the number always moves.
                percent=round(((index - 1) + within) / total * 100, 1),
                repoPercent=round(within * 100, 1),
                filesDone=state["files_done"],
                filesTotal=files_total,
                bytes=state["bytes"],
            )

        def close(self):
            if self._is_file_counter:
                self._emit(force=True)
            return super().close()

    return Reporter


def preflight(repo_id: str) -> str | None:
    """Resolve one small file before committing to the whole org.

    Without this the endpoint problem only surfaces after the first repo has
    already been attempted, once per repo, with an error that says nothing
    actionable. Returns None when downloads work, or a diagnostic message.
    """
    from huggingface_hub import hf_hub_download
    import tempfile

    endpoint = os.environ.get("HF_ENDPOINT", "")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            hf_hub_download(
                repo_id=repo_id,
                filename="meta/info.json",
                repo_type="dataset",
                local_dir=tmp,
            )
        return None
    except Exception as exc:
        name = type(exc).__name__
        if name in ("LocalEntryNotFoundError", "FileMetadataError"):
            if "hf-mirror" in endpoint or endpoint not in ("", "https://huggingface.co"):
                return f"{endpoint} cannot serve downloads. {MIRROR_HINT}"
            return f"Could not reach the Hub: {exc}"
        # Anything else (auth, missing repo) is reported as-is by the caller.
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", required=True, help="Hugging Face org / author")
    parser.add_argument("--root", required=True, help="local dataset root")
    parser.add_argument(
        "--list-only",
        action="store_true",
        help="report what would be downloaded, transfer nothing",
    )
    parser.add_argument(
        "--repo",
        action="append",
        default=[],
        help="restrict to these repo ids (repeatable); default is the whole org",
    )
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    endpoint = os.environ.get("HF_ENDPOINT", "")
    progress(phase="listing", endpoint=endpoint, org=args.org, percent=0)

    try:
        repos = args.repo or list_org_repos(args.org, args.limit)
    except Exception as exc:  # network down, bad token, unknown org
        return fail(f"Could not list datasets for {args.org}: {exc}")

    if not repos:
        emit({
            "type": "result",
            "result": {
                "org": args.org, "endpoint": endpoint, "repos": [],
                "downloaded": 0, "failed": [], "listOnly": args.list_only,
            },
        })
        return 0

    if args.list_only:
        # The gate the UI uses to show a confirmation before pulling anything.
        emit({
            "type": "result",
            "result": {
                "org": args.org, "endpoint": endpoint, "repos": repos,
                "downloaded": 0, "failed": [], "listOnly": True,
            },
        })
        return 0

    # Fail fast and legibly rather than once per repo with a library message
    # that names neither the endpoint nor the fix.
    progress(phase="preflight", percent=0)
    blocker = preflight(repos[0])
    if blocker:
        return fail(blocker)

    from huggingface_hub import snapshot_download

    total = len(repos)
    downloaded = 0
    failed: list[dict] = []

    for i, repo_id in enumerate(repos):
        # `<root>/<org>/<name>` — the layout the viewer's scanner expects.
        leaf = repo_id.split("/")[-1]
        target = os.path.join(args.root, args.org, leaf)
        progress(
            phase="downloading",
            repo=repo_id,
            index=i + 1,
            total=total,
            percent=round(i / total * 100),
        )
        try:
            snapshot_download(
                repo_id=repo_id,
                repo_type="dataset",
                local_dir=target,
                # Resumes partial transfers and skips files already identical,
                # so re-running after an interruption is cheap.
                max_workers=4,
                tqdm_class=make_reporter(repo_id, i + 1, total),
            )
            downloaded += 1
        except Exception as exc:
            # One bad repo must not abandon the rest of the org.
            failed.append({"repo": repo_id, "error": str(exc)})
            progress(phase="failed", repo=repo_id, index=i + 1, total=total)

    progress(phase="complete", total=total, percent=100)
    emit({
        "type": "result",
        "result": {
            "org": args.org,
            "endpoint": endpoint,
            "repos": repos,
            "downloaded": downloaded,
            "failed": failed,
            "listOnly": False,
        },
    })
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(fail("Sync cancelled"))
    except Exception:
        sys.exit(fail(traceback.format_exc(limit=3)))
