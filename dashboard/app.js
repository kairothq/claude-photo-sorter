/* Photo sorter dashboard. Plain JS, no build step.
   States: setup (choose folders) -> running (live sort) -> done (results, replay).
   ?demo   the fake camera roll in demo/      ?d=20  replay length in seconds      ?auto  replay by itself */
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const BASE = DEMO ? "demo/" : "data/";
const REPLAY_MS = (+params.get("d") || 12) * 1000;
const TOKENS_PER_FILE = 980;
const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString("en-US");
const size = b => b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.round(b / 1e6) + " MB";
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const roughly = s => s < 50 ? "under a minute" : s < 90 ? "about a minute" : `about ${Math.round(s / 60)} min`;
const tilde = p => (p || "").replace(/^\/Users\/[^/]+/, "~");
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k.startsWith("aria-")) e.setAttribute(k, String(v));
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};

/* lucide icons, inlined */
const ICONS = {
  images: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>', down: '<path d="m6 9 6 6 6-6"/>',
  reveal: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
};
const svg = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;
const icon = n => { const s = el("span", { "data-icon": n }); s.innerHTML = svg(n); return s; };
const paintIcons = (root = document) => root.querySelectorAll("[data-icon]").forEach(e => { if (!e.firstChild) e.innerHTML = svg(e.dataset.icon); });
function toast(t) { const e = $("toast"); e.textContent = t; e.classList.add("on"); clearTimeout(e.t); e.t = setTimeout(() => e.classList.remove("on"), 3200); }

/* ---------- theme: one sun / moon button ---------- */
function setTheme(t) {
  try { localStorage.setItem("theme", t); } catch (e) {}
  document.documentElement.dataset.theme = t;
  $("theme").innerHTML = svg(t === "dark" ? "sun" : "moon");
  $("theme").setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
}
let theme = "light";
try { theme = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } catch (e) {}
setTheme(theme === "system" ? "light" : theme);
$("theme").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

/* ---------- state ---------- */
let S = {};                                 // server state
let mode = "loading";                       // setup | running | done
let cats = [], catBy = {}, items = [], byId = {}, dupeIds = new Set(), labels = {};
const pick = { source: null, dest: null, peek: null, advanced: false, labeler: "claude", sample: false, typing: null };
let tiles = [], run = "idle", order = [], released = 0, landed = 0, t0 = 0;
const queue = [], flown = new Set();
const stats = { photos: 0, videos: 0, dupes: 0, saved: 0 };

async function api(path, body) {
  if (DEMO) { toast("This is the demo. Run ./start.sh to sort your own photos."); throw new Error("demo"); }
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const j = await r.json();
  if (j && j.error) { toast(j.error); throw new Error(j.error); }
  return j;
}
const getJSON = f => fetch(BASE + f, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null);

function setCats(c) {
  cats = c || [];
  catBy = Object.fromEntries(cats.map(x => [x.key, x]));
  catBy._dupes = { key: "_dupes", label: "Duplicates", emoji: "🗂️", kind: "review" };
  $("k-ftotal").textContent = cats.length;
}
async function loadLibrary(withLabels) {
  const [inv, lab, dupes, src] = await Promise.all(["inventory.json", "labels.json", "dupes.json", "source.json"].map(getJSON));
  dupeIds = new Set((dupes || []).flatMap(g => g.dupes));
  labels = withLabels && lab ? lab : {};
  items = (inv || []).map(r => ({ ...r, cat: labels[r.id], dupe: dupeIds.has(r.id),
    mini: `${BASE}mini/${r.id}.jpg`, src: `${BASE}thumbs/${r.id}.jpg` }));
  byId = Object.fromEntries(items.map(it => [it.id, it]));
  return { inv, lab, src };
}
function miniImg(it) {  // small copy for the animation; falls back to the bigger preview for older scans
  const img = el("img", { src: it.mini, alt: "" });
  img.onerror = () => { img.onerror = null; img.src = it.src; };
  return img;
}

/* ---------- header ---------- */
function setPill(kind, text) {
  $("pill").querySelector(".dot").className = "dot" + (kind ? " " + kind : "");
  $("pilltext").textContent = text + (DEMO ? " · demo" : "");
}
function setHeader() {
  const src = mode === "setup" ? pick.source : S.source;
  $("source").textContent = src ? tilde(src) + (S.limit && mode !== "setup" ? ` · sample of ${fmt(S.limit)}` : "") : "";
  $("total").hidden = !items.length || mode === "setup";
  $("total").textContent = fmt(items.length);
  $("btnOpen").hidden = !(mode === "done" && S.sorted);
  $("btnNew").hidden = mode !== "done";
  $("k-checked-s").textContent = items.length && mode !== "setup" ? size(items.reduce((s, r) => s + r.bytes, 0)) + " in total" : "photos & videos";
  document.body.dataset.mode = mode;
}

