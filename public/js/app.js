// SLS Video Studio — single-page app (no build step).
import { api, costListeners, callListeners, emitCall } from "./api.js";
import { putFile, getFile, delFile } from "./idb.js";
// The pipeline (and its large libraries) loads only when a video needs it,
// so sign-in and admin pages work even if a library fails to load.
const pipeline = () => import("./pipeline/run.js");
import { loadMathJax } from "./pipeline/render.js";
import { SAMPLE_SCRIPT, RECORDING_TIPS } from "./voice-script.js";

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
const STATUS_TEXT = { "awaiting-approval": "Awaiting approval", new: "Uploaded", analysing: "Transcribing", "review-transcript": "Check transcript", planning: "Planning slides",
  "review-slides": "Review slides", rendering: "Rendering", done: "Done", failed: "Needs attention" };
const statusTag = (s) => `<span class="status ${esc(s)}">${esc(STATUS_TEXT[s] || s)}</span>`;
const loader = `<span class="loader" aria-hidden="true"><span></span><span></span><span></span></span>`;
const loading = (text = "Loading") => `<div class="loading" role="status">${loader}<span>${esc(text)}…</span></div>`;
// Length of an audio file in seconds (0 if the browser can't tell quickly).
function audioDuration(file) {
  return new Promise((res) => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    const done = (d) => { URL.revokeObjectURL(url); res(Number.isFinite(d) ? d : 0); };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}
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
    (me.role === "admin" ? `<span class="sep"></span>${a("#/admin/approvals", `Approvals<span class="badge" id="apcount" hidden></span>`)}${a("#/admin/usage", "Usage")}${a("#/admin/users", "Users")}${a("#/admin/keys", "API keys")}${a("#/admin/settings", "Settings")}` : "") +
    `<span class="sep"></span>${a("#/voice", "Voice")}${a("#/account", esc(me.name || me.email))}<button id="signout">Sign out</button>`;
}
function route() {
  $nav.innerHTML = navHtml();
  if (me.role === "admin") refreshApprovalCount();
  document.getElementById("signout").onclick = async () => { await api("POST", "/api/auth/logout", {}); location.hash = ""; location.reload(); };
  const h = (location.hash || "#/videos").slice(1);
  const [, a, b] = h.split("/");
  if (a === "videos" || !a) return videosView();
  if (a === "new") return newView();
  if (a === "job") return jobView(b);
  if (a === "account") return passwordView(false);
  if (a === "voice") return voiceView();
  if (a === "admin" && me.role === "admin") {
    if (b === "approvals") return approvalsView();
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
    <label class="switch"><input type="checkbox" name="enhance" checked><span>Enhance audio <span class="muted">(recommended: lowers background noise and hum, evens out the volume and adds clarity; you can compare and change this later)</span></span></label>
    <div id="advbox">
      <label>Advanced animated scenes <span class="muted">(Claude writes custom animation code for a scene; costs a little more)</span></label>
      <select name="advancedMode">
        <option value="auto">Let the planner decide (only where diagrams can't show it)</option>
        <option value="requested">I'll describe the scenes I want animated</option>
        <option value="off">Off: use diagrams and standard slides only</option>
      </select>
      <label id="advnoteslbl">Which scenes, and what should move? <span class="muted">(optional for "Let the planner decide")</span>
        <textarea name="advancedNotes" rows="3" placeholder="e.g. Animate the strips shrinking as Δx goes to 0, with the corner vanishing fastest"></textarea></label>
    </div>
    <div id="m"></div>
    <div class="actions"><button>Upload and start</button><span class="muted small">Next: we transcribe it, then you check the transcript.</span></div>
  </form>`;
  const advSel = document.querySelector('select[name="advancedMode"]');
  advSel.onchange = () => { document.getElementById("advnoteslbl").style.display = advSel.value === "off" ? "none" : ""; };
  api("GET", "/api/jobs").then(({ asrProvider: ap, allowAdvanced }) => {
    if (allowAdvanced === false) document.getElementById("advbox").remove();
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
      const durationSec = await audioDuration(audio);
      const { job } = await api("POST", "/api/jobs", { durationSec,
        title: fd.get("title"), eyebrow: fd.get("eyebrow"), subtitle: fd.get("subtitle"), stream: fd.get("stream"),
        script: fd.get("script"), notes: fd.get("notes"), tipsheet, audioName: audio.name,
        advancedMode: fd.get("advancedMode") || "off", advancedNotes: fd.get("advancedNotes") || "", enhance: fd.get("enhance") === "on",
      });
      await putFile(`audio:${job.id}`, audio);
      location.hash = `#/job/${job.id}`;
      if (job.status !== "awaiting-approval") startStage(job, "analyse");
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
// ---------- Model indicator lights ----------
// A small row of labels; each one's light turns orange while that service is working.
const LIGHTS = ["HAIKU", "SONNET", "OPUS", "ASSEMBLYAI", "ELEVENLABS"];
const active = new Map(); // light -> number of calls running
const lightOf = (ev) => {
  const m = String(ev.model || ""), st = ev.stage;
  if (st === "transcribe") return "ASSEMBLYAI";
  if (st === "voice" || /elevenlabs/i.test(m)) return "ELEVENLABS";
  return /haiku/i.test(m) ? "HAIKU" : /sonnet/i.test(m) ? "SONNET" : /opus/i.test(m) ? "OPUS" : null;
};
const lightsHtml = () => `<span class="lights" aria-label="Services in use">${LIGHTS.map((l) =>
  `<span class="light ${active.get(l) ? "on" : ""}" data-light="${l}" title="${l}${active.get(l) ? " is working" : ""}"><i></i>${l}</span>`).join("")}</span>`;
function paintLights() {
  document.querySelectorAll(".light[data-light]").forEach((el) => {
    const on = !!active.get(el.dataset.light);
    el.classList.toggle("on", on);
    el.title = `${el.dataset.light}${on ? " is working" : ""}`;
  });
}
callListeners.add((ev) => {
  const l = lightOf(ev);
  if (!l) return;
  active.set(l, Math.max(0, (active.get(l) || 0) + (ev.type === "start" ? 1 : -1)));
  paintLights();
});

function paint(id) {
  const box = document.getElementById("runbox");
  if (!box || openJobId() !== id) return;
  const r = running.get(id);
  if (!r) return;
  const pct = r.progress == null ? null : Math.round(r.progress * 100);
  box.innerHTML = `<div class="card"><div class="cardtop"><div class="eyebrow">Working — keep this tab open</div>${lightsHtml()}</div>
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
    <p class="muted small">${statusTag(job.status)} &nbsp; Created ${when(job.createdAt)}${showCost ? ` · Claude cost so far <b id="jobcost">${money(r ? r.cost : job.costUsd)}</b> (<span id="jobcalls">${r ? r.calls : job.calls || 0}</span> calls)` : ""}${job.approval?.required && job.approval.status === "approved" && job.approval.limitUsd != null ? ` · Approved budget <b>${money(job.approval.limitUsd)}</b>` : ""}</p>
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
    for (const k of ["audio", "audio-original", "mp4", "srt"]) await delFile(`${k}:${id}`);
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
  if (job.status === "awaiting-approval") return awaitingView(job, st);
  if (job.approval?.status === "declined") {
    st.innerHTML = `<div class="card"><h3>An admin declined this video</h3><p>${esc(job.approval.note || "No reason was given.")}</p>
      <p class="muted small">Declined by ${esc(job.approval.decidedBy)} on ${when(job.approval.decidedAt)}. Nothing was charged for it.</p></div>`;
    return;
  }
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

// ----- waiting for approval -----
let approvalPoll = null;
function awaitingView(job, st) {
  const a = job.approval || {};
  st.innerHTML = `<div class="card"><div class="eyebrow">Waiting for approval</div>
    <div class="runhead">${loader}<h3>An admin needs to approve this video before it starts</h3></div>
    <p>Estimated cost: <b>${money(a.estimateUsd)}</b>${job.durationSec ? ` for ${Math.round(job.durationSec / 60 * 10) / 10} minutes of narration` : ""}.
    Nothing is charged until it's approved. Your audio is saved in this browser, so you can close this page and come back.</p>
    <p class="muted small">Requested ${when(a.requestedAt)}. This page checks for a decision every 20 seconds.</p>
    <div class="actions"><button class="secondary" id="recheck">Check now</button></div></div>`;
  document.getElementById("recheck").onclick = () => jobView(job.id);
  clearInterval(approvalPoll);
  approvalPoll = setInterval(async () => {
    if (openJobId() !== job.id) return clearInterval(approvalPoll);
    try {
      const { job: j } = await api("GET", `/api/jobs/${job.id}`);
      if (j.status !== "awaiting-approval") { clearInterval(approvalPoll); jobView(job.id); }
    } catch {}
  }, 20000);
}

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
          ${(c.flags || []).map((f, fi) => `<div class="flag"><b>${esc(f.kind === "slip" ? "Possible slip" : f.kind === "ambiguous" ? "Ambiguous" : f.kind === "false-start" ? "False start" : "Unclear")}:</b> ${esc(f.note)}
            ${(f.options || []).map((o, oi) => `<button class="secondary" data-opt="${i}|${fi}|${oi}">Use ${esc(o)}</button>`).join("")}</div>`).join("")}
        </div></div>`).join("")}</div>
    <div id="cleanbox"></div><div id="patchbox"></div>
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
  audioPanels(job);
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
    ${spec.scenes.map((sc, si) => `<div class="scene"><div class="eyebrow">Scene ${si + 1} · ${esc(sc.kind === "advanced" ? "advanced animation" : sc.kind)}</div>
      <div class="runhead"><h3>${esc(sc.heading || spec.title)}</h3>
        ${sc.kind === "advanced" || sc.builds?.length > 1 ? `<button class="secondary small-btn" data-play="${si}" style="margin-left:auto">▶ Play scene</button>` : ""}</div>
      <div class="player" id="player-${si}" hidden><canvas width="960" height="540"></canvas>
        <div class="small muted">Preview with estimated timing; the final video follows your narration exactly.</div></div>
      <div class="thumbs">${thumbs.filter((t) => t.scene === si).map((t) => {
        const b = sc.builds[t.build] || {};
        const ch = chunkById.get(b.start?.chunk);
        return `<div class="thumb"><img src="${t.src}" alt="Scene ${si + 1} build ${t.build + 1}">
          <div class="cap">${ch ? `at ${fmtT(ch.start)}: “${esc(b.start?.phrase || "")}…”` : ""}</div>
          ${t.errors.map((e) => `<div class="bad">${esc(e)}</div>`).join("")}</div>`;
      }).join("")}</div>
      <label>Comments on this scene <span class="muted">(optional)</span><textarea data-scene="${si}" rows="2" placeholder="e.g. Box the final answer; move the note to the next build"></textarea></label>
    </div>`).join("")}
    <div id="cleanbox"></div><div id="patchbox"></div>
    <div class="card"><label>General comments <span class="muted">(optional)</span><textarea id="general" rows="2"></textarea></label>
    <div id="m"></div>
    <div class="actions"><button id="render">Approve and render</button><button class="secondary" id="apply">Apply comments</button>
      <button class="link" id="adv">Edit the slide spec directly</button></div>
    <div id="advbox"></div></div>`;
  audioPanels(job);
  let stopPlay = null;
  st.querySelectorAll("[data-play]").forEach((btn) => (btn.onclick = async () => {
    const si = Number(btn.dataset.play);
    stopPlay?.();
    st.querySelectorAll(".player").forEach((p) => (p.hidden = true));
    const box = document.getElementById(`player-${si}`);
    box.hidden = false;
    btn.disabled = true; btn.textContent = "Playing…";
    stopPlay = (await pipeline()).playScene(box.querySelector("canvas"), si, () => { btn.disabled = false; btn.textContent = "▶ Play again"; });
  }));
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
    ${job.state.patchedAfterRender ? `<div class="warn">You've changed the narration or its audio settings since this video was rendered. Choose <b>Render again</b> to hear the change in the video.</div>` : ""}
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
    <div id="cleanbox"></div><div id="patchbox"></div>
    <p class="muted small">Download your files now: the finished video is kept only in this browser. Remember brand@ontariotechu.ca asks to be contacted before the Ontario Tech name or logo is used in a project.</p>`;
  document.getElementById("rerender").onclick = () => { job._error = null; startStage(job, "render"); jobView(job.id); };
  audioPanels(job);
  document.getElementById("back").onclick = async () => { await api("PATCH", `/api/jobs/${job.id}`, { status: "review-slides" }); jobView(job.id); };
}

// ---------------- admin: approvals ----------------
async function refreshApprovalCount() {
  try {
    const { pending } = await api("GET", "/api/admin/approvals");
    const b = document.getElementById("apcount");
    if (b) { b.textContent = pending.length; b.hidden = !pending.length; }
  } catch {}
}
async function approvalsView() {
  $app.innerHTML = `<div class="eyebrow">Admin</div><h1>Approvals</h1><div id="ap">${loading("Loading requests")}</div>`;
  const [{ pending, recent }, { settings: s }] = await Promise.all([api("GET", "/api/admin/approvals"), api("GET", "/api/admin/settings")]);
  const mode = { none: "Approval is off — videos start straight away.", threshold: `Videos estimated over ${money(s.approvalThresholdUsd)} need approval.`,
    always: "Every video needs approval." }[s.approvalMode || "none"];
  const mins = (j) => (j.durationSec ? `${(j.durationSec / 60).toFixed(1)} min` : "—");
  const suggest = (j) => Math.ceil((j.approval.estimateUsd || 0.5) * 1.5 * 100) / 100;
  document.getElementById("ap").outerHTML = `
    <p class="muted">${mode} <a href="#/admin/settings">Change in Settings</a>. Admins' own videos are approved automatically.</p>
    <h2>Waiting (${pending.length})</h2>
    ${pending.length ? `<table><thead><tr><th>Video</th><th>Person</th><th>Length</th><th class="num">Estimate</th><th>Budget for this video</th><th>Note <span class="muted">(optional)</span></th><th></th></tr></thead><tbody>
    ${pending.map((j) => `<tr data-id="${esc(j.id)}"><td><b>${esc(j.title)}</b><br><span class="small muted">${when(j.approval.requestedAt)}</span></td>
      <td>${esc(j.ownerName || j.owner)}<br><span class="small muted">${esc(j.owner)}</span></td><td>${mins(j)}</td><td class="num">${money(j.approval.estimateUsd)}</td>
      <td><input data-k="limit" type="number" min="0.01" step="0.05" value="${suggest(j)}" aria-label="Budget in dollars" style="width:110px">
        <div class="small muted">blank = no limit</div></td>
      <td><input data-k="note" maxlength="500" placeholder="e.g. Keep it under 5 minutes"></td>
      <td style="white-space:nowrap"><button data-act="approve">Approve</button> <button class="danger" data-act="decline">Decline</button></td></tr>`).join("")}</tbody></table>`
      : `<div class="card muted">Nothing is waiting for approval.</div>`}
    <div id="m"></div>
    <h2>Recent decisions</h2>
    ${recent.length ? `<table><thead><tr><th>Video</th><th>Person</th><th>Decision</th><th class="num">Estimate</th><th class="num">Spent</th><th>Budget</th><th>By</th></tr></thead><tbody>
    ${recent.map((j) => `<tr data-id="${esc(j.id)}"><td>${esc(j.title)}</td><td>${esc(j.ownerName || j.owner)}</td>
      <td>${j.approval.status === "approved" ? '<span class="status done">Approved</span>' : '<span class="status failed">Declined</span>'}${j.approval.note ? `<br><span class="small muted">${esc(j.approval.note)}</span>` : ""}</td>
      <td class="num">${money(j.approval.estimateUsd)}</td><td class="num">${money(j.costUsd)}</td>
      <td>${j.approval.status === "approved" ? `<input data-k="limit" type="number" min="0.01" step="0.05" value="${j.approval.limitUsd ?? ""}" placeholder="none" style="width:90px"> <button class="secondary" data-act="budget">Set</button>` : "—"}</td>
      <td class="small">${esc(j.approval.decidedBy || "")}<br>${when(j.approval.decidedAt)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="card muted">No decisions yet.</div>`}`;
  const m = document.getElementById("m");
  $app.querySelectorAll("tr[data-id]").forEach((tr) => {
    const id = tr.dataset.id;
    const val = (k) => tr.querySelector(`[data-k="${k}"]`)?.value ?? "";
    const send = async (decision) => {
      try {
        await api("POST", `/api/admin/approvals/${encodeURIComponent(id)}`, { decision, limitUsd: val("limit"), note: val("note") });
        approvalsView(); refreshApprovalCount();
      } catch (e) { showErr(m, e); }
    };
    tr.querySelector('[data-act="approve"]')?.addEventListener("click", () => send("approve"));
    tr.querySelector('[data-act="decline"]')?.addEventListener("click", () => {
      if (!val("note") && !confirm("Decline without a note? The person will see that it was declined.")) return;
      send("decline");
    });
    tr.querySelector('[data-act="budget"]')?.addEventListener("click", () => send("budget"));
  });
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
    <h2>Cost estimates</h2>
    <div class="card">
      <p style="margin-top:0">New videos are estimated at <b>${money(u.estimates.base)} + ${money(u.estimates.perMin, 3)} per minute</b> of narration
        (a 5-minute video: <b>${money(u.estimates.example5min)}</b>, including transcription if AssemblyAI is on).
        ${u.estimates.n ? `Learned from <b>${u.estimates.n}</b> finished video${u.estimates.n > 1 ? "s" : ""}, weighted ${Math.round(u.estimates.weight * 100)}% on your data and the rest on the starting formula; it sharpens as more videos finish.`
          : "No finished videos yet, so this is the starting formula. It starts learning from real costs as videos finish."}</p>
      ${u.estimates.recent.length ? `<table><thead><tr><th>Finished video</th><th>Person</th><th class="num">Length</th><th class="num">Estimated</th><th class="num">Actual</th><th class="num">Difference</th></tr></thead><tbody>
      ${u.estimates.recent.map((p) => { const d = p.estimate == null ? null : p.total - p.estimate;
        return `<tr><td>${esc(p.title)}</td><td>${esc(p.owner)}</td><td class="num">${p.min.toFixed(1)} min</td><td class="num">${money(p.estimate)}</td>
          <td class="num">${money(p.total)}</td><td class="num">${d == null ? "—" : `${d >= 0 ? "+" : "−"}${money(Math.abs(d))} (${p.estimate ? Math.round((d / p.estimate) * 100) : 0}%)`}</td></tr>`; }).join("")}
      </tbody></table>` : ""}
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
  const NAMES = { anthropic: "Anthropic (Claude)", assemblyai: "AssemblyAI (transcription)", elevenlabs: "ElevenLabs (voice patching)" };
  const table = (provider) => {
    const mine = keys.filter((k) => (k.provider || "anthropic") === provider);
    return `<h2>${NAMES[provider]}</h2>
    <table><thead><tr><th>Label</th><th>Key</th><th>Added</th><th>Status</th><th></th></tr></thead><tbody>
    ${mine.map((k) => `<tr data-id="${esc(k.id)}"><td>${esc(k.label)}</td><td class="mono">${provider === "anthropic" ? "sk-ant-" : ""}…${esc(k.last4)}</td>
      <td class="small">${when(k.addedAt)}<br>${esc(k.addedBy)}</td>
      <td>${k.active ? '<span class="status done">Active</span>' : `<button class="secondary" data-act="use">Make active</button>`}</td>
      <td><button class="link" data-act="del">Remove</button></td></tr>`).join("") ||
      `<tr><td colspan="5" class="muted">${provider === "anthropic" ? "No key yet. Nobody can make videos until you add one."
        : provider === "elevenlabs" ? "No key yet. Needed only for the optional Voice feature. Give the key two permissions: Text to Speech (Access) and Voices (Write); leave the rest off and don't restrict it by IP."
        : "No key yet. Needed only if Settings → Transcription is set to AssemblyAI."}</td></tr>`}</tbody></table>`;
  };
  document.getElementById("k").outerHTML = `
    <p class="muted">Keys are encrypted on the server and never sent to anyone's browser. Every call uses the active key for its service and is metered on the Usage page.</p>
    ${table("anthropic")}${table("assemblyai")}${table("elevenlabs")}
    <div id="m"></div>
    <h2>Add a key</h2>
    <form id="add" class="card"><div class="grid g3">
      <label>Service<select name="provider"><option value="anthropic">Anthropic (Claude)</option><option value="assemblyai">AssemblyAI (transcription)</option><option value="elevenlabs">ElevenLabs (voice patching)</option></select></label>
      <label>Label<input name="label" placeholder="TLC budget key" required></label>
      <label>API key<input name="key" type="password" autocomplete="off" placeholder="sk-ant-…, AssemblyAI or ElevenLabs key" required></label></div>
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
    <label class="switch"><input type="checkbox" name="allowAdvanced" ${s.allowAdvanced !== false ? "checked" : ""}>
      <span>Allow advanced animated scenes <span class="muted">(Claude writes animation code for scenes a diagram can't show; it runs sandboxed in the browser and costs a little more per video)</span></span></label>
    <label class="switch"><input type="checkbox" name="showCost" ${s.showCost !== false ? "checked" : ""}>
      <span>Show costs while making videos <span class="muted">(a live $ total as each Claude step finishes, plus the cost on each video. Admins always see costs on the Usage page.)</span></span></label><p class="small muted">When a cap is reached, new Claude calls are blocked until next month or until you raise it. A call already running finishes.</p></div>
    <div class="card"><h3>Approval</h3>
      <p class="small muted">Whether an admin has to approve a video before it can spend anything. The estimate starts at about $0.46 plus $0.04 per minute of narration (plus transcription if AssemblyAI is chosen) and learns from the real cost of each finished video; see Usage → Cost estimates. Admins' own videos are approved automatically.</p>
      <label class="switch"><input type="radio" name="approvalMode" value="none" ${(s.approvalMode || "none") === "none" ? "checked" : ""}><span>No approval needed</span></label>
      <label class="switch"><input type="radio" name="approvalMode" value="threshold" ${s.approvalMode === "threshold" ? "checked" : ""}>
        <span>Approval when the estimate is over <input name="approvalThresholdUsd" type="number" min="0" step="0.05" value="${s.approvalThresholdUsd ?? 1}" style="width:100px;display:inline-block;margin:0 6px" aria-label="Approval threshold in dollars"> USD</span></label>
      <label class="switch"><input type="radio" name="approvalMode" value="always" ${s.approvalMode === "always" ? "checked" : ""}><span>Every video needs approval</span></label>
    </div>
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
    <div class="card"><h3>Voice patching (ElevenLabs)</h3>
      <p class="small muted">Each person can turn on an AI copy of their own voice on their Voice page, then use it to re-say a line of their narration instead of re-recording. Their sample goes to ElevenLabs once to make the voice and isn't kept here. Needs an ElevenLabs key under API keys.</p>
      <label class="switch"><input type="checkbox" name="allowVoice" ${s.allowVoice !== false ? "checked" : ""}>
        <span>Allow people to set up and use their AI voice <span class="muted">(turning this off blocks new voices and patches; existing voices stay until each person deletes theirs)</span></span></label>
      <div class="grid g2">
      <label>ElevenLabs model
        <select name="elevenlabsModel">${[["eleven_multilingual_v2", "Multilingual v2 — most natural, uses the surrounding sentences for flow"],
          ["eleven_v3", "Eleven v3 — most expressive"], ["eleven_turbo_v2_5", "Turbo v2.5 — half price, slightly flatter"], ["eleven_flash_v2_5", "Flash v2.5 — half price, fastest"]]
          .concat(["eleven_multilingual_v2", "eleven_v3", "eleven_turbo_v2_5", "eleven_flash_v2_5"].includes(s.elevenlabsModel) ? [] : [[s.elevenlabsModel, s.elevenlabsModel]])
          .map(([v, l]) => `<option value="${esc(v)}" ${s.elevenlabsModel === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <label>ElevenLabs prices <span class="muted">(USD per 1,000 characters, by model)</span>
        <textarea name="voicePrices" class="mono" rows="6">${esc(JSON.stringify(s.voicePrices, null, 2))}</textarea></label>
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
        showCost: f.showCost === "on", asrProvider: f.asrProvider, transcriptionPrices: JSON.parse(f.transcriptionPrices),
        approvalMode: f.approvalMode, approvalThresholdUsd: f.approvalThresholdUsd, allowAdvanced: f.allowAdvanced === "on",
        allowVoice: f.allowVoice === "on", elevenlabsModel: f.elevenlabsModel, voicePrices: JSON.parse(f.voicePrices) };
      for (const [k] of stages) body.stageModels[k] = f[`stage:${k}`];
      await api("PUT", "/api/admin/settings", body);
      m.innerHTML = `<div class="okmsg">Settings saved.</div>`;
      checkAsrKey();
    } catch (e) { showErr(m, e); }
  };
}

// ---------------- voice (optional AI voice for patching lines) ----------------
const patchMod = () => import("./pipeline/patch.js");
const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const md = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").split(/\n\n/).map((p) => `<p>${p}</p>`).join("");
let voicePoll = null;
const patchOpen = new Set(); // videos whose "Fix a line" panel is open

async function voiceView() {
  $app.innerHTML = `<div class="eyebrow">Your account</div><h1>Voice</h1><div id="v">${loading("Loading")}</div>`;
  const v = await api("GET", "/api/voice/me");
  const vo = v.voice;
  const el = document.getElementById("v");
  const per = (n) => money((n / 1000) * v.pricePer1kChars, 3);
  const scriptHtml = `<details class="script"><summary>The sample script (about 4 minutes to read)</summary>
      <ul class="small">${RECORDING_TIPS.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <p class="small muted">Words in <b>bold</b> are stressed: lean on them a little more than feels natural.</p>
      ${SAMPLE_SCRIPT.map(([h, t], i) => `<h4>${i + 1}. ${esc(h)}</h4>${md(t)}`).join("")}</details>`;
  const uploadForm = (replacing) => `<form id="sample" class="sub">
      ${scriptHtml}
      <label>${replacing ? "New sample" : "Your recording of the script"} <span class="muted">(M4A, MP3 or WAV, 1–10 minutes, under 10 MB)</span>
        <input type="file" name="sample" accept="audio/*,.m4a,.mp3,.wav" required></label>
      <label class="switch"><input type="checkbox" name="removeNoise"><span>Remove background noise <span class="muted">(only if the room was noisy; it can make a clean recording sound worse)</span></span></label>
      <label class="switch"><input type="checkbox" name="consent" required><span>${esc(v.consentText)}</span></label>
      <div id="sm"></div>
      <div class="actions"><button>${replacing ? "Replace my voice" : "Create my voice"}</button>
        ${replacing ? `<button type="button" class="link" id="cancelrep">Cancel</button>` : ""}</div></form>`;

  el.innerHTML = `<p>Fix a line in a video without re-recording: you type what you meant to say, your AI voice says it, and it's spliced into your narration in place of the old line. It's optional and stays off unless you turn it on.</p>
    ${v.available ? "" : `<div class="warn">${esc(v.reason)}</div>`}
    <div class="card"><label class="switch big"><input type="checkbox" id="vonoff" ${vo.enabled ? "checked" : ""} ${v.available || vo.enabled ? "" : "disabled"}>
      <span><b>Use my AI voice to fix lines</b> <span class="muted">(${vo.enabled ? "on: a “Fix a line” panel appears on your videos" : "off"})</span></span></label></div>
    ${vo.enabled ? `
    <div class="card"><h3>Your voice</h3><div id="vstate">${
      vo.status === "creating" ? `<div class="runhead">${loader}<span>Making your voice with ElevenLabs. This usually takes under a minute.</span></div>`
      : vo.hasVoice ? `<p>Made from <b>${esc(vo.sampleName || "your sample")}</b>${vo.sampleSeconds ? ` (${fmtT(vo.sampleSeconds)})` : ""} on ${when(vo.createdAt)}${vo.removedNoise ? ", with background noise removed" : ""}.</p>
          ${vo.error ? `<div class="err">The last attempt to replace it failed: ${esc(vo.error)}</div>` : ""}
          <div class="actions"><button class="secondary" id="replace">Replace with a new sample</button><button class="danger" id="vdel">Delete my voice</button></div>
          <div id="repbox"></div>`
      : `${vo.error ? `<div class="err">${esc(vo.error)}</div>` : ""}
          <p>To make your voice, record yourself reading the sample script below, then upload it. 2 to 5 minutes of clear speech works best.</p>${v.available ? uploadForm(false) : ""}`}</div>
      <p class="small muted">Your sample is sent to ElevenLabs once to make the voice and isn't kept on this site. The voice is kept in the TLC's ElevenLabs account until you delete it, and only you can use it.</p></div>
    ${vo.hasVoice ? `<div class="card"><h3>How it sounds</h3>
      <div class="grid g2">
        ${[["stability", "Stability", 0, 1, 0.05, "Lower is more expressive, higher is steadier"], ["similarity", "Similarity to your sample", 0, 1, 0.05, "Higher sticks closer to your sample"],
           ["style", "Style exaggeration", 0, 1, 0.05, "Keep near 0 for narration"], ["speed", "Speed", 0.7, 1.2, 0.01, "1 is your sample's pace"]]
          .map(([k, l, lo, hi, step, hint]) => `<label>${l} <b id="out-${k}">${vo.settings[k]}</b><input type="range" data-set="${k}" min="${lo}" max="${hi}" step="${step}" value="${vo.settings[k]}">
            <span class="small muted">${hint}</span></label>`).join("")}
      </div>
      <div class="actions"><button class="secondary" id="vsave">Save settings</button><button class="link" id="vreset">Back to defaults</button></div>
      <label>Try it <span class="muted">(each try costs about ${per(120)})</span>
        <textarea id="vtest" rows="2" maxlength="600">Okay, so let's check our answer. It's not the first step that matters most here, it's the **last** one.</textarea></label>
      <div class="actions"><button id="vplay">Say it</button><span class="small muted" id="vcost"></span>${lightsHtml()}</div><div id="vtake"></div></div>` : ""}`
    : vo.hasVoice ? `<div class="card"><p>Your voice is turned off, so it can't be used, but it's still kept at ElevenLabs.</p>
        <div class="actions"><button class="danger" id="vdel">Delete my voice</button></div></div>` : ""}
    <div id="vm"></div>`;

  const vm = document.getElementById("vm");
  document.getElementById("vonoff").onchange = async (ev) => {
    try { await api("PUT", "/api/voice/me", { enabled: ev.target.checked }); voiceView(); } catch (e) { showErr(vm, e); }
  };
  const del = document.getElementById("vdel");
  if (del) del.onclick = async () => {
    if (!confirm("Delete your AI voice? It's removed from ElevenLabs. Lines you've already patched stay patched.")) return;
    try { await api("POST", "/api/voice/delete", {}); voiceView(); } catch (e) { showErr(vm, e); }
  };
  const wireUpload = (form) => {
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form), file = fd.get("sample"), sm = form.querySelector("#sm");
      try {
        if (!file?.size) throw new Error("Choose your recording.");
        if (file.size > 10 * 1024 * 1024) throw new Error("That file is over 10 MB. Export it as M4A or MP3, or trim it to about 5 minutes.");
        const dur = await audioDuration(file);
        if (dur && dur < 45) throw new Error("That recording is under a minute. Read the whole sample script (about 4 minutes).");
        form.querySelector("button").disabled = true;
        const bytes = new Uint8Array(await file.arrayBuffer()), PART = 3 * 1024 * 1024, parts = Math.ceil(bytes.length / PART);
        sm.innerHTML = loading("Uploading your sample");
        const { id } = await api("POST", "/api/voice/sample/start", { parts, durationSec: Math.round(dur), sampleName: file.name, mime: file.type || "audio/mpeg",
          consent: fd.get("consent") === "on", removeNoise: fd.get("removeNoise") === "on" });
        for (let n = 0; n < parts; n++) await api("POST", "/api/voice/sample/part", { id, n, data: b64(bytes.subarray(n * PART, (n + 1) * PART)) });
        await api("POST", "/api/voice/sample/run", { id });
        sm.innerHTML = loading("Making your voice with ElevenLabs");
        const t0 = Date.now();
        while (true) {
          await new Promise((r) => setTimeout(r, 2000));
          const r = await api("GET", `/api/voice/sample/result?id=${encodeURIComponent(id)}`);
          if (r.status === "done") break;
          if (r.status === "error") throw new Error(r.error);
          if (Date.now() - t0 > 5 * 60 * 1000) throw new Error("ElevenLabs is taking a long time. Check back on this page in a few minutes.");
        }
        voiceView();
      } catch (e) { form.querySelector("button").disabled = false; showErr(sm, e); }
    };
  };
  const sf = document.getElementById("sample");
  if (sf) wireUpload(sf);
  const rep = document.getElementById("replace");
  if (rep) rep.onclick = () => {
    const box = document.getElementById("repbox");
    box.innerHTML = uploadForm(true);
    wireUpload(document.getElementById("sample"));
    document.getElementById("cancelrep").onclick = () => (box.innerHTML = "");
  };
  if (vo.status === "creating") {
    clearInterval(voicePoll);
    voicePoll = setInterval(async () => {
      if (!location.hash.startsWith("#/voice")) return clearInterval(voicePoll);
      const r = await api("GET", "/api/voice/me").catch(() => null);
      if (r && r.voice.status !== "creating") { clearInterval(voicePoll); voiceView(); }
    }, 4000);
  }
  // settings
  const vals = () => Object.fromEntries([...document.querySelectorAll("[data-set]")].map((r) => [r.dataset.set, Number(r.value)]));
  document.querySelectorAll("[data-set]").forEach((r) => (r.oninput = () => (document.getElementById(`out-${r.dataset.set}`).textContent = r.value)));
  const save = document.getElementById("vsave");
  if (save) save.onclick = async () => {
    try { await api("PUT", "/api/voice/me", { settings: vals() }); vm.innerHTML = `<div class="okmsg">Settings saved.</div>`; } catch (e) { showErr(vm, e); }
  };
  const reset = document.getElementById("vreset");
  if (reset) reset.onclick = async () => {
    try { await api("PUT", "/api/voice/me", { settings: { stability: 0.5, similarity: 0.8, style: 0, speed: 1 } }); voiceView(); } catch (e) { showErr(vm, e); }
  };
  const play = document.getElementById("vplay");
  if (play) play.onclick = async () => {
    const out = document.getElementById("vtake");
    try {
      play.disabled = true;
      await api("PUT", "/api/voice/me", { settings: vals() });
      out.innerHTML = loading("Saying it in your voice");
      const text = document.getElementById("vtest").value.replace(/\*\*/g, "");
      emitCall({ type: "start", stage: "voice", model: "elevenlabs" });
      let r;
      try { r = await api("POST", "/api/voice/speak", { text }); } finally { emitCall({ type: "end", stage: "voice", model: "elevenlabs" }); }
      const bytes = Uint8Array.from(atob(r.audio), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
      out.innerHTML = `<audio controls autoplay src="${url}"></audio>`;
      document.getElementById("vcost").textContent = `${r.chars} characters · ${money(r.costUsd, 4)}`;
    } catch (e) { showErr(out, e); } finally { play.disabled = false; }
  };
}

