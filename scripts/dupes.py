"""Step 2: find duplicates.  python scripts/dupes.py

Exact = identical bytes (sha256). Near = looks the same (perceptual hash distance <= 4):
burst shots, re-saved screenshots, resized copies. The biggest file in each group is kept,
the rest are listed in dashboard/data/dupes.json and later copied to _Review/duplicates/.
Also writes work/duplicates.jpg so you can eyeball the groups before trusting them.
"""
import os, sys

import imagehash
from PIL import Image, ImageChops, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
from common import DATA, THUMBS, WORK, load, save

recs = load(os.path.join(DATA, "inventory.json"))
parent = {r["id"]: r["id"] for r in recs}


def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def union(a, b):
    parent[find(b)] = find(a)


by_sha = {}
for r in recs:
    by_sha.setdefault(r["sha256"], []).append(r["id"])
for ids in by_sha.values():
    for x in ids[1:]:
        union(ids[0], x)

byid = {r["id"]: r for r in recs}


def pixels_differ(a, b):
    """Screenshots of the same app look identical to a perceptual hash (dark UI, same layout),
    so for PNGs also require almost no changed pixels: <0.4% of the preview."""
    A = Image.open(os.path.join(THUMBS, f"{a}.jpg")).convert("L")
    B = Image.open(os.path.join(THUMBS, f"{b}.jpg")).convert("L")
    changed = sum(1 for p in ImageChops.difference(A, B).getdata() if p > 40)
    return changed / (A.width * A.height) > 0.004


hashed = [(r["id"], r["kind"], imagehash.hex_to_hash(r["phash"])) for r in recs if r.get("phash") and "error" not in r]
for i in range(len(hashed)):
    if i % 50 == 0:
        print(f"PROGRESS {i} {len(hashed)}", flush=True)
    for j in range(i + 1, len(hashed)):
        a, b = hashed[i], hashed[j]
        if a[1] != b[1] or a[2] - b[2] > 4:
            continue
        if byid[a[0]]["ext"] == ".png" and byid[b[0]]["ext"] == ".png" and byid[a[0]]["sha256"] != byid[b[0]]["sha256"] \
                and pixels_differ(a[0], b[0]):
            continue
        union(a[0], b[0])

groups = {}
for r in recs:
    groups.setdefault(find(r["id"]), []).append(r)
out = []
for g in groups.values():
    if len(g) < 2:
        continue
    g.sort(key=lambda r: (-r["bytes"], len(r["name"])))
    out.append({"keep": g[0]["id"], "dupes": [r["id"] for r in g[1:]],
                "type": "exact" if len({r["sha256"] for r in g}) == 1 else "near",
                "freed": sum(r["bytes"] for r in g[1:])})
save(os.path.join(DATA, "dupes.json"), out)

# contact sheet: one row per group, keeper first
if out:
    rows = [[g["keep"]] + g["dupes"] for g in out][:60]
    W = min(max(map(len, rows)), 8)
    sheet = Image.new("RGB", (W * 170, len(rows) * 170), "white")
    d = ImageDraw.Draw(sheet)
    for y, row in enumerate(rows):
        for x, i in enumerate(row[:W]):
            sheet.paste(Image.open(os.path.join(THUMBS, f"{i}.jpg")).resize((160, 160)), (x * 170, y * 170))
            d.rectangle((x * 170, y * 170, x * 170 + 60, y * 170 + 14), fill="black")
            d.text((x * 170 + 3, y * 170 + 2), ("KEEP " if x == 0 else "") + str(i), fill="yellow")
    os.makedirs(WORK, exist_ok=True)
    sheet.save(os.path.join(WORK, "duplicates.jpg"), quality=80)

n = sum(len(g["dupes"]) for g in out)
print(f"{len(out)} duplicate groups, {n} extra copies, {sum(g['freed'] for g in out) / 1e9:.2f} GB could be freed"
      + ("  (preview: work/duplicates.jpg)" if out else ""))
