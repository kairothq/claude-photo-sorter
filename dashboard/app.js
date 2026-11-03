/* Photo sorter dashboard. Plain JS, no build step.
   ?demo   use the fake camera roll in demo/
   ?d=20   animation length in seconds (default 14)
   ?auto   start the animation by itself                                       */
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const BASE = DEMO ? "demo/" : "data/";
const DURATION = (+params.get("d") || 14) * 1000;
const TOKENS_PER_FILE = 980;
const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString("en-US");
const size = b => b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.round(b / 1e6) + " MB";
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k.startsWith("aria-")) e.setAttribute(k, String(v));
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};

/* lucide icons, inlined */
const ICONS = {
  images: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
  reveal: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  replay: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
};
const icon = n => { const s = el("span", { "data-icon": n }); s.innerHTML = svg(n); return s; };
const svg = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;
const paintIcons = (root = document) => root.querySelectorAll("[data-icon]").forEach(e => { if (!e.firstChild) e.innerHTML = svg(e.dataset.icon); });

/* ---------- theme ---------- */
function setTheme(t) {
  try { localStorage.setItem("theme", t); } catch (e) {}
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelectorAll("#theme button").forEach(b => b.setAttribute("aria-pressed", b.dataset.t === t));
}
let savedTheme = "light";
try { savedTheme = localStorage.getItem("theme") || "light"; } catch (e) {}
setTheme(savedTheme);
document.querySelectorAll("#theme button").forEach(b => b.onclick = () => setTheme(b.dataset.t));

/* ---------- data ---------- */
let S = {};                 // server state
let cats = [], catBy = {}, items = [], dupeIds = new Set(), mode = "loading";
let order = [], tiles = [], released = 0, landed = 0, t0 = 0, run = "idle";
const stats = { photos: 0, videos: 0, dupes: 0, saved: 0 };

async function api(path, body) {
  if (DEMO) { toast("This is the demo. Run ./start.sh to use your own photos."); throw new Error("demo"); }
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const j = await r.json();
  if (j.error) { toast(j.error); throw new Error(j.error); }
  return j;
}
const getJSON = f => fetch(BASE + f, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null);

async function load() {
  if (!DEMO) { try { S = await api("/api/state"); } catch (e) { S = {}; } }
  const [inv, labels, dupes, c, src] = await Promise.all(["inventory.json", "labels.json", "dupes.json", "categories.json", "source.json"].map(getJSON));
  cats = (DEMO ? c : S.categories) || c || [];
  catBy = Object.fromEntries(cats.map(x => [x.key, x]));
  catBy._dupes = { key: "_dupes", label: "Duplicates", emoji: "🗂️", kind: "review" };
  dupeIds = new Set((dupes || []).flatMap(g => g.dupes));
  items = (inv || []).map(r => ({ ...r, cat: labels && labels[r.id], dupe: dupeIds.has(r.id), src: `${BASE}thumbs/${r.id}.jpg` }));
  if (DEMO) S = { source: src && src.source, sorted: null, steps: { scan: true, label: true, apply: false } };
  mode = !items.length ? "empty" : !labels ? "unlabelled" : "ready";
  $("total").textContent = fmt(items.length);
  $("source").textContent = S.source ? S.source + (S.limit ? ` · sample of ${fmt(S.limit)}` : "") : "";
  $("k-ftotal").textContent = cats.length;
  $("k-checked-s").textContent = items.length ? size(items.reduce((s, r) => s + r.bytes, 0)) + " in total" : "photos & videos";
  $("btnOpen").hidden = !S.sorted;
  buildCards();
  buildSphere();
  showEmpty();
  setPill();
}

