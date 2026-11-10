// SLS Video Studio — single-page app (no build step).
import { api, costListeners, callListeners } from "./api.js";
import { putFile, getFile, delFile } from "./idb.js";
// The pipeline (and its large libraries) loads only when a video needs it,
// so sign-in and admin pages work even if a library fails to load.
const pipeline = () => import("./pipeline/run.js");
import { loadMathJax } from "./pipeline/render.js";

const $app = document.getElementById("app");
const $nav = document.getElementById("nav");
let me = null;
let asrModel = "Xenova/whisper-small.en";
let showCost = true; // admin setting: show $ on video pages
let asrProvider = "browser"; // admin setting: "browser" Whisper or "assemblyai"
const running = new Map(); // jobId -> {stage, step, progress, label, warnings[], error}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, d = 2) => (n == null ? "—" : "$" + Number(n).toFixed(n > 0 && n < 0.01 ? 4 : d));
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const STATUS_TEXT = { new: "Uploaded", analysing: "Transcribing", "review-transcript": "Check transcript", planning: "Planning slides",
  "review-slides": "Review slides", rendering: "Rendering", done: "Done", failed: "Needs attention" };
const statusTag = (s) => `<span class="status ${esc(s)}">${esc(STATUS_TEXT[s] || s)}</span>`;
const loader = `<span class="loader" aria-hidden="true"><span></span><span></span><span></span></span>`;
const loading = (text = "Loading") => `<div class="loading" role="status">${loader}<span>${esc(text)}…</span></div>`;
function form(el) { return Object.fromEntries(new FormData(el).entries()); }
function showErr(where, e) { where.innerHTML = `<div class="err">${esc(e.message || e)}</div>`; }

// ---------------- self-check ----------------
// If the deploy left out public/vendor/, Netlify answers with an HTML page instead of the file.
async function checkVendor() {
  const files = ["/vendor/mp4-muxer.mjs", "/vendor/fonts/ubuntu-latin-400-normal.woff2", "/vendor/mathjax/tex-svg-full.js",
    "/vendor/ffmpeg/index.js", "/vendor/ffmpeg/core/ffmpeg-core.wasm", "/vendor/transformers/transformers.min.js", "/vendor/mp4box.all.min.js"];
  const missing = [];
  await Promise.all(files.map(async (f) => {
    try {
      const r = await fetch(f, { method: "HEAD", cache: "no-store" });
      if (!r.ok || (r.headers.get("content-type") || "").includes("text/html")) missing.push(f);
    } catch { missing.push(f); }
  }));
  if (!missing.length) return;
  const box = document.createElement("div");
  box.className = "err";
  box.style.margin = "0";
  box.innerHTML = `<b>This deploy is missing bundled files</b>, so videos can't be made yet. Missing: ${missing.map(esc).join(", ")}.
    Redeploy the whole project including the <code>public/vendor/</code> folder (see the README).`;
  document.body.insertBefore(box, document.querySelector("main"));
}

// ---------------- routing ----------------
async function boot() {
  checkVendor();
  const s = await api("GET", "/api/auth/status");
  me = s.user;
  if (s.needsSetup) return setupView();
  if (!me) return loginView();
  if (me.mustChangePassword) return passwordView(true);
  window.addEventListener("hashchange", route);
  route();
}
function navHtml() {
  const h = location.hash || "#/videos";
  const a = (href, label) => `<a href="${href}" class="${h.startsWith(href) ? "on" : ""}">${label}</a>`;
  return a("#/videos", "My videos") + a("#/new", "New video") +
    (me.role === "admin" ? `<span class="sep"></span>${a("#/admin/usage", "Usage")}${a("#/admin/users", "Users")}${a("#/admin/keys", "API keys")}${a("#/admin/settings", "Settings")}` : "") +
    `<span class="sep"></span>${a("#/account", esc(me.name || me.email))}<button id="signout">Sign out</button>`;
}
function route() {
  $nav.innerHTML = navHtml();
  document.getElementById("signout").onclick = async () => { await api("POST", "/api/auth/logout", {}); location.hash = ""; location.reload(); };
  const h = (location.hash || "#/videos").slice(1);
  const [, a, b] = h.split("/");
  if (a === "videos" || !a) return videosView();
  if (a === "new") return newView();
  if (a === "job") return jobView(b);
  if (a === "account") return passwordView(false);
  if (a === "admin" && me.role === "admin") {
    if (b === "usage") return usageView();
    if (b === "users") return usersView();
    if (b === "keys") return keysView();
    if (b === "settings") return settingsView();
  }
  $app.innerHTML = `<h1>Not found</h1>`;
}

// ---------------- auth views ----------------
function setupView() {
  $nav.innerHTML = "";
  $app.innerHTML = `<div class="card narrow"><div class="eyebrow">First-time setup</div><h1>Create the admin account</h1>
  <p class="muted">Enter the setup code from the site's SETUP_CODE environment variable. This only works once.</p>
  <form id="f"><label>Setup code<input name="setupCode" required></label><label>Your name<input name="name" required></label>
  <label>Email<input name="email" type="email" required autocomplete="username"></label>
  <label>Password <span class="muted">(at least 10 characters)</span><input name="password" type="password" minlength="10" required autocomplete="new-password"></label>
  <div id="m"></div><div class="actions"><button>Create admin</button></div></form></div>`;
  document.getElementById("f").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api("POST", "/api/auth/setup", form(ev.target)); location.reload(); } catch (e) { showErr(document.getElementById("m"), e); }
  };
}
function loginView() {
  $nav.innerHTML = "";
  $app.innerHTML = `<div class="card narrow"><div class="eyebrow">Student Learning Support</div><h1>Sign in</h1>
  <form id="f"><label>Email<input name="email" type="email" required autocomplete="username"></label>
  <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
  <div id="m"></div><div class="actions"><button>Sign in</button></div></form>
  <p class="muted small">No account? Ask your SLS admin to add you.</p></div>`;
  document.getElementById("f").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api("POST", "/api/auth/login", form(ev.target)); location.reload(); } catch (e) { showErr(document.getElementById("m"), e); }
  };
}
function passwordView(forced) {
  if (forced) $nav.innerHTML = "";
  $app.innerHTML = `<div class="card narrow"><h1>${forced ? "Choose your password" : "Your account"}</h1>
  ${forced ? `<p>Your admin set a temporary password. Choose your own to continue.</p>` : `<p class="muted">${esc(me.email)} · ${esc(me.role)}</p>`}
  <form id="f"><label>Current password<input name="current" type="password" required autocomplete="current-password"></label>
  <label>New password <span class="muted">(at least 10 characters)</span><input name="next" type="password" minlength="10" required autocomplete="new-password"></label>
  <div id="m"></div><div class="actions"><button>Change password</button></div></form></div>`;
  document.getElementById("f").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api("POST", "/api/auth/password", form(ev.target)); location.hash = "#/videos"; location.reload(); }
    catch (e) { showErr(document.getElementById("m"), e); }
  };
}

