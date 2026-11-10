// Runs the pipeline stages for one video. UI-agnostic: reports through `ui` callbacks.
import { api, claude } from "../api.js";
import { getFile, putFile } from "../idb.js";
import { decodeFile, toMono16k, speechChunks, slice } from "./audio.js";
import { loadASR, transcribeRemote, chunksFromWords, buildKeyterms } from "./asr.js";
import * as P from "./prompts.js";
import { checkSpec } from "./spec.js";
import { renderAllBuilds, loadLogo, loadFonts, loadMathJax } from "./render.js";
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
      ui.step(`Transcribing (${i + 1} of ${chunks.length})`);
      ui.progress(i / chunks.length, "Transcribing");
      chunks[i].text = await transcribe(slice(samples, chunks[i].start, chunks[i].end));
    }
    ui.progress(1, "Transcribing");
  }
  const spoken = chunks.filter((c) => c.text);
  ui.step("Turning spoken math into LaTeX (Haiku)");
  const r = await claude(job.id, "math-pass", {
    system: P.MATH_PASS, max_tokens: 12000,
    messages: [{ role: "user", content: P.mathPassMessage(spoken, job.state.script) }],
  }, { onStatus: status(ui, "Math pass") });
  const got = new Map(P.parseJSON(r.text).chunks.map((c) => [c.id, c]));
  const merged = spoken.map((c) => ({
    ...c, caption: got.get(c.id)?.caption || c.text, latex: got.get(c.id)?.latex || c.text, flags: got.get(c.id)?.flags || [],
  }));
  await save(job, { status: "review-transcript", state: { chunks: merged, asrProvider } });
}

// ---------- Stage 2: plan slides (Opus) + automatic fixes (Sonnet) ----------
export async function plan(job, ui) {
  await save(job, { status: "planning" });
  await Promise.all([loadFonts(), loadMathJax(), loadLogo()]);
  ui.step("Planning the slides (Opus) — this usually takes 1–3 minutes");
  const r = await claude(job.id, "plan", {
    system: P.PLAN, max_tokens: 16000,
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
    const errors = await checkSpec(spec, job.state.chunks);
    if (!errors.length) return spec;
    if (round === rounds) { ui.warn?.(`Some problems remain after ${rounds} fix rounds:\n• ${errors.join("\n• ")}`); return spec; }
    ui.step(`Fixing ${errors.length} problem${errors.length > 1 ? "s" : ""} (Sonnet)`);
    const r = await claude(job.id, "fix", {
      system: P.FIX, max_tokens: 16000,
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
    system: P.REVISE, max_tokens: 16000,
    messages: [{ role: "user", content: `Comments:\n${text}\n\nTranscript chunks:\n${chunkList(job)}\n\nCurrent spec:\n${JSON.stringify(job.state.spec)}` }],
  }, { onStatus: status(ui, "Revising") });
  let spec = P.parseJSON(r.text);
  spec = await fixLoop(job, spec, ui);
  await save(job, { state: { spec, lastComments: comments } });
  return spec;
}

// ---------- Stage 3: timing, render, outro, final check ----------
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
  const builds = await renderAllBuilds(spec, (p) => ui.progress(p, "Drawing slides"));

  ui.step("Encoding video (keep this tab open)");
  const { video, hasOutro, outroUrl } = await encodeVideo({ builds, times: t, captions: caps, duration,
    onProgress: (p) => ui.progress(p, "Encoding video") });
  if (!hasOutro) ui.warn?.("The Ontario Tech outro clip wasn't found at /assets/OT_Outro_White.mp4, so this video has no outro. Ask an admin to add it.");

  ui.step("Mixing audio and adding the outro");
  const mp4 = await muxAudio({ video, audioFile: file, audioStart: lessonStart, duration, hasOutro, outroUrl,
    onProgress: (p) => ui.progress(p, "Mixing audio") });
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

  const name = `${job.title.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}_OntarioTech`;
  await putFile(`mp4:${job.id}`, mp4);
  await putFile(`srt:${job.id}`, new Blob([srt], { type: "application/x-subrip" }));
  await save(job, { status: "done", state: { output: { name, duration: duration + 7.2, sizeBytes: mp4.size, renderedAt: new Date().toISOString(), flags, times: t } } });
  return { mp4, srt, name, flags };
}

// Thumbnails of every build for Checkpoint B (data URLs).
export async function thumbnails(job, width = 640) {
  await Promise.all([loadFonts(), loadMathJax(), loadLogo()]);
  const spec = { ...job.state.spec, stream: job.stream };
  const builds = await renderAllBuilds(spec);
  const out = [];
  for (const b of builds) out.push({ scene: b.scene, build: b.build, errors: b.errors, src: await stillAt({ bitmap: b.bitmap, width }) });
  return out;
}
