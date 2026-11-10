import { api, costListeners } from "../api.js";
// Whisper speech recognition in the browser via transformers.js.
// The model downloads once from Hugging Face and is cached by the browser.
// The audio itself never leaves the computer.

let asrPromise = null;
let asrModel = null;

export async function loadASR(modelId = "Xenova/whisper-small.en", onProgress) {
  if (window.__SVS_MOCK_ASR) return window.__SVS_MOCK_ASR; // test hook
  if (asrPromise && asrModel === modelId) return asrPromise;
  asrModel = modelId;
  asrPromise = (async () => {
    const { pipeline, env } = await import("/vendor/transformers/transformers.min.js");
    env.allowLocalModels = false;
    env.backends.onnx.wasm.wasmPaths = "/vendor/transformers/";
    const files = {};
    const progress_callback = (p) => {
      if (p.status === "progress" && p.total) {
        files[p.file] = [p.loaded, p.total];
        const vals = Object.values(files);
        onProgress?.(vals.reduce((a, v) => a + v[0], 0) / vals.reduce((a, v) => a + v[1], 0));
      }
    };
    let device = "wasm";
    try { if (navigator.gpu && (await navigator.gpu.requestAdapter())) device = "webgpu"; } catch {}
    const opts = device === "webgpu"
      ? { device, dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }, progress_callback }
      : { device, dtype: "q8", progress_callback };
    const pipe = await pipeline("automatic-speech-recognition", modelId, opts);
    return async (samples16k) => {
      const out = await pipe(samples16k, { language: undefined, return_timestamps: false });
      return String(out.text || "").trim();
    };
  })();
  asrPromise.catch(() => { asrPromise = null; });
  return asrPromise;
}

// ---------- AssemblyAI (metered, through the site) ----------

const PART = 3 * 1024 * 1024; // bytes of audio per upload request

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Uploads the recording, waits for AssemblyAI, and returns {words:[{w,s,e,c}], text, model, costUsd, audioSeconds}.
export async function transcribeRemote(jobId, file, { durationSec, keyterms, onProgress, onStatus }) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts = Math.max(1, Math.ceil(bytes.length / PART));
  const { id } = await api("POST", "/api/transcribe/start", { jobId, parts, durationSec, keyterms });
  for (let n = 0; n < parts; n++) {
    await api("POST", "/api/transcribe/part", { id, n, data: toBase64(bytes.subarray(n * PART, (n + 1) * PART)) });
    onProgress?.((n + 1) / parts);
  }
  await api("POST", "/api/transcribe/run", { id });
  const t0 = Date.now();
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await api("GET", `/api/transcribe/result?id=${encodeURIComponent(id)}`);
    onStatus?.(r.status, Math.round((Date.now() - t0) / 1000));
    if (r.status === "done") { for (const f of costListeners) try { f(jobId, r.costUsd || 0); } catch {} return r; }
    if (r.status === "error") throw new Error(r.error || "Transcription failed");
    if (Date.now() - t0 > 15 * 60 * 1000) throw new Error("Transcription timed out");
  }
}

// Speech chunks from word timings: a new chunk at every pause of 0.6 s or more, at most ~25 s each.
export function chunksFromWords(words, { minPause = 0.6, maxLen = 25 } = {}) {
  const chunks = [];
  let cur = null;
  for (const w of words) {
    const gap = cur ? w.s - cur.words.at(-1).e : Infinity;
    if (!cur || gap >= minPause || (w.e - cur.start > maxLen && /[.,;?!]$/.test(cur.words.at(-1).w)) || w.e - cur.start > maxLen + 8) {
      cur = { id: chunks.length, start: w.s, end: w.e, words: [] };
      chunks.push(cur);
    }
    cur.words.push(w);
    cur.end = w.e;
  }
  return chunks.map((c) => ({ ...c, start: +c.start.toFixed(3), end: +c.end.toFixed(3), text: c.words.map((w) => w.w).join(" ") }));
}

// Key terms (custom vocabulary) for AssemblyAI from the title, script, tipsheet and notes.
const STOP = new Set(("about above after again against all also and any are because been before being below between both but " +
  "can could did does doing down during each few for from further had has have having her here hers him his how into its itself " +
  "just more most much must not now off once only other our out over own same she should some such than that their them then " +
  "there these they this those through too under until very was were what when where which while who whom why will with would " +
  "you your yours okay right let's lets going want need look looks thing things first second next last example way ways " +
  "make makes made take takes one two three four five six seven eight nine ten get gets got see says said").split(" "));
const MATH_TERMS = ["recurrence", "recurrence relation", "a sub n", "n minus one", "n minus two", "base case", "initial condition",
  "derivative", "integral", "chain rule", "product rule", "quotient rule", "limit", "summation", "sigma", "theta", "lambda",
  "matrix", "eigenvalue", "eigenvector", "determinant", "vector", "binomial", "factorial", "modulo", "logarithm", "exponent",
  "polynomial", "induction", "big O", "algorithm", "array", "recursion", "Ontario Tech", "nool", "Study Hall"];
export function buildKeyterms(job) {
  const st = job.state || {};
  const text = [job.title, job.eyebrow, job.subtitle, st.script, st.tipsheet, st.notes].filter(Boolean).join("\n")
    .replace(/\\[a-zA-Z]+/g, " ").replace(/[${}_^\\]/g, " ");
  const counts = new Map();
  for (const raw of text.split(/[^A-Za-z'-]+/)) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < 4 || STOP.has(w.toLowerCase())) continue;
    const k = w.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const fromText = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120).map(([w]) => w);
  const titleBits = [job.title, job.eyebrow].filter(Boolean);
  return [...new Set([...titleBits, ...MATH_TERMS, ...fromText])].slice(0, 180);
}