// ---------------- videos ----------------
async function videosView() {
  $app.innerHTML = `<div class="eyebrow">Student Learning Support</div><h1>My videos</h1><div id="list">${loading("Loading your videos")}</div>`;
  const { jobs, asrModel: m, showCost: sc, asrProvider: ap } = await api("GET", "/api/jobs");
  asrModel = m || asrModel;
  asrProvider = ap || asrProvider;
  showCost = sc !== false;
  const el = document.getElementById("list");
  if (!jobs.length) {
    el.innerHTML = `<div class="card"><p>No videos yet.</p><a class="btn" href="#/new">Make your first video</a></div>`;
    return;
  }
  el.innerHTML = `<table><thead><tr><th>Title</th><th>Status</th><th>Created</th>${showCost ? '<th class="num">Cost</th>' : ""}</tr></thead><tbody>
  ${jobs.map((j) => `<tr><td><a href="#/job/${esc(j.id)}">${esc(j.title)}</a>${running.has(j.id) ? ' <span class="pill">working…</span>' : ""}</td>
    <td>${statusTag(j.status)}</td><td>${when(j.createdAt)}</td>${showCost ? `<td class="num">${money(j.costUsd)}</td>` : ""}</tr>`).join("")}</tbody></table>`;
}

function newView() {
  $app.innerHTML = `<div class="eyebrow">New explainer video</div><h1>Start from your narration</h1>
  <p class="muted" id="privacy">Record yourself explaining the topic (one take, a quiet room, a phone voice memo is fine).</p>
  <form id="f" class="card">
    <div class="grid g2">
      <label>Video title<input name="title" required maxlength="120" placeholder="Counting with Recurrences"></label>
      <label>Topic eyebrow <span class="muted">(shows as "THE …" on slides)</span><input name="eyebrow" maxlength="60" placeholder="Recurrence"></label>
    </div>
    <label>Subtitle <span class="muted">(optional, for the title card)</span><input name="subtitle" maxlength="160" placeholder="Building domino walls one piece at a time"></label>
    <label>Stream</label>
    <select name="stream"><option value="math">Mathematics (Math Study Hall)</option><option value="cp">Coding and Programming (C&amp;P Study Hall)</option></select>
    <label>Narration audio <span class="muted">(M4A, MP3 or WAV)</span><input name="audio" type="file" accept="audio/*,.m4a,.mp3,.wav" required></label>
    <label>Your script <span class="muted">(optional; gives exact LaTeX for your math)</span><textarea name="script" rows="5" placeholder="Paste your script, with math as $…$"></textarea></label>
    <label>Tipsheet <span class="muted">(optional; a .tex, .md or .txt file)</span><input name="tipsheet" type="file" accept=".tex,.md,.txt,text/*"></label>
    <label>Notes for the slide planner <span class="muted">(optional)</span><textarea name="notes" rows="3" placeholder="e.g. Use the domino picture in the mental-model scene"></textarea></label>
    <div id="m"></div>
    <div class="actions"><button>Upload and start</button><span class="muted small">Next: we transcribe it, then you check the transcript.</span></div>
  </form>`;
  api("GET", "/api/jobs").then(({ asrProvider: ap }) => {
    asrProvider = ap || asrProvider;
    document.getElementById("privacy").textContent += asrProvider === "assemblyai"
      ? " Your audio is sent to AssemblyAI for transcription and deleted there afterwards; only text goes to Claude."
      : " Your audio stays on this computer; only the transcript text goes to Claude.";
  }).catch(() => {});
  document.getElementById("f").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const audio = fd.get("audio");
    const tip = fd.get("tipsheet");
    const m = document.getElementById("m");
    try {
      if (!audio || !audio.size) throw new Error("Choose your narration audio file.");
      if (audio.size > 300 * 1024 * 1024) throw new Error("That audio file is very large (over 300 MB).");
      const tipsheet = tip && tip.size ? (await tip.text()).slice(0, 60000) : "";
      ev.target.querySelector("button").disabled = true;
      const { job } = await api("POST", "/api/jobs", {
        title: fd.get("title"), eyebrow: fd.get("eyebrow"), subtitle: fd.get("subtitle"), stream: fd.get("stream"),
        script: fd.get("script"), notes: fd.get("notes"), tipsheet, audioName: audio.name,
      });
      await putFile(`audio:${job.id}`, audio);
      location.hash = `#/job/${job.id}`;
      startStage(job, "analyse");
    } catch (e) { ev.target.querySelector("button").disabled = false; showErr(m, e); }
  };
}

