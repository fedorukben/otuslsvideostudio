// Runs the pipeline stages for one video. UI-agnostic: reports through `ui` callbacks.
import { api, claude } from "../api.js";
import { getFile, putFile } from "../idb.js";
import { decodeFile, toMono16k, speechChunks, slice } from "./audio.js";
import { loadASR, transcribeRemote, chunksFromWords, buildKeyterms } from "./asr.js";
import * as P from "./prompts.js";
import { checkSpec } from "./spec.js";
import { renderAllBuilds, loadLogo, loadFonts, loadMathJax } from "./render.js";
import { approxTimes } from "./timing.js";
import { buildTimes, buildCaptions, toSrt } from "./timing.js";
import { encodeVideo, muxAudio, stillAt } from "./encode.js";

const audioCache = new Map();
async function audioFor(job) {
  if (audioCache.has(job.id)) return audioCache.get(job.id);
  const file = await getFile(`audio:${job.id}`);
  if (!file) throw new Error("The narration file isn't stored in this browser. Open this video on the computer you uploaded it from, or re-attach the audio.");
  const buffer = await decodeFile(file);
  const samples = await toMono16k(buffer);
  const a = { file, buffer, samples, duration: buffer.duration };
  audioCache.set(job.id, a);
  return a;
}
export const forgetAudio = (jobId) => audioCache.delete(jobId);
export { makeTake, applyTake, undoAll, lineClip } from "./patch.js";
export { enhancePreview } from "./encode.js";

async function save(job, patch) {
  Object.assign(job, patch.title ? { title: patch.title } : {}, patch.status ? { status: patch.status } : {});
  if (patch.state) job.state = { ...job.state, ...patch.state };
  await api("PATCH", `/api/jobs/${job.id}`, patch);
}

const status = (ui, stage) => (st, sec) => ui.step?.(`${stage} — Claude is ${st === "running" ? "working" : st} (${sec}s)`);

// ---------- Stage 1: analyse (audio prep, Whisper, math pass) ----------
export async function analyse(job, ui, asrModel, asrProvider = "browser") {
  await save(job, { status: "analysing" });
  ui.step("Reading your audio");
  const { samples, file, duration } = await audioFor(job);
  let chunks;
  if (asrProvider === "assemblyai") {
    ui.step("Uploading your audio to AssemblyAI");
    const r = await transcribeRemote(job.id, file, {
      durationSec: duration, keyterms: buildKeyterms(job),
      onProgress: (p) => ui.progress(p, "Uploading"),
      onStatus: (st, sec) => ui.step(`Transcribing with AssemblyAI (${st === "running" ? "working" : st}, ${sec}s)`),
    });
    if (!r.words?.length) throw new Error("AssemblyAI didn't find any speech in the recording.");
    chunks = chunksFromWords(r.words);
  } else {
    chunks = speechChunks(samples);
    if (!chunks.length) throw new Error("No speech found in the recording. Is it very quiet?");
    ui.step("Loading the speech model (first time only: about 250 MB)");
    const transcribe = await loadASR(asrModel, (p) => ui.progress(p, "Downloading speech model"));
    for (let i = 0; i < chunks.length; i++) {
      ui.step(`Transcribing (${i + 1} of ${chunks.length})${i === 0 ? " — the first piece is the slowest" : ""}`);
      ui.progress(i / chunks.length, "Transcribing");
      chunks[i].text = await transcribe(slice(samples, chunks[i].start, chunks[i].end));
    }
    ui.progress(1, "Transcribing");
  }
  const spoken = chunks.filter((c) => c.text);
  ui.step("Turning spoken math into LaTeX (Haiku)");
  const got = await mathPass(job, spoken, ui);
  const merged = spoken.map((c) => ({
    ...c, caption: got.get(c.id)?.caption || c.text, latex: got.get(c.id)?.latex || c.text, flags: got.get(c.id)?.flags || [],
  }));
  await save(job, { status: "review-transcript", state: { chunks: merged, asrProvider } });
}

