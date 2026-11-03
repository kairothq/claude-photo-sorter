"""Step 1: inventory a photo folder (any folder, Google Takeout, Apple Photos export...).

  python scripts/scan.py "/path/to/photos"              # everything
  python scripts/scan.py "/path/to/photos" --limit 200  # try a sample first

Records size, sha256, dimensions, video length and (for Google Takeout) the .json sidecar
date/GPS for each file, and makes a 256px square preview in dashboard/data/thumbs/.
Read-only on your photos.
"""
import argparse, hashlib, json, os, random, re, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageOps
import imagehash

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(__file__))
from common import DATA, IMG, THUMBS, VID, save

ap = argparse.ArgumentParser()
ap.add_argument("source")
ap.add_argument("--limit", type=int, default=0, help="only scan a random sample of N files")
args = ap.parse_args()
src = os.path.expanduser(args.source)
if not os.path.isdir(src):
    sys.exit(f"Folder not found: {src}")

HAS_FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")
MINI = os.path.join(DATA, "mini")  # 72px copies for the animation, so hundreds can move smoothly
for d in (THUMBS, MINI):
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(d)


def sidecar(path):
    """Google Takeout writes '<file>.json' or '<file>.supplemental-metadata.json' (often truncated)."""
    d, name = os.path.split(path)
    m = re.match(r"(.*?)(\(\d+\))(\.\w+)$", name)  # IMG_1(1).JPG -> IMG_1.JPG...(1).json
    for f in os.listdir(d):
        if not f.endswith(".json"):
            continue
        if m and f.startswith(m.group(1) + m.group(3)) and f.endswith(m.group(2) + ".json"):
            return os.path.join(d, f)
        if not m and f.startswith(name + ".") and not re.search(r"\(\d+\)\.json$", f):
            return os.path.join(d, f)
    return None


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def square(im, size=256):
    im = im.convert("RGB")
    s = min(im.size)
    left, top = (im.width - s) // 2, (im.height - s) // 2
    return im.crop((left, top, left + s, top + s)).resize((size, size))


def video_info(path, thumb):
    if not HAS_FFMPEG:
        return 0, 0, 0.0
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height:stream_tags=rotate:format=duration", "-of", "json", path],
                       capture_output=True, text=True)
    j = json.loads(r.stdout or "{}")
    s = (j.get("streams") or [{}])[0]
    w, h = s.get("width", 0), s.get("height", 0)
    if str(s.get("tags", {}).get("rotate", "0")) in ("90", "-90", "270"):
        w, h = h, w
    dur = float(j.get("format", {}).get("duration", 0) or 0)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1" if dur > 2 else "0", "-i", path, "-frames:v", "1",
                    "-vf", "scale=256:256:force_original_aspect_ratio=increase,crop=256:256", thumb])
    return w, h, dur


def process(args):
    i, path = args
    ext = os.path.splitext(path)[1].lower()
    kind = "video" if ext in VID else "photo"
    rec = {"id": i, "path": path, "name": os.path.basename(path), "ext": ext, "kind": kind,
           "bytes": os.path.getsize(path), "sha256": sha(path)}
    thumb = os.path.join(THUMBS, f"{i}.jpg")
    try:
        if kind == "video":
            rec["w"], rec["h"], rec["duration"] = video_info(path, thumb)
            if not os.path.exists(thumb):  # no ffmpeg: grey placeholder so the dashboard still works
                Image.new("RGB", (256, 256), (60, 60, 66)).save(thumb)
        else:
            with Image.open(path) as im:
                rec["w"], rec["h"] = im.size
                im.draft("RGB", (512, 512))
                square(ImageOps.exif_transpose(im)).save(thumb, quality=80)
        with Image.open(thumb) as t:
            rec["phash"] = str(imagehash.phash(t))
            t.convert("RGB").resize((72, 72)).save(os.path.join(MINI, f"{i}.jpg"), quality=72)
    except Exception as e:  # unreadable file: keep it in the inventory, flag it
        rec["error"] = str(e)[:200]
        Image.new("RGB", (256, 256), (230, 228, 222)).save(thumb)
        Image.new("RGB", (72, 72), (230, 228, 222)).save(os.path.join(MINI, f"{i}.jpg"))
    sc = sidecar(path)
    if sc:
        try:
            j = json.load(open(sc))
            rec["taken"] = int(j.get("photoTakenTime", {}).get("timestamp", 0)) or None
            g = j.get("geoData") or {}
            if g.get("latitude"):
                rec["geo"] = [g["latitude"], g["longitude"]]
        except Exception:
            pass
    return rec


files = sorted(os.path.join(dp, f) for dp, _, fs in os.walk(src) for f in fs
               if os.path.splitext(f)[1].lower() in IMG | VID and not f.startswith("._"))
if not files:
    sys.exit("No photos or videos found in that folder.")
if args.limit and args.limit < len(files):
    files = sorted(random.Random(0).sample(files, args.limit))
print(f"Scanning {len(files)} files...", flush=True)
if not HAS_FFMPEG and any(os.path.splitext(f)[1].lower() in VID for f in files):
    print("  note: ffmpeg not installed, videos will get grey previews (Mac: brew install ffmpeg)")

with ThreadPoolExecutor(8) as ex:
    recs = []
    for n, r in enumerate(ex.map(process, enumerate(files)), 1):
        recs.append(r)
        if n % 20 == 0 or n == len(files):
            print(f"PROGRESS {n} {len(files)}", flush=True)
        if n % 200 == 0:
            print(f"  {n}/{len(files)}", flush=True)

save(os.path.join(DATA, "inventory.json"), recs)
save(os.path.join(DATA, "source.json"), {"source": src, "limit": args.limit})
bad = [r["name"] for r in recs if "error" in r]
print(f"Done: {len(recs)} files ({sum(r['kind'] == 'video' for r in recs)} videos), "
      f"{sum(r['bytes'] for r in recs) / 1e9:.1f} GB" + (f", {len(bad)} unreadable: {bad[:5]}" if bad else ""))
