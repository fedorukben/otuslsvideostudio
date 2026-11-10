// Fake Anthropic Messages API (streaming). Replies are chosen by the system prompt's stage tag.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));

function replyFor(body) {
  const sys = (body.system || []).map((b) => b.text).join("");
  const tag = (sys.match(/\[stage:([a-z-]+)\]/) || [])[1];
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

export async function mockFetch(url, init) {
  const body = JSON.parse(init.body);
  const text = replyFor(body);
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1200, cache_creation_input_tokens: 800, cache_read_input_tokens: 0, output_tokens: 1 } } },
    ...text.match(/[\s\S]{1,200}/g).map((t) => ({ type: "content_block_delta", delta: { type: "text_delta", text: t } })),
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: Math.ceil(text.length / 4) } },
  ];
  const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}