// The math pass, in batches small enough that a reply is never cut off. A batch whose reply is cut off
// or isn't valid JSON is split in half and tried again; a single chunk that still fails keeps its plain text.
async function mathPass(job, spoken, ui, size = 15) {
  const got = new Map();
  const batches = [];
  for (let i = 0; i < spoken.length; i += size) batches.push(spoken.slice(i, i + size));
  let done = 0;
  const run = async (batch) => {
    let parsed = null;
    try {
      const r = await claude(job.id, "math-pass", {
        system: P.MATH_PASS, max_tokens: 16000,
        messages: [{ role: "user", content: P.mathPassMessage(batch, job.state.script) }],
      }, { onStatus: status(ui, "Math pass") });
      if (r.stopReason !== "max_tokens") parsed = P.parseJSON(r.text);
    } catch (e) {
      if (!/JSON|Unexpected|end of data|expected/i.test(e.message)) throw e; // real failures (caps, network) stop here
    }
    if (parsed?.chunks) { for (const c of parsed.chunks) got.set(c.id, c); done++; return; }
    if (batch.length > 1) {
      const h = Math.ceil(batch.length / 2);
      await run(batch.slice(0, h));
      await run(batch.slice(h));
      return;
    }
    ui.warn?.(`The math pass couldn't read one line (at ${Math.round(batch[0].start)} s), so it keeps the plain transcript. Check it at Checkpoint A.`);
  };
  // up to three batches at a time
  const queue = [...batches];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length) await run(queue.shift()); }));
  return got;
}

// ---------- Stage 2: plan slides (Opus) + automatic fixes (Sonnet) ----------
export async function plan(job, ui) {
  await save(job, { status: "planning" });
  await Promise.all([loadFonts(), loadMathJax(), loadLogo()]);
  ui.step("Planning the slides (Opus) — this usually takes 1–3 minutes");
  const r = await claude(job.id, "plan", {
    system: P.PLAN, max_tokens: job.state.advancedMode === "off" ? 16000 : 24000,
    messages: [{ role: "user", content: P.planMessage(job, job.state.chunks) }],
  }, { onStatus: status(ui, "Slide planning") });
  let spec = P.parseJSON(r.text);
  spec = await fixLoop(job, spec, ui);
  await save(job, { status: "review-slides", state: { spec } });
  return spec;
}

export async function fixLoop(job, spec, ui, rounds = 3) {
  spec.stream = job.stream;
  for (let round = 0; round <= rounds; round++) {
    ui.step(round ? `Checking the fixed slides (round ${round})` : "Checking every slide (LaTeX, layout, timing)");
    const errors = await checkSpec(spec, job.state.chunks, { allowAdvanced: job.state.advancedMode !== "off" && job.allowAdvanced !== false });
    if (!errors.length) return spec;
    if (round === rounds) { ui.warn?.(`Some problems remain after ${rounds} fix rounds:\n• ${errors.join("\n• ")}`); return spec; }
    ui.step(`Fixing ${errors.length} problem${errors.length > 1 ? "s" : ""} (Sonnet)`);
    const r = await claude(job.id, "fix", {
      system: P.FIX, max_tokens: 24000,
      messages: [{ role: "user", content: `Problems:\n- ${errors.join("\n- ")}\n\nTranscript chunks:\n${chunkList(job)}\n\nSpec:\n${JSON.stringify(spec)}` }],
    }, { onStatus: status(ui, "Fixing slides") });
    spec = { ...P.parseJSON(r.text), stream: job.stream };
  }
  return spec;
}
const chunkList = (job) => job.state.chunks.map((c) => `[${c.id}] ${c.caption}`).join("\n");

