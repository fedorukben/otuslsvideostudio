// Voice patching: replace one line (a transcript chunk) of the narration with a take in the person's AI voice.
// Everything happens in this browser: the narration is decoded, the line is cut out at the pauses around it,
// the chosen take is level-matched and spliced in, and the result is saved as the video's audio (WAV).
// The original recording is kept so every patch can be undone.
import { api, costListeners } from "../api.js";
import { getFile, putFile, delFile } from "../idb.js";

const SR = 48000;
const FADE = 0.008;   // seconds of fade at each join
const PAD = 0.03;     // silence kept around a trimmed take

// ---------- audio helpers ----------
async function decodeMono(blobOrBuf) {
  const buf = blobOrBuf instanceof ArrayBuffer ? blobOrBuf : await blobOrBuf.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, SR);
  const ab = await ctx.decodeAudioData(buf.slice(0));
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return out;
}

export function wavBlob(pcm, sr = SR) {
  const data = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); data.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, sr, true);
  data.setUint32(28, sr * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true); str(36, "data");
  data.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([data.buffer], { type: "audio/wav" });
}

// Level per 10 ms frame (dBFS).
function frames(pcm) {
  const step = SR / 100, n = Math.floor(pcm.length / step), db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * step; j < (i + 1) * step; j++) s += pcm[j] * pcm[j];
    db[i] = 10 * Math.log10(s / step + 1e-12);
  }
  return db;
}
const speechRms = (pcm) => {
  const db = frames(pcm);
  const peak = Math.max(...db);
  const loud = [...db].filter((d) => d > peak - 25);
  if (!loud.length) return 1e-6;
  return Math.sqrt(loud.reduce((a, d) => a + 10 ** (d / 10), 0) / loud.length);
};

// Cuts leading and trailing silence from a take, keeping a little air.
function trim(pcm) {
  const db = frames(pcm);
  const peak = Math.max(...db);
  const thr = Math.max(-50, peak - 40);
  let a = 0, b = db.length - 1;
  while (a < db.length && db[a] < thr) a++;
  while (b > a && db[b] < thr) b--;
  const s = Math.max(0, Math.floor((a / 100 - PAD) * SR)), e = Math.min(pcm.length, Math.ceil(((b + 1) / 100 + PAD) * SR));
  return pcm.slice(s, e);
}

// The quietest 20 ms point between t0 and t1 (seconds), for a clean cut.
function quietest(pcm, t0, t1) {
  const db = frames(pcm);
  let best = (t0 + t1) / 2, bestV = Infinity;
  for (let i = Math.max(0, Math.floor(t0 * 100)); i <= Math.min(db.length - 2, Math.floor(t1 * 100)); i++) {
    const v = db[i] + db[i + 1];
    if (v < bestV) { bestV = v; best = (i + 1) / 100; }
  }
  return best;
}

function fade(pcm, atStart, atEnd) {
  const n = Math.floor(FADE * SR);
  for (let i = 0; i < n && i < pcm.length; i++) {
    if (atStart) pcm[i] *= i / n;
    if (atEnd) pcm[pcm.length - 1 - i] *= i / n;
  }
  return pcm;
}

// ---------- narration ----------
const cache = new Map();
async function narration(jobId) {
  const file = await getFile(`audio:${jobId}`);
  if (!file) throw new Error("The narration audio isn't stored in this browser. Re-attach it first.");
  const key = `${jobId}:${file.size}:${file.lastModified || ""}:${file.name || ""}`;
  if (cache.get(jobId)?.key === key) return cache.get(jobId);
  const n = { key, file, pcm: await decodeMono(file) };
  cache.set(jobId, n);
  return n;
}

// Where a chunk's audio will be cut: the quietest points in the pauses on either side.
function cutPoints(pcm, chunks, i) {
  const c = chunks[i], dur = pcm.length / SR;
  const prevEnd = i > 0 ? chunks[i - 1].end : 0, nextStart = i + 1 < chunks.length ? chunks[i + 1].start : dur;
  const a = c.start - prevEnd > 0.04 ? quietest(pcm, Math.max(prevEnd, c.start - 0.3), c.start) : c.start;
  const b = nextStart - c.end > 0.04 ? quietest(pcm, c.end, Math.min(nextStart, c.end + 0.3)) : c.end;
  return { a: Math.max(0, a), b: Math.min(dur, b) };
}

