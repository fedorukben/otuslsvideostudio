// Background function: creates one person's ElevenLabs voice clone from their uploaded sample.
// Only callable from our own /api/voice/sample/run, which sends an internal token.
import { internalToken } from "../lib/lib.mjs";
import { runClone } from "../lib/voice.mjs";

export default async (req) => {
  if (req.headers.get("x-internal") !== internalToken()) return new Response("Forbidden", { status: 403 });
  const { id } = await req.json();
  await runClone(id);
};