/* ---------- cards ---------- */
function card(c) {
  const wide = c.key === "_dupes";
  const n = wide ? 24 : 12;
  const e = el("button", { class: "card" + (wide ? " wide review" : ""), onclick: () => openFolder(c) },
    el("div", { class: "ch" }, el("span", {}, c.emoji || "📁"), el("span", { class: "name" }, c.label), el("span", { class: "mx-count" }, "0")),
    el("div", { class: "grid" }, Array.from({ length: n }, () => el("div", { class: "slot" }))));
  Object.assign(c, { el: e, badge: e.querySelector(".mx-count"), slots: [...e.querySelectorAll(".slot")], queued: 0, landed: [] });
  return e;
}
function buildCards() {
  $("photos").replaceChildren(...cats.filter(c => c.kind === "photo").map(card));
  $("videos").replaceChildren(...cats.filter(c => c.kind === "video").map(card), card(catBy._dupes));
}
const targetOf = it => it.dupe ? catBy._dupes : (catBy[it.cat] || catBy._dupes);

/* ---------- sphere ---------- */
let rot = 0;
function buildSphere() {
  $("sphere").replaceChildren();
  tiles = [];
  if (!items.length) return;
  const T = Math.min(items.length, 420), golden = Math.PI * (3 - Math.sqrt(5));
  order = shuffle(items.map((_, i) => i));
  for (let i = 0; i < T; i++) {
    const y = 1 - (i / Math.max(1, T - 1)) * 2, r = Math.sqrt(1 - y * y), th = golden * i;
    const img = el("img", { src: items[order[i]].src, alt: "" });
    $("sphere").append(img);
    tiles.push({ el: img, x: Math.cos(th) * r, y, z: Math.sin(th) * r, left: 0, sx: 0, sy: 0, s: 1, alive: true });
  }
  order.forEach((idx, k) => { tiles[k % T].left++; items[idx].tile = tiles[k % T]; });
}
function geom() {
  const r = $("stage").getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: Math.min(r.width, r.height) * 0.38 };
}
function drawSphere(dt) {
  if (!tiles.length) return;
  rot += dt * 0.00035;
  const tilt = Math.sin(performance.now() / 4000) * 0.35;
  const { cx, cy, R } = geom();
  const ca = Math.cos(rot), sa = Math.sin(rot), cb = Math.cos(tilt), sb = Math.sin(tilt);
  for (const t of tiles) {
    if (!t.alive) continue;
    const x = t.x * ca + t.z * sa; let z = -t.x * sa + t.z * ca;
    const y = t.y * cb - z * sb; z = t.y * sb + z * cb;
    const depth = (z + 1) / 2;
    t.s = 0.45 + depth * 0.75; t.sx = cx + x * R; t.sy = cy + y * R;
    t.el.style.transform = `translate(${t.sx - 15}px,${t.sy - 15}px) scale(${t.s})`;
    t.el.style.opacity = 0.2 + depth * 0.8;
    t.el.style.zIndex = Math.round(depth * 100);
  }
}

