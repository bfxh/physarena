"""Build the four-renderer comparison sheet."""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = r"D:\开发\physarena"
ITEMS = [
    ("three.js（WebGL2 · 92 KB）", "r-three.png"),
    ("Babylon.js（WebGL2 · 1343 KB）", "r-babylon.png"),
    ("原生 WebGL2（手写管线 · 6 KB）", "r-webgl2.png"),
    ("Canvas2D 软件光栅（无 GPU · 5.7 KB）", "r-canvas2d.png"),
]

CELL_W = 880
MARGIN = 18
LABEL_H = 38
GAP = 14

font = None
for c in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"):
    if os.path.exists(c):
        font = ImageFont.truetype(c, 20)
        break
if font is None:
    font = ImageFont.load_default()

imgs = []
for label, name in ITEMS:
    im = Image.open(os.path.join(ROOT, "docs", name)).convert("RGB")
    h = round(CELL_W * im.height / im.width)
    imgs.append((label, im.resize((CELL_W, h), Image.LANCZOS)))

cell_h = imgs[0][1].height
total_w = MARGIN * 3 + CELL_W * 2
total_h = MARGIN * 3 + (LABEL_H + cell_h) * 2 + GAP

canvas = Image.new("RGB", (total_w, total_h), (238, 241, 246))
draw = ImageDraw.Draw(canvas)

for i, (label, im) in enumerate(imgs):
    col = i % 2
    row = i // 2
    x = MARGIN + col * (CELL_W + MARGIN)
    y = MARGIN + row * (LABEL_H + cell_h + GAP + MARGIN)
    draw.text((x + 2, y + 8), label, fill=(27, 35, 51), font=font)
    canvas.paste(im, (x, y + LABEL_H))

out = os.path.join(ROOT, "docs", "renderer-matrix.png")
canvas.save(out)
print("wrote", out, canvas.size)