// ---------------- stage runner ----------------
function startStage(job, stage, extra) {
  if (running.has(job.id)) return;
  const r = { stage, step: "Starting", progress: null, label: "", warnings: [], error: null, startedAt: Date.now(),
    cost: job.costUsd || 0, stageCost: 0, calls: job.calls || 0 };
  running.set(job.id, r);
  const ui = {
    step: (s) => { r.step = s; r.progress = null; paint(job.id); },
    progress: (p, label) => { r.progress = p; r.label = label; paintProgress(job.id); },
    warn: (w) => { r.warnings.push(w); paint(job.id); },
  };
  const go = async () => {
    const run = await pipeline();
    return { analyse: () => run.analyse(job, ui, asrModel, asrProvider), plan: () => run.plan(job, ui),
      revise: () => run.revise(job, extra, ui), render: () => run.render(job, ui, asrModel) }[stage]();
  };
  go().then(() => { running.delete(job.id); if (r.warnings.length) job._warnings = r.warnings; refreshIfOpen(job.id); })
    .catch(async (e) => {
      console.error(e);
      running.delete(job.id);
      job._error = e.message || String(e);
      job._warnings = r.warnings;
      const back = { analyse: "new", plan: "review-transcript", revise: "review-slides", render: "review-slides" }[stage];
      try { await api("PATCH", `/api/jobs/${job.id}`, { status: back }); job.status = back; } catch {}
      refreshIfOpen(job.id);
    });
  paint(job.id);
}
const openJobId = () => ((location.hash.match(/^#\/job\/([^/]+)/) || [])[1]);
function refreshIfOpen(id) { if (openJobId() === id) jobView(id, true); }
function paint(id) {
  const box = document.getElementById("runbox");
  if (!box || openJobId() !== id) return;
  const r = running.get(id);
  if (!r) return;
  const pct = r.progress == null ? null : Math.round(r.progress * 100);
  box.innerHTML = `<div class="card"><div class="eyebrow">Working — keep this tab open</div>
    <div class="runhead">${loader}<h3 id="rstep">${esc(r.step)}</h3><span class="elapsed" id="relapsed"></span></div>
    <div class="progress ${pct == null ? "indeterminate" : ""}" id="rprog" role="progressbar" aria-label="${esc(r.step)}"
      ${pct == null ? "" : `aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"`}><div style="${pct == null ? "" : `width:${pct}%`}"></div></div>
    <div class="small muted" id="rlabel">${pct == null ? "" : `${esc(r.label)} ${pct}%`}</div>
    ${showCost ? `<div class="livecost" id="rcost">${costLine(r)}</div>` : ""}
    ${r.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}</div>`;
  tickElapsed();
}
// Elapsed time for the running stage, updated every second.
let elapsedTimer = null;
function tickElapsed() {
  clearInterval(elapsedTimer);
  const upd = () => {
    const el = document.getElementById("relapsed");
    const r = running.get(openJobId());
    if (!el || !r) { clearInterval(elapsedTimer); return; }
    const s = Math.floor((Date.now() - r.startedAt) / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} elapsed`;
  };
  upd();
  elapsedTimer = setInterval(upd, 1000);
}
function paintProgress(id) {
  const r = running.get(id);
  const bar = document.getElementById("rprog");
  if (!bar || !r || openJobId() !== id) return paint(id);
  const pct = Math.round(r.progress * 100);
  bar.classList.remove("indeterminate");
  bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); bar.setAttribute("aria-valuenow", String(pct));
  bar.firstElementChild.style.width = `${r.progress * 100}%`;
  document.getElementById("rlabel").textContent = `${r.label} ${pct}%`;
}

// ---------- Live cost ticker ----------
// While a metered call runs, the shown total climbs at an estimated rate for that step
// (capped at a typical cost for it). When the real bill arrives, the total eases to the exact figure.
// Rates are USD per second of a typical call: tokens/sec × price; caps are a typical full call.
const TICK = {
  "math-pass":   { rate: 0.00008, cap: 0.01 },
  "plan":        { rate: 0.0012,  cap: 0.40 },
  "fix":         { rate: 0.0008,  cap: 0.12 },
  "revise":      { rate: 0.0008,  cap: 0.12 },
  "frame-check": { rate: 0.00006, cap: 0.006 },
};
const money4 = (n) => "$" + Math.max(0, n).toFixed(4);
function costLine(r) {
  return `<span class="k">Cost so far</span> <b class="tick" id="rcostv">${r.pending ? "≈ " : ""}${money4(r.shown ?? r.cost)}</b>` +
    ` <span class="muted small" id="rcostnote"></span>`;
}
callListeners.add((ev) => {
  const r = running.get(ev.jobId);
  if (!r) return;
  if (ev.type === "start") {
    let t = TICK[ev.stage] || { rate: 0.0005, cap: 0.05 };
    if (ev.stage === "transcribe") {
      // AssemblyAI: about $0.26 per hour of audio, usually done in well under a minute
      const est = ((ev.audioSeconds || 300) / 3600) * 0.26;
      t = { rate: est / 30, cap: est };
    }
    r.pending = { stage: ev.stage, t0: Date.now(), ...t };
  } else r.pending = null;
});
costListeners.add((jobId, c) => {
  const r = running.get(jobId);
  if (!r) return;
  r.cost += c; r.stageCost += c; r.calls += 1;
  r.pending = null;
  const jn = document.getElementById("jobcalls"); if (jn) jn.textContent = r.calls;
});
// One timer drives the on-screen number (10 updates a second).
setInterval(() => {
  const id = openJobId();
  const r = id && running.get(id);
  if (!r || !showCost) return;
  const est = r.pending ? Math.min(r.pending.cap * 0.85, (r.pending.rate * (Date.now() - r.pending.t0)) / 1000) : 0;
  const target = r.cost + est;
  r.shown ??= r.cost;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) r.shown = target;
  else if (r.pending) r.shown = Math.max(r.shown, r.shown + (target - r.shown) * 0.35); // only climbs while working
  else r.shown += (target - r.shown) * 0.25;                                          // eases to the exact bill
  if (Math.abs(target - r.shown) < 0.00005) r.shown = target;
  const v = document.getElementById("rcostv");
  if (v) v.textContent = (r.pending ? "≈ " : "") + money4(r.shown);
  const note = document.getElementById("rcostnote");
  if (note) note.textContent = r.pending ? `(estimate while ${r.pending.stage === "transcribe" ? "AssemblyAI" : "Claude"} works; exact when it finishes)`
    : r.stageCost ? `(+${money(r.stageCost)} this stage)` : "";
  const jc = document.getElementById("jobcost"); if (jc) jc.textContent = money4(r.shown);
}, 100);