// The audio tools on a video: enhancement, false-start cuts, and (if turned on) AI-voice fixes.
function audioPanels(job) {
  cleanupPanel(job, document.getElementById("cleanbox"));
  patchPanel(job, document.getElementById("patchbox"));
}
const editsSaver = (job) => (state) => api("PATCH", `/api/jobs/${job.id}`, { state });
const afterEdit = async (job) => { (await pipeline()).forgetAudio(job.id); jobView(job.id, true); };

async function cleanupPanel(job, host) {
  if (!host || !(job.state.chunks || []).length) return;
  if (!(await getFile(`audio:${job.id}`))) return;
  const enhance = job.state.enhance !== false;
  host.innerHTML = `<div class="card clean"><h3>Audio</h3>
    <label class="switch big"><input type="checkbox" id="enh" ${enhance ? "checked" : ""}><span><b>Enhance audio</b>
      <span class="muted">(lowers background noise and hum, trims boominess, adds clarity, softens harsh “s” sounds and evens out the volume; applied when the video is rendered)</span></span></label>
    <div class="actions"><button class="secondary small-btn" id="enhpv">Compare before and after</button><span id="enhout"></span></div>
    <h4>False starts</h4><div id="fs">${loading("Listening for restarts")}</div><div id="fsm"></div></div>`;
  const save = editsSaver(job);
  host.querySelector("#enh").onchange = async (ev) => {
    const state = { enhance: ev.target.checked, ...(job.status === "done" ? { patchedAfterRender: true } : {}) };
    Object.assign(job.state, state);
    await save(state);
    if (job.status === "done") jobView(job.id, true);
  };
  host.querySelector("#enhpv").onclick = async (ev) => {
    const out = host.querySelector("#enhout");
    ev.target.disabled = true;
    out.innerHTML = loading("Making a 12-second sample");
    try {
      const file = await getFile(`audio:${job.id}`);
      const c = job.state.chunks.find((x) => x.end - x.start > 6) || job.state.chunks[0];
      const { before, after } = await (await pipeline()).enhancePreview(file, Math.max(0, c.start - 0.3), 12);
      out.innerHTML = `<span class="pvpair"><span class="small">Before</span> <audio controls src="${URL.createObjectURL(before)}"></audio>
        <span class="small">After</span> <audio controls src="${URL.createObjectURL(after)}"></audio></span>`;
    } catch (e) { showErr(out, e); }
    ev.target.disabled = false;
  };
  const fsBox = host.querySelector("#fs"), fsm = host.querySelector("#fsm");
  let list;
  try { list = await (await patchMod()).findFalseStarts(job); } catch (e) { showErr(fsBox, e); return; }
  const kept = new Set(job.state.keptStarts || []);
  const keyOf = (f) => `${job.state.chunks[f.i].id}:${f.cut}`;
  list = list.filter((f) => !kept.has(keyOf(f)));
  const cuts = (job.state.patches || []).filter((p) => p.kind === "cut").flatMap((p) => p.cuts);
  const P = await patchMod();
  fsBox.innerHTML = `${list.length ? `<p class="small muted">Places where you stopped and restarted. Listen, then cut the abandoned words: only that bit of audio is removed, and the captions follow. Nothing is re-generated.</p>
      <div class="plist">${list.map((f, k) => {
        const c = job.state.chunks[f.i];
        return `<div class="fsrow" data-k="${k}"><span class="t">${fmtT(f.a)}</span>
          <span class="txt">Cut <b>“${esc(f.cut)}”</b> from “${esc(String(c.caption ?? c.text).slice(0, 110))}${String(c.caption ?? c.text).length > 110 ? "…" : ""}”
            <span class="small muted">${esc(f.why)} · <span class="len">${(f.b - f.a).toFixed(1)}</span> s${f.unplaced ? " · couldn't find these exact words, so the cut is a guess: listen and adjust it" : f.approx ? " · position estimated, listen first" : ""}</span>
            <span class="adj small" ${f.unplaced ? "" : "hidden"}>Cut from <input type="number" step="0.05" min="0" data-ab="a" value="${f.a.toFixed(2)}" aria-label="Cut start in seconds">
              to <input type="number" step="0.05" min="0" data-ab="b" value="${f.b.toFixed(2)}" aria-label="Cut end in seconds"> seconds into the recording</span>
            <span class="pv"></span></span>
          <span class="btns"><button class="secondary small-btn" data-act="listen">Listen</button><button class="small-btn" data-act="cut">Cut</button>
            <button class="link" data-act="adjust">Adjust</button><button class="link" data-act="keep">Keep</button></span></div>`;
      }).join("")}</div>
      ${list.length > 1 ? `<div class="actions"><button class="secondary" id="cutall">Cut all ${list.length}</button></div>` : ""}`
    : `<p class="small muted">No false starts found${cuts.length ? " (any more)" : ""}.</p>`}
    ${cuts.length ? `<p class="small">Cut so far: ${cuts.map((c) => `“${esc(c.cut)}”`).join(", ")}. <button class="link" id="undocuts">Undo all edits</button></p>` : ""}`;
  fsBox.querySelectorAll(".fsrow").forEach((row) => {
    const f = list[Number(row.dataset.k)];
    row.querySelector('[data-act="adjust"]').onclick = () => { const a = row.querySelector(".adj"); a.hidden = !a.hidden; };
    row.querySelectorAll("[data-ab]").forEach((inp) => (inp.oninput = () => {
      const v = Number(inp.value);
      if (!isFinite(v)) return;
      f[inp.dataset.ab] = v;
      row.querySelector(".len").textContent = Math.max(0, f.b - f.a).toFixed(2);
      row.querySelector(".pv").innerHTML = "";
      row.querySelector('[data-act="listen"]').disabled = false;
    }));
    row.querySelector('[data-act="listen"]').onclick = async (ev) => {
      if (!(f.b - f.a > 0.02)) { showErr(fsm, new Error("The end of the cut has to come after its start.")); return; }
      ev.target.disabled = true;
      try {
        const { before, after } = await P.cutPreview(job, f);
        row.querySelector(".pv").innerHTML = `<span class="pvpair"><span class="small">Now</span> <audio controls src="${before}"></audio>
          <span class="small">With the cut</span> <audio controls src="${after}"></audio></span>`;
      } catch (e) { showErr(fsm, e); }
    };
    row.querySelector('[data-act="cut"]').onclick = async (ev) => {
      ev.target.disabled = true;
      try { await P.applyCuts(job, [f], save); await afterEdit(job); } catch (e) { ev.target.disabled = false; showErr(fsm, e); }
    };
    row.querySelector('[data-act="keep"]').onclick = async () => {
      const keptStarts = [...kept, keyOf(f)];
      job.state.keptStarts = keptStarts;
      await save({ keptStarts });
      cleanupPanel(job, host);
    };
  });
  const all = fsBox.querySelector("#cutall");
  if (all) all.onclick = async () => {
    if (!confirm(`Cut all ${list.length} false starts? You can undo this.`)) return;
    all.disabled = true;
    try { await P.applyCuts(job, list, save); await afterEdit(job); } catch (e) { all.disabled = false; showErr(fsm, e); }
  };
  const undo = fsBox.querySelector("#undocuts");
  if (undo) undo.onclick = async () => {
    if (!confirm("Put back your original recording and transcript? Every cut and every AI-voice fix is undone.")) return;
    try { await P.undoAll(job, save); await afterEdit(job); } catch (e) { showErr(fsm, e); }
  };
}

