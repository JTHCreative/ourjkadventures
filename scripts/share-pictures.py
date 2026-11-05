"""Make the pictures shown when someone shares a link to the site (site/assets/img/share/*.jpg).

Messages, Instagram, Facebook and the rest show a picture with a shared link, read from the page's og:image tag.
They want a wide JPEG, about 1200 x 630, and some don't show WebP or see-through backgrounds, so these are
flat JPEG copies of the products themselves on the site's cream background: the board with a few pups for the
home page and general pages, the board alone for the pin board pages, a row of pups for the pup club, and
each pup alone for its own page. Run from the repo root after adding a product:

    python3 scripts/share-pictures.py

Needs Pillow (pip install pillow).
"""
import glob
import os

from PIL import Image

OUT = 'site/assets/img/share'
SIZE = (1200, 630)
CREAM = (249, 249, 247)  # --cream-50 (#f9f9f7) in styles.css, the page background


def save(im, name):
    path = os.path.join(OUT, name + '.jpg')
    im.convert('RGB').save(path, quality=84, optimize=True, progressive=True)
    print(path, im.size, os.path.getsize(path) // 1024, 'KB')


def centred(src, height):
    """the whole picture, centred on cream (for pins and the board)"""
    pic = Image.open(src).convert('RGBA')
    pic.thumbnail((SIZE[0], height), Image.LANCZOS)
    im = Image.new('RGBA', SIZE, CREAM + (255,))
    im.alpha_composite(pic, ((SIZE[0] - pic.width) // 2, (SIZE[1] - pic.height) // 2))
    return im


os.makedirs(OUT, exist_ok=True)
def shop_front():
    """the bay area board with a few pups beside it, for the home page and the shop's general pages"""
    im = Image.new('RGBA', SIZE, CREAM + (255,))
    board = Image.open('site/assets/img/bay-area-board-full.webp').convert('RGBA')
    board.thumbnail((SIZE[0], 560), Image.LANCZOS)
    im.alpha_composite(board, (90, (SIZE[1] - board.height) // 2))
    left = 90 + board.width + 40
    cell = (SIZE[0] - left - 60) // 2
    for i, slug in enumerate(['aussie', 'corgi', 'golden', 'shiba']):
        pic = Image.open('site/assets/img/pins/' + slug + '.webp').convert('RGBA')
        pic.thumbnail((cell - 16, cell - 16), Image.LANCZOS)
        x = left + (i % 2) * cell + (cell - pic.width) // 2
        y = (SIZE[1] - 2 * cell) // 2 + (i // 2) * cell + (cell - pic.height) // 2
        im.alpha_composite(pic, (x, y))
    return im


def pack(slugs):
    """a row of pups on cream, for the pup club page"""
    im = Image.new('RGBA', SIZE, CREAM + (255,))
    w = SIZE[0] // len(slugs)
    for i, slug in enumerate(slugs):
        pic = Image.open('site/assets/img/pins/' + slug + '.webp').convert('RGBA')
        pic.thumbnail((w - 20, w - 20), Image.LANCZOS)
        im.alpha_composite(pic, (i * w + (w - pic.width) // 2, (SIZE[1] - pic.height) // 2))
    return im


save(shop_front(), 'home')
save(pack(['aussie', 'corgi', 'golden', 'shiba', 'pug']), 'pup-club')
save(centred('site/assets/img/bay-area-board-full.webp', 590), 'bay-area-pin-board')
for f in sorted(glob.glob('site/assets/img/pins/*.webp')):
    save(centred(f, 500), os.path.basename(f)[:-5])