// ---------------- job page ----------------
const FLOW = [["analysing", "Transcribe"], ["review-transcript", "Check transcript"], ["planning", "Plan slides"],
  ["review-slides", "Review slides"], ["rendering", "Render"], ["done", "Download"]];
async function jobView(id, keepScroll) {
  const y = window.scrollY;
  const { job, showCost: sc, asrProvider: ap, asrModel: am } = await api("GET", `/api/jobs/${id}`).catch((e) => ({ job: null, e }));
  if (sc !== undefined) showCost = sc;
  if (ap) asrProvider = ap;
  if (am) asrModel = am;
  if (!job) { $app.innerHTML = `<h1>Video not found</h1><p><a href="#/videos">Back to my videos</a></p>`; return; }
  const prev = jobCache.get(id);
  if (prev) { job._error = prev._error; job._warnings = prev._warnings; }
  jobCache.set(id, job);
  const r = running.get(id);
  const idx = FLOW.findIndex(([s]) => s === job.status);
  const nowIdx = job.status === "new" ? 0 : idx;
  const hasAudio = !!(await getFile(`audio:${id}`));
  $app.innerHTML = `<div class="eyebrow">${job.stream === "cp" ? "Coding and Programming" : "Mathematics"} · ${esc(job.eyebrow || "")}</div>
    <h1>${esc(job.title)}</h1>
    <p class="muted small">${statusTag(job.status)} &nbsp; Created ${when(job.createdAt)}${showCost ? ` · Claude cost so far <b id="jobcost">${money(r ? r.cost : job.costUsd)}</b> (<span id="jobcalls">${r ? r.calls : job.calls || 0}</span> calls)` : ""}</p>
    <div class="steps">${FLOW.map(([s, l], i) => `<div class="${i < nowIdx || job.status === "done" ? "done" : i === nowIdx ? "now" : ""}">${i + 1}. ${l}</div>`).join("")}</div>
    ${job._error ? `<div class="err"><b>Something went wrong:</b> ${esc(job._error)}</div>` : ""}
    ${(job._warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join("")}
    ${!hasAudio && job.status !== "done" ? `<div class="warn">The narration audio isn't stored in this browser. Re-attach it to continue:
      <input type="file" id="reattach" accept="audio/*,.m4a,.mp3,.wav"></div>` : ""}
    <div id="runbox"></div><div id="stage"></div>
    <div class="actions" style="margin-top:40px"><button class="danger" id="del">Delete this video</button></div>`;
  document.getElementById("del").onclick = async () => {
    if (!confirm("Delete this video? Its usage history stays in the admin reports.")) return;
    await api("DELETE", `/api/jobs/${id}`);
    for (const k of ["audio", "mp4", "srt"]) await delFile(`${k}:${id}`);
    location.hash = "#/videos";
  };
  const re = document.getElementById("reattach");
  if (re) re.onchange = async () => { if (re.files[0]) { await putFile(`audio:${id}`, re.files[0]); (await pipeline()).forgetAudio(id); jobView(id); } };
  if (r) { paint(id); return; }
  const st = document.getElementById("stage");
  const resume = (label, stage, note = "") => {
    st.innerHTML = `<div class="card"><p>${note || "This step was interrupted (the tab was closed or something failed)."}</p>
      <div class="actions"><button id="go">${label}</button></div></div>`;
    document.getElementById("go").onclick = () => { job._error = null; startStage(job, stage); jobView(id); };
  };
  if (job.status === "new" || job.status === "analysing") resume("Transcribe the audio", "analyse", job.status === "new" && !job._error ? "Ready to transcribe your narration." : "");
  else if (job.status === "review-transcript") transcriptReview(job, st);
  else if (job.status === "planning") resume("Plan the slides", "plan");
  else if (job.status === "review-slides") slideReview(job, st);
  else if (job.status === "rendering") resume("Render the video", "render");
  else if (job.status === "done") doneView(job, st);
  else if (job.status === "failed") resume("Start again from transcription", "analyse");
  if (keepScroll) window.scrollTo(0, y);
}
const jobCache = new Map();

