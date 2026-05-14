"""Compare two PlumeLens evaluation manifests.

The input files are JSON documents emitted by ``evals/run_eval.py``. Run with
``uv run python evals/report.py base.json candidate.json``. The report is intentionally
schema-light so it remains useful while private golden datasets evolve.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def _load(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        msg = f"{path} is not a JSON object"
        raise ValueError(msg)
    return data


def _numeric_metrics(data: dict[str, Any]) -> dict[str, float]:
    raw = data.get("metrics", {})
    if not isinstance(raw, dict):
        return {}
    metrics: dict[str, float] = {}
    for key, value in raw.items():
        if isinstance(value, int | float):
            metrics[key] = float(value)
    return metrics


def compare(base: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    base_metrics = _numeric_metrics(base)
    candidate_metrics = _numeric_metrics(candidate)
    keys = sorted(set(base_metrics) | set(candidate_metrics))
    deltas = {
        key: {
            "base": base_metrics.get(key),
            "candidate": candidate_metrics.get(key),
            "delta": candidate_metrics.get(key, 0.0) - base_metrics.get(key, 0.0),
        }
        for key in keys
    }
    return {
        "schema_version": 1,
        "base_pipeline_version": base.get("pipeline_version"),
        "candidate_pipeline_version": candidate.get("pipeline_version"),
        "base_status": base.get("status"),
        "candidate_status": candidate.get("status"),
        "metric_deltas": deltas,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)

    report = compare(_load(args.base), _load(args.candidate))
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(f"{payload}\n", encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
