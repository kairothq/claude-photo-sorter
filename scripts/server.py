"""The dashboard app.  python scripts/server.py   ->  http://127.0.0.1:8765

Serves dashboard/ plus a small local API so the page can do everything itself:
pick folders, peek at a folder, run the whole sort (scan, duplicates, Claude labels,
build folders) with live progress, edit folders, browse photos at full size, move a
photo to another folder, and open folders in Finder.
Listens on 127.0.0.1 only: nothing is reachable from other computers.
"""
import glob, hashlib, io, json, mimetypes, os, random, re, shutil, subprocess, sys, threading, time, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
from common import CATEGORIES, DATA, IMG, JEV_OUT, LABELS, ROOT, VID, WORK, load, save

PORT = int(os.environ.get("PORT", 8765))
DASH = os.path.join(ROOT, "dashboard")
PEEK = os.path.join(DASH, "peek")
OVERRIDES = os.path.join(WORK, "overrides.json")
SCRIPTS = os.path.join(ROOT, "scripts")
PY = sys.executable
job = {"step": None, "running": False, "log": [], "code": None, "phase": None, "phases": [], "done": 0, "total": 0,
       "started": None, "phase_started": None, "timings": {}}


def has_jev_key():
    if os.environ.get("JEV_KEY") or os.environ.get("TYPESAFE_API_KEY"):
        return True
    env = os.path.join(ROOT, ".env")
    return os.path.exists(env) and bool(re.search(r"^(JEV_KEY|TYPESAFE_API_KEY)=\S", open(env).read(), re.M))


def state():
    inv = load(os.path.join(DATA, "inventory.json"), [])
    src = load(os.path.join(DATA, "source.json"), {})
    claude_files = glob.glob(os.path.join(LABELS, "*.json"))
    return {
        "categories": load(CATEGORIES, []),
        "source": src.get("source"), "limit": src.get("limit"), "sorted": src.get("sorted"),
        "files": len(inv), "bytes": sum(r["bytes"] for r in inv),
        "steps": {
            "scan": bool(inv),
            "dupes": os.path.exists(os.path.join(DATA, "dupes.json")),
            "label": bool(claude_files) or os.path.exists(JEV_OUT),
            "jev_labels": os.path.exists(JEV_OUT),
            "apply": bool(src.get("sorted")) and os.path.exists(os.path.join(DATA, "labels.json")),
        },
        "jev_key": has_jev_key(),
        "claude_cli": bool(shutil.which("claude")),
        "overrides": len(load(OVERRIDES, {})),
        "job": {k: job[k] for k in ("step", "running", "code", "phase", "phases", "done", "total", "started", "phase_started", "timings")}
               | {"log": job["log"][-40:], "now": time.time()},
        "platform": sys.platform,
    }


def live_labels():
    """Labels written so far (Claude batches + confident Jev answers), for the live animation."""
    out = {}
    for f in sorted(glob.glob(os.path.join(LABELS, "*.json"))):
        out.update({str(k): v for k, v in load(f, {}).items()})
    for k, v in load(JEV_OUT, {}).items():
        if "key" in v and (v.get("confidence", 0) >= 0.7 or k not in out):
            out[k] = v["key"]
    return out


def clear_library():
    """A new folder (or sample size) means the old labels no longer match."""
    for f in (os.path.join(DATA, "labels.json"), os.path.join(DATA, "dupes.json"), JEV_OUT, OVERRIDES):
        if os.path.exists(f):
            os.remove(f)
    for d in (LABELS, os.path.join(WORK, "sheets")):
        shutil.rmtree(d, ignore_errors=True)


def categories_fingerprint():
    return hashlib.sha1(open(CATEGORIES, "rb").read()).hexdigest()[:12]


def stream(cmd):
    """Run one script, keep its output for the log, and read PROGRESS lines."""
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=ROOT)
    for line in p.stdout:
        line = line.rstrip()
        m = re.match(r"PROGRESS (\d+) (\d+)", line)
        if m:
            job["done"], job["total"] = int(m.group(1)), int(m.group(2))
        else:
            job["log"].append(line)
    return p.wait()


def start_job(step, phases, body):
    if job["running"]:
        raise RuntimeError("Something is already running. Wait for it to finish.")
    now = time.time()
    job.update(step=step, running=True, log=[f"$ {step}"], code=None, phase=None, phases=phases, done=0, total=0,
               started=now, phase_started=now, timings={})
    threading.Thread(target=body, daemon=True).start()


def run_phase(name, cmd):
    job.update(phase=name, done=0, total=0, phase_started=time.time())
    code = stream([PY, "-u"] + cmd)
    job["timings"][name] = round(time.time() - job["phase_started"], 1)
    return code