/* ---------- folder cards ---------- */
function card(c) {
  const wide = c.key === "_dupes";
  const e = el("button", { class: "card" + (wide ? " wide review" : ""), onclick: () => mode === "setup" ? null : openFolder(c) },
    el("div", { class: "ch" }, el("span", {}, c.emoji || "📁"), el("span", { class: "name" }, c.label), el("span", { class: "mx-count" }, "0")),
    el("div", { class: "grid" }, Array.from({ length: wide ? 24 : 12 }, () => el("div", { class: "slot" }))));
  Object.assign(c, { el: e, badge: e.querySelector(".mx-count"), slots: [...e.querySelectorAll(".slot")], queued: 0, landed: [] });
  return e;
}
function buildCards() {
  $("photos").replaceChildren(...cats.filter(c => c.kind === "photo").map(card));
  $("videos").replaceChildren(...cats.filter(c => c.kind === "video").map(card), card(catBy._dupes));
  Object.assign(stats, { photos: 0, videos: 0, dupes: 0, saved: 0 });
  released = landed = 0;
  flown.clear();
}
const targetOf = it => it.dupe ? catBy._dupes : (catBy[it.cat] || catBy._dupes);

/* ---------- sphere ---------- */
let rot = 0;
function buildSphere(srcs) {  // srcs: [{img element factory}] , at most 320 tiles
  $("sphere").replaceChildren();
  tiles = [];
  const T = Math.min(srcs.length, 320), golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < T; i++) {
    const y = 1 - (i / Math.max(1, T - 1)) * 2, r = Math.sqrt(1 - y * y), th = golden * i;
    const img = srcs[i]();
    $("sphere").append(img);
    tiles.push({ el: img, x: Math.cos(th) * r, y, z: Math.sin(th) * r, left: 0, sx: 0, sy: 0, s: 1, alive: true });
  }
}
function sphereFromItems() {
  order = shuffle(items.map((_, i) => i));
  buildSphere(order.map(i => () => miniImg(items[i])));
  order.forEach((idx, k) => { if (tiles.length) { tiles[k % tiles.length].left++; items[idx].tile = tiles[k % tiles.length]; } });
}
function geom() {
  const r = $("stage").getBoundingClientRect();
  const lift = mode === "running" ? 0.42 : 0.5;
  return { cx: r.left + r.width / 2, cy: r.top + r.height * lift, R: Math.min(r.width, r.height) * (mode === "running" ? 0.32 : 0.36) };
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
    t.el.style.transform = `translate3d(${(t.sx - 14).toFixed(1)}px,${(t.sy - 14).toFixed(1)}px,0) scale(${t.s.toFixed(3)})`;
    t.el.style.opacity = (0.2 + depth * 0.8).toFixed(2);
    t.el.style.zIndex = Math.round(depth * 100);
  }
}

