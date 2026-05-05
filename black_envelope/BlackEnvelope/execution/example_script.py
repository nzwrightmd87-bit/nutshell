#!/usr/bin/env python3
"""Deterministic execution script template.

This script demonstrates the execution-layer contract:
- read explicit inputs
- perform deterministic processing
- write intermediates to .tmp/
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Example deterministic script")
    parser.add_argument("--task", required=True, help="Task name to process")
    parser.add_argument(
        "--output",
        default=".tmp/example_output.json",
        help="Path for intermediate output",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "task": args.task,
        "status": "ok",
        "note": "Example execution complete",
    }

    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote intermediate file: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