// ----- Checkpoint A -----
async function transcriptReview(job, st) {
  const chunks = job.state.chunks || [];
  const flagged = chunks.filter((c) => c.flags?.length).length;
  st.innerHTML = `<h2>Checkpoint A: check the transcript</h2>
    <p>Left: captions (what you said). Right: the math version the slide planner will use, with a preview.
    ${flagged ? `<b>${flagged} chunk${flagged > 1 ? "s need" : " needs"} a look</b>, highlighted below.` : "Nothing was flagged."}</p>
    <div class="card" id="chunks">${chunks.map((c, i) => `
      <div class="chunk ${c.flags?.length ? "flagged" : ""}" data-i="${i}">
        <div class="t">${fmtT(c.start)}–${fmtT(c.end)}</div>
        <div><textarea data-k="caption" aria-label="Caption ${i + 1}">${esc(c.caption)}</textarea></div>
        <div><textarea data-k="latex" aria-label="Math version ${i + 1}" class="mono">${esc(c.latex)}</textarea>
          <div class="preview" data-p="${i}">${esc(c.latex)}</div>
          ${(c.flags || []).map((f, fi) => `<div class="flag"><b>${esc(f.kind === "slip" ? "Possible slip" : f.kind === "ambiguous" ? "Ambiguous" : "Unclear")}:</b> ${esc(f.note)}
            ${(f.options || []).map((o, oi) => `<button class="secondary" data-opt="${i}|${fi}|${oi}">Use ${esc(o)}</button>`).join("")}</div>`).join("")}
        </div></div>`).join("")}</div>
    <div id="m"></div>
    <div class="actions"><button id="approve">Approve and plan slides</button><button class="secondary" id="save">Save changes</button>
      <span class="muted small">Planning uses Opus and usually costs $0.30–$0.60.</span></div>`;
  await loadMathJax();
  const typeset = async (i) => {
    const p = st.querySelector(`[data-p="${i}"]`);
    p.textContent = chunks[i].latex;
    try { await MathJax.typesetPromise([p]); } catch {}
  };
  chunks.forEach((_, i) => typeset(i));
  st.querySelectorAll(".chunk textarea").forEach((ta) => {
    ta.oninput = () => {
      const i = Number(ta.closest(".chunk").dataset.i);
      chunks[i][ta.dataset.k] = ta.value;
      if (ta.dataset.k === "latex") { clearTimeout(ta._t); ta._t = setTimeout(() => typeset(i), 300); }
    };
  });
  st.querySelectorAll("[data-opt]").forEach((b) => (b.onclick = () => {
    const [i, fi, oi] = b.dataset.opt.split("|").map(Number);
    const f = chunks[i].flags[fi], opt = f.options[oi];
    const cur = chunks[i].latex;
    // swap whichever option currently appears in the text, else append a note
    const found = f.options.find((o) => cur.includes(o));
    chunks[i].latex = found ? cur.replace(found, opt) : cur;
    if (!found) alert("Couldn't find that expression in the text — edit the math box directly.");
    st.querySelector(`.chunk[data-i="${i}"] textarea[data-k="latex"]`).value = chunks[i].latex;
    typeset(i);
  }));
  const persist = () => api("PATCH", `/api/jobs/${job.id}`, { state: { chunks } });
  document.getElementById("save").onclick = async () => { await persist(); document.getElementById("m").innerHTML = `<div class="okmsg">Saved.</div>`; };
  document.getElementById("approve").onclick = async () => {
    await persist();
    job.state.chunks = chunks;
    job._error = null;
    startStage(job, "plan");
    jobView(job.id);
  };
}

// ----- Checkpoint B -----
async function slideReview(job, st) {
  st.innerHTML = `<h2>Checkpoint B: review the slides</h2>${loading("Drawing every slide")}`;
  const thumbs = await (await pipeline()).thumbnails(job, 640);
  const spec = job.state.spec;
  const chunkById = new Map((job.state.chunks || []).map((c) => [c.id, c]));
  const comments = job.state.lastComments && false ? job.state.lastComments : { scenes: {}, general: "" };
  st.innerHTML = `<h2>Checkpoint B: review the slides</h2>
    <p>Each picture is one build; it appears when you say the words under it. Comment on any scene, then apply the comments, or approve to render.</p>
    ${spec.scenes.map((sc, si) => `<div class="scene"><div class="eyebrow">Scene ${si + 1} · ${esc(sc.kind)}</div>
      <h3>${esc(sc.heading || spec.title)}</h3>
      <div class="thumbs">${thumbs.filter((t) => t.scene === si).map((t) => {
        const b = sc.builds[t.build] || {};
        const ch = chunkById.get(b.start?.chunk);
        return `<div class="thumb"><img src="${t.src}" alt="Scene ${si + 1} build ${t.build + 1}">
          <div class="cap">${ch ? `at ${fmtT(ch.start)}: “${esc(b.start?.phrase || "")}…”` : ""}</div>
          ${t.errors.map((e) => `<div class="bad">${esc(e)}</div>`).join("")}</div>`;
      }).join("")}</div>
      <label>Comments on this scene <span class="muted">(optional)</span><textarea data-scene="${si}" rows="2" placeholder="e.g. Box the final answer; move the note to the next build"></textarea></label>
    </div>`).join("")}
    <div class="card"><label>General comments <span class="muted">(optional)</span><textarea id="general" rows="2"></textarea></label>
    <div id="m"></div>
    <div class="actions"><button id="render">Approve and render</button><button class="secondary" id="apply">Apply comments</button>
      <button class="link" id="adv">Edit the slide spec directly</button></div>
    <div id="advbox"></div></div>`;
  document.getElementById("apply").onclick = () => {
    st.querySelectorAll("[data-scene]").forEach((t) => (comments.scenes[t.dataset.scene] = t.value));
    comments.general = document.getElementById("general").value;
    if (!Object.values(comments.scenes).some((v) => v.trim()) && !comments.general.trim()) {
      document.getElementById("m").innerHTML = `<div class="warn">Write at least one comment first.</div>`;
      return;
    }
    job._error = null;
    startStage(job, "revise", comments);
    jobView(job.id);
  };
  document.getElementById("render").onclick = () => { job._error = null; startStage(job, "render"); jobView(job.id); };
  document.getElementById("adv").onclick = () => {
    const box = document.getElementById("advbox");
    box.innerHTML = `<label>Slide spec (JSON)</label><textarea id="specjson" class="mono" rows="18">${esc(JSON.stringify(spec, null, 2))}</textarea>
      <div class="actions"><button class="secondary" id="savespec">Save and redraw</button></div>`;
    document.getElementById("savespec").onclick = async () => {
      try {
        const s = JSON.parse(document.getElementById("specjson").value);
        await api("PATCH", `/api/jobs/${job.id}`, { state: { spec: s } });
        jobView(job.id);
      } catch (e) { showErr(document.getElementById("m"), e); }
    };
  };
}

