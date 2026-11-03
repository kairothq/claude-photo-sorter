"""The dashboard app.  python scripts/server.py   ->  http://127.0.0.1:8765

Serves dashboard/ plus a small local API so the page can run every step itself:
pick a folder, scan, find duplicates, label with Jev, build folders, edit folders,
browse photos at full size, move a photo to another folder, open folders in Finder.
Listens on 127.0.0.1 only: nothing is reachable from other computers.
"""
import io, json, mimetypes, os, re, subprocess, sys, threading, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
from common import CATEGORIES, DATA, JEV_OUT, LABELS, ROOT, WORK, load, save

PORT = int(os.environ.get("PORT", 8765))
DASH = os.path.join(ROOT, "dashboard")
OVERRIDES = os.path.join(WORK, "overrides.json")
PY = sys.executable
job = {"step": None, "running": False, "log": [], "code": None}


def has_jev_key():
    if os.environ.get("JEV_KEY") or os.environ.get("TYPESAFE_API_KEY"):
        return True
    env = os.path.join(ROOT, ".env")
    return os.path.exists(env) and bool(re.search(r"^(JEV_KEY|TYPESAFE_API_KEY)=\S", open(env).read(), re.M))


def state():
    inv = load(os.path.join(DATA, "inventory.json"), [])
    src = load(os.path.join(DATA, "source.json"), {})
    claude_files = [f for f in os.listdir(LABELS)] if os.path.isdir(LABELS) else []
    return {
        "categories": load(CATEGORIES, []),
        "source": src.get("source"), "limit": src.get("limit"), "sorted": src.get("sorted"),
        "files": len(inv),
        "steps": {
            "scan": bool(inv),
            "dupes": os.path.exists(os.path.join(DATA, "dupes.json")),
            "label": bool(claude_files) or os.path.exists(JEV_OUT),
            "claude_labels": len(claude_files) > 0,
            "jev_labels": os.path.exists(JEV_OUT),
            "apply": bool(src.get("sorted")) and os.path.exists(os.path.join(DATA, "labels.json")),
        },
        "jev_key": has_jev_key(),
        "overrides": len(load(OVERRIDES, {})),
        "job": {k: job[k] for k in ("step", "running", "code")} | {"log": job["log"][-40:]},
        "platform": sys.platform,
    }


def run(step, args):
    cmds = {
        "scan": ["scan.py", args.get("source", "")] + (["--limit", str(args["limit"])] if args.get("limit") else []),
        "dupes": ["dupes.py"],
        "estimate": ["label_jev.py", "--estimate"],
        "jev": ["label_jev.py"],
        "apply": ["apply.py", args.get("dest", "")],
    }
    if step not in cmds:
        raise ValueError("unknown step")
    if job["running"]:
        raise RuntimeError("another step is still running")
    cmd = [PY, "-u", os.path.join(ROOT, "scripts", cmds[step][0])] + cmds[step][1:]
    job.update(step=step, running=True, log=[f"$ {step}"], code=None)

    def go():
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=ROOT)
        for line in p.stdout:
            job["log"].append(line.rstrip())
        job.update(running=False, code=p.wait())
        if step == "scan" and job["code"] == 0:  # new library: old labels no longer match
            for f in (os.path.join(DATA, "labels.json"), os.path.join(DATA, "dupes.json"), JEV_OUT, OVERRIDES):
                if os.path.exists(f):
                    os.remove(f)
    threading.Thread(target=go, daemon=True).start()


def open_path(path, reveal=False):
    if sys.platform == "darwin":
        subprocess.run(["open", "-R", path] if reveal else ["open", path])
    elif sys.platform.startswith("win"):
        subprocess.run(["explorer", "/select," + path] if reveal else ["explorer", path])
    else:
        subprocess.run(["xdg-open", os.path.dirname(path) if reveal else path])


def pick_folder(prompt="Choose the folder with your photos"):
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
        if self.path.startswith("/data/") and self.path.endswith(".json"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/state":
            return self.send_json(state())
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
            ctype = "video/mp4"  # most iPhone .mov files are H.264/HEVC in an mp4-compatible box
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
            if p == "/api/run":
                run(body.get("step"), body)
            elif p == "/api/categories":
                cats = body["categories"]
                keys = [c["key"] for c in cats]
                if len(keys) != len(set(keys)) or not all(c.get("label") and c.get("kind") in ("photo", "video") for c in cats):
                    raise ValueError("every folder needs a unique key, a name and a type")
                if not any(c["kind"] == "photo" for c in cats) or not any(c["kind"] == "video" for c in cats):
                    raise ValueError("keep at least one photo folder and one video folder")
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
                    raise ValueError("build the folders first")
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
