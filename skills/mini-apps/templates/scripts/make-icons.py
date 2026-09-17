#!/usr/bin/env python3
"""Generate PWA icons (32/180/192/512 px PNG) from a single emoji.

macOS only (uses the Apple Color Emoji font). Needs Pillow:

    python3 -m venv .venv && .venv/bin/pip install pillow
    .venv/bin/python scripts/make-icons.py "🍳" "#FFF8F0" client/public/icons

Arguments: <emoji> <background hex colour> <output dir>
The emoji is drawn at ~62% of the canvas, which also keeps it inside the
"maskable" safe zone, so icon-512.png can double as the maskable icon.
Keep .venv out of git (it is in the template .gitignore).
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

if len(sys.argv) != 4:
    sys.exit(__doc__)

emoji, bg, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)

# Apple Color Emoji is a bitmap font: 160 is one of the few sizes it accepts.
font = ImageFont.truetype("/System/Library/Fonts/Apple Color Emoji.ttc", 160)
glyph = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
ImageDraw.Draw(glyph).text((100, 100), emoji, font=font, embedded_color=True, anchor="mm")
glyph = glyph.crop(glyph.getbbox())

for size in (32, 180, 192, 512):
    icon = Image.new("RGBA", (size, size), bg)
    g = glyph.copy()
    inner = int(size * 0.62)
    g.thumbnail((inner, inner), Image.LANCZOS)
    icon.alpha_composite(g, ((size - g.width) // 2, (size - g.height) // 2))
    icon.convert("RGB").save(os.path.join(out, f"icon-{size}.png"))

print(f"Wrote icons to {out}")