def sort_all(args):
    source = (args.get("source") or "").strip().rstrip("/")
    dest = (args.get("dest") or "").strip()
    limit = int(args.get("limit") or 0)
    labeler = args.get("labeler") or "claude"
    if not source or not os.path.isdir(os.path.expanduser(source)):
        raise ValueError("Choose the folder with your photos first.")
    if labeler == "claude" and not shutil.which("claude"):
        raise ValueError("Claude Code is not installed, so it can't label the photos. Install it, or use Jev under Advanced.")
    if labeler == "jev" and not has_jev_key():
        raise ValueError("Add JEV_KEY=your-key to a .env file in this folder to use Jev.")
    src = load(os.path.join(DATA, "source.json"), {})
    have = os.path.exists(os.path.join(DATA, "inventory.json"))
    need_scan = not have or src.get("source") != os.path.expanduser(source) or int(src.get("limit") or 0) != limit
    phases = (["scan"] if need_scan else []) + ["dupes", "label", "apply"]

    def body():
        def fail(code):
            job.update(running=False, code=code)
        if need_scan:
            clear_library()
            if run_phase("scan", [os.path.join(SCRIPTS, "scan.py"), source] + (["--limit", str(limit)] if limit else [])):
                return fail(1)
        if run_phase("dupes", [os.path.join(SCRIPTS, "dupes.py")]):
            return fail(1)
        marker = os.path.join(LABELS, ".categories")
        if load(marker) != categories_fingerprint():  # folders changed since the last labels
            shutil.rmtree(LABELS, ignore_errors=True)
            if os.path.exists(JEV_OUT):
                os.remove(JEV_OUT)
        os.makedirs(LABELS, exist_ok=True)
        save(marker, categories_fingerprint())
        script = "label_jev.py" if labeler == "jev" else "label_claude.py"
        if run_phase("label", [os.path.join(SCRIPTS, script)]):
            return fail(1)
        if run_phase("apply", [os.path.join(SCRIPTS, "apply.py"), dest]):
            return fail(1)
        job.update(running=False, code=0, phase="done")
    start_job("sort", phases, body)


def run_single(step, args):
    cmds = {
        "scan": ["scan.py", args.get("source", "")] + (["--limit", str(args["limit"])] if args.get("limit") else []),
        "dupes": ["dupes.py"], "estimate": ["label_jev.py", "--estimate"], "jev": ["label_jev.py"],
        "claude": ["label_claude.py"], "apply": ["apply.py", args.get("dest", "")],
    }
    if step not in cmds:
        raise ValueError("unknown step")

    def body():
        if step == "scan":
            clear_library()
        code = run_phase(step, [os.path.join(SCRIPTS, cmds[step][0])] + cmds[step][1:])
        job.update(running=False, code=code, phase="done" if code == 0 else step)
    start_job(step, [step], body)