// ----- done -----
async function doneView(job, st) {
  const mem = (await pipeline()).outputs.get(job.id);
  const mp4 = mem?.mp4 || (await getFile(`mp4:${job.id}`).catch(() => null));
  const srt = mem?.srt || (await getFile(`srt:${job.id}`).catch(() => null));
  const out = job.state.output || {};
  const name = out.name || "video";
  st.innerHTML = `<h2>Your video is ready</h2>
    ${mp4 ? `<video controls src="${URL.createObjectURL(mp4)}"></video>` :
      `<div class="warn">The finished file isn't stored in this browser (it was made on another computer or cleared). Re-render it here from the approved slides — that step costs only a few cents.</div>`}
    <div class="actions">
      ${mp4 ? `<a class="btn" download="${esc(name)}.mp4" href="${URL.createObjectURL(mp4)}">Download MP4</a>` : ""}
      ${srt ? `<a class="btn secondary" download="${esc(name)}.srt" href="${URL.createObjectURL(srt)}">Download captions (.srt)</a>` : ""}
      <a class="btn secondary" download="${esc(name)}_slides.json" href="data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(job.state.spec, null, 2))}">Download slide spec</a>
      <button class="secondary" id="rerender">Render again</button><button class="secondary" id="back">Back to slide review</button>
    </div>
    ${out.flags?.length ? `<h3>The final check flagged ${out.flags.length} frame${out.flags.length > 1 ? "s" : ""}</h3>
      <ul>${out.flags.map((f) => `<li>Build ${f.build + 1}: ${esc(f.issue)}</li>`).join("")}</ul>` : mp4 ? `<div class="okmsg">The final frame check found no problems.</div>` : ""}
    <p class="muted small">Download your files now: the finished video is kept only in this browser. Remember brand@ontariotechu.ca asks to be contacted before the Ontario Tech name or logo is used in a project.</p>`;
  document.getElementById("rerender").onclick = () => { job._error = null; startStage(job, "render"); jobView(job.id); };
  document.getElementById("back").onclick = async () => { await api("PATCH", `/api/jobs/${job.id}`, { status: "review-slides" }); jobView(job.id); };
}

// ---------------- admin: usage ----------------
async function usageView() {
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const month = params.get("month") || new Date().toISOString().slice(0, 7);
  $app.innerHTML = `<div class="eyebrow">Admin</div><h1>Usage and spending</h1><div id="u">${loading("Adding up this month")}</div>`;
  const u = await api("GET", `/api/admin/usage?month=${month}`);
  const pct = u.capUsd ? Math.min(100, (u.totalUsd / u.capUsd) * 100) : 0;
  const months = [...Array(12)].map((_, i) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 7); });
  document.getElementById("u").outerHTML = `
    <div class="actions" style="margin:0 0 8px"><label style="margin:0">Month</label>
      <select id="month" style="width:auto">${months.map((m) => `<option ${m === month ? "selected" : ""}>${m}</option>`).join("")}</select>
      <a class="btn secondary" href="/api/admin/usage?month=${month}&format=csv">Export CSV</a></div>
    <div class="grid g4">
      <div class="stat"><div class="k">Spent this month</div><div class="v">${money(u.totalUsd)}</div>
        ${u.capUsd != null ? `<div class="meter ${pct > 80 ? "hot" : ""}"><div style="width:${pct}%"></div></div><div class="small muted">${pct.toFixed(0)}% of ${money(u.capUsd)} cap</div>` : `<div class="small muted">No cap set</div>`}</div>
      <div class="stat"><div class="k">Videos started</div><div class="v">${u.videos}</div></div>
      <div class="stat"><div class="k">Claude calls</div><div class="v">${u.calls}</div></div>
      <div class="stat"><div class="k">Average per video</div><div class="v">${u.byJob.length ? money(u.totalUsd / u.byJob.length) : "—"}</div></div>
    </div>
    <h2>By person</h2>
    <table><thead><tr><th>User</th><th class="num">Videos</th><th class="num">Calls</th><th class="num">Spent</th></tr></thead><tbody>
    ${u.byUser.map((r) => `<tr><td>${esc(r.user)}</td><td class="num">${r.videos}</td><td class="num">${r.calls}</td><td class="num">${money(r.costUsd)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No usage yet.</td></tr>`}</tbody></table>
    <h2>By stage and model</h2>
    <table><thead><tr><th>Stage</th><th>Model</th><th class="num">Calls</th><th class="num">Input tokens</th><th class="num">Output tokens</th><th class="num">Spent</th></tr></thead><tbody>
    ${u.byStage.map((r) => `<tr><td>${esc(r.stage)}</td><td>${esc(r.model)}</td><td class="num">${r.calls}</td>${r.audioSeconds ? `<td class="num" colspan="2">${(r.audioSeconds / 60).toFixed(1)} min of audio</td>` : `<td class="num">${r.input.toLocaleString()}</td><td class="num">${r.output.toLocaleString()}</td>`}<td class="num">${money(r.costUsd)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No usage yet.</td></tr>`}</tbody></table>
    <h2>By video</h2>
    <table><thead><tr><th>Video</th><th>User</th><th>Status</th><th class="num">Calls</th><th class="num">Spent</th></tr></thead><tbody>
    ${u.byJob.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.user)}</td><td>${r.status ? statusTag(r.status) : ""}</td><td class="num">${r.calls}</td><td class="num">${money(r.costUsd)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No usage yet.</td></tr>`}</tbody></table>
    <h2>Recent calls</h2>
    <table><thead><tr><th>Time</th><th>User</th><th>Stage</th><th class="num">Tokens in / cache read / out</th><th class="num">Cost</th></tr></thead><tbody>
    ${u.recent.map((r) => `<tr><td>${when(r.ts)}</td><td>${esc(r.user)}</td><td>${esc(r.stage)} <span class="muted small">${esc(r.model)}</span></td>
      <td class="num">${r.audioSeconds ? `${(r.audioSeconds / 60).toFixed(1)} min audio` : `${(r.input + r.cacheWrite).toLocaleString()} / ${r.cacheRead.toLocaleString()} / ${r.output.toLocaleString()}`}</td><td class="num">${money(r.costUsd, 4)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No calls yet.</td></tr>`}</tbody></table>`;
  document.getElementById("month").onchange = (e) => { location.hash = `#/admin/usage?month=${e.target.value}`; };
}

// ---------------- admin: users ----------------
async function usersView() {
  $app.innerHTML = `<div class="eyebrow">Admin</div><h1>Users</h1><div id="u">${loading("Loading people")}</div>`;
  const { users } = await api("GET", "/api/admin/users");
  const lim = (v) => (v == null ? "" : v);
  document.getElementById("u").outerHTML = `
    <table><thead><tr><th>Person</th><th>Role</th><th>Monthly $ limit</th><th>Monthly video limit</th><th>Active</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr data-email="${esc(u.email)}"><td><b>${esc(u.name)}</b><br><span class="small muted">${esc(u.email)}</span></td>
      <td><select data-k="role"><option value="user" ${u.role === "user" ? "selected" : ""}>User</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option></select></td>
      <td><input data-k="monthlyLimitUsd" type="number" min="0" step="0.5" value="${lim(u.monthlyLimitUsd)}" placeholder="default"></td>
      <td><input data-k="monthlyVideoLimit" type="number" min="0" step="1" value="${lim(u.monthlyVideoLimit)}" placeholder="default"></td>
      <td><input data-k="active" type="checkbox" ${u.active ? "checked" : ""} aria-label="Active"></td>
      <td class="small">${when(u.lastLoginAt)}</td>
      <td><button class="secondary" data-act="save">Save</button> <button class="link" data-act="reset">Reset password</button> <button class="link" data-act="del">Delete</button></td></tr>`).join("")}
    </tbody></table><div id="m"></div>
    <h2>Add a person</h2>
    <form id="add" class="card"><div class="grid g3">
      <label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
      <label>Temporary password <span class="muted">(10+ characters; they change it at first sign-in)</span><input name="password" required minlength="10"></label>
      <label>Role<select name="role"><option value="user">User</option><option value="admin">Admin (can see metering)</option></select></label>
      <label>Monthly $ limit <span class="muted">(blank = default)</span><input name="monthlyLimitUsd" type="number" min="0" step="0.5"></label>
      <label>Monthly video limit <span class="muted">(blank = default)</span><input name="monthlyVideoLimit" type="number" min="0" step="1"></label>
    </div><div class="actions"><button>Add person</button></div></form>`;
  const m = document.getElementById("m");
  $app.querySelectorAll("tr[data-email]").forEach((tr) => {
    const email = tr.dataset.email;
    tr.querySelector('[data-act="save"]').onclick = async () => {
      const v = (k) => tr.querySelector(`[data-k="${k}"]`);
      try {
        await api("PATCH", `/api/admin/users/${encodeURIComponent(email)}`, { role: v("role").value, active: v("active").checked,
          monthlyLimitUsd: v("monthlyLimitUsd").value, monthlyVideoLimit: v("monthlyVideoLimit").value });
        m.innerHTML = `<div class="okmsg">Saved ${esc(email)}.</div>`;
      } catch (e) { showErr(m, e); }
    };
    tr.querySelector('[data-act="reset"]').onclick = async () => {
      const pw = prompt(`New temporary password for ${email} (at least 10 characters):`);
      if (!pw) return;
      try { await api("PATCH", `/api/admin/users/${encodeURIComponent(email)}`, { password: pw }); m.innerHTML = `<div class="okmsg">Password reset. They'll choose a new one when they sign in.</div>`; }
      catch (e) { showErr(m, e); }
    };
    tr.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`Delete ${email}? Their usage history stays in the reports.`)) return;
      try { await api("DELETE", `/api/admin/users/${encodeURIComponent(email)}`); usersView(); } catch (e) { showErr(m, e); }
    };
  });
  document.getElementById("add").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api("POST", "/api/admin/users", form(ev.target)); usersView(); } catch (e) { showErr(m, e); }
  };
}