/* ---------- flying into folders ---------- */
function release(it) {
  if (flown.has(it.id)) return;
  flown.add(it.id);
  released++;
  const c = targetOf(it);
  const to = c.slots[c.queued++ % c.slots.length].getBoundingClientRect();
  const t = it.tile || { sx: geom().cx, sy: geom().cy, s: 1, left: 1, el: null };
  const s = 28 * (t.s || 1), img = miniImg(it);
  img.style.width = img.style.height = s + "px";
  $("fly").append(img);
  if (t.el && --t.left <= 0) { t.alive = false; t.el.style.opacity = 0; }
  const mx = (t.sx + to.left) / 2 + (Math.random() - .5) * 120, my = (t.sy + to.top) / 2 - 60 - Math.random() * 80;
  const a = img.animate([
    { transform: `translate3d(${t.sx - s / 2}px,${t.sy - s / 2}px,0) scale(1)` },
    { transform: `translate3d(${mx - s / 2}px,${my - s / 2}px,0) scale(1.2) rotate(${(Math.random() - .5) * 50}deg)`, offset: .45 },
    { transform: `translate3d(${to.left}px,${to.top}px,0) scale(${to.width / s})` },
  ], { duration: 650 + Math.random() * 400, easing: "cubic-bezier(.55,0,.25,1)" });
  a.onfinish = () => { img.remove(); land(it, c, true); };
}
function land(it, c, live) {
  c.landed.push(it);
  if (live) {
    const recent = c.landed.slice(-c.slots.length).reverse();
    c.slots.forEach((s, i) => { const w = recent[i]; if (w && s.dataset.id !== String(w.id)) { s.dataset.id = w.id; s.replaceChildren(miniImg(w)); } });
    c.badge.classList.remove("pop"); void c.badge.offsetWidth; c.badge.classList.add("pop");
    c.el.classList.add("hit"); clearTimeout(c.hitT); c.hitT = setTimeout(() => c.el.classList.remove("hit"), 260);
  }
  c.badge.textContent = fmt(c.landed.length); c.badge.classList.add("on");
  if (it.dupe) { stats.dupes++; stats.saved += it.bytes; } else if (it.kind === "video") stats.videos++; else stats.photos++;
  landed++;
  if (live && run === "replay" && landed === items.length) celebrate();
  if (live && run === "live" && finishing && landed >= items.length) celebrate();
}
function fillStatic() {  // results without animation
  buildCards();
  tiles.forEach(t => { t.alive = false; t.el.style.opacity = 0; });
  items.forEach(it => { flown.add(it.id); released++; land(it, targetOf(it), false); });
  cats.concat(catBy._dupes).forEach(c => {
    const recent = c.landed.slice(-c.slots.length).reverse();
    c.slots.forEach((s, i) => s.replaceChildren(...(recent[i] ? [miniImg(recent[i])] : [])));
  });
}
function showDone(celebrateNow) {
  document.body.classList.add("is-done");
  $("bigF").textContent = `${cats.length} folders`;
  $("chipD").textContent = `🗂️ ${fmt(stats.dupes)} duplicates`;
  $("chipS").textContent = `💾 ${size(stats.saved)} freed`;
  if (celebrateNow) { countUp($("bigN"), items.length, 900); confetti(); } else $("bigN").textContent = fmt(items.length);
  setPill("live", "Sorted");
}
function celebrate() { run = "idle"; finishing = false; mode = "done"; setHeader(); renderPanel(); showDone(true); }

/* ---------- replay (after sorting, for recording) ---------- */
function replay() {
  document.body.classList.remove("is-done");
  buildCards(); sphereFromItems();
  run = "replay"; t0 = performance.now(); released = 0;
  setPill("busy", "Claude is looking at every photo & video");
}