/* ---------- the sort animation ---------- */
const ease = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
function start() {
  if (mode === "empty" || mode === "unlabelled") return openSteps();
  if (run === "running") return;
  if (run === "done") reset();
  run = "running"; t0 = performance.now();
  document.body.classList.remove("is-done");
  $("golabel").textContent = "Sorting…";
  setPill("busy", "Claude is looking at every photo & video");
}
function release(it) {
  const t = it.tile, c = targetOf(it);
  const to = c.slots[c.queued++ % c.slots.length].getBoundingClientRect();
  const s = 30 * t.s, img = el("img", { src: it.src, alt: "" });
  img.style.width = img.style.height = s + "px";
  $("fly").append(img);
  if (--t.left === 0) { t.alive = false; t.el.style.opacity = 0; }
  const mx = (t.sx + to.left) / 2 + (Math.random() - .5) * 120, my = (t.sy + to.top) / 2 - 60 - Math.random() * 80;
  const a = img.animate([
    { transform: `translate(${t.sx - s / 2}px,${t.sy - s / 2}px) scale(1)` },
    { transform: `translate(${mx - s / 2}px,${my - s / 2}px) scale(1.25) rotate(${(Math.random() - .5) * 50}deg)`, offset: .45 },
    { transform: `translate(${to.left}px,${to.top}px) scale(${to.width / s})` },
  ], { duration: 650 + Math.random() * 450, easing: "cubic-bezier(.55,0,.25,1)" });
  a.onfinish = () => { img.remove(); land(it, c, true); };
}
function land(it, c, live) {
  c.landed.push(it);
  if (live) {
    const recent = c.landed.slice(-c.slots.length).reverse();
    c.slots.forEach((s, i) => { const w = recent[i] && recent[i].src; if (w && s.dataset.src !== w) { s.dataset.src = w; s.replaceChildren(el("img", { src: w, alt: "" })); } });
    c.badge.classList.remove("pop"); void c.badge.offsetWidth; c.badge.classList.add("pop");
    c.el.classList.add("hit"); clearTimeout(c.hitT); c.hitT = setTimeout(() => c.el.classList.remove("hit"), 280);
  }
  c.badge.textContent = fmt(c.landed.length); c.badge.classList.add("on");
  if (it.dupe) { stats.dupes++; stats.saved += it.bytes; } else if (it.kind === "video") stats.videos++; else stats.photos++;
  landed++;
  if (live && landed === items.length) finish();
}
function finish() {
  run = "done";
  document.body.classList.add("is-done");
  $("golabel").textContent = "Play again";
  $("bigF").textContent = `${cats.length} folders`;
  $("chipD").textContent = `🗂️ ${fmt(stats.dupes)} duplicates`;
  $("chipS").textContent = `💾 ${size(stats.saved)} freed`;
  countUp($("bigN"), items.length, 900);
  setPill("live", "Sorted");
  confetti();
}
function showResult() {  // skip the animation: fill every card straight away
  if (mode !== "ready") return openSteps();
  reset();
  tiles.forEach(t => { t.alive = false; t.el.style.opacity = 0; });
  items.forEach(it => land(it, targetOf(it), false));
  cats.concat(catBy._dupes).forEach(c => {
    const recent = c.landed.slice(-c.slots.length).reverse();
    c.slots.forEach((s, i) => s.replaceChildren(...(recent[i] ? [el("img", { src: recent[i].src, alt: "" })] : [])));
  });
  released = items.length;
  run = "done";
  document.body.classList.add("is-done");
  $("golabel").textContent = "Play again";
  $("bigF").textContent = `${cats.length} folders`;
  $("chipD").textContent = `🗂️ ${fmt(stats.dupes)} duplicates`;
  $("chipS").textContent = `💾 ${size(stats.saved)} freed`;
  $("bigN").textContent = fmt(items.length);
  setPill("live", "Sorted");
}
function reset() {
  Object.assign(stats, { photos: 0, videos: 0, dupes: 0, saved: 0 });
  released = landed = 0; run = "idle";
  document.body.classList.remove("is-done");
  $("fly").replaceChildren();
  buildCards(); buildSphere();
  $("golabel").textContent = "Sort with Claude";
  setPill();
}
function updateStats() {
  $("k-checked").textContent = fmt(released);
  $("k-photos").textContent = fmt(stats.photos);
  $("k-videos").textContent = fmt(stats.videos);
  $("k-folders").textContent = cats.filter(c => c.landed && c.landed.length).length;
  $("k-dupes").textContent = fmt(stats.dupes);
  $("k-saved").textContent = size(stats.saved);
  $("pcount").textContent = fmt(stats.photos);
  $("vcount").textContent = fmt(stats.videos);
  $("bar").style.width = (items.length ? landed / items.length * 100 : 0) + "%";
}
let last = performance.now();
function tick(now) {
  const dt = now - last; last = now;
  drawSphere(dt);
  if (run === "running") {
    const want = Math.min(items.length, Math.floor(items.length * ease(Math.min(1, (now - t0) / DURATION))));
    while (released < want) release(items[order[released++]]);
  }
  updateStats();
  requestAnimationFrame(tick);
}
function countUp(e, to, ms) {
  const s = performance.now();
  (function f(n) { const p = Math.min(1, (n - s) / ms); e.textContent = fmt(to * ease(p)); if (p < 1) requestAnimationFrame(f); })(s);
}
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = $("confetti"), ctx = cv.getContext("2d"), dpr = devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const cols = ["--brand-solid", "--green", "--accent", "--faint", "--ink"].map(v => css.getPropertyValue(v).trim());
  const { cx, cy } = geom(), s = performance.now();
  const ps = Array.from({ length: 200 }, () => ({ x: cx, y: cy - 40, vx: (Math.random() - .5) * 14, vy: -Math.random() * 13 - 3,
    w: 5 + Math.random() * 5, h: 3 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - .5) * .3, c: cols[Math.floor(Math.random() * cols.length)] }));
  (function f(n) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const a = Math.max(0, 1 - (n - s) / 3200);
    ps.forEach(p => { p.vy += .32; p.vx *= .985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = a; ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); });
    if (a > 0) requestAnimationFrame(f);
  })(s);
}

