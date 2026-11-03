"""Optional: label every file with TypeSafe's Jev image model instead of (or as well as) Claude.

  python scripts/label_jev.py --estimate   # no API calls: count files, estimate tokens
  python scripts/label_jev.py              # label everything -> work/jev.json (resumable)

Needs JEV_KEY (or TYPESAFE_API_KEY) in your environment or in a .env file in this repo.
Each file is one "choice" question: a 280px preview + the folder list from categories.json.
Only the 280px preview leaves your computer, never the original photo.
"""
import base64, io, json, os, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from common import DATA, JEV_OUT, ROOT, THUMBS, categories, load, save

TOKENS_PER_FILE = 980  # measured: ~870 image tokens + question + ~108 output tokens
URL = "https://api.typesafe.ai/v1/systemone"
MODEL = os.environ.get("JEV_MODEL", "jev-1.14.0")

recs = load(os.path.join(DATA, "inventory.json"))
done = load(JEV_OUT, {})
todo = [r for r in recs if str(r["id"]) not in done or "error" in done[str(r["id"])]]

if "--estimate" in sys.argv:
    print(f"{len(recs)} files, {len(todo)} still to label with Jev.")
    print(f"Estimated tokens: ~{len(todo) * TOKENS_PER_FILE:,} "
          f"(about {TOKENS_PER_FILE} per file). Multiply by the per-token price on console.typesafe.ai.")
    sys.exit()


def env_key():
    for name in ("JEV_KEY", "TYPESAFE_API_KEY"):
        if os.environ.get(name):
            return os.environ[name]
    env = os.path.join(ROOT, ".env")
    if os.path.exists(env):
        for line in open(env):
            k, _, v = line.strip().partition("=")
            if k.strip() in ("JEV_KEY", "TYPESAFE_API_KEY") and v.strip():
                return v.strip().strip('"').strip("'")
    sys.exit("No Jev key found. Put JEV_KEY=your-key in a file called .env in this folder.")


KEY = env_key()
cats = categories()
crit = {k: {c["key"]: c["rule"] for c in cats if c["kind"] == k} for k in ("photo", "video")}


def ask(r):
    im = Image.open(os.path.join(THUMBS, f"{r['id']}.jpg")).convert("RGB").resize((280, 280))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    body = {"model": MODEL,
            "state": {"item": "img", "kind": "a frame from a video" if r["kind"] == "video" else "a photo",
                      "file": r["name"]},
            "assets": {"img": {"type": "image", "format": "jpeg",
                               "data_base64": base64.b64encode(buf.getvalue()).decode()}},
            "questions": {"folder": {"type": "choice", "criteria": crit[r["kind"]],
                                     "instructions": "Which camera-roll folder does `item` belong in?"}}}
    err = "retries exhausted"
    for attempt in range(5):
        req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + KEY,
            "TypeSafe-Danger-Zone-Images": "true"})  # image input is a beta feature, this opts in
        try:
            j = json.load(urllib.request.urlopen(req, timeout=90))
            a = j["answers"]["folder"]
            return r["id"], {"key": a["choice"], "confidence": a["confidence"],
                             "tokens": j.get("usage", {}).get("input_tokens", 0) + j.get("usage", {}).get("output_tokens", 0)}
        except urllib.error.HTTPError as e:
            err = f"{e.code} {e.read().decode()[:200]}"
            if e.code in (401, 403):
                sys.exit(f"Jev rejected the key: {err}")
            if e.code not in (429, 500, 502, 503, 504):
                break
        except Exception as e:
            err = str(e)
        time.sleep(2 ** attempt * 2)
    return r["id"], {"error": err}


print(f"Labelling {len(todo)} files with {MODEL}...", flush=True)
t0, tokens = time.time(), 0
with ThreadPoolExecutor(6) as ex:
    for n, (i, res) in enumerate(ex.map(ask, todo), 1):
        done[str(i)] = res
        tokens += res.get("tokens", 0)
        if n % 50 == 0 or n == len(todo):
            save(JEV_OUT, done)
            print(f"  {n}/{len(todo)}  tokens so far {tokens:,}", flush=True)
errs = [k for k, v in done.items() if "error" in v]
print(f"Done in {time.time() - t0:.0f}s: {len(done) - len(errs)} labelled, {len(errs)} errors, {tokens:,} tokens."
      + (f" First error: {done[errs[0]]['error']}" if errs else ""))