/* ---------- KPIs and the frame loop ---------- */
const ease = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
function updateStats() {
  const scanning = mode === "running" && S.job && S.job.phase === "scan";
  $("k-checked").textContent = fmt(scanning ? S.job.done : Math.max(released, mode === "running" ? S.files || 0 : 0));
  $("k-photos").textContent = fmt(stats.photos);
  $("k-videos").textContent = fmt(stats.videos);
  $("k-folders").textContent = cats.filter(c => c.landed && c.landed.length).length;
  $("k-dupes").textContent = fmt(stats.dupes);
  $("k-saved").textContent = size(stats.saved);
  $("pcount").textContent = fmt(stats.photos);
  $("vcount").textContent = fmt(stats.videos);
  $("bar").style.width = (mode === "running" ? overallProgress() * 100 : items.length ? landed / items.length * 100 : 0) + "%";
}
let last = performance.now();
function tick(now) {
  const dt = now - last; last = now;
  drawSphere(dt);
  if (run === "replay") {
    const want = Math.min(items.length, Math.floor(items.length * ease(Math.min(1, (now - t0) / REPLAY_MS))));
    while (released < want) release(items[order[released]]);
  }
  if (run === "live" && queue.length) {  // labels arrive in batches: spread them out so it flows
    const n = Math.max(1, Math.ceil(queue.length / 45));
    for (let i = 0; i < n && queue.length; i++) release(queue.shift());
  }
  updateStats();
  if (mode === "running") paintTimer();
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

/* ---------- time estimate ----------
   Measured on a 2020 MacBook with 1,136 files (10.7 GB): scan 125 s, duplicates 6 s,
   Claude labels about 12 s per 90 files with 4 at a time, building folders 20 s. */
function phaseEstimates(files, bytes, scan = true) {
  const batches = Math.ceil(Math.ceil(files / 30) / 3);
  return {
    scan: scan ? 4 + files * 0.025 + bytes / 1e9 * 9 : 0,
    dupes: 2 + Math.pow(files / 1000, 2) * 4,
    label: 12 + files * 0.012 + Math.ceil(batches / 4) * 14,
    apply: 2 + files * 0.018,
  };
}
const NAMES = { scan: "Looking at every file", dupes: "Finding duplicates", label: "Claude is sorting your photos", apply: "Building your folders" };
function overallProgress() {
  const j = S.job || {}; if (!j.phases || !j.phases.length) return 0;
  const est = runEstimates(), total = j.phases.reduce((s, p) => s + est[p], 0) || 1;
  let done = 0;
  for (const p of j.phases) {
    if (p === j.phase) { done += est[p] * (j.total ? j.done / j.total : 0); break; }
    done += est[p];
  }
  return j.phase === "done" ? 1 : Math.min(1, done / total);
}
let runInfo = { files: 0, bytes: 0 };
function runEstimates() { return phaseEstimates(runInfo.files, runInfo.bytes, (S.job.phases || []).includes("scan")); }
function remaining() {
  const j = S.job, est = runEstimates();
  let left = 0, seen = false;
  for (const p of j.phases) {
    if (p === j.phase) {
      seen = true;
      const spent = (j.now - j.phase_started), frac = j.total ? j.done / j.total : 0;
      const guess = frac > 0.15 ? spent / frac - spent : est[p] - spent;
      left += Math.max(2, guess);
    } else if (seen) left += est[p];
  }
  return left;
}

/* ---------- the center panel: setup, running, done ---------- */
function renderPanel() {
  const panel = $("panel");
  panel.className = "panel is-" + mode;
  if (mode === "setup") return panel.replaceChildren(setupCard());
  if (mode === "running") return panel.replaceChildren(runCard());
  panel.replaceChildren();
}

function setupCard() {
  const box = el("div", { class: "setup mx-rise" });
  const mac = S.platform === "darwin";
  const pathBox = (key, placeholder) => {
    const input = el("input", { class: "field", placeholder, value: pick[key] || "" });
    const use = el("button", { class: "mx-btn small solid", onclick: () => choose(key, input.value.trim()) }, "Use");
    input.onkeydown = e => { if (e.key === "Enter") use.click(); };
    setTimeout(() => input.focus(), 30);
    return el("div", { class: "typed" }, input, use);
  };
  const typeLink = key => el("button", { class: "linkish", onclick: () => { pick.typing = key; renderPanel(); } }, "or type a path");

  // 1. photos
  if (!pick.source) {
    box.append(el("div", { class: "q" }, el("span", { class: "n" }, "1"), el("div", {},
      el("h2", {}, "Choose your photos"),
      el("p", {}, "A Google Photos or Apple Photos export, or any folder with photos and videos. Nothing in it gets moved or deleted."))));
    if (mac && pick.typing !== "source") box.append(el("div", { class: "acts" },
      el("button", { class: "mx-btn solid big-btn", onclick: () => pickFolder("source") }, icon("folder"), "Choose folder"), typeLink("source")));
    else box.append(pathBox("source", "/Users/you/Pictures/Camera roll"));
    if (S.source && S.source !== pick.source) box.append(el("button", { class: "linkish recent", onclick: () => choose("source", S.source) }, `Last time: ${tilde(S.source)}`));
    return box;
  }
  const pk = pick.peek;
  box.append(el("div", { class: "q done" }, el("span", { class: "n" }, icon("check")), el("div", {},
    el("h3", {}, "Photos"), el("div", { class: "picked", title: pick.source }, icon("folder"), el("span", {}, tilde(pick.source))),
    pk ? el("p", { class: "meta" }, `${fmt(pk.photos)} photos · ${fmt(pk.videos)} videos · ${size(pk.bytes)}`) : el("p", { class: "meta" }, "Counting…")),
    el("button", { class: "linkish", onclick: () => { pick.source = pick.peek = pick.dest = null; pick.typing = null; resetStageForSetup(); renderPanel(); } }, "Change")));

  // 2. where to save
  if (!pick.dest) {
    box.append(el("div", { class: "q" }, el("span", { class: "n" }, "2"), el("div", {},
      el("h2", {}, "Where should the sorted copies go?"),
      el("p", {}, "Your originals stay where they are. On a Mac the copies take no extra space."))));
    const sug = (pk && pk.suggested_dest) || pick.source + " (sorted)";
    if (mac && pick.typing !== "dest") box.append(el("div", { class: "acts col" },
      el("button", { class: "mx-btn solid big-btn", onclick: () => choose("dest", sug) }, icon("check"), "Next to my photos"),
      el("p", { class: "meta mono", title: sug }, tilde(sug)),
      el("div", { class: "row" }, el("button", { class: "mx-btn small", onclick: () => pickFolder("dest") }, icon("folder"), "Choose another folder"), typeLink("dest"))));
    else box.append(pathBox("dest", sug), el("button", { class: "linkish", onclick: () => choose("dest", sug) }, `Use ${tilde(sug)}`));
    return box;
  }
  box.append(el("div", { class: "q done" }, el("span", { class: "n" }, icon("check")), el("div", {},
    el("h3", {}, "Sorted copies go to"), el("div", { class: "picked", title: pick.dest }, icon("folder"), el("span", {}, tilde(pick.dest)))),
    el("button", { class: "linkish", onclick: () => { pick.dest = null; pick.typing = null; renderPanel(); } }, "Change")));

  // 3. start
  const files = pk ? (pick.sample ? Math.min(200, pk.photos + pk.videos) : pk.photos + pk.videos) : 0;
  const bytes = pk ? pk.bytes * (files / Math.max(1, pk.photos + pk.videos)) : 0;
  const est = phaseEstimates(files, bytes, true), total = Object.values(est).reduce((a, b) => a + b, 0);
  box.append(el("div", { class: "start" },
    el("button", { class: "mx-btn solid big-btn wide", onclick: startSorting }, icon("play"), "Start sorting"),
    el("p", { class: "meta" }, icon("clock"), pk ? ` Usually ${roughly(total)} for ${fmt(files)} files` : " Counting files…")));

  // advanced
  box.append(el("button", { class: "adv-toggle", "aria-expanded": pick.advanced, onclick: () => { pick.advanced = !pick.advanced; renderPanel(); } },
    "Advanced", icon("down")));
  if (pick.advanced) box.append(advancedBox(files));
  return box;
}

function advancedBox(files) {
  const chips = kind => cats.filter(c => c.kind === kind).map(c => el("span", { class: "fchip" }, `${c.emoji || "📁"} ${c.label}`,
    el("button", { "aria-label": `Remove ${c.label}`, onclick: () => saveCats(cats.filter(x => x !== c)) }, icon("x"))));
  const adder = kind => {
    const box = el("span", { class: "fchip add" });
    box.append(el("button", { "aria-label": `Add a ${kind} folder`, onclick: () => {
      const name = el("input", { placeholder: "Folder name", "aria-label": "Folder name" });
      const rule = el("input", { placeholder: "What goes in it", "aria-label": "What goes in it" });
      const add = () => {
        const label = name.value.trim(); if (!label) return name.focus();
        let key = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "folder", i = 2;
        while (catBy[key]) key = key.replace(/-\d+$/, "") + "-" + i++;
        const at = cats.map(c => c.kind).lastIndexOf(kind);  // keep the catch-all folder last
        const next = cats.slice(); next.splice(Math.max(0, at), 0, { key, kind, label, emoji: kind === "photo" ? "📁" : "🎬", rule: rule.value.trim() || label });
        saveCats(next);
      };
      [name, rule].forEach(i => i.onkeydown = e => { if (e.key === "Enter") add(); if (e.key === "Escape") renderPanel(); });
      box.replaceWith(el("span", { class: "newf" }, name, rule, el("button", { class: "mx-btn small solid", onclick: add }, "Add")));
      name.focus();
    } }, icon("plus")));
    return box;
  };
  const lab = (k, title, text, extra) => el("label", { class: "opt" + (pick.labeler === k ? " on" : "") },
    el("input", { type: "radio", name: "labeler", checked: pick.labeler === k, onchange: () => { pick.labeler = k; renderPanel(); } }),
    el("span", {}, el("b", {}, title, extra || ""), el("small", {}, text)));
  return el("div", { class: "adv" },
    el("h4", {}, "Photo folders"), el("div", { class: "fchips" }, chips("photo"), adder("photo")),
    el("h4", {}, "Video folders"), el("div", { class: "fchips" }, chips("video"), adder("video")),
    el("p", { class: "meta" }, "The last folder of each kind catches everything that fits nowhere else."),
    el("h4", {}, "Who looks at the photos"),
    lab("claude", "Claude", "Uses your Claude plan. No key needed."),
    lab("jev", "Jev by TypeSafe ", S.jev_key ? `Fast image model, billed per file: about ${fmt(files * TOKENS_PER_FILE)} tokens.` : "Needs JEV_KEY=your-key in a .env file in this folder.",
      el("span", { class: "paid" }, "PAID")),
    el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: pick.sample, onchange: e => { pick.sample = e.target.checked; renderPanel(); } }), "Try 200 random files first"));
}

