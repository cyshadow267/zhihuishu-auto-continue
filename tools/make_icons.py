"""生成扩展图标（16 / 48 / 128 px）。运行：python tools/make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG = (15, 23, 42)
ACCENT = (56, 189, 248)
WHITE = (241, 245, 249)


def make(size: int) -> Image.Image:
    # 4x 超采样后缩小，边缘更干净
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    # 播放三角
    cx, cy = s * 0.5, s * 0.5
    tri_h = s * 0.34
    tri_w = s * 0.30
    pts = [
        (cx - tri_w / 2 + s * 0.02, cy - tri_h / 2),
        (cx - tri_w / 2 + s * 0.02, cy + tri_h / 2),
        (cx + tri_w * 1.15, cy),
    ]
    d.polygon(pts, fill=ACCENT)

    # 右下角的续播弧线，暗示"循环"
    pad = int(s * 0.13)
    box = [s - pad - int(s * 0.30), s - pad - int(s * 0.30), s - pad, s - pad]
    d.arc(box, start=35, end=300, fill=WHITE, width=max(2, int(s * 0.055)))

    return img.resize((size, size), Image.LANCZOS)


for px in (16, 48, 128):
    make(px).save(OUT / f"icon{px}.png")
    print(f"icons/icon{px}.png")
