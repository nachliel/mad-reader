"""Generate Mad Reader's icons (app icon + .md document icon).

Usage:  python tools/make_icons.py
Writes: assets/app.ico, assets/doc.ico, assets/app-256.png
Requires Pillow (pip install pillow).
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
S = 1024  # draw at 4x, downsample for smooth edges

TOP = (99, 102, 241)      # indigo-500
BOTTOM = (168, 85, 247)   # purple-500


def gradient(size, top, bottom):
    g = Image.new("RGBA", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x * 0.35 + y * 0.65) / size
            px[x, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
    return g


def rounded_mask(size, box, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=radius, fill=255)
    return m


def draw_mark(d, x0, y0, w, h, color, stroke):
    """The 'M' + down-arrow Markdown mark, inside box (x0, y0, w, h)."""
    mw = w * 0.58
    # M
    pts = [
        (x0, y0 + h),
        (x0, y0),
        (x0 + mw * 0.5, y0 + h * 0.48),
        (x0 + mw, y0),
        (x0 + mw, y0 + h),
    ]
    d.line(pts, fill=color, width=stroke, joint="curve")
    for p in (pts[0], pts[-1]):
        d.ellipse((p[0] - stroke / 2, p[1] - stroke / 2, p[0] + stroke / 2, p[1] + stroke / 2), fill=color)
    # arrow
    ax = x0 + w * 0.84
    d.line([(ax, y0), (ax, y0 + h * 0.62)], fill=color, width=stroke)
    aw = w * 0.17
    d.polygon([(ax - aw, y0 + h * 0.52), (ax + aw, y0 + h * 0.52), (ax, y0 + h)], fill=color)
    d.ellipse((ax - stroke / 2, y0 - stroke / 2, ax + stroke / 2, y0 + stroke / 2), fill=color)


def app_icon():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    pad = 56
    bg = gradient(S, TOP, BOTTOM)
    img.paste(bg, (0, 0), rounded_mask(S, (pad, pad, S - pad, S - pad), 210))
    d = ImageDraw.Draw(img)
    # two "text lines", right-aligned, hinting at RTL reading
    white = (255, 255, 255, 255)
    soft = (255, 255, 255, 150)
    draw_mark(d, 230, 250, 560, 330, white, 92)
    d.rounded_rectangle((330, 668, 794, 712), radius=22, fill=soft)
    d.rounded_rectangle((470, 760, 794, 804), radius=22, fill=soft)
    return img


def doc_icon():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # page with folded corner
    x0, y0, x1, y1, fold = 170, 60, 854, 964, 210
    page = [(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)]
    shadow = [(px + 10, py + 14) for px, py in page]
    d.polygon(shadow, fill=(0, 0, 0, 50))
    d.polygon(page, fill=(250, 250, 252, 255), outline=(200, 202, 214, 255))
    d.line(page + [page[0]], fill=(190, 192, 206, 255), width=12)
    d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=(222, 224, 236, 255))
    # gradient badge with the mark
    bx0, by0, bx1, by1 = 230, 470, 794, 840
    bg = gradient(S, TOP, BOTTOM)
    img.paste(bg, (0, 0), rounded_mask(S, (bx0, by0, bx1, by1), 70))
    draw_mark(d, bx0 + 90, by0 + 85, bx1 - bx0 - 180, by1 - by0 - 170, (255, 255, 255, 255), 64)
    # text lines above badge, right aligned
    for i, (a, b) in enumerate([(330, 700), (420, 700), (280, 700)]):
        y = 210 + i * 80
        d.rounded_rectangle((a, y, b if i else 560, y + 36), radius=18, fill=(180, 184, 204, 255))
    return img


def save(img, name):
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    frames = [img.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[-1].save(ASSETS / name, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    return frames[-1]


if __name__ == "__main__":
    ASSETS.mkdir(exist_ok=True)
    big = save(app_icon(), "app.ico")
    big.save(ASSETS / "app-256.png")
    save(doc_icon(), "doc.ico")
    print("icons written to", ASSETS)
