#!/usr/bin/env python3
"""Package desktop app for the current operating system.

- macOS: builds dist/<name>.app
- Windows: builds dist/<name>/<name>.exe (or --onefile)
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def _default_icon_path() -> str:
    if sys.platform == "win32":
        return "execution/assets/black_envelope.ico"
    return "execution/assets/black_envelope.icns"


def _data_sep() -> str:
    return ";" if sys.platform == "win32" else ":"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Package desktop app for current OS")
    parser.add_argument(
        "--name",
        default="Black Envelope",
        help="Application name",
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
        default=_default_icon_path(),
        help="Icon file (.icns on macOS, .ico on Windows).",
    )
    parser.add_argument(
        "--onefile",
        action="store_true",
        help="Windows only: produce a single executable.",
    )
    return parser.parse_args()


def run(cmd: list[str]) -> None:
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)


def build_with_pyinstaller(args: argparse.Namespace) -> int:
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
        f"execution/assets/black_envelope_logo.png{_data_sep()}execution/assets",
        "--add-data",
        f"execution/assets/black_envelope_icon.png{_data_sep()}execution/assets",
    ]
    icon_path = Path(args.icon)
    if icon_path.exists():
        cmd.extend(["--icon", str(icon_path)])
    else:
        print(f"Warning: icon not found, using default PyInstaller icon: {icon_path}")
    if sys.platform == "win32" and args.onefile:
        cmd.append("--onefile")
    cmd.append(str(entry_path))
    run(cmd)
    return 0


def validate_output(args: argparse.Namespace) -> int:
    if sys.platform == "darwin":
        target = Path("dist") / f"{args.name}.app"
    elif sys.platform == "win32":
        if args.onefile:
            target = Path("dist") / f"{args.name}.exe"
        else:
            target = Path("dist") / args.name / f"{args.name}.exe"
    else:
        print(
            "Unsupported platform for native packaging. Use macOS or Windows.",
            file=sys.stderr,
        )
        return 1

    if not target.exists():
        print(f"Build completed but output not found: {target}", file=sys.stderr)
        return 1

    print(f"Packaged app created: {target.resolve()}")
    return 0


def main() -> int:
    if sys.platform not in {"darwin", "win32"}:
        print(
            "Native packaging is supported only on macOS and Windows.",
            file=sys.stderr,
        )
        return 1

    args = parse_args()
    code = build_with_pyinstaller(args)
    if code != 0:
        return code
    return validate_output(args)


if __name__ == "__main__":
    raise SystemExit(main())
