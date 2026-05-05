#!/usr/bin/env python3
"""Generate desktop branding assets for the Black Envelope app."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from io import BytesIO
from pathlib import Path


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise SystemExit(msg)


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    assets_dir = repo_root / "execution" / "assets"
    svg_path = assets_dir / "black_envelope.svg"

    _require(svg_path.is_file(), f"Missing {svg_path}")

    try:
        import cairosvg  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise SystemExit("Missing dependency: cairosvg") from exc

    try:
        from PIL import Image  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise SystemExit("Missing dependency: pillow (PIL)") from exc

    svg_bytes = svg_path.read_bytes()

    def render_png(size: int) -> bytes:
        return cairosvg.svg2png(bytestring=svg_bytes, output_width=size, output_height=size)

    icon_png_path = assets_dir / "black_envelope_icon.png"
    logo_png_path = assets_dir / "black_envelope_logo.png"
    ico_path = assets_dir / "black_envelope.ico"
    icns_path = assets_dir / "black_envelope.icns"

    icon_png_path.write_bytes(render_png(1024))
    logo_png_path.write_bytes(render_png(256))

    im = Image.open(BytesIO(icon_png_path.read_bytes())).convert("RGBA")
    im.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    iconutil = shutil.which("iconutil")
    if sys.platform == "darwin" and iconutil:
        with tempfile.TemporaryDirectory(prefix="black-envelope-iconset-") as tmp:
            iconset = Path(tmp) / "black_envelope.iconset"
            iconset.mkdir(parents=True, exist_ok=True)

            size_map = {
                "icon_16x16.png": 16,
                "icon_16x16@2x.png": 32,
                "icon_32x32.png": 32,
                "icon_32x32@2x.png": 64,
                "icon_128x128.png": 128,
                "icon_128x128@2x.png": 256,
                "icon_256x256.png": 256,
                "icon_256x256@2x.png": 512,
                "icon_512x512.png": 512,
                "icon_512x512@2x.png": 1024,
            }
            for filename, size in size_map.items():
                (iconset / filename).write_bytes(render_png(size))

            _run([iconutil, "-c", "icns", str(iconset), "-o", str(icns_path)])

    print("Wrote:")
    for p in (icon_png_path, logo_png_path, ico_path):
        print(f"- {p.relative_to(repo_root)} ({p.stat().st_size} bytes)")

    if icns_path.exists():
        print(f"- {icns_path.relative_to(repo_root)} ({icns_path.stat().st_size} bytes)")
    else:
        print("- execution/assets/black_envelope.icns (not generated on this platform)")


if __name__ == "__main__":
    main()