// ---------------- admin: keys ----------------
async function keysView() {
  $app.innerHTML = `<div class="eyebrow">Admin</div><h1>API keys</h1><div id="k">${loading("Loading keys")}</div>`;
  const { keys } = await api("GET", "/api/admin/keys");
  const NAMES = { anthropic: "Anthropic (Claude)", assemblyai: "AssemblyAI (transcription)" };
  const table = (provider) => {
    const mine = keys.filter((k) => (k.provider || "anthropic") === provider);
    return `<h2>${NAMES[provider]}</h2>
    <table><thead><tr><th>Label</th><th>Key</th><th>Added</th><th>Status</th><th></th></tr></thead><tbody>
    ${mine.map((k) => `<tr data-id="${esc(k.id)}"><td>${esc(k.label)}</td><td class="mono">${provider === "anthropic" ? "sk-ant-" : ""}…${esc(k.last4)}</td>
      <td class="small">${when(k.addedAt)}<br>${esc(k.addedBy)}</td>
      <td>${k.active ? '<span class="status done">Active</span>' : `<button class="secondary" data-act="use">Make active</button>`}</td>
      <td><button class="link" data-act="del">Remove</button></td></tr>`).join("") ||
      `<tr><td colspan="5" class="muted">${provider === "anthropic" ? "No key yet. Nobody can make videos until you add one."
        : "No key yet. Needed only if Settings → Transcription is set to AssemblyAI."}</td></tr>`}</tbody></table>`;
  };
  document.getElementById("k").outerHTML = `
    <p class="muted">Keys are encrypted on the server and never sent to anyone's browser. Every call uses the active key for its service and is metered on the Usage page.</p>
    ${table("anthropic")}${table("assemblyai")}
    <div id="m"></div>
    <h2>Add a key</h2>
    <form id="add" class="card"><div class="grid g3">
      <label>Service<select name="provider"><option value="anthropic">Anthropic (Claude)</option><option value="assemblyai">AssemblyAI (transcription)</option></select></label>
      <label>Label<input name="label" placeholder="TLC budget key" required></label>
      <label>API key<input name="key" type="password" autocomplete="off" placeholder="sk-ant-… or AssemblyAI key" required></label></div>
      <div class="actions"><button>Add key</button></div></form>`;
  const m = document.getElementById("m");
  $app.querySelectorAll("tr[data-id]").forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector('[data-act="use"]')?.addEventListener("click", async () => { await api("PATCH", `/api/admin/keys/${id}`, { active: true }); keysView(); });
    tr.querySelector('[data-act="del"]').onclick = async () => { if (confirm("Remove this key?")) { await api("DELETE", `/api/admin/keys/${id}`); keysView(); } };
  });
  document.getElementById("add").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api("POST", "/api/admin/keys", form(ev.target)); keysView(); } catch (e) { showErr(m, e); }
  };
}

