"""Label every file with Claude Code running headless in the background.

  python scripts/label_claude.py            # all batches (resumes where it stopped)
  python scripts/label_claude.py --only 1   # just the first batch, to test

Uses the `claude` command you already have (your Claude plan, no API key).
Contact sheets of 30 previews are grouped 3 per batch (about 90 files) and up to 4
batches run at once. Each batch's answer is saved to work/labels/claude_NN.json,
so the dashboard can show progress and fly those photos into their folders.
"""
import glob, json, os, re, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(__file__))
from common import DATA, LABELS, WORK, categories, load, save

SHEETS_PER_BATCH = 3
WORKERS = int(os.environ.get("CLAUDE_WORKERS", 4))
MODEL = os.environ.get("CLAUDE_MODEL", "sonnet")

claude = shutil.which("claude")
if not claude:
    sys.exit("The `claude` command was not found. Install Claude Code from claude.com/claude-code, "
             "or label with Jev under Advanced.")

sheet_dir = os.path.join(WORK, "sheets")
if not glob.glob(os.path.join(sheet_dir, "sheet_*.jpg")):
    subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "sheets.py")], check=True)
sheets = sorted(glob.glob(os.path.join(sheet_dir, "sheet_*.jpg")))
inv = load(os.path.join(DATA, "inventory.json"))
cats = categories()
os.makedirs(LABELS, exist_ok=True)

folders = "\n".join(f"- {c['key']} ({c['kind']}): {c['rule']}" for c in cats)
batches = [sheets[i:i + SHEETS_PER_BATCH] for i in range(0, len(sheets), SHEETS_PER_BATCH)]
if "--only" in sys.argv:
    batches = batches[:int(sys.argv[sys.argv.index("--only") + 1])]


def ids_in(batch):
    first = int(re.search(r"sheet_(\d+)", batch[0]).group(1)) * 30
    last = (int(re.search(r"sheet_(\d+)", batch[-1]).group(1)) + 1) * 30
    return [str(r["id"]) for r in inv[first:last]]


def run(n, batch):
    out = os.path.join(LABELS, f"claude_{n:02d}.json")
    want = ids_in(batch)
    if os.path.exists(out) and set(want) <= set(load(out, {})):
        return n, len(want), 0.0, "cached"
    prompt = (
        "You sort a camera roll into folders. These are the folders, as key (kind): what goes in it\n"
        f"{folders}\n\n"
        "Use the Read tool to look at each of these contact sheet images:\n" + "\n".join(batch) + "\n\n"
        "Each sheet shows up to 30 square previews, each tagged in yellow with a number (its id). "
        "A tag with VIDEO is a video and must get a (video) folder. Every other tile is a photo and must get a "
        "(photo) folder. PNG usually means a screenshot. Give every id you see exactly one folder key from the list.\n\n"
        "Reply with only a JSON object mapping id to folder key, like {\"12\": \"food\", \"13\": \"selfies\"}. No other text.")
    t0 = time.time()
    r = subprocess.run([claude, "-p", prompt, "--model", MODEL, "--allowedTools", "Read", "--strict-mcp-config",
                        "--setting-sources", "project", "--no-session-persistence", "--output-format", "json"],
                       cwd=WORK, capture_output=True, text=True, timeout=900)
    try:
        res = json.loads(r.stdout)
        text, cost = res.get("result", ""), res.get("total_cost_usd", 0) or 0
        labels = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
    except Exception:
        raise RuntimeError(f"batch {n}: could not read Claude's answer: {(r.stdout or r.stderr)[:300]}")
    labels = {str(k): v for k, v in labels.items() if str(k) in want}
    save(out, labels)
    return n, len(labels), cost, f"{time.time() - t0:.0f}s"


print(f"Claude is labelling {len(inv)} files in {len(batches)} batches ({WORKERS} at a time, model {MODEL})...", flush=True)
t0, done, cost, failed = time.time(), 0, 0.0, []
with ThreadPoolExecutor(WORKERS) as ex:
    futs = [ex.submit(run, n, b) for n, b in enumerate(batches)]
    for f in as_completed(futs):
        try:
            n, k, c, how = f.result()
            done += 1
            cost += c
            print(f"PROGRESS {done} {len(batches)}", flush=True)
            print(f"  batch {done}/{len(batches)} done: {k} files ({how})", flush=True)
        except Exception as e:
            failed.append(str(e))
            print(f"  {e}", flush=True)

labelled = set()
for f in glob.glob(os.path.join(LABELS, "*.json")):
    labelled |= set(load(f, {}))
missing = len(inv) - len(labelled & {str(r["id"]) for r in inv})
print(f"Done in {time.time() - t0:.0f}s: {len(inv) - missing} labelled, {missing} missing"
      + (f", {len(failed)} batches failed (run again to retry)" if failed else ""), flush=True)
sys.exit(1 if failed else 0)