async function saveCats(next) {
  try { S = await api("/api/categories", { categories: next.map(({ key, kind, label, emoji, rule }) => ({ key, kind, label, emoji, rule })) }); }
  catch (e) { return; }
  setCats(S.categories); buildCards(); renderPanel();
}

async function pickFolder(key) {
  const prompt = key === "source" ? "Choose the folder with your photos" : "Choose where to save the sorted folders";
  try {
    const r = await api("/api/pick", { prompt });
    if (r.path) await choose(key, r.path);
  } catch (e) {}
}
async function choose(key, path) {
  if (!path) return toast("Pick a folder first.");
  pick[key] = path; pick.typing = null;
  if (key === "source") {
    pick.peek = null; pick.dest = null; renderPanel(); setHeader();
    try { pick.peek = await api("/api/peek", { source: path }); pick.source = pick.peek.source; }
    catch (e) { pick.source = null; renderPanel(); return; }
    if (!pick.peek.photos && !pick.peek.videos) { toast("No photos or videos in that folder."); pick.source = null; }
    else buildSphere(pick.peek.previews.map(u => () => el("img", { src: u, alt: "" })));
  }
  renderPanel(); setHeader();
}

function resetStageForSetup() {
  $("sphere").replaceChildren(); tiles = [];
  $("fly").replaceChildren();
  document.body.classList.remove("is-done");
  run = "idle";
  buildCards();
}