// ---------------- admin: settings ----------------
async function settingsView() {
  $app.innerHTML = `<div class="eyebrow">Admin</div><h1>Settings</h1><div id="s">${loading("Loading settings")}</div>`;
  const { settings: s } = await api("GET", "/api/admin/settings");
  const stages = [["math-pass", "Math pass (spoken math → LaTeX)"], ["plan", "Slide planning"], ["fix", "Automatic spec fixes"],
    ["revise", "Applying review comments"], ["frame-check", "Final frame check"]];
  document.getElementById("s").outerHTML = `<form id="f">
    <div class="card"><h3>Spending</h3><div class="grid g3">
      <label>Monthly cap for the whole site (USD) <span class="muted">(blank = no cap)</span><input name="monthlyCapUsd" type="number" min="0" step="1" value="${s.monthlyCapUsd ?? ""}"></label>
      <label>Default monthly $ limit per person <span class="muted">(blank = none)</span><input name="defaultUserMonthlyLimitUsd" type="number" min="0" step="0.5" value="${s.defaultUserMonthlyLimitUsd ?? ""}"></label>
      <label>Default monthly videos per person <span class="muted">(blank = none)</span><input name="defaultUserMonthlyVideoLimit" type="number" min="0" step="1" value="${s.defaultUserMonthlyVideoLimit ?? ""}"></label>
    </div>
    <label class="switch"><input type="checkbox" name="showCost" ${s.showCost !== false ? "checked" : ""}>
      <span>Show costs while making videos <span class="muted">(a live $ total as each Claude step finishes, plus the cost on each video. Admins always see costs on the Usage page.)</span></span></label><p class="small muted">When a cap is reached, new Claude calls are blocked until next month or until you raise it. A call already running finishes.</p></div>
    <div class="card"><h3>Models for each stage</h3><div class="grid g2">
      ${stages.map(([k, l]) => `<label>${l}<input name="stage:${k}" value="${esc(s.stageModels[k])}"></label>`).join("")}</div>
    </div>
    <div class="card"><h3>Transcription</h3>
      <p class="small muted">How narration is turned into text. You can switch at any time; videos already transcribed keep their transcript.</p>
      <label class="switch"><input type="radio" name="asrProvider" value="browser" ${s.asrProvider !== "assemblyai" ? "checked" : ""}>
        <span>In-browser Whisper — free <span class="muted">(audio never leaves the computer; downloads a speech model the first time; slide timing comes from pauses)</span></span></label>
      <label class="switch"><input type="radio" name="asrProvider" value="assemblyai" ${s.asrProvider === "assemblyai" ? "checked" : ""}>
        <span>AssemblyAI — metered, about $0.02 for a 5-minute video <span class="muted">(timing for every word, so slides and captions line up exactly; your script and tipsheet are sent as key terms; audio goes to AssemblyAI and the transcript is deleted there afterwards; needs an AssemblyAI key)</span></span></label>
      <div id="asrwarn"></div>
      <div class="grid g2">
      <label>Whisper model <span class="muted">(in-browser option)</span>
        <select name="asrModel">${[["Xenova/whisper-small.en", "Whisper small (English) — most accurate, ~250 MB download"],
          ["Xenova/whisper-base.en", "Whisper base (English) — faster, ~80 MB"], ["Xenova/whisper-tiny.en", "Whisper tiny (English) — fastest, least accurate"]]
          .map(([v, l]) => `<option value="${v}" ${s.asrModel === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>AssemblyAI prices <span class="muted">(USD per hour of audio, by model; key terms add a per-hour charge)</span>
        <textarea name="transcriptionPrices" class="mono" rows="7">${esc(JSON.stringify(s.transcriptionPrices, null, 2))}</textarea></label>
      </div></div>
    <div class="card"><h3>Prices (USD per million tokens)</h3>
      <p class="small muted">Used to work out costs from each response's token counts. Update these if Anthropic's prices change. Haiku's "long" prices apply when a prompt is over its threshold.</p>
      <textarea name="prices" class="mono" rows="14">${esc(JSON.stringify(s.prices, null, 2))}</textarea></div>
    <div id="m"></div><div class="actions"><button>Save settings</button></div></form>`;
  // Warn if AssemblyAI is chosen without a key.
  const checkAsrKey = async () => {
    const choice = document.querySelector('input[name="asrProvider"]:checked')?.value;
    const box = document.getElementById("asrwarn");
    if (!box) return;
    if (choice !== "assemblyai") { box.innerHTML = ""; return; }
    const { keys } = await api("GET", "/api/admin/keys");
    box.innerHTML = keys.some((k) => k.provider === "assemblyai" && k.active) ? ""
      : `<div class="warn">No AssemblyAI key yet. Add one under <a href="#/admin/keys">API keys</a>, or new videos can't be transcribed.</div>`;
  };
  document.querySelectorAll('input[name="asrProvider"]').forEach((r) => (r.onchange = checkAsrKey));
  checkAsrKey();
  document.getElementById("f").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = form(ev.target);
    const m = document.getElementById("m");
    try {
      const body = { monthlyCapUsd: f.monthlyCapUsd, defaultUserMonthlyLimitUsd: f.defaultUserMonthlyLimitUsd,
        defaultUserMonthlyVideoLimit: f.defaultUserMonthlyVideoLimit, asrModel: f.asrModel, stageModels: {}, prices: JSON.parse(f.prices),
        showCost: f.showCost === "on", asrProvider: f.asrProvider, transcriptionPrices: JSON.parse(f.transcriptionPrices) };
      for (const [k] of stages) body.stageModels[k] = f[`stage:${k}`];
      await api("PUT", "/api/admin/settings", body);
      m.innerHTML = `<div class="okmsg">Settings saved.</div>`;
      checkAsrKey();
    } catch (e) { showErr(m, e); }
  };
}

boot().catch((e) => { $app.innerHTML = `<div class="err">${esc(e.message)}</div>`; });
