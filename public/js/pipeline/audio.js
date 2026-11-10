// Audio analysis in the browser: decode, resample to 16 kHz mono, find pauses and speech chunks.

export async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const ac = new AudioContext();
  try { return await ac.decodeAudioData(buf); } finally { ac.close(); }
}

export async function toMono16k(audioBuffer) {
  const sr = 16000;
  const len = Math.ceil(audioBuffer.duration * sr);
  const off = new OfflineAudioContext(1, len, sr);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination); // channels are down-mixed to mono
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

// Level in dBFS per 10 ms frame.
export function frameDb(samples, sr = 16000, frameSec = 0.01) {
  const n = Math.floor(samples.length / (sr * frameSec));
  const step = Math.floor(sr * frameSec);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * step; j < (i + 1) * step; j++) s += samples[j] * samples[j];
    db[i] = 10 * Math.log10(s / step + 1e-12);
  }
  return db;
}

// Like ffmpeg silencedetect: runs below `noiseDb` for at least `minDur` seconds.
export function findPauses(db, { noiseDb = -38, minDur = 0.6, frameSec = 0.01 } = {}) {
  const pauses = [];
  let start = null;
  for (let i = 0; i <= db.length; i++) {
    const quiet = i < db.length && db[i] < noiseDb;
    if (quiet && start === null) start = i;
    if (!quiet && start !== null) {
      if ((i - start) * frameSec >= minDur) pauses.push({ start: start * frameSec, end: i * frameSec });
      start = null;
    }
  }
  return pauses;
}

// Speech chunks between long pauses, each at most `maxLen` seconds (Whisper's window is 30 s).
export function speechChunks(samples, sr = 16000, { noiseDb = -38, minPause = 0.6, maxLen = 25 } = {}) {
  const db = frameDb(samples, sr);
  const dur = samples.length / sr;
  const pauses = findPauses(db, { noiseDb, minDur: minPause });
  let chunks = [];
  let cur = 0;
  for (const p of pauses) {
    if (p.start - cur > 0.15) chunks.push({ start: cur, end: p.start });
    cur = p.end;
  }
  if (dur - cur > 0.15) chunks.push({ start: cur, end: dur });
  // Drop chunks that are pure noise blips.
  chunks = chunks.filter((c) => c.end - c.start >= 0.25 && maxDb(db, c) > noiseDb + 6);
  // Split long chunks at their quietest short pause.
  const out = [];
  for (const c of chunks) splitLong(c, db, maxLen, out);
  // Trim each chunk to where sound actually starts/ends (pause detection can leave edges).
  return out.map((c, i) => ({ id: i, start: round(c.start), end: round(c.end) }));
}

function maxDb(db, c) {
  let m = -200;
  for (let i = Math.floor(c.start * 100); i < Math.min(db.length, Math.ceil(c.end * 100)); i++) m = Math.max(m, db[i]);
  return m;
}
function splitLong(c, db, maxLen, out) {
  if (c.end - c.start <= maxLen) { out.push(c); return; }
  // look for the quietest 200 ms window in the middle 60% of the chunk
  const a = Math.floor((c.start + (c.end - c.start) * 0.2) * 100);
  const b = Math.floor((c.start + (c.end - c.start) * 0.8) * 100);
  let best = a, bestV = Infinity;
  for (let i = a; i < b - 20; i++) {
    let s = 0;
    for (let j = i; j < i + 20; j++) s += db[j];
    if (s < bestV) { bestV = s; best = i + 10; }
  }
  const t = best / 100;
  splitLong({ start: c.start, end: t }, db, maxLen, out);
  splitLong({ start: t, end: c.end }, db, maxLen, out);
}
const round = (x) => Math.round(x * 1000) / 1000;

export const slice = (samples, start, end, sr = 16000) =>
  samples.subarray(Math.max(0, Math.floor(start * sr)), Math.min(samples.length, Math.ceil(end * sr)));