// ---------- Checkpoint B helper: apply comments (Sonnet) ----------
export async function revise(job, comments, ui) {
  ui.step("Applying your comments (Sonnet)");
  const text = Object.entries(comments.scenes || {}).filter(([, v]) => v.trim()).map(([k, v]) => `Scene ${Number(k) + 1}: ${v}`).join("\n")
    + (comments.general?.trim() ? `\nGeneral: ${comments.general}` : "");
  const r = await claude(job.id, "revise", {
    system: P.REVISE, max_tokens: 24000,
    messages: [{ role: "user", content: `ADVANCED SCENES: ${P.advancedRule(job)}\n\nComments:\n${text}\n\nTranscript chunks:\n${chunkList(job)}\n\nCurrent spec:\n${JSON.stringify(job.state.spec)}` }],
  }, { onStatus: status(ui, "Revising") });
  let spec = P.parseJSON(r.text);
  spec = await fixLoop(job, spec, ui);
  await save(job, { state: { spec, lastComments: comments } });
  return spec;
}

// ---------- Stage 3: timing, render, outro, final check ----------
// Finished videos kept in memory too, in case this browser won't store them (private windows, full storage).
export const outputs = new Map();
const stepRun = async (label, fn) => {
  try { return await fn(); }
  catch (e) { console.error(label, e); throw new Error(`${label} failed: ${e?.message || e}`); }
};

export async function render(job, ui, asrModel) {
  await save(job, { status: "rendering" });
  const spec = { ...job.state.spec, stream: job.stream };
  const { file, samples, duration: audioDur } = await audioFor(job);
  const chunks = job.state.chunks;

  ui.step("Matching each slide to your narration");
  let transcribe = null;
  const hasWords = chunks.every((c) => Array.isArray(c.words) && c.words.length);
  if (!hasWords) {
    try { transcribe = await loadASR(asrModel, (p) => ui.progress(p, "Loading speech model")); } catch { /* fall back to estimates */ }
  }
  const times = await buildTimes({ spec, chunks, samples, transcribe, onProgress: (p) => ui.progress(p, "Timing") });

  const lessonStart = Math.max(0, chunks[0].start - 0.5);
  const lessonEnd = Math.min(audioDur, chunks.at(-1).end + 1.2);
  const duration = lessonEnd - lessonStart;
  const capsRaw = buildCaptions(chunks);
  const caps = capsRaw.map((c) => ({ ...c, start: c.start - lessonStart, end: c.end - lessonStart }));
  const t = times.map((x) => Math.max(0, x - lessonStart));
  t[0] = 0;

  ui.step("Drawing slides");
  await Promise.all([loadFonts(), loadMathJax(), loadLogo()]);
  const builds = await renderAllBuilds(spec, (p) => ui.progress(p, "Drawing slides"), { times: t });

  ui.step("Encoding video (keep this tab open)");
  const { video, hasOutro, outroUrl } = await stepRun("Encoding video", () => encodeVideo({ builds, times: t, captions: caps, duration,
    onProgress: (p) => ui.progress(p, "Encoding video") }));
  if (!hasOutro) ui.warn?.("The Ontario Tech outro clip wasn't found at /assets/OT_Outro_White.mp4, so this video has no outro. Ask an admin to add it.");

  ui.step("Mixing audio and adding the outro");
  const mp4 = await stepRun("Mixing audio", () => muxAudio({ video, audioFile: file, audioStart: lessonStart, duration, hasOutro, outroUrl, enhance: job.state.enhance !== false,
    onProgress: (p) => ui.progress(p, "Mixing audio") }));
  const srt = toSrt(capsRaw, lessonStart);

  // Final check: one still just after each build change, with what's being said then.
  ui.step("Final check of key frames (Haiku)");
  let flags = [];
  try {
    const picks = builds.map((b, i) => i).filter((i) => i > 0).slice(0, 12);
    const content = [];
    for (const [n, i] of picks.entries()) {
      const at = t[i] + 1.0;
      const said = caps.filter((c) => c.end > at - 2 && c.start < at + 6).map((c) => c.text).join(" ");
      const cap = caps.find((c) => c.start <= at && at < c.end)?.text;
      const img = await stillAt({ bitmap: builds[i].bitmap, caption: cap, width: 960 });
      content.push({ type: "text", text: `Frame ${n} (scene ${builds[i].scene + 1}, build ${builds[i].build + 1}) — narration: "${said}"` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.split(",")[1] } });
    }
    if (content.length) {
      const r = await claude(job.id, "frame-check", { system: P.FRAME_CHECK, max_tokens: 2000,
        messages: [{ role: "user", content }] }, { onStatus: status(ui, "Final check") });
      flags = (P.parseJSON(r.text).frames || []).filter((f) => !f.ok).map((f) => ({ ...f, build: picks[f.index] }));
    }
  } catch (e) { ui.warn?.("The final frame check didn't run: " + e.message); }

  builds.dispose?.();
  const name = `${job.title.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}_OntarioTech`;
  const srtBlob = new Blob([srt], { type: "application/x-subrip" });
  outputs.set(job.id, { mp4, srt: srtBlob });
  try {
    await putFile(`mp4:${job.id}`, mp4);
    await putFile(`srt:${job.id}`, srtBlob);
  } catch (e) {
    ui.warn?.("This browser wouldn't store the finished video (a private window or full storage?). Download it now from this page; it will be gone if you reload.");
  }
  await stepRun("Saving the result", () => save(job, { status: "done", state: { patchedAfterRender: false, output: { name, duration: duration + 7.2, sizeBytes: mp4.size, renderedAt: new Date().toISOString(), flags, times: t } } }));
  return { mp4, srt, name, flags };
}