/* ---------- status, empty states ---------- */
function setPill(kind, text) {
  const d = $("pill").querySelector(".dot");
  d.className = "dot" + (kind ? " " + kind : "");
  $("pilltext").textContent = text || ({ empty: "No photos yet", unlabelled: "Scanned, not labelled", ready: "Ready to sort", loading: "Loading" }[mode]) + (DEMO ? " · demo" : "");
}
function showEmpty() {
  const box = $("empty");
  box.classList.toggle("on", mode === "empty" || mode === "unlabelled");
  if (mode === "empty") box.replaceChildren(el("div", { class: "onboard mx-rise" },
    el("h2", {}, "Sort your camera roll"),
    el("p", {}, "Pick the folder with your photos and videos. Nothing is moved or deleted, the tool only makes sorted copies."),
    el("button", { class: "mx-btn solid", onclick: openSteps }, icon("folder"), "Choose photos folder"),
    el("p", { class: "note" }, el("a", { href: "?demo" }, "or look at the demo first"))));
  else if (mode === "unlabelled") box.replaceChildren(el("div", { class: "onboard mx-rise" },
    el("h2", {}, `${fmt(items.length)} files scanned`),
    el("p", {}, "Next, label them. Ask Claude in your terminal, or use Jev from the Steps panel."),
    el("button", { class: "mx-btn solid", onclick: openSteps }, icon("list"), "Open steps")));
}

/* ---------- overlays ---------- */
function closeAll() { $("overlay").replaceChildren(); document.removeEventListener("keydown", lbKeys); }
function overlay(...nodes) { closeAll(); $("overlay").append(...nodes); paintIcons($("overlay")); }
function toast(t) { const e = $("toast"); e.textContent = t; e.classList.add("on"); clearTimeout(e.t); e.t = setTimeout(() => e.classList.remove("on"), 2800); }
addEventListener("keydown", e => { if (e.key === "Escape" && !document.querySelector(".lightbox")) closeAll(); });

