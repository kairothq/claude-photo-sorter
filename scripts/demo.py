"""Make a fake camera roll so you can see the dashboard before using your own photos.
  python scripts/demo.py   ->  dashboard/demo/   (open http://127.0.0.1:8765/?demo)
The thumbnails are drawn shapes, not real photos.
"""
import json, os, random, shutil, sys

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(__file__))
from common import CATEGORIES, ROOT, load

OUT = os.path.join(ROOT, "dashboard", "demo")
rnd = random.Random(7)
cats = load(CATEGORIES)
if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(os.path.join(OUT, "thumbs"))
os.makedirs(os.path.join(OUT, "mini"))

WEIGHTS = {"selfies": 110, "people": 95, "pets": 40, "food": 60, "travel": 85, "city": 70, "home": 120,
           "docs": 55, "memes": 150, "screenshots": 140, "vtalk": 45, "vtravel": 25, "vscreen": 12, "vclips": 50}


def jitter(c, n=26):
    return tuple(max(0, min(255, v + rnd.randint(-n, n))) for v in c)


def draw(key, S=256):
    im = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(im)
    r = rnd.randint
    if key in ("screenshots", "memes", "docs", "vscreen"):
        dark = rnd.random() < .5 and key != "docs"
        bg = (24, 24, 28) if dark else (246, 246, 248)
        d.rectangle((0, 0, S, S), fill=bg)
        ink = (70, 70, 80) if dark else (205, 205, 212)
        y = 26
        if key == "memes":
            d.rectangle((18, 22, S - 18, 150), fill=jitter((200, 120, 90), 60))
            y = 170
        if key == "docs":
            d.rectangle((26, 18, S - 26, S - 10), fill=(252, 250, 244), outline=(220, 214, 200))
            ink = (180, 172, 160)
            y = 44
        while y < S - 20:
            d.rounded_rectangle((30, y, 30 + r(70, 190), y + 10), 5, fill=ink)
            y += r(18, 30)
        if key in ("screenshots",) and rnd.random() < .5:
            d.rounded_rectangle((30, S - 60, S - 30, S - 30), 14, fill=(52, 120, 246))
    elif key in ("travel", "vtravel"):
        sky = jitter(rnd.choice([(150, 190, 230), (250, 170, 120), (200, 215, 235)]), 15)
        d.rectangle((0, 0, S, S), fill=sky)
        for k in range(3):
            base = jitter((90 - k * 20, 110 - k * 20, 130 - k * 15), 15)
            x = r(-60, 120)
            d.polygon([(x, S), (x + r(80, 140), r(70, 140)), (x + r(220, 300), S)], fill=base)
            if rnd.random() < .6:
                d.polygon([(x + 120, r(70, 100)), (x + 95, 125), (x + 150, 125)], fill=(248, 248, 250))
    elif key == "city":
        d.rectangle((0, 0, S, S), fill=jitter((22, 26, 48), 10))
        x = 0
        while x < S:
            w, h = r(28, 60), r(80, 210)
            d.rectangle((x, S - h, x + w, S), fill=jitter((40, 44, 70), 12))
            for wy in range(S - h + 10, S - 8, 16):
                for wx in range(x + 6, x + w - 6, 12):
                    if rnd.random() < .45:
                        d.rectangle((wx, wy, wx + 5, wy + 7), fill=(250, 214, 120))
            x += w + 4
    elif key == "food":
        d.rectangle((0, 0, S, S), fill=jitter((180, 130, 90), 30))
        d.ellipse((30, 30, S - 30, S - 30), fill=(245, 245, 240))
        for _ in range(7):
            cx, cy, rr = r(80, 176), r(80, 176), r(14, 30)
            d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=jitter(rnd.choice([(200, 80, 50), (90, 150, 70), (230, 180, 60)]), 25))
    elif key == "pets":
        d.rectangle((0, 0, S, S), fill=jitter((150, 190, 140), 30))
        fur = jitter(rnd.choice([(190, 140, 90), (60, 50, 45), (230, 220, 200)]), 20)
        d.ellipse((60, 90, 196, 230), fill=fur)
        d.polygon([(70, 120), (80, 50), (118, 100)], fill=fur)
        d.polygon([(186, 120), (176, 50), (138, 100)], fill=fur)
        for ex in (102, 154):
            d.ellipse((ex - 8, 140, ex + 8, 156), fill=(25, 25, 25))
    else:  # people: selfies, groups, talking heads, everyday clips, home
        bg = jitter(rnd.choice([(225, 215, 200), (190, 205, 225), (160, 160, 175), (235, 200, 190)]), 20)
        d.rectangle((0, 0, S, S), fill=bg)
        if key == "home":
            d.rectangle((0, 170, S, S), fill=jitter((150, 120, 95), 20))
            d.rectangle((r(20, 60), 60, r(140, 200), 150), fill=jitter((70, 90, 120), 30))
            d.rectangle((r(150, 190), 120, 240, 175), fill=jitter((200, 190, 170), 20))
        else:
            n = 1 if key in ("selfies", "vtalk") else r(2, 4)
            for k in range(n):
                cx = S // 2 if n == 1 else 40 + k * (176 // max(1, n - 1))
                sc = 1.0 if n == 1 else 0.6
                skin = jitter(rnd.choice([(235, 200, 170), (200, 150, 110), (150, 105, 75)]), 12)
                shirt = jitter((rnd.randint(40, 220), rnd.randint(40, 200), rnd.randint(40, 220)), 0)
                d.ellipse((cx - 90 * sc, S - 70 * sc, cx + 90 * sc, S + 120 * sc), fill=shirt)
                d.ellipse((cx - 45 * sc, S - 190 * sc, cx + 45 * sc, S - 80 * sc), fill=skin)
                d.pieslice((cx - 48 * sc, S - 200 * sc, cx + 48 * sc, S - 110 * sc), 180, 360, fill=jitter((40, 30, 25), 15))
    return im.filter(ImageFilter.GaussianBlur(0.6))


inv, labels = [], {}
i = 0
for c in cats:
    for _ in range(WEIGHTS.get(c["key"], 40)):
        im = draw(c["key"])
        im.save(os.path.join(OUT, "thumbs", f"{i}.jpg"), quality=78)
        im.resize((72, 72)).save(os.path.join(OUT, "mini", f"{i}.jpg"), quality=72)
        video = c["kind"] == "video"
        inv.append({"id": i, "name": f"IMG_{4000 + i}.{'MOV' if video else 'JPG'}", "kind": c["kind"],
                    "ext": ".mov" if video else ".jpg", "bytes": rnd.randint(20, 90) * 10**6 if video else rnd.randint(18, 60) * 10**5})
        labels[str(i)] = c["key"]
        i += 1

dupes = []
for _ in range(38):  # pretend a few are burst shots
    k = rnd.randrange(len(inv))
    if inv[k]["kind"] == "photo":
        dupes.append({"keep": max(0, k - 1), "dupes": [k], "type": "near", "freed": inv[k]["bytes"] * 6})
seen = set()
dupes = [g for g in dupes if g["dupes"][0] not in seen and not seen.add(g["dupes"][0])]

for name, obj in (("inventory.json", inv), ("labels.json", labels), ("dupes.json", dupes), ("categories.json", cats),
                  ("source.json", {"source": "~/Pictures/Camera roll (demo)"})):
    json.dump(obj, open(os.path.join(OUT, name), "w"))
print(f"Demo camera roll: {len(inv)} files in dashboard/demo/")