// Thumbnails of every build for Checkpoint B (data URLs), plus the prepared builds for scene previews.
let previewBuilds = null;
export async function thumbnails(job, width = 640) {
  await Promise.all([loadFonts(), loadMathJax(), loadLogo()]);
  const spec = { ...job.state.spec, stream: job.stream };
  previewBuilds?.dispose?.();
  const times = approxTimes(spec, job.state.chunks || []);
  const builds = await renderAllBuilds(spec, null, { times });
  previewBuilds = Object.assign(builds, { times });
  const out = [];
  for (const b of builds) out.push({ scene: b.scene, build: b.build, errors: b.errors, src: await stillAt({ bitmap: b.bitmap, width }) });
  return out;
}

// Plays one scene (with its animations) into a canvas, using estimated timings. Returns a stop function.
export function playScene(canvas, sceneIdx, onDone) {
  const builds = previewBuilds;
  if (!builds) return () => {};
  const idx = builds.map((b, i) => i).filter((i) => builds[i].scene === sceneIdx);
  const t0 = builds.times[idx[0]];
  const end = idx.at(-1) + 1 < builds.length ? builds.times[idx.at(-1) + 1] : builds.times[idx.at(-1)] + 4;
  const dur = Math.max(2, end - t0);
  const ctx = canvas.getContext("2d");
  const start = performance.now();
  let stop = false, busy = false;
  const tick = async () => {
    if (stop) return;
    const t = t0 + (performance.now() - start) / 1000;
    if (t > t0 + dur) { onDone?.(); return; }
    if (!busy) {
      busy = true;
      let b = idx[0];
      while (b + 1 <= idx.at(-1) && builds.times[b + 1] <= t) b++;
      const off = new OffscreenCanvas(1920, 1080);
      const octx = off.getContext("2d");
      try {
        const { drawLessonFrame } = await import("./encode.js");
        // within a preview, don't crossfade from the previous scene
        const view = Object.assign([...builds], { drawMorph: builds.drawMorph, drawAdvanced: builds.drawAdvanced });
        if (b === idx[0]) view[b] = { ...builds[b], transition: { kind: "cut", dur: 0 } };
        await drawLessonFrame(octx, view, builds.times, b, t, t - builds.times[b]);
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
      } catch (e) { console.error(e); }
      busy = false;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => { stop = true; };
}
