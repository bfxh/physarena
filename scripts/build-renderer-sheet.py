"""
Builds docs/renderer-matrix.png: the same scene drawn by every available
renderer backend, laid out as a grid.

Run after re-capturing the per-backend screenshots:

    node scripts/arena-drive.mjs ...            # or agent-browser, one session
                                                # per renderer, ?renderer=<id>
    python scripts/build-renderer-sheet.py

Each tile is labelled with the backend's name and its built chunk size, because
the size spread (7 KB to 5.9 MB for the same picture) is half the point of
having ten backends at all.
"""
from PIL import Image, ImageDraw, ImageFont
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")

# id -> label; order is the sidebar order.
#
# Babylon and WebGPU are deliberately absent: neither currently produces a
# picture (see README「渲染后端现状」), and a tile of empty background next to
# eight working ones reads as a glitch rather than as information. Their status
# is stated in the README instead.
TILES = [
    ("three", "three.js · WebGL2 · 372 KB"),
    ("webgl2", "原生 WebGL2 · GLSL · 15 KB"),
    ("webgl1", "原生 WebGL1 · GLSL 100 · 12 KB"),
    ("points", "点云 · gl.POINTS · 9 KB"),
    ("wireframe", "线框 · gl.LINES · 9 KB"),
    ("canvas2d", "Canvas2D 软件光栅 · 13 KB"),
    ("svg", "SVG 多边形 · 8 KB"),
    ("css3d", "CSS 3D 合成 · 7 KB"),
]

COLS = 3
CELL_W = 620
MARGIN = 16
LABEL_H = 30
GAP = 12


def load_font(size: int):
    for path in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf",
                 "/System/Library/Fonts/PingFang.ttc"):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def main() -> int:
    font = load_font(17)
    tiles = []
    missing = []
    for key, label in TILES:
        path = os.path.join(DOCS, f"r-{key}.png")
        if not os.path.exists(path):
            missing.append(key)
            continue
        im = Image.open(path).convert("RGB")
        h = round(CELL_W * im.height / im.width)
        tiles.append((label, im.resize((CELL_W, h), Image.LANCZOS)))

    if missing:
        print(f"skipped (no screenshot): {', '.join(missing)}", file=sys.stderr)
    if not tiles:
        print("no screenshots found - capture docs/r-<id>.png first", file=sys.stderr)
        return 1

    cell_h = tiles[0][1].height
    rows = (len(tiles) + COLS - 1) // COLS
    total_w = MARGIN * (COLS + 1) + CELL_W * COLS
    total_h = MARGIN * (rows + 1) + (LABEL_H + cell_h) * rows + GAP * (rows - 1)

    canvas = Image.new("RGB", (total_w, total_h), (238, 241, 246))
    draw = ImageDraw.Draw(canvas)

    for i, (label, im) in enumerate(tiles):
        col = i % COLS
        row = i // COLS
        x = MARGIN + col * (CELL_W + MARGIN)
        y = MARGIN + row * (LABEL_H + cell_h + GAP + MARGIN)
        draw.text((x + 2, y + 6), label, fill=(27, 35, 51), font=font)
        canvas.paste(im, (x, y + LABEL_H))

    out = os.path.join(DOCS, "renderer-matrix.png")
    canvas.save(out)
    print(f"wrote {out} ({canvas.width}x{canvas.height}, {len(tiles)} tiles)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