// "Fix a line" panel shown on a video when the person's voice is on and ready.
async function patchPanel(job, host) {
  if (!host) return;
  let v;
  try { v = await api("GET", "/api/voice/me"); } catch { return; }
  if (!(v.available && v.voice.enabled && v.voice.hasVoice && v.voice.status === "ready")) return;
  const chunks = job.state.chunks || [];
  if (!chunks.length) return;
  const patches = job.state.patches || [];
  const per = (n) => (n / 1000) * v.pricePer1kChars;
  const line = (c) => String(c.caption ?? c.text ?? "").replace(/\s+/g, " ").trim();
  host.innerHTML = `<details class="card patch" ${patchOpen.has(job.id) ? "open" : ""}><summary><b>Fix a line with your AI voice</b>
      <span class="muted">— re-say a sentence without re-recording${(() => { const n = patches.filter((p) => p.kind !== "cut").length; return n ? ` · ${n} line${n > 1 ? "s" : ""} fixed` : ""; })()}</span></summary>
    <p class="small muted">Choose the line, type what you meant to say, and pick the best of three takes. Each line is cut at the pauses around it, so keep the fix to the same sentence. Three takes of a typical sentence cost about ${money(per(3 * 110), 3)}.</p>
    ${patches.some((p) => p.kind !== "cut") ? `<p class="small">Fixed so far: ${patches.filter((p) => p.kind !== "cut").map((p) => `“${esc(p.to)}”`).join("; ")}. <button class="link" id="undoall">Undo all edits</button></p>` : ""}
    <div class="plist">${chunks.map((c, i) => `<div class="pline ${c.patched ? "patched" : ""}" data-i="${i}">
      <span class="t">${fmtT(c.start)}</span><span class="txt">${esc(line(c))}${c.patched ? ' <span class="pill">AI voice</span>' : ""}</span>
      <button class="secondary small-btn" data-fix="${i}">Fix this line</button></div>`).join("")}</div>
    <div id="peditor"></div><div id="pm"></div></details>`;
  const details = host.querySelector("details");
  details.ontoggle = () => (details.open ? patchOpen.add(job.id) : patchOpen.delete(job.id));
  const pm = host.querySelector("#pm");
  const save = (state) => api("PATCH", `/api/jobs/${job.id}`, { state });
  const after = async () => { (await pipeline()).forgetAudio(job.id); patchOpen.add(job.id); jobView(job.id, true); };
  const undo = host.querySelector("#undoall");
  if (undo) undo.onclick = async () => {
    if (!confirm("Put back your original recording and transcript? Every fixed line and every cut goes back to how you recorded it.")) return;
    try { await (await patchMod()).undoAll(job, save); await after(); } catch (e) { showErr(pm, e); }
  };
  host.querySelectorAll("[data-fix]").forEach((b) => (b.onclick = async () => {
    const i = Number(b.dataset.fix), c = chunks[i];
    host.querySelectorAll(".pline").forEach((p) => p.classList.toggle("on", Number(p.dataset.i) === i));
    const ed = host.querySelector("#peditor");
    const P = await patchMod();
    ed.innerHTML = `<div class="sub"><div class="eyebrow">Line at ${fmtT(c.start)}</div>
      <p>${esc(line(c))}</p><div id="orig">${loading("Loading your recording")}</div>
      <label>What it should say <span class="muted">(write numbers and symbols the way you'd say them)</span>
        <textarea id="ptext" rows="3" maxlength="600">${esc(line(c))}</textarea></label>
      <div class="actions"><button id="ptakes">Make 3 takes</button><span class="small muted" id="pest"></span><button class="link" id="pclose">Close</button>${lightsHtml()}</div>
      <div id="takes"></div></div>`;
    const ta = ed.querySelector("#ptext"), est = ed.querySelector("#pest");
    const upd = () => (est.textContent = `about ${money(per(3 * ta.value.trim().length), 4)}`);
    ta.oninput = upd; upd();
    ed.querySelector("#pclose").onclick = () => { ed.innerHTML = ""; host.querySelectorAll(".pline").forEach((p) => p.classList.remove("on")); };
    try { ed.querySelector("#orig").innerHTML = `<audio controls src="${await P.lineClip(job, i)}"></audio> <span class="small muted">how it sounds now</span>`; }
    catch (e) { showErr(ed.querySelector("#orig"), e); }
    ed.querySelector("#ptakes").onclick = async () => {
      const text = ta.value.replace(/\s+/g, " ").trim();
      const box = ed.querySelector("#takes"), btn = ed.querySelector("#ptakes");
      if (!text) return;
      btn.disabled = true;
      box.innerHTML = "";
      const takes = [];
      try {
        for (let k = 0; k < 3; k++) {
          box.insertAdjacentHTML("beforeend", `<div class="take" id="take-${k}">${loading(`Take ${k + 1} of 3`)}</div>`);
          const t = await P.makeTake(job, i, text);
          takes.push(t);
          box.querySelector(`#take-${k}`).innerHTML = `<b>Take ${k + 1}</b> <audio controls src="${t.url}"></audio>
            <span class="small muted">${t.seconds.toFixed(1)} s</span> <button class="secondary small-btn" data-use="${k}">Use this take</button>`;
          const jc = document.getElementById("jobcost"); if (jc) jc.textContent = money(job.costUsd);
        }
      } catch (e) { showErr(pm, e); }
      btn.disabled = false; btn.textContent = "Make 3 more";
      box.querySelectorAll("[data-use]").forEach((u) => (u.onclick = async () => {
        u.disabled = true;
        try {
          await P.applyTake(job, i, takes[Number(u.dataset.use)], text, save);
          await after();
        } catch (e) { u.disabled = false; showErr(pm, e); }
      }));
    };
  }));
}

boot().catch((e) => { $app.innerHTML = `<div class="err">${esc(e.message)}</div>`; });
