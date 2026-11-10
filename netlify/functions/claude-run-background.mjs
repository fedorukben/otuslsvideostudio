// Background function (up to 15 minutes): runs one queued Claude call.
// Only callable from our own /api/claude/start, which sends an internal token.
import { internalToken } from "../lib/lib.mjs";
import { runRequest } from "../lib/claude-run.mjs";

export default async (req) => {
  if (req.headers.get("x-internal") !== internalToken()) return new Response("Forbidden", { status: 403 });
  const { id } = await req.json();
  await runRequest(id);
};