def peek(source):
    """Count what is in a folder and make a few tiny previews, right after it is picked."""
    source = os.path.expanduser(source.strip().rstrip("/"))
    if not os.path.isdir(source):
        raise ValueError("That folder does not exist.")
    photos, videos, size, pics = 0, 0, 0, []
    for dp, dirs, fs in os.walk(source):
        dirs[:] = [d for d in dirs if not d.startswith(".") and not d.endswith(" (sorted)")]
        for f in fs:
            ext = os.path.splitext(f)[1].lower()
            if f.startswith("._"):
                continue
            if ext in IMG:
                photos += 1
                if ext in (".jpg", ".jpeg", ".png", ".heic", ".webp"):
                    pics.append(os.path.join(dp, f))
            elif ext in VID:
                videos += 1
            else:
                continue
            try:
                size += os.path.getsize(os.path.join(dp, f))
            except OSError:
                pass
    shutil.rmtree(PEEK, ignore_errors=True)
    os.makedirs(PEEK)
    from PIL import Image, ImageOps
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except ImportError:
        pass
    out, stamp = [], int(time.time())
    for i, p in enumerate(random.Random(3).sample(pics, min(60, len(pics)))):
        try:
            with Image.open(p) as im:
                im.draft("RGB", (160, 160))
                im = ImageOps.exif_transpose(im).convert("RGB")
                s = min(im.size)
                im = im.crop(((im.width - s) // 2, (im.height - s) // 2, (im.width + s) // 2, (im.height + s) // 2)).resize((64, 64))
                im.save(os.path.join(PEEK, f"{i}.jpg"), quality=70)
                out.append(f"peek/{i}.jpg?{stamp}")
        except Exception:
            pass
    return {"source": source, "photos": photos, "videos": videos, "bytes": size, "previews": out,
            "suggested_dest": source + " (sorted)"}


def open_path(path, reveal=False):
    if sys.platform == "darwin":
        subprocess.run(["open", "-R", path] if reveal else ["open", path])
    elif sys.platform.startswith("win"):
        subprocess.run(["explorer", "/select," + path] if reveal else ["explorer", path])
    else:
        subprocess.run(["xdg-open", os.path.dirname(path) if reveal else path])


def pick_folder(prompt):
    """Native macOS folder picker, shown in front of the browser."""
    if sys.platform != "darwin":
        return None
    prompt = prompt.replace('"', "'")[:120]
    script = ('tell application (path to frontmost application as text)\n'
              f'  POSIX path of (choose folder with prompt "{prompt}")\n'
              'end tell')
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    return r.stdout.strip().rstrip("/") or None


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DASH, **k)

    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def end_headers(self):
        if self.path.startswith(("/data/", "/peek/")) or self.path.endswith((".js", ".css", ".html")) or self.path == "/":
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/state":
            return self.send_json(state())
        if u.path == "/api/labels":
            return self.send_json(live_labels())
        m = re.match(r"^/api/file/(\d+)$", u.path)
        if m:
            return self.send_original(int(m.group(1)))
        return super().do_GET()

    def send_original(self, i):
        inv = load(os.path.join(DATA, "inventory.json"), [])
        rec = next((r for r in inv if r["id"] == i), None)
        if not rec or not os.path.exists(rec["path"]):
            return self.send_error(404)
        path = rec["path"]
        if rec["ext"] in (".heic", ".heif", ".tif", ".tiff", ".bmp"):  # browsers can't show these: convert
            from PIL import Image, ImageOps
            try:
                from pillow_heif import register_heif_opener
                register_heif_opener()
            except ImportError:
                pass
            im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
            im.thumbnail((2400, 2400))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=88)
            b = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            return self.wfile.write(b)
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if rec["ext"] == ".mov":
            ctype = "video/mp4"  # most iPhone .mov files play fine as mp4
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                start = int(m.group(1) or 0)
                end = min(int(m.group(2)) if m.group(2) else size - 1, size - 1)
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_POST(self):
        if self.headers.get("Origin") not in (None, f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            return self.send_json({"error": "forbidden"}, 403)  # only this page may call the API
        n = int(self.headers.get("Content-Length", 0) or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        p = urllib.parse.urlparse(self.path).path
        try:
            if p == "/api/sort":
                sort_all(body)
            elif p == "/api/run":
                run_single(body.get("step"), body)
            elif p == "/api/peek":
                return self.send_json(peek(body.get("source", "")))
            elif p == "/api/categories":
                cats = body["categories"]
                keys = [c["key"] for c in cats]
                if len(keys) != len(set(keys)) or not all(c.get("label") and c.get("kind") in ("photo", "video") for c in cats):
                    raise ValueError("Every folder needs a name.")
                if not any(c["kind"] == "photo" for c in cats) or not any(c["kind"] == "video" for c in cats):
                    raise ValueError("Keep at least one photo folder and one video folder.")
                save(CATEGORIES, cats)
                save(os.path.join(DATA, "categories.json"), cats)
            elif p == "/api/move":
                ov = load(OVERRIDES, {})
                ov[str(body["id"])] = body["key"]
                save(OVERRIDES, ov)
                labels = load(os.path.join(DATA, "labels.json"), {})
                labels[str(body["id"])] = body["key"]
                save(os.path.join(DATA, "labels.json"), labels)
            elif p == "/api/open":
                src = load(os.path.join(DATA, "source.json"), {})
                if body.get("id") is not None:
                    rec = next(r for r in load(os.path.join(DATA, "inventory.json")) if r["id"] == int(body["id"]))
                    open_path(rec["path"], reveal=True)
                elif src.get("sorted"):
                    folder = body.get("folder")
                    path = os.path.join(src["sorted"], folder) if folder else src["sorted"]
                    open_path(path if os.path.isdir(path) else src["sorted"])
                else:
                    raise ValueError("Sort first, then the folders can be opened.")
            elif p == "/api/pick":
                return self.send_json({"path": pick_folder(body.get("prompt") or "Choose the folder with your photos")})
            else:
                return self.send_json({"error": "not found"}, 404)
        except Exception as e:
            return self.send_json({"error": str(e)}, 400)
        return self.send_json(state())


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    print(f"Photo sorter running at http://127.0.0.1:{PORT}  (Ctrl+C to stop)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
