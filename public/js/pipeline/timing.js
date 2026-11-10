// When each build appears, and when each caption shows.
import { frameDb, findPauses, slice } from "./audio.js";
import { wrapCaption } from "./render.js";

const norm = (s) => String(s || "").toLowerCase().replace(/\$[^$]*\$/g, " ").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

// Fraction of the first `n` phrase words found at the start of `text` (in order, allowing small slips).
export function startsWithScore(text, phrase, n = 3) {
  const a = norm(text).slice(0, n + 2), b = norm(phrase).slice(0, n);
  if (!b.length) return 0;
  let hit = 0, j = 0;
  for (const w of b) {
    const k = a.indexOf(w, j);
    if (k >= 0 && k - j <= 2) { hit++; j = k + 1; }
  }
  return hit / b.length;
}

// Character offset of `phrase` inside `text` (best word-window match), as a fraction 0..1.
export function phrasePosition(text, phrase) {
  const words = norm(text), target = norm(phrase).slice(0, 4);
  if (!words.length || !target.length) return null;
  let best = -1, bestScore = 0;
  for (let i = 0; i < words.length; i++) {
    let sc = 0;
    for (let k = 0; k < target.length; k++) if (words[i + k] === target[k]) sc++;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  if (bestScore < Math.min(2, target.length)) return null;
  const chars = words.slice(0, best).join(" ").length;
  return chars / Math.max(1, words.join(" ").length);
}

// Returns an array of build start times (seconds, on the original audio clock), in scene/build order.
export async function buildTimes({ spec, chunks, samples, transcribe, onProgress }) {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const db = frameDb(samples);
  const shortPauses = findPauses(db, { noiseDb: -36, minDur: 0.12 });
  const builds = [];
  spec.scenes.forEach((sc, si) => (sc.builds || [{}]).forEach((b, bi) => builds.push({ si, bi, start: b.start || {} })));
  const times = [];
  let n = 0;
  for (const b of builds) {
    onProgress?.(++n / builds.length);
    const ch = byId.get(b.start.chunk);
    if (!ch) { times.push(times.length ? times.at(-1) + 2 : 0); continue; }
    const text = ch.caption ?? ch.text ?? "";
    if (!b.start.phrase || startsWithScore(text, b.start.phrase) >= 0.67) { times.push(ch.start - 0.3); continue; }
    // With word timings (AssemblyAI), find the phrase's first word directly.
    if (ch.words?.length) {
      const at = wordIndexOf(ch.words, b.start.phrase);
      if (at >= 0) { times.push(ch.words[at].s - 0.2); continue; }
    }
    const pos = phrasePosition(text, b.start.phrase);
    const est = pos == null ? ch.start : ch.start + pos * (ch.end - ch.start);
    // Candidate pauses inside the chunk near the estimate; verify by listening to 1.6 s after each.
    const cands = shortPauses
      .filter((p) => p.end > ch.start + 0.2 && p.end < ch.end - 0.3 && Math.abs(p.end - est) < 2.2)
      .sort((p, q) => Math.abs(p.end - est) - Math.abs(q.end - est))
      .slice(0, 4);
    let best = null, bestScore = 0;
    if (transcribe) {
      for (const p of cands) {
        const said = await transcribe(slice(samples, p.end - 0.05, p.end + 1.6));
        const sc = startsWithScore(said, b.start.phrase, 2);
        if (sc > bestScore) { bestScore = sc; best = p; }
        if (sc >= 1) break;
      }
    }
    times.push(best && bestScore >= 0.5 ? best.end - 0.15 : est - 0.2);
  }
  // Keep order and a minimum gap so a build is on screen for at least 0.8 s.
  for (let i = 0; i < times.length; i++) {
    times[i] = Math.max(0, times[i]);
    if (i && times[i] < times[i - 1] + 0.8) times[i] = times[i - 1] + 0.8;
  }
  return times;
}

// Index of the word where `phrase` starts (best match of its first 4 words), or -1.
export function wordIndexOf(words, phrase) {
  const target = norm(phrase).slice(0, 4);
  if (!target.length) return -1;
  const ws = words.map((w) => norm(w.w)[0] || "");
  let best = -1, bestScore = 0;
  for (let i = 0; i < ws.length; i++) {
    let sc = 0;
    for (let k = 0; k < target.length; k++) if (ws[i + k] === target[k]) sc++;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return bestScore >= Math.min(2, target.length) ? best : -1;
}

// Captions from what was actually said: each chunk split into ≤ 2-line pieces, timed by characters.
export function buildCaptions(chunks) {
  const out = [];
  for (const ch of chunks) {
    const text = String(ch.caption ?? ch.text ?? "").replace(/\s+/g, " ").trim();
    if (!/[A-Za-z0-9]/.test(text)) continue; // nothing to read (empty, or punctuation left after a cut)
    const pieces = splitCaption(text, 140);
    // Word timings (AssemblyAI) give exact caption times, as long as the caption text wasn't edited.
    const tokenWord = []; // which timed word each normalised token came from
    (ch.words || []).forEach((w, i) => { if (Number.isFinite(w?.s) && Number.isFinite(w?.e)) norm(w.w).forEach(() => tokenWord.push(i)); });
    if (tokenWord.length && norm(text).join(" ") === norm(ch.words.map((w) => w.w).join(" ")).join(" ")) {
      let ti = 0;
      for (const p of pieces) {
        const n = Math.max(1, norm(p).length);
        const first = ch.words[tokenWord[Math.min(ti, tokenWord.length - 1)]];
        const last = ch.words[tokenWord[Math.min(ti + n - 1, tokenWord.length - 1)]];
        out.push({ start: first.s, end: last.e, text: p });
        ti += n;
      }
      // keep each caption up until the next one starts (no flicker between words)
      for (let i = out.length - pieces.length; i < out.length - 1; i++) out[i].end = Math.max(out[i].end, out[i + 1].start);
      continue;
    }
    // No usable word timings (none, edited text, or a line with no words in it): spread by characters.
    const total = pieces.reduce((a, p) => a + p.length, 0) || 1;
    let t = Number.isFinite(ch.start) ? ch.start : (out.at(-1)?.end ?? 0);
    const dur = Number.isFinite(ch.end) && ch.end > t ? ch.end - t : Math.max(1, text.length / 15);
    for (const p of pieces) {
      const d = (p.length / total) * dur;
      out.push({ start: t, end: t + d, text: p });
      t += d;
    }
  }
  return out;
}
function splitCaption(text, max) {
  if (text.length <= max) return [text];
  // sentence ends first, then commas/semicolons (never colons), then words
  for (const re of [/(?<=[.!?])\s+/, /(?<=[,;])\s+/]) {
    const parts = text.split(re);
    if (parts.length > 1) {
      const merged = [];
      for (const p of parts) {
        if (merged.length && (merged.at(-1) + " " + p).length <= max) merged[merged.length - 1] += " " + p;
        else merged.push(p);
      }
      if (merged.every((m) => m.length <= max)) return merged;
      return merged.flatMap((m) => splitCaption(m, max));
    }
  }
  const words = text.split(" ");
  const half = Math.ceil(words.length / 2);
  return [...splitCaption(words.slice(0, half).join(" "), max), ...splitCaption(words.slice(half).join(" "), max)];
}

const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
export function toSrt(captions, offset = 0) {
  return captions.map((c, i) =>
    `${i + 1}\n${srtTime(c.start - offset)} --> ${srtTime(c.end - offset)}\n${wrapCaption(c.text).slice(0, 2).join("\n")}\n`).join("\n");
}

// Build start times from the transcript alone (no audio): for previews before the real timing is done.
export function approxTimes(spec, chunks) {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const out = [];
  for (const sc of spec.scenes) for (const b of sc.builds?.length ? sc.builds : [{}]) {
    const ch = byId.get(b.start?.chunk);
    let t = out.length ? out.at(-1) + 2.5 : 0;
    if (ch) {
      const text = ch.caption ?? ch.text ?? "";
      if (ch.words?.length) { const k = wordIndexOf(ch.words, b.start.phrase || ""); if (k >= 0) t = ch.words[k].s; else t = ch.start; }
      else if (b.start.phrase && startsWithScore(text, b.start.phrase) < 0.67) {
        const pos = phrasePosition(text, b.start.phrase);
        t = pos == null ? ch.start : ch.start + pos * (ch.end - ch.start);
      } else t = ch.start;
    }
    out.push(out.length ? Math.max(t, out.at(-1) + 0.8) : 0);
  }
  return out;
}
