#!/usr/bin/env python3
"""
Generate favicon PNG/ICO assets from web/e2ee_chat/favicon.svg.

Why: SVG favicons are supported in modern browsers, but providing PNG/ICO improves
compatibility (Safari, pinned tabs, bookmarks, etc.).

Outputs (web/e2ee_chat/):
  - favicon-32.png
  - apple-touch-icon.png (180x180)
  - favicon.ico (multi-size)
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise SystemExit(msg)


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    web_dir = repo_root / "web" / "e2ee_chat"
    svg_path = web_dir / "favicon.svg"

    _require(svg_path.is_file(), f"Missing {svg_path}")

    # Lazy imports so the script fails with a clear message if deps are missing.
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
        # Force a square raster at the requested size.
        return cairosvg.svg2png(bytestring=svg_bytes, output_width=size, output_height=size)

    # favicon-32.png
    (web_dir / "favicon-32.png").write_bytes(render_png(32))

    # apple-touch-icon.png (180x180)
    (web_dir / "apple-touch-icon.png").write_bytes(render_png(180))

    # favicon.ico (multi-size)
    base_png = render_png(256)
    im = Image.open(BytesIO(base_png)).convert("RGBA")
    ico_path = web_dir / "favicon.ico"
    im.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    print("Wrote:")
    for p in ("favicon-32.png", "apple-touch-icon.png", "favicon.ico"):
        out = web_dir / p
        print(f"- {out.relative_to(repo_root)} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

