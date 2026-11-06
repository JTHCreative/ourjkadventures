"""Make the product pictures Google Shopping uses (site/assets/img/merchant/<slug>.jpg).

Google Shopping wants each product on a plain white or light background, filling most of a square picture, with
no words on top. Our pin pictures have see-through backgrounds, so these are copies set on white, 1000px square
(Google asks for at least 500px). Run from the repo root after adding a product:

    python3 scripts/merchant-pictures.py

Needs Pillow (pip install pillow). server/merchant.js points Google at these.
"""
import glob
import os

from PIL import Image

OUT = 'site/assets/img/merchant'
SIZE = 1000
FILL = 0.86  # the product takes up this much of the square, like Google suggests (75 to 90 percent)
# products whose picture isn't in the pins folder
OTHERS = {'bay-area-pin-board': 'site/assets/img/bay-area-board-full.webp'}


def save(src, slug):
    im = Image.open(src).convert('RGBA')
    # trim the see-through edges first, so every product fills its square the same way
    box = im.getchannel('A').getbbox()
    if box:
        im = im.crop(box)
    inner = int(SIZE * FILL)
    scale = min(inner / im.width, inner / im.height)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    canvas = Image.new('RGB', (SIZE, SIZE), (255, 255, 255))
    canvas.paste(im, ((SIZE - im.width) // 2, (SIZE - im.height) // 2), im)
    path = os.path.join(OUT, slug + '.jpg')
    canvas.save(path, quality=88, optimize=True, progressive=True)
    print(path, canvas.size, os.path.getsize(path) // 1024, 'KB')


os.makedirs(OUT, exist_ok=True)
for f in sorted(glob.glob('site/assets/img/pins/*.webp')):
    save(f, os.path.basename(f)[:-5])
for slug, src in OTHERS.items():
    save(src, slug)