// A playable clip of a line as it is now, with `around` seconds of context either side.
export async function lineClip(job, i, around = 0) {
  const { pcm } = await narration(job.id);
  const chunks = job.state.chunks;
  const { a, b } = cutPoints(pcm, chunks, i);
  const s = Math.max(0, Math.floor((a - around) * SR)), e = Math.min(pcm.length, Math.ceil((b + around) * SR));
  return URL.createObjectURL(wavBlob(pcm.slice(s, e)));
}

const lineText = (c) => String(c?.caption ?? c?.text ?? "").replace(/\$[^$]*\$/g, " ").replace(/\s+/g, " ").trim();

// Asks for one take in the person's voice. Returns {url, pcm, seconds, costUsd, chars}.
export async function makeTake(job, i, text) {
  const chunks = job.state.chunks;
  const previousText = chunks.slice(Math.max(0, i - 2), i).map(lineText).join(" ");
  const nextText = chunks.slice(i + 1, i + 2).map(lineText).join(" ");
  const r = await api("POST", "/api/voice/speak", { jobId: job.id, text, previousText, nextText, seed: Math.floor(Math.random() * 1e9) });
  for (const f of costListeners) try { f(job.id, r.costUsd || 0); } catch {}
  job.costUsd = (job.costUsd || 0) + (r.costUsd || 0);
  const bytes = Uint8Array.from(atob(r.audio), (ch) => ch.charCodeAt(0));
  const pcm = trim(await decodeMono(bytes.buffer));
  return { pcm, seconds: pcm.length / SR, url: URL.createObjectURL(wavBlob(pcm)), costUsd: r.costUsd, chars: r.chars };
}

// Saves an edited narration (keeping the untouched recording once) plus the new transcript timings.
async function commit(job, file, out, chunks, record, save) {
  if (!(await getFile(`audio-original:${job.id}`))) await putFile(`audio-original:${job.id}`, file);
  const base = (job.audioName || "narration").replace(/\.[^.]+$/, "");
  await putFile(`audio:${job.id}`, new File([wavBlob(out)], `${base}-edited.wav`, { type: "audio/wav", lastModified: Date.now() }));
  cache.delete(job.id);
  const patches = [...(job.state.patches || []), { ...record, at: new Date().toISOString() }];
  const state = { chunks, patches, ...(job.state.originalChunks ? {} : { originalChunks: job.state.chunks }) };
  if (job.status === "done") state.patchedAfterRender = true;
  Object.assign(job.state, state);
  await save(state);
}

// Moves every chunk after i by delta seconds.
function shiftAfter(chunks, i, delta) {
  for (let k = i + 1; k < chunks.length; k++) {
    chunks[k].start += delta; chunks[k].end += delta;
    chunks[k].words?.forEach((w) => { w.s += delta; w.e += delta; });
  }
}
const copyChunks = (job) => job.state.chunks.map((c) => ({ ...c, words: c.words?.map((w) => ({ ...w })), flags: c.flags?.map((f) => ({ ...f })) }));

// Splices a take in place of chunk i and saves the new narration and transcript timings.
export async function applyTake(job, i, take, text, save) {
  const { pcm, file } = await narration(job.id);
  const chunks = copyChunks(job);
  const { a, b } = cutPoints(pcm, chunks, i);
  const ia = Math.floor(a * SR), ib = Math.ceil(b * SR);

  // Match the take's loudness to the line it replaces.
  const gain = Math.min(3, Math.max(0.3, speechRms(pcm.subarray(ia, ib)) / speechRms(take.pcm)));
  const t = fade(take.pcm.map((x) => x * gain), true, true);
  const before = fade(pcm.slice(0, ia), false, true), after = fade(pcm.slice(ib), true, false);
  const out = new Float32Array(before.length + t.length + after.length);
  out.set(before, 0); out.set(t, before.length); out.set(after, before.length + t.length);

  // Timings: this line now runs for the take's length; everything after moves by the difference.
  const takeSec = t.length / SR, delta = takeSec - (ib - ia) / SR;
  const c = chunks[i];
  const oldText = lineText(c);
  const start = a + PAD, end = a + takeSec - PAD;
  Object.assign(c, { start, end, text, caption: text, latex: text, flags: [], patched: true });
  if (c.words?.length || chunks.some((x) => x.words?.length)) {
    const ws = text.split(/\s+/).filter(Boolean);
    const total = ws.reduce((s, w) => s + w.length + 1, 0);
    let at = start;
    c.words = ws.map((w) => { const d = ((w.length + 1) / total) * (end - start); const o = { w, s: at, e: at + d * 0.9, c: 1 }; at += d; return o; });
  }
  shiftAfter(chunks, i, delta);
  await commit(job, file, out, chunks, { kind: "voice", chunk: c.id, from: oldText, to: text, seconds: +takeSec.toFixed(2) }, save);
  return { delta };
}