/* Top-bar button: asks for whatever is missing, then starts. After sorting it replays. */
function sortWithClaude() {
  if (mode === "running") return;
  if (mode === "done") return replay();
  if (!pick.source) return S.platform === "darwin" ? pickFolder("source") : (pick.typing = "source", renderPanel());
  if (!pick.dest) return S.platform === "darwin" ? pickFolder("dest") : (pick.typing = "dest", renderPanel());
  startSorting();
}

async function startSorting() {
  if (!pick.source || !pick.dest) return sortWithClaude();
  const files = pick.peek ? pick.peek.photos + pick.peek.videos : 0;
  if (pick.labeler === "jev") {
    if (!S.jev_key) return toast("Add JEV_KEY=your-key to a .env file in this folder to use Jev.");
    if (!await confirmPaid(Math.min(files, pick.sample ? 200 : files))) return;
  }
  if (pick.labeler === "claude" && S.claude_cli === false) return toast("Claude Code isn't installed on this computer. Install it, or pick Jev under Advanced.");
  try {
    S = await api("/api/sort", { source: pick.source, dest: pick.dest, labeler: pick.labeler, limit: pick.sample ? 200 : 0 });
  } catch (e) { return; }
  runInfo = { files: pick.sample ? Math.min(200, files) : files, bytes: pick.peek ? pick.peek.bytes * (pick.sample ? Math.min(1, 200 / Math.max(1, files)) : 1) : 0 };
  beginRunning();
}

