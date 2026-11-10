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
    return JSON.stringify({ chunks: chunks.map((c) => ({ id: c.id, latex: c.text, flags: [] })) });
  }
  if (tag === "frame-check") return JSON.stringify({ frames: [] });
  return "Hello from the mock Claude API.";
}

// ---- fake AssemblyAI ----
// Words for dev/fixtures/test_voice7.m4a: a 3 s burst of "speech" every 4 s.
const SENTENCES = ["Okay so today we count walls", "Picture a wall two units tall and n units long", "Look at the right hand end of the wall",
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

export async function mockFetch(url, init) {
  if (String(url).startsWith("https://api.assemblyai.com")) return mockAssembly(url, init);
  const body = JSON.parse(init.body);
  const text = replyFor(body);
  // MOCK_SLOW=1 makes the planning call take 8 s, to test the live cost ticker.
  if (process.env.MOCK_SLOW && /\[stage:plan\]/.test((body.system || []).map((b) => b.text).join(""))) await new Promise((r) => setTimeout(r, 8000));
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1200, cache_creation_input_tokens: 800, cache_read_input_tokens: 0, output_tokens: 1 } } },
    ...text.match(/[\s\S]{1,200}/g).map((t) => ({ type: "content_block_delta", delta: { type: "text_delta", text: t } })),
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: Math.ceil(text.length / 4) } },
  ];
  const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}