/* Steps drawer: scan, duplicates, label, build */
let poll;
function openSteps() {
  const st = S.steps || {};
  const srcInput = el("input", { class: "field", placeholder: "/Users/you/Pictures/Camera roll", value: S.source || "" });
  const sample = el("input", { type: "checkbox" });
  const dest = el("input", { class: "field", placeholder: "Where to put the sorted folders", value: S.sorted || (S.source ? S.source.replace(/\/$/, "") + " (sorted)" : "") });
  const log = el("pre", { class: "log", id: "log" }, (S.job && S.job.log || []).join("\n") || "Output from each step shows up here.");
  const step = (n, ok, title, text, ...row) => el("div", { class: "step" + (ok ? " ok" : "") },
    el("span", { class: "n" }, ok ? icon("check") : String(n)), el("div", {}, el("b", {}, title), el("p", {}, text), el("div", { class: "row" }, row)));
  const go = (name, extra = {}) => api("/api/run", { step: name, ...extra }).then(watch).catch(() => {});

  overlay(el("div", { class: "scrim", onclick: closeAll }), el("aside", { class: "drawer", role: "dialog", "aria-label": "Steps" },
    el("div", { class: "fb-head" }, el("h2", {}, "Steps"), el("button", { class: "mx-icon", onclick: closeAll, "aria-label": "Close" }, icon("x"))),
    el("div", { style: "overflow-y:auto" },
      step(1, st.scan, "Choose your photos", "A Google Takeout, Apple Photos export or any folder. Read only.",
        el("div", { style: "width:100%" }, srcInput,
          el("div", { class: "row" },
            S.platform === "darwin" ? el("button", { class: "mx-btn small", onclick: async () => { const r = await api("/api/pick", {}); if (r.path) srcInput.value = r.path; } }, icon("folder"), "Browse…") : null,
            el("label", { class: "check-row" }, sample, "Try 200 first"),
            el("span", { style: "flex:1" }),
            el("button", { class: "mx-btn small solid", onclick: () => go("scan", { source: srcInput.value.trim(), limit: sample.checked ? 200 : 0 }) }, "Scan")))),
      step(2, st.dupes, "Find duplicates", "Burst shots, re-saved screenshots and identical copies.",
        el("button", { class: "mx-btn small", disabled: !st.scan, onclick: () => go("dupes") }, "Find duplicates")),
      step(3, st.label, "Label every file", "Pick one. Claude is free with your Claude plan. Jev is a fast image model billed per file.",
        el("div", { style: "width:100%" },
          el("p", { class: "hint" }, "Claude: in your terminal say ", el("code", {}, "label my photos")),
          el("div", { class: "row" },
            el("button", { class: "mx-btn small", onclick: () => { navigator.clipboard.writeText("label my photos"); toast("Copied. Paste it into Claude Code."); } }, icon("copy"), "Copy"),
            el("span", { style: "flex:1" }),
            el("button", { class: "mx-btn small", disabled: !st.scan, onclick: confirmJev }, "Label with Jev ", el("span", { class: "paid" }, "PAID"))))),
      step(4, st.apply, "Build the folders", "Copies every file into its folder. Duplicates go to _Review. Originals stay where they are.",
        el("div", { style: "width:100%" }, dest,
          el("div", { class: "row" },
            el("span", { style: "flex:1" }),
            S.sorted ? el("button", { class: "mx-btn small", onclick: () => api("/api/open", {}) }, icon("folder"), "Open") : null,
            el("button", { class: "mx-btn small solid", disabled: !st.label, onclick: () => go("apply", { dest: dest.value.trim() }) }, "Build folders"))))),
    log));
  if (S.job && S.job.running) watch(S);
}
function watch(state) {
  S = state;
  clearInterval(poll);
  poll = setInterval(async () => {
    S = await api("/api/state");
    const log = $("log");
    if (log) { log.textContent = S.job.log.join("\n"); log.scrollTop = log.scrollHeight; }
    setPill(S.job.running ? "busy" : null, S.job.running ? `Running: ${S.job.step}` : null);
    if (!S.job.running) {
      clearInterval(poll);
      toast(S.job.code === 0 ? `Done: ${S.job.step}` : `${S.job.step} stopped, see the log`);
      await load();
      if ($("log")) openSteps();
    }
  }, 900);
}
function confirmJev() {
  if (!S.jev_key) return toast("Add JEV_KEY=your-key to a .env file in this folder first.");
  const n = items.length;
  overlay(el("div", { class: "fb-scrim", onclick: e => e.target === e.currentTarget && closeAll() },
    el("div", { class: "fb-dialog pc", role: "dialog" },
      el("div", { class: "fb-head" }, el("h2", {}, "Label with Jev"), el("button", { class: "mx-icon", onclick: closeAll, "aria-label": "Close" }, icon("x"))),
      el("div", { class: "pc-list" }, el("div", { class: "pc-choice" },
        el("div", {}, el("b", {}, `${fmt(n)} files, about ${fmt(n * TOKENS_PER_FILE)} tokens`),
          el("p", {}, "Sends a small 280px preview of each file to TypeSafe's Jev model, never the original. Check the per-token price on console.typesafe.ai.")),
        el("button", { class: "mx-btn solid", onclick: () => { closeAll(); api("/api/run", { step: "jev" }).then(s => { openSteps(); watch(s); }).catch(() => {}); } }, "Spend tokens"))),
      el("p", { class: "pc-note" }, "Already-labelled files are skipped, so you can stop and resume."))));
}

