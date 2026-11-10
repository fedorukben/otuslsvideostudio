// /api/claude/start and /api/claude/result
// The browser never sees the API key. It queues a request here; a background
// function makes the call (up to 15 minutes), records usage and stores the reply.
import {
  reqStore, jobsStore, json, bad, body, requireUser, getSettings, checkSpend, newId, nowIso, internalToken, activeKey, approvalBlock,
} from "../lib/lib.mjs";
import { runRequest } from "../lib/claude-run.mjs";

const STAGES = ["math-pass", "plan", "fix", "revise", "frame-check"];

export default async (req, context) => {
  const { user, error } = await requireUser(req);
  if (error) return error;
  const action = new URL(req.url).pathname.split("/").pop();
  try {
    if (action === "start" && req.method === "POST") {
      const b = await body(req);
      if (!STAGES.includes(b.stage)) return bad("Unknown stage");
      const job = await jobsStore().get(String(b.jobId || ""), { type: "json" });
      if (!job || job.owner !== user.email) return bad("Video not found", 404);
      const blocked = approvalBlock(job);
      if (blocked) return bad(blocked, 403);
      const capMsg = await checkSpend(user);
      if (capMsg) return bad(capMsg, 429);
      const s = await getSettings();
      if (!activeKey(s, "anthropic")) return bad("No Anthropic API key has been set up. Ask an admin to add one.", 503);
      const model = s.stageModels[b.stage];
      const r = b.request || {};
      if (!Array.isArray(r.messages) || !r.messages.length) return bad("Request needs messages");
      const id = newId();
      await reqStore().setJSON(id, {
        id, owner: user.email, jobId: job.id, jobTitle: job.title, stage: b.stage, model, status: "queued",
        createdAt: nowIso(),
        request: {
          system: String(r.system || ""), messages: r.messages,
          max_tokens: Math.min(Number(r.max_tokens) || 4096, 64000),
          temperature: typeof r.temperature === "number" ? r.temperature : undefined,
        },
      });
      if (process.env.SYNC_CLAUDE === "true") {
        // Fallback for sites without background functions (30 s limit: fine for short stages only).
        await runRequest(id);
      } else {
        const resp = await fetch(new URL("/.netlify/functions/claude-run-background", req.url), {
          method: "POST", headers: { "content-type": "application/json", "x-internal": internalToken() },
          body: JSON.stringify({ id }),
        });
        if (resp.status >= 400) {
          await reqStore().setJSON(id, { ...(await reqStore().get(id, { type: "json" })), status: "error",
            error: `Could not start the background call (${resp.status}). Check that background functions are enabled for this site.` });
        }
      }
      return json({ id, model });
    }

    if (action === "result" && req.method === "GET") {
      const id = new URL(req.url).searchParams.get("id");
      const r = id && (await reqStore().get(id, { type: "json" }));
      if (!r || r.owner !== user.email) return bad("Request not found", 404);
      const { request, ...rest } = r;
      return json(rest);
    }
    return bad("Not found", 404);
  } catch (e) {
    console.error(e);
    return bad(e.message || "Server error", 500);
  }
};

export const config = { path: "/api/claude/*" };
