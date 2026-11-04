"""Make the PNG pictures the "it's here" email uses (site/assets/img/email/<slug>.png).

Many mail apps, Gmail among them, don't show WebP pictures, so the email gets PNG copies of the site's
pictures, 480px (shown at 240px, sharp on phones). Run from the repo root after adding a product:

    python3 scripts/email-pictures.py

Needs Pillow (pip install pillow). The logo (logo.png) is made once from logo.svg and kept; this leaves it alone.
"""
import glob
import os

from PIL import Image

OUT = 'site/assets/img/email'
# products whose picture isn't in the pins folder
OTHERS = {'bay-area-pin-board': 'site/assets/img/bay-area-board-full.webp'}


def save(src, slug, box):
    im = Image.open(src).convert('RGBA')
    im.thumbnail(box, Image.LANCZOS)
    path = os.path.join(OUT, slug + '.png')
    im.save(path, optimize=True)
    print(path, im.size, os.path.getsize(path) // 1024, 'KB')


os.makedirs(OUT, exist_ok=True)
for f in sorted(glob.glob('site/assets/img/pins/*.webp')):
    save(f, os.path.basename(f)[:-5], (480, 480))
for slug, src in OTHERS.items():
    save(src, slug, (480, 600))
