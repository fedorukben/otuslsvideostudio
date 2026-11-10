// Background function (up to 15 minutes): one AssemblyAI transcription.
// Only callable from our own /api/transcribe/run, which sends an internal token.
import { internalToken } from "../lib/lib.mjs";
import { runTranscription } from "../lib/transcribe-run.mjs";

export default async (req) => {
  if (req.headers.get("x-internal") !== internalToken()) return new Response("Forbidden", { status: 403 });
  const { id } = await req.json();
  await runTranscription(id);
};