/* ---------- running: poll the server and animate as labels arrive ---------- */
let monitor, lastLabelsAt = 0, libraryLoaded = false, dupesMarked = false, finishing = false;
function beginRunning() {
  mode = "running"; run = "live"; libraryLoaded = false; dupesMarked = false; finishing = false;
  queue.length = 0;
  document.body.classList.remove("is-done");
  $("fly").replaceChildren();
  setHeader(); renderPanel(); buildCards();
  clearInterval(monitor);
  monitor = setInterval(pollRun, 900);
  pollRun();
}
async function pollRun() {
  let s;
  try { s = await fetch("/api/state", { cache: "no-store" }).then(r => r.json()); } catch (e) { return; }
  S = s;
  const j = S.job;
  if (!runInfo.files) runInfo = { files: S.files || 0, bytes: S.bytes || 0 };
  setPill("busy", NAMES[j.phase] || "Working");
  // after the scan, swap the preview sphere for the real library
  if (!libraryLoaded && j.phase && j.phase !== "scan") {
    libraryLoaded = true;
    await loadLibrary(false);
    runInfo = { files: items.length, bytes: items.reduce((s, r) => s + r.bytes, 0) };
    buildCards(); sphereFromItems(); setHeader();
  }
  if (libraryLoaded && !dupesMarked && ["label", "apply", "done"].includes(j.phase)) {
    dupesMarked = true;
    const d = await getJSON("dupes.json");
    dupeIds = new Set((d || []).flatMap(g => g.dupes));
    items.forEach(it => it.dupe = dupeIds.has(it.id));
  }
  if (libraryLoaded && ["label", "apply", "done"].includes(j.phase) && performance.now() - lastLabelsAt > 1200) {
    lastLabelsAt = performance.now();
    const live = await fetch("/api/labels", { cache: "no-store" }).then(r => r.json()).catch(() => ({}));
    for (const [id, key] of Object.entries(live)) {
      const it = byId[id];
      if (it && !flown.has(it.id) && !queue.includes(it)) { it.cat = key; queue.push(it); }
    }
  }
  renderPanel();
  if (!j.running) {
    clearInterval(monitor);
    if (j.code !== 0) { setPill(null, "Stopped"); toast("Sorting stopped. See the details in the panel."); return; }
    // final labels (with any hand moves), then let the rest fly in
    const final = await getJSON("labels.json") || {};
    items.forEach(it => { if (final[it.id]) it.cat = final[it.id]; if (!flown.has(it.id) && !queue.includes(it)) queue.push(it); });
    finishing = true;
    if (landed >= items.length) celebrate();
  }
}
function runCard() {
  const j = S.job || {};
  const failed = !j.running && j.code && j.code !== 0;
  const steps = (j.phases || []).map(p => {
    const idx = j.phases.indexOf(p), cur = j.phases.indexOf(j.phase);
    const state = j.phase === "done" || idx < cur ? "ok" : p === j.phase ? (failed ? "bad" : "now") : "";
    return el("li", { class: state }, state === "ok" ? icon("check") : el("i", {}), { scan: "Scan", dupes: "Duplicates", label: "Label", apply: "Folders" }[p]);
  });
  const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
  return el("div", { class: "run" },
    el("div", { class: "run-h" }, el("b", {}, failed ? "Something went wrong" : NAMES[j.phase] || "Getting ready"),
      el("span", { class: "num", id: "timer" }, "")),
    el("div", { class: "pbar" }, el("i", { style: `width:${failed ? 100 : pct}%` })),
    el("ol", { class: "phases" }, steps),
    failed ? el("pre", { class: "log" }, (j.log || []).slice(-8).join("\n")) : null,
    failed ? el("button", { class: "mx-btn small solid", onclick: startSorting }, "Try again") : null);
}
function paintTimer() {
  const t = $("timer"); if (!t || !S.job || !S.job.started) return;
  const now = Date.now() / 1000;
  const elapsed = S.job.running ? now - S.job.started : S.job.now - S.job.started;
  const left = S.job.running ? remaining() - (now - S.job.now) : 0;
  t.textContent = `${mmss(Math.max(0, elapsed))} · ${S.job.running ? (left > 5 ? roughly(left) + " left" : "almost done") : "done"}`;
}

/* ---------- dialogs: edit folders, browse a folder, view a photo, paid confirm ---------- */
function closeAll() { $("overlay").replaceChildren(); document.removeEventListener("keydown", lbKeys); }
function overlay(...nodes) { closeAll(); $("overlay").append(...nodes); paintIcons($("overlay")); }
addEventListener("keydown", e => { if (e.key === "Escape" && !document.querySelector(".lightbox")) closeAll(); });

