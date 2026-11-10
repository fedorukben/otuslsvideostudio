// Fake Anthropic Messages API (streaming). Replies are chosen by the system prompt's stage tag.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));

function replyFor(body) {
  const sys = (body.system || []).map((b) => b.text).join("");
  const tag = (sys.match(/\[stage:([a-z-]+)\]/) || [])[1];
  // PLAN_FIXTURE=product.json makes the plan/fix/revise stages return that spec instead.
  if (process.env.PLAN_FIXTURE && ["plan", "fix", "revise"].includes(tag)) return fs.readFileSync(path.join(here, "fixtures", process.env.PLAN_FIXTURE), "utf8");
  const fixture = path.join(here, "fixtures", `${tag}.txt`);
  if (tag && fs.existsSync(fixture)) return fs.readFileSync(fixture, "utf8");
  if (tag === "math-pass") {
    const msg = body.messages.at(-1).content;
    const text = typeof msg === "string" ? msg : msg.map((m) => m.text || "").join("");
    const chunks = JSON.parse(text.slice(text.indexOf("<chunks>") + 8, text.indexOf("</chunks>")));
    // MOCK_FLAGS=1: flag restarts the way Haiku does, including one whose words aren't in the caption.
    const flagsFor = (t) => !process.env.MOCK_FLAGS ? []
      : /^Picture/.test(t) ? [process.env.MOCK_FLAGS === "whole" ? { kind: "false-start", note: "Abandoned this whole sentence", cut: t }
        : { kind: "false-start", note: "Started the sentence, then began again", cut: "Picture a" }]
      : /^So to recap/.test(t) ? [{ kind: "false-start", note: "Abandoned 'uh so to' before restarting", cut: "uh so to" }] : [];
    return JSON.stringify({ chunks: chunks.map((c) => ({ id: c.id, latex: c.text, flags: flagsFor(c.text) })) });
  }
  if (tag === "frame-check") return JSON.stringify({ frames: [] });
  return "Hello from the mock Claude API.";
}

// ---- fake AssemblyAI ----
// Words for dev/fixtures/test_voice7.m4a: a 3 s burst of "speech" every 4 s.
const SENTENCES = ["Okay so today we count walls", "Picture a wall two units tall and n units long", "Look at the, look at the right hand end of the wall",
  "So every wall of length n is one of these plus the walls with two flat dominoes", "Let's find a three and then a four and a five",
  "A common mistake is to write a n equals a n minus one plus one", "So to recap here are three steps"];
export const assemblyCalls = [];
function fakeWords() {
  const out = [];
  SENTENCES.forEach((sent, i) => {
    const ws = sent.split(" "), t0 = i * 4 + 0.1, dur = 2.8 / ws.length;
    ws.forEach((w, k) => out.push({ text: w, start: Math.round((t0 + k * dur) * 1000), end: Math.round((t0 + (k + 0.8) * dur) * 1000), confidence: 0.97 }));
  });
  return out;
}
async function mockAssembly(url, init = {}) {
  const u = new URL(url);
  assemblyCalls.push({ method: init.method || "GET", path: u.pathname, body: typeof init.body === "string" ? JSON.parse(init.body) : { bytes: init.body?.length } });
  const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (u.pathname === "/v2/upload") return j({ upload_url: "https://cdn.assemblyai.example/upload/abc" });
  if (u.pathname === "/v2/transcript" && init.method === "POST") return j({ id: "tr_123", status: "queued" });
  if (u.pathname.startsWith("/v2/transcript/") && init.method === "DELETE") return j({ id: "tr_123", status: "deleted" });
  if (u.pathname.startsWith("/v2/transcript/")) {
    const words = fakeWords();
    return j({ id: "tr_123", status: "completed", audio_duration: 28, speech_model_used: "universal-3-5-pro",
      text: SENTENCES.join(". "), words });
  }
  return j({ error: "not mocked" }, 404);
}

// ---- fake ElevenLabs ----
export const elevenCalls = [];
function toneWav(seconds, sr = 22050) {
  const n = Math.round(seconds * sr), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.sin(Math.PI * ((t * 3) % 1)) ** 2; // "syllables"
    const v = Math.sin(2 * Math.PI * 180 * t) * 0.3 * env + Math.sin(2 * Math.PI * 360 * t) * 0.1 * env;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  // 0.15 s of silence either side, like real TTS output
  const pad = Buffer.alloc(Math.round(0.15 * sr) * 2);
  const all = Buffer.concat([h, pad, data, pad]);
  all.writeUInt32LE(all.length - 8, 4); all.writeUInt32LE(data.length + pad.length * 2, 40);
  return all;
}
async function mockEleven(url, init = {}) {
  const u = new URL(url);
  const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (!init.headers?.["xi-api-key"]) return j({ detail: "missing key" }, 401);
  if (u.pathname === "/v1/voices/add" && init.method === "POST") {
    const files = init.body.getAll("files");
    elevenCalls.push({ op: "add", name: init.body.get("name"), bytes: files[0]?.size || 0, noise: init.body.get("remove_background_noise") });
    return j({ voice_id: "voice_" + Math.random().toString(36).slice(2, 10), requires_verification: false });
  }
  if (u.pathname.startsWith("/v1/voices/") && init.method === "DELETE") { elevenCalls.push({ op: "delete", id: u.pathname.split("/").pop() }); return j({ status: "ok" }); }
  if (u.pathname.startsWith("/v1/text-to-speech/")) {
    const b = JSON.parse(init.body);
    elevenCalls.push({ op: "tts", voice: u.pathname.split("/").pop(), text: b.text, model: b.model_id, prev: b.previous_text, next: b.next_text, seed: b.seed, settings: b.voice_settings });
    const wav = toneWav(Math.max(0.8, b.text.length / 15) * (b.voice_settings?.speed ? 1 / b.voice_settings.speed : 1));
    return new Response(wav, { status: 200, headers: { "content-type": "audio/wav", "character-cost": String(b.text.length) } });
  }
  return j({ detail: "not mocked" }, 404);
}

export async function mockFetch(url, init) {
  if (String(url).startsWith("https://api.assemblyai.com")) return mockAssembly(url, init);
  if (String(url).startsWith("https://api.elevenlabs.io")) return mockEleven(url, init);
  const body = JSON.parse(init.body);
  let text = replyFor(body), stop = "end_turn";
  // MOCK_TRUNCATE=1: math-pass replies for more than 3 chunks are cut off, like a reply that hit max_tokens.
  if (process.env.MOCK_TRUNCATE && /\[stage:math-pass\]/.test((body.system || []).map((b) => b.text).join("")) && JSON.parse(text).chunks.length > 3) {
    text = text.slice(0, Math.floor(text.length * 0.6)); stop = "max_tokens"; console.log("mock: truncated a math-pass reply");
  }
  // MOCK_SLOW=1 makes the planning call take 8 s, to test the live cost ticker.
  if (process.env.MOCK_SLOW && /\[stage:plan\]/.test((body.system || []).map((b) => b.text).join(""))) await new Promise((r) => setTimeout(r, 8000));
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1200, cache_creation_input_tokens: 800, cache_read_input_tokens: 0, output_tokens: 1 } } },
    ...text.match(/[\s\S]{1,200}/g).map((t) => ({ type: "content_block_delta", delta: { type: "text_delta", text: t } })),
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: Math.ceil(text.length / 4) } },
  ];
  const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}
