#!/usr/bin/env python3
"""Build a macOS .app bundle for the desktop cypher UI."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Package Black Envelope as .app")
    parser.add_argument(
        "--name",
        default="Black Envelope",
        help="App bundle display name",
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
        default="execution/assets/black_envelope.icns",
        help="Path to .icns file for the app icon.",
    )
    return parser.parse_args()


def run(cmd: list[str]) -> None:
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main() -> int:
    if sys.platform != "darwin":
        print("This script must be run on macOS.", file=sys.stderr)
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
        "execution/assets/black_envelope_logo.png:execution/assets",
        "--add-data",
        "execution/assets/black_envelope_icon.png:execution/assets",
    ]
    icon_path = Path(args.icon)
    if icon_path.exists():
        cmd.extend(["--icon", str(icon_path)])
    else:
        print(f"Warning: icon not found, using default PyInstaller icon: {icon_path}")
    cmd.append(str(entry_path))
    run(cmd)

    app_path = Path("dist") / f"{args.name}.app"
    if not app_path.exists():
        print(f"Build completed but .app not found at {app_path}", file=sys.stderr)
        return 1

    print(f"Packaged app created: {app_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