function confirmPaid(n) {
  return new Promise(res => {
    const done = v => { closeAll(); res(v); };
    overlay(el("div", { class: "fb-scrim", onclick: e => e.target === e.currentTarget && done(false) },
      el("div", { class: "fb-dialog pc", role: "dialog" },
        el("div", { class: "fb-head" }, el("h2", {}, "Label with Jev"), el("button", { class: "mx-icon", onclick: () => done(false), "aria-label": "Close" }, icon("x"))),
        el("div", { class: "pc-list" }, el("div", { class: "pc-choice" },
          el("div", {}, el("b", {}, `${fmt(n)} files, about ${fmt(n * TOKENS_PER_FILE)} tokens`),
            el("p", {}, "Sends a small 280px preview of each file to TypeSafe's Jev model, never the original. Check the per-token price on console.typesafe.ai.")),
          el("button", { class: "mx-btn solid", onclick: () => done(true) }, "Spend tokens"))),
        el("p", { class: "pc-note" }, "Already-labelled files are skipped, so you can stop and resume."))));
  });
}

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
    list.replaceChildren(el("h4", {}, "Photo folders"), ...draft.filter(c => c.kind === "photo").map(row),
      el("h4", {}, "Video folders"), ...draft.filter(c => c.kind === "video").map(row));
    paintIcons(list);
  }
  const add = kind => () => { draft.push({ key: "", kind, label: "", emoji: kind === "photo" ? "📁" : "🎬", rule: "" }); render(); };
  async function saveIt() {
    for (const c of draft) {
      if (!c.label.trim()) return toast("Every folder needs a name.");
      c.label = c.label.trim(); c.rule = (c.rule || "").trim() || c.label;
      if (!c.key) { let k = slug(c.label), i = 2; while (draft.some(d => d !== c && d.key === k)) k = slug(c.label) + "-" + i++; c.key = k; }
    }
    await saveCats(draft);
    closeAll();
    if (mode === "done") toast("Saved. Press New sort and sort again so files can use the new folders.");
  }
  render();
  overlay(el("div", { class: "fb-scrim", onclick: e => e.target === e.currentTarget && closeAll() },
    el("div", { class: "fb-dialog", role: "dialog", "aria-label": "Edit folders" },
      el("div", { class: "fb-head" }, el("h2", {}, "Folders"), el("button", { class: "mx-icon", onclick: closeAll, "aria-label": "Close" }, icon("x"))),
      el("div", { class: "fb-rows" }, list,
        el("p", { class: "note" }, "The rule is what Claude reads, so describe each folder the way you'd explain it to a friend.")),
      el("div", { class: "fb-foot" },
        el("button", { class: "mx-btn", onclick: add("photo") }, icon("plus"), "Photo folder"),
        el("button", { class: "mx-btn", onclick: add("video") }, icon("plus"), "Video folder"),
        el("span", { class: "spacer" }),
        el("button", { class: "mx-btn ghost", onclick: closeAll }, "Cancel"),
        el("button", { class: "mx-btn solid", onclick: saveIt }, "Save folders")))));
}

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
          S.sorted && !DEMO ? el("button", { class: "mx-btn small", onclick: () => api("/api/open", { folder: c.key === "_dupes" ? "_Review/duplicates" : c.label.replace(/&/g, "and").replace(/\//g, "-") }) }, icon("folder"), "Open in Finder") : null,
          el("button", { class: "mx-icon", onclick: closeAll, "aria-label": "Close" }, icon("x")))),
      all.length ? grid : el("p", { class: "mx-empty", style: "padding:22px" }, "Nothing in this folder yet."))));
}

let lbKeys = () => {};
function lightbox(list, i) {
  const it = list[i];
  const full = DEMO ? it.src : `/api/file/${it.id}`;
  const media = it.kind === "video" && !DEMO ? el("video", { src: full, controls: true, autoplay: true, playsinline: true, poster: it.src }) : el("img", { src: full, alt: it.name });
  const move = el("select", { class: "mx-select", "aria-label": "Move to folder", onchange: async e => {
    const key = e.target.value;
    try { await api("/api/move", { id: it.id, key }); } catch (err) { return; }
    it.cat = key; it.dupe = false; dupeIds.delete(it.id);
    toast(`Moved to ${catBy[key].label}. It moves on disk the next time you sort.`);
    fillStatic(); showDone(false);
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

/* ---------- start ---------- */
function newSort() {
  mode = "setup";
  pick.source = pick.dest = pick.peek = null; pick.typing = null;
  resetStageForSetup(); setHeader(); renderPanel();
  setPill(null, "Choose your photos");
}
async function init() {
  paintIcons();
  if (DEMO) {
    const c = await getJSON("categories.json"); setCats(c);
    await loadLibrary(true);
    S = { source: "~/Pictures/Camera roll (demo)", platform: "demo" };
  } else {
    try { S = await api("/api/state"); } catch (e) { S = {}; }
    setCats(S.categories);
  }
  buildCards();
  if (!DEMO && S.job && S.job.running && S.job.step === "sort") {
    pick.source = S.source;
    runInfo = { files: S.files, bytes: S.bytes };
    beginRunning();
  } else if (DEMO || (S.steps && S.steps.apply)) {
    if (!DEMO) await loadLibrary(true);
    mode = "done"; sphereFromItems(); fillStatic(); showDone(false);
    pick.source = S.source;
  } else {
    mode = "setup"; setPill(null, "Choose your photos");
  }
  setHeader(); renderPanel();
  requestAnimationFrame(tick);
  if (params.has("auto") && mode === "done") setTimeout(replay, 1200);
}
$("go").onclick = sortWithClaude;
$("btnNew").onclick = newSort;
$("btnFolders").onclick = openFolders;
$("btnOpen").onclick = () => api("/api/open", {}).catch(() => {});
addEventListener("keydown", e => {
  if (e.target.matches("input, textarea, select") || $("overlay").children.length) return;
  if (e.code === "Space" && mode === "done") { e.preventDefault(); replay(); }
});
init();