/* Folder editor */
function openFolders() {
  const draft = cats.map(c => ({ ...c }));
  const list = el("div", { class: "folder-list" });
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "folder";
  function row(c) {
    const seg = el("div", { class: "mx-seg" }, ["photo", "video"].map(k => el("button", { "aria-pressed": c.kind === k, onclick: () => { c.kind = k; render(); } }, k === "photo" ? "Photos" : "Videos")));
    return el("div", { class: "folder-row" },
      el("input", { class: "emoji", value: c.emoji || "📁", "aria-label": "Emoji", oninput: e => c.emoji = e.target.value }),
      el("input", { value: c.label, placeholder: "Folder name", "aria-label": "Folder name", oninput: e => c.label = e.target.value }),
      el("input", { class: "rule", value: c.rule || "", placeholder: "What goes in here, in plain words", "aria-label": "Rule", oninput: e => c.rule = e.target.value }),
      seg,
      el("button", { class: "mx-icon", "aria-label": `Delete ${c.label}`, onclick: () => { draft.splice(draft.indexOf(c), 1); render(); } }, icon("trash")));
  }
  function render() {
    list.replaceChildren(
      el("h4", {}, "Photo folders"), ...draft.filter(c => c.kind === "photo").map(row),
      el("h4", {}, "Video folders"), ...draft.filter(c => c.kind === "video").map(row));
    paintIcons(list);
  }
  const add = kind => () => { draft.push({ key: "", kind, label: "", emoji: kind === "photo" ? "📁" : "🎬", rule: "" }); render(); list.querySelector(".folder-row:last-of-type input:nth-child(2)"); };
  async function saveIt() {
    const used = new Set();
    for (const c of draft) {
      if (!c.label.trim()) return toast("Every folder needs a name.");
      c.label = c.label.trim(); c.rule = (c.rule || "").trim() || c.label;
      if (!c.key) { let k = slug(c.label), i = 2; while (used.has(k) || draft.some(d => d !== c && d.key === k)) k = slug(c.label) + "-" + i++; c.key = k; }
      used.add(c.key);
    }
    try {
      S = await api("/api/categories", { categories: draft.map(({ key, kind, label, emoji, rule }) => ({ key, kind, label, emoji, rule })) });
    } catch (e) { return; }
    closeAll();
    toast(S.steps && S.steps.label ? "Saved. Label again so files can use the new folders." : "Folders saved.");
    await load();
  }
  render();
  overlay(el("div", { class: "fb-scrim", onclick: e => e.target === e.currentTarget && closeAll() },
    el("div", { class: "fb-dialog", role: "dialog", "aria-label": "Edit folders" },
      el("div", { class: "fb-head" }, el("h2", {}, "Folders"), el("button", { class: "mx-icon", onclick: closeAll, "aria-label": "Close" }, icon("x"))),
      el("div", { class: "fb-rows" }, list,
        el("p", { class: "note" }, "The rule is what the model reads, so describe the folder like you would to a friend. Changing folders after labelling means labelling again.")),
      el("div", { class: "fb-foot" },
        el("button", { class: "mx-btn", onclick: add("photo") }, icon("plus"), "Photo folder"),
        el("button", { class: "mx-btn", onclick: add("video") }, icon("plus"), "Video folder"),
        el("span", { class: "spacer" }),
        el("button", { class: "mx-btn ghost", onclick: closeAll }, "Cancel"),
        el("button", { class: "mx-btn solid", onclick: saveIt }, "Save folders")))));
}