// ---------- false starts ----------
const toks = (s) => String(s || "").toLowerCase().replace(/\$[^$]*\$/g, " ").replace(/[^a-z0-9'\- ]+/g, " ").split(/\s+/).filter(Boolean);
const same = (x, y) => x === y || (x.endsWith("-") && x.length > 2 && y.startsWith(x.slice(0, -1)));
// Words that people stumble on and repeat ("the the", "so so"); a repeat of other single words is often on purpose.
const STUMBLE = new Set("a an the and but so to of in on is it it's i i'm we we're you you're this that that's if then when what which there they".split(" "));

// Finds restarts in the transcript: the narrator's own repeats ("so the, so the …"), half words ("deriv- derivative"),
// and the ones the transcript check flagged. Returns [{i, start, len, cut, approx, a, b}] with cut times once located.
export async function findFalseStarts(job) {
  const chunks = job.state.chunks || [];
  const out = [];
  chunks.forEach((c, i) => {
    const t = toks(c.caption ?? c.text);
    const seen = new Set();
    const add = (start, len, why) => {
      if (len < 1 || start < 0 || start + len >= t.length) return; // keep at least the restart
      const key = `${start}:${len}`;
      if (seen.has(key)) return;
      if (out.some((o) => o.i === i && start < o.start + o.len && o.start < start + len)) return;
      seen.add(key);
      out.push({ i, start, len, cut: t.slice(start, start + len).join(" "), why });
    };
    for (const f of c.flags || []) {
      if (f.kind !== "false-start" || !f.cut) continue;
      const ct = toks(f.cut);
      for (let k = 0; k + ct.length <= t.length; k++) if (ct.every((w, j) => w === t[k + j])) { add(k, ct.length, f.note || "Restarted here"); break; }
    }
    for (let k = 0; k < t.length; k++) {
      for (let L = 5; L >= 1; L--) {
        if (k + 2 * L > t.length) continue;
        let ok = true;
        for (let j = 0; j < L; j++) if (!same(t[k + j], t[k + L + j])) { ok = false; break; }
        if (!ok) continue;
        if (L === 1 && !STUMBLE.has(t[k]) && !t[k].endsWith("-")) continue;
        add(k, L, L === 1 ? "Repeated word" : "Restarted the phrase");
        break;
      }
      if (t[k].endsWith("-") && t[k].length > 2 && !out.some((o) => o.i === i && k >= o.start && k < o.start + o.len)) add(k, 1, "Half-finished word");
    }
  });
  if (!out.length) return out;
  const { pcm } = await narration(job.id);
  for (const f of out) Object.assign(f, locate(pcm, chunks, f));
  return out.filter((f) => f.b - f.a > 0.08).sort((x, y) => x.a - y.a);
}

// Where to cut: from the start of the abandoned words to the start of the restart.
function locate(pcm, chunks, f) {
  const c = chunks[f.i], t = toks(c.caption ?? c.text);
  const prevEnd = f.i > 0 ? chunks[f.i - 1].end : 0;
  // With word timings (AssemblyAI) the cut is exact, as long as the caption still matches the words.
  if (c.words?.length) {
    const tw = [];
    c.words.forEach((w, wi) => toks(w.w).forEach(() => tw.push(wi)));
    if (tw.length === t.length) {
      const w0 = c.words[tw[f.start]], w1 = c.words[tw[f.start + f.len]];
      const a = quietest(pcm, Math.max(prevEnd, w0.s - 0.12), w0.s + 0.02);
      const b = quietest(pcm, Math.max(a + 0.05, w1.s - 0.15), w1.s);
      return { a, b, approx: false };
    }
  }
  // Otherwise estimate from the words' place in the line and snap to the nearest short pause.
  const chars = (n) => t.slice(0, n).join(" ").length + (n ? 1 : 0);
  const total = t.join(" ").length || 1;
  const at = (n) => c.start + (chars(n) / total) * (c.end - c.start);
  const pauses = shortPauses(pcm, c.start - 0.3, c.end);
  const snap = (x, lo) => {
    const p = pauses.filter((q) => q.mid > lo).sort((p1, p2) => Math.abs(p1.mid - x) - Math.abs(p2.mid - x))[0];
    return p && Math.abs(p.mid - x) < 0.8 ? p.mid : x;
  };
  const a = f.start === 0 ? quietest(pcm, Math.max(prevEnd, c.start - 0.25), c.start) : snap(at(f.start), c.start - 0.3);
  const b = snap(at(f.start + f.len), a + 0.1);
  return { a, b, approx: true };
}
function shortPauses(pcm, t0, t1) {
  const db = frames(pcm), out = [];
  let s = null;
  for (let i = Math.max(0, Math.floor(t0 * 100)); i <= Math.min(db.length, Math.ceil(t1 * 100)); i++) {
    const quiet = i < db.length && db[i] < -36;
    if (quiet && s === null) s = i;
    if (!quiet && s !== null) { if (i - s >= 8) out.push({ start: s / 100, end: i / 100, mid: (s + i) / 200 }); s = null; }
  }
  return out;
}

function cutPcm(pcm, a, b) {
  const ia = Math.floor(a * SR), ib = Math.ceil(b * SR);
  const before = fade(pcm.slice(0, ia), false, true), after = fade(pcm.slice(ib), true, false);
  const out = new Float32Array(before.length + after.length);
  out.set(before, 0); out.set(after, before.length);
  return out;
}

// Before/after clips (a couple of seconds either side) so the cut can be checked by ear.
export async function cutPreview(job, f, around = 1.5) {
  const { pcm } = await narration(job.id);
  const s = Math.max(0, f.a - around), e = Math.min(pcm.length / SR, f.b + around);
  const clip = pcm.slice(Math.floor(s * SR), Math.ceil(e * SR));
  return {
    before: URL.createObjectURL(wavBlob(clip)),
    after: URL.createObjectURL(wavBlob(cutPcm(clip, f.a - s, f.b - s))),
  };
}

// Removes one false start (or several, applied from the end so earlier times stay valid).
export async function applyCuts(job, list, save) {
  const { pcm, file } = await narration(job.id);
  const chunks = copyChunks(job);
  let out = pcm;
  const done = [];
  for (const f of [...list].sort((x, y) => y.a - x.a)) {
    const c = chunks[f.i], d = f.b - f.a;
    out = cutPcm(out, f.a, f.b);
    const t = toks(c.caption ?? c.text);
    const words = t.slice(f.start, f.start + f.len);
    // Remove the abandoned words from the caption, math version and plain text.
    const re = new RegExp(`(^|[^A-Za-z0-9'])${words.map((w) => w.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("[^A-Za-z0-9']+")}[\\s,.;:\u2014\u2013-]*`, "i");
    for (const k of ["caption", "text", "latex"]) if (typeof c[k] === "string") c[k] = c[k].replace(re, "$1").replace(/^\s*([a-z])/, (m, x) => (f.start === 0 ? x.toUpperCase() : m)).trim();
    if (c.words?.length) {
      const tw = [];
      c.words.forEach((w, wi) => toks(w.w).forEach(() => tw.push(wi)));
      if (tw.length === t.length) {
        const w0 = tw[f.start], w1 = tw[f.start + f.len];
        c.words.splice(w0, w1 - w0);
        for (let k = w0; k < c.words.length; k++) { c.words[k].s -= d; c.words[k].e -= d; }
      }
    }
    if (f.start === 0) c.start = Math.max(f.a, c.start - d);
    c.end -= d;
    c.flags = (c.flags || []).filter((x) => !(x.kind === "false-start" && toks(x.cut).join(" ") === f.cut));
    shiftAfter(chunks, f.i, -d);
    done.push({ chunk: c.id, cut: f.cut, seconds: +d.toFixed(2) });
  }
  await commit(job, file, out, chunks, { kind: "cut", cuts: done.reverse() }, save);
  return done;
}

// Puts back the original recording and transcript.
export async function undoAll(job, save) {
  const orig = await getFile(`audio-original:${job.id}`);
  if (!orig || !job.state.originalChunks) throw new Error("The original recording isn't stored in this browser, so the patches can't be undone here.");
  await putFile(`audio:${job.id}`, orig);
  await delFile(`audio-original:${job.id}`);
  cache.delete(job.id);
  const state = { chunks: job.state.originalChunks, patches: [], originalChunks: null, patchedAfterRender: job.status === "done" };
  Object.assign(job.state, state);
  await save(state);
}
