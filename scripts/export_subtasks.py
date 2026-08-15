#!/usr/bin/env python3
"""Compile Pi-style subtask segmentation into lerobot-native subtask columns.

Reads the authoring sidecar ``meta/annotations.json`` (JSONL, one record per
episode, produced by the Episodes-tab Subtask panel) and writes:

  * a per-frame ``subtask_index`` column into every ``data/**/*.parquet`` file,
  * ``meta/subtasks.parquet`` mapping ``subtask_index -> subtask string``
    (mirroring ``meta/tasks.parquet``: the string is the pandas index
    ``__index_level_0__`` and ``subtask_index`` is a column),
  * a ``subtask_index`` feature (+ ``total_subtasks``) into ``meta/info.json``.

so lerobot exposes ``sample["subtask"]`` at train time, exactly like ``task``.

Design notes / safety:
  * Data parquet is rewritten with **pyarrow** (not pandas) so the ``list<float>``
    ``action`` / ``observation.state`` columns keep their exact element type; only
    an int64 column is appended.
  * Every rewrite is verified (row count + byte-for-byte equality of the
    untouched columns) before the original is replaced. A ``.bak`` copy is kept.
  * Frames not covered by any segment (an episode's unlabeled head, or an episode
    with no annotation at all) fall back to that frame's own ``task`` string as a
    single-subtask span, so the column is always fully populated.
  * ``subtask_index`` values are stable across runs: an existing
    ``meta/subtasks.parquet`` mapping is preserved and only appended to.

Usage:
    python3 scripts/export_subtasks.py /path/to/dataset [--yes] [--json] [--dry-run]

Requires: pandas, pyarrow (see scripts/requirements.txt).
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import shutil
import sys
from typing import Any


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def die(msg: str, as_json: bool) -> "NoReturn":  # type: ignore[name-defined]
    if as_json:
        print(json.dumps({"ok": False, "error": msg}))
    else:
        log("ERROR: " + msg)
    sys.exit(1)


def read_annotations_jsonl(path: str) -> dict[int, dict[str, Any]]:
    """Parse the JSONL / array / single-object annotations sidecar."""
    if not os.path.isfile(path):
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read().strip()
    if not text:
        return {}
    records: list[dict[str, Any]] = []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            records = [r for r in parsed if isinstance(r, dict)]
        elif isinstance(parsed, dict):
            records = [parsed]
    except json.JSONDecodeError:
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)  # let a genuine parse error surface
            if isinstance(obj, dict):
                records.append(obj)
    out: dict[int, dict[str, Any]] = {}
    for r in records:
        ei = r.get("episode_index")
        if isinstance(ei, (int, float)):
            out[int(ei)] = r
    return out


def load_task_map(dataset_dir: str, version: str) -> dict[int, str]:
    """task_index -> task string, from tasks.parquet (v3) or tasks.jsonl (v2)."""
    import pandas as pd

    tasks_parquet = os.path.join(dataset_dir, "meta", "tasks.parquet")
    tasks_jsonl = os.path.join(dataset_dir, "meta", "tasks.jsonl")
    mapping: dict[int, str] = {}
    if os.path.isfile(tasks_parquet):
        df = pd.read_parquet(tasks_parquet)
        # lerobot stores the task string as the (index) and task_index as a column.
        df = df.reset_index()
        str_col = "__index_level_0__" if "__index_level_0__" in df.columns else None
        if str_col is None:
            # fall back to a column literally named "task"
            str_col = "task" if "task" in df.columns else df.columns[0]
        for _, row in df.iterrows():
            mapping[int(row["task_index"])] = str(row[str_col])
    elif os.path.isfile(tasks_jsonl):
        with open(tasks_jsonl, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                mapping[int(obj["task_index"])] = str(obj.get("task", ""))
    return mapping


def load_existing_subtask_map(dataset_dir: str) -> dict[str, int]:
    """Preserve subtask_index assignments from a prior export, if any."""
    path = os.path.join(dataset_dir, "meta", "subtasks.parquet")
    if not os.path.isfile(path):
        return {}
    import pandas as pd

    df = pd.read_parquet(path).reset_index()
    str_col = "__index_level_0__" if "__index_level_0__" in df.columns else None
    if str_col is None:
        str_col = "subtask" if "subtask" in df.columns else df.columns[0]
    out: dict[str, int] = {}
    for _, row in df.iterrows():
        out[str(row[str_col])] = int(row["subtask_index"])
    return out


def build_segment_index(
    annotations: dict[int, dict[str, Any]],
) -> dict[int, tuple[list[int], list[str]]]:
    """episode_index -> (sorted start frames, aligned instruction strings)."""
    out: dict[int, tuple[list[int], list[str]]] = {}
    for ei, rec in annotations.items():
        segs = rec.get("instruction_segments") or []
        pairs: list[tuple[int, str]] = []
        for s in segs:
            if not isinstance(s, dict):
                continue
            instr = s.get("instruction")
            if not isinstance(instr, str) or not instr.strip():
                continue
            start = int(s.get("start_frame_index", 0) or 0)
            pairs.append((start, instr.strip()))
        pairs.sort(key=lambda p: p[0])
        if pairs:
            out[ei] = ([p[0] for p in pairs], [p[1] for p in pairs])
    return out


def write_subtasks_parquet(dataset_dir: str, vocab: list[str]) -> str:
    """Write meta/subtasks.parquet mirroring meta/tasks.parquet's shape."""
    import pandas as pd

    path = os.path.join(dataset_dir, "meta", "subtasks.parquet")
    df = pd.DataFrame(
        {"subtask_index": list(range(len(vocab)))},
        index=pd.Index(vocab),  # unnamed -> serialized as __index_level_0__
    )
    tmp = f"{path}.tmp-{os.getpid()}"
    df.to_parquet(tmp, engine="pyarrow", compression="snappy")
    os.replace(tmp, path)
    return path