/* Browse one folder */
function openFolder(c) {
  const all = items.filter(i => c.key === "_dupes" ? i.dupe : !i.dupe && i.cat === c.key);
  const grid = el("div", { class: "browse" });
  let shown = 0;
  const more = () => {
    grid.querySelector(".more")?.remove();
    const from = shown;
    all.slice(from, from + 120).forEach((it, k) => grid.append(el("button", { onclick: () => lightbox(all, from + k), "aria-label": it.name },
      el("img", { src: it.src, alt: "", loading: "lazy" }), it.kind === "video" ? el("span", { class: "vid" }, "▶ " + (it.duration ? Math.round(it.duration) + "s" : "video")) : null)));
    shown += 120;
    if (shown < all.length) grid.append(el("button", { class: "mx-btn more", onclick: more }, `Show ${fmt(Math.min(120, all.length - shown))} more`));
  };
  more();
  overlay(el("div", { class: "fb-scrim", onclick: e => e.target === e.currentTarget && closeAll() },
    el("div", { class: "fb-dialog wide", role: "dialog", "aria-label": c.label },
      el("div", { class: "fb-head" }, el("h2", {}, c.emoji || "📁", ` ${c.label}`, el("span", { class: "mx-count" }, fmt(all.length))),
        el("div", { class: "acts" },
          S.sorted ? el("button", { class: "mx-btn small", onclick: () => api("/api/open", { folder: c.key === "_dupes" ? "_Review/duplicates" : c.label.replace(/&/g, "and").replace(/\//g, "-") }) }, icon("folder"), "Open in Finder") : null,
          el("button", { class: "mx-icon", onclick: closeAll, "aria-label": "Close" }, icon("x")))),
      all.length ? grid : el("p", { class: "mx-empty", style: "padding:22px" }, "Nothing in this folder yet."))));
}

/* Full-size viewer */
let lbKeys = () => {};
function lightbox(list, i) {
  const it = list[i];
  const full = DEMO ? it.src : `/api/file/${it.id}`;
  const media = it.kind === "video" && !DEMO ? el("video", { src: full, controls: true, autoplay: true, playsinline: true, poster: it.src }) : el("img", { src: full, alt: it.name });
  const move = el("select", { class: "mx-select", "aria-label": "Move to folder", onchange: async e => {
    const key = e.target.value;
    try { await api("/api/move", { id: it.id, key }); } catch (err) { return; }
    it.cat = key; it.dupe = false; dupeIds.delete(it.id);
    toast(`Moved to ${catBy[key].label}. Build folders again to update the copies.`);
    if (run === "done") showResult();
  } }, cats.filter(c => c.kind === it.kind).map(c => el("option", { value: c.key, selected: c.key === it.cat }, `${c.emoji || ""} ${c.label}`)));
  const box = el("div", { class: "lightbox", role: "dialog", "aria-label": it.name },
    el("div", { class: "media" }, media),
    el("div", { class: "bar" },
      el("b", {}, it.name), el("small", {}, `${size(it.bytes)}${it.taken ? " · " + new Date(it.taken * 1000).toLocaleDateString() : ""} · ${i + 1} of ${fmt(list.length)}`),
      el("span", { class: "spacer" }),
      el("small", {}, "Move to"), move,
      DEMO ? null : el("button", { class: "mx-btn small", onclick: () => api("/api/open", { id: it.id }) }, icon("reveal"), "Show original")),
    el("button", { class: "nav prev", "aria-label": "Previous", onclick: () => i > 0 && lightbox(list, i - 1) }, icon("left")),
    el("button", { class: "nav next", "aria-label": "Next", onclick: () => i < list.length - 1 && lightbox(list, i + 1) }, icon("right")),
    el("button", { class: "mx-icon close", "aria-label": "Close", onclick: () => { box.remove(); document.removeEventListener("keydown", lbKeys); } }, icon("x")));
  document.querySelector(".lightbox")?.remove();
  document.removeEventListener("keydown", lbKeys);
  lbKeys = e => {
    if (e.key === "ArrowLeft" && i > 0) lightbox(list, i - 1);
    if (e.key === "ArrowRight" && i < list.length - 1) lightbox(list, i + 1);
    if (e.key === "Escape") { box.remove(); document.removeEventListener("keydown", lbKeys); }
  };
  document.addEventListener("keydown", lbKeys);
  $("overlay").append(box);
  paintIcons(box);
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ---------- wire up ---------- */
paintIcons();
$("go").onclick = start;
$("btnSteps").onclick = openSteps;
$("btnFolders").onclick = openFolders;
$("btnShow").onclick = showResult;
$("btnOpen").onclick = () => api("/api/open", {}).catch(() => {});
addEventListener("keydown", e => {
  if (e.target.matches("input, textarea, select") || $("overlay").children.length) return;
  if (e.code === "Space") { e.preventDefault(); start(); }
  if (e.key === "r" || e.key === "R") reset();
});
load().then(() => { requestAnimationFrame(tick); if (params.has("auto")) setTimeout(start, 1200); });
