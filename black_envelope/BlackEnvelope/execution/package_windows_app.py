#!/usr/bin/env python3
"""Build a Windows .exe bundle for the desktop cypher UI.

Run this script on Windows.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Package Black Envelope as .exe")
    parser.add_argument(
        "--name",
        default="Black Envelope",
        help="Executable/app display name",
    )
    parser.add_argument(
        "--entry",
        default="execution/desktop_cypher_app_qt.py",
        help="Path to app entry script",
    )
    parser.add_argument(
        "--paths",
        default="execution",
        help="Additional import search path for PyInstaller",
    )
    parser.add_argument(
        "--icon",
        default="execution/assets/black_envelope.ico",
        help="Path to .ico file for the app icon.",
    )
    parser.add_argument(
        "--onefile",
        action="store_true",
        help="Build a single-file exe instead of a folder-based dist output.",
    )
    return parser.parse_args()


def run(cmd: list[str]) -> None:
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main() -> int:
    if sys.platform != "win32":
        print("This script must be run on Windows.", file=sys.stderr)
        return 1

    args = parse_args()
    entry_path = Path(args.entry)
    if not entry_path.exists():
        print(f"Entry script not found: {entry_path}", file=sys.stderr)
        return 1

    run([sys.executable, "-m", "pip", "install", "pyinstaller"])

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--name",
        args.name,
        "--windowed",
        "--clean",
        "--noconfirm",
        "--paths",
        args.paths,
        "--add-data",
        "execution/assets/black_envelope_logo.png;execution/assets",
        "--add-data",
        "execution/assets/black_envelope_icon.png;execution/assets",
    ]
    icon_path = Path(args.icon)
    if icon_path.exists():
        cmd.extend(["--icon", str(icon_path)])
    else:
        print(f"Warning: icon not found, using default PyInstaller icon: {icon_path}")
    if args.onefile:
        cmd.append("--onefile")
    cmd.append(str(entry_path))
    run(cmd)

    if args.onefile:
        exe_path = Path("dist") / f"{args.name}.exe"
    else:
        exe_path = Path("dist") / args.name / f"{args.name}.exe"

    if not exe_path.exists():
        print(f"Build completed but .exe not found at {exe_path}", file=sys.stderr)
        return 1

    print(f"Packaged app created: {exe_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