def rewrite_data_file(
    path: str,
    seg_index: dict[int, tuple[list[int], list[str]]],
    str_to_idx: dict[str, int],
    task_map: dict[int, str],
    dry_run: bool,
) -> int:
    """Add/refresh the subtask_index column for one data parquet. Returns rows."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    orig = pq.read_table(path)
    n = orig.num_rows
    ep = orig.column("episode_index").to_pylist()
    fi = orig.column("frame_index").to_pylist()
    ti = (
        orig.column("task_index").to_pylist()
        if "task_index" in orig.column_names
        else [0] * n
    )

    sub_idx: list[int] = []
    for e, f, t in zip(ep, fi, ti):
        chosen: int | None = None
        seg = seg_index.get(int(e)) if e is not None else None
        if seg is not None:
            starts, instrs = seg
            k = bisect.bisect_right(starts, int(f)) - 1
            # Full coverage: head frames before the first segment belong to the
            # first subtask (the frontend already pins it to frame 0; this keeps
            # externally-authored annotations.json fully covered too).
            if k < 0:
                k = 0
            chosen = str_to_idx[instrs[k]]
        if chosen is None:
            # Episode with no annotation at all: fall back to its own task
            # string as a single whole-episode subtask.
            fallback_str = task_map.get(int(t) if t is not None else 0, "")
            chosen = str_to_idx.get(fallback_str, 0)
        sub_idx.append(chosen)

    base = orig
    if "subtask_index" in orig.column_names:
        base = orig.drop(["subtask_index"])
    out = base.append_column(
        "subtask_index", pa.array(sub_idx, type=pa.int64())
    )

    if dry_run:
        return n

    tmp = f"{path}.tmp-{os.getpid()}"
    pq.write_table(out, tmp, compression="snappy")

    # Verify: row count + every untouched column identical before we replace.
    check = pq.read_table(tmp)
    if check.num_rows != n:
        os.remove(tmp)
        raise RuntimeError(
            f"row count changed for {path}: {n} -> {check.num_rows}"
        )
    for name in base.column_names:
        if not base.column(name).equals(check.column(name)):
            os.remove(tmp)
            raise RuntimeError(
                f"column '{name}' changed during rewrite of {path}"
            )

    shutil.copy2(path, f"{path}.bak")  # keep the previous state
    os.replace(tmp, path)
    return n


def update_info_json(dataset_dir: str, total_subtasks: int, dry_run: bool) -> None:
    path = os.path.join(dataset_dir, "meta", "info.json")
    with open(path, "r", encoding="utf-8") as fh:
        info = json.load(fh)
    features = info.setdefault("features", {})
    features["subtask_index"] = {"dtype": "int64", "shape": [1], "names": None}
    info["total_subtasks"] = total_subtasks
    if dry_run:
        return
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(info, fh, indent=4)
        fh.write("\n")
    os.replace(tmp, path)


def main() -> None:
    ap = argparse.ArgumentParser(description="Compile subtasks into lerobot columns")
    ap.add_argument("dataset_dir", help="Path to the LeRobot dataset directory")
    ap.add_argument("--yes", action="store_true", help="skip interactive confirm")
    ap.add_argument("--json", action="store_true", help="emit a JSON result line")
    ap.add_argument("--dry-run", action="store_true", help="compute but don't write")
    args = ap.parse_args()
    as_json = args.json

    try:
        import pandas  # noqa: F401
        import pyarrow  # noqa: F401
    except Exception as exc:  # pragma: no cover - env dependent
        die(
            f"pandas + pyarrow are required, and {sys.executable} does not have "
            f"them ({exc}). Install them there "
            f"({sys.executable} -m pip install -r scripts/requirements.txt), or "
            "set PYTHON_BIN to an interpreter that already has them.",
            as_json,
        )

    dataset_dir = os.path.abspath(args.dataset_dir)
    info_path = os.path.join(dataset_dir, "meta", "info.json")
    if not os.path.isfile(info_path):
        die(f"not a dataset (no meta/info.json): {dataset_dir}", as_json)

    with open(info_path, "r", encoding="utf-8") as fh:
        info = json.load(fh)
    version = str(info.get("codebase_version", "v3.0"))

    annotations = read_annotations_jsonl(
        os.path.join(dataset_dir, "meta", "annotations.json")
    )
    if not annotations:
        die("no meta/annotations.json subtasks to export", as_json)

    task_map = load_task_map(dataset_dir, version)
    seg_index = build_segment_index(annotations)

    # Vocabulary: preserve existing indices, then add task strings, then segment
    # instructions (deterministic order → stable subtask_index across runs).
    str_to_idx = load_existing_subtask_map(dataset_dir)
    vocab: list[str] = [""] * len(str_to_idx)
    for s, i in str_to_idx.items():
        if i < len(vocab):
            vocab[i] = s

    def ensure(s: str) -> None:
        if s not in str_to_idx:
            str_to_idx[s] = len(vocab)
            vocab.append(s)

    for _, s in sorted(task_map.items()):
        ensure(s)
    for ei in sorted(seg_index):
        for instr in seg_index[ei][1]:
            ensure(instr)

    data_files = []
    data_root = os.path.join(dataset_dir, "data")
    for root, _dirs, files in os.walk(data_root):
        for f in files:
            if f.endswith(".parquet"):
                data_files.append(os.path.join(root, f))
    data_files.sort()
    if not data_files:
        die(f"no data parquet files under {data_root}", as_json)

    log(
        f"[export] version={version} episodes_annotated={len(seg_index)} "
        f"subtasks={len(vocab)} data_files={len(data_files)}"
    )
    if not args.yes and not args.dry_run:
        resp = input(
            f"Rewrite {len(data_files)} data parquet file(s) in {dataset_dir}? [y/N] "
        )
        if resp.strip().lower() not in ("y", "yes"):
            die("aborted by user", as_json)

    subtasks_path = None
    if not args.dry_run:
        subtasks_path = write_subtasks_parquet(dataset_dir, vocab)

    total_rows = 0
    for i, path in enumerate(data_files, 1):
        rows = rewrite_data_file(
            path, seg_index, str_to_idx, task_map, args.dry_run
        )
        total_rows += rows
        log(f"[export] ({i}/{len(data_files)}) {os.path.relpath(path, dataset_dir)} · {rows} rows")

    update_info_json(dataset_dir, len(vocab), args.dry_run)

    message = (
        f"{'(dry-run) ' if args.dry_run else ''}Wrote subtask_index for "
        f"{total_rows} frames across {len(data_files)} file(s); "
        f"{len(vocab)} subtasks in meta/subtasks.parquet."
    )
    log("[export] " + message)
    if as_json:
        print(
            json.dumps(
                {
                    "ok": True,
                    "message": message,
                    "path": subtasks_path,
                    "subtasks": len(vocab),
                    "frames": total_rows,
                    "files": len(data_files),
                }
            )
        )


if __name__ == "__main__":
    main()
