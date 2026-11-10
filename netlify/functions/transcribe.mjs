// /api/transcribe/* — metered AssemblyAI transcription.
// The browser uploads the recording in small parts (Netlify limits request size),
// then a background function sends it to AssemblyAI and records the cost.
import {
  reqStore, jobsStore, json, bad, body, requireUser, getSettings, checkSpend, newId, nowIso, internalToken, activeKey,
} from "../lib/lib.mjs";
import { partsStore, runTranscription } from "../lib/transcribe-run.mjs";

const MAX_PARTS = 80;          // 80 × 3 MB = 240 MB
const MAX_PART_B64 = 4_200_000; // about 3 MB of audio per part

export default async (req) => {
  const { user, error } = await requireUser(req);
  if (error) return error;
  const action = new URL(req.url).pathname.split("/").pop();
  try {
    if (action === "start" && req.method === "POST") {
      const b = await body(req);
      const job = await jobsStore().get(String(b.jobId || ""), { type: "json" });
      if (!job || job.owner !== user.email) return bad("Video not found", 404);
      const s = await getSettings();
      if (!activeKey(s, "assemblyai")) return bad("No AssemblyAI key has been set up. Ask an admin to add one.", 503);
      const capMsg = await checkSpend(user);
      if (capMsg) return bad(capMsg, 429);
      const parts = Number(b.parts);
      if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) return bad("That recording is too large");
      const keyterms = (Array.isArray(b.keyterms) ? b.keyterms : [])
        .map((k) => String(k).trim()).filter((k) => k && k.split(/\s+/).length <= 6 && k.length <= 60).slice(0, 200);
      const id = newId();
      await reqStore().setJSON(id, {
        id, kind: "transcribe", owner: user.email, jobId: job.id, jobTitle: job.title, stage: "transcribe",
        status: "uploading", parts, received: 0, durationSec: Number(b.durationSec) || 0, keyterms, createdAt: nowIso(),
      });
      return json({ id });
    }

    if (action === "part" && req.method === "POST") {
      const b = await body(req);
      const r = await reqStore().get(String(b.id || ""), { type: "json" });
      if (!r || r.owner !== user.email || r.kind !== "transcribe") return bad("Upload not found", 404);
      if (r.status !== "uploading") return bad("This upload has already been sent");
      const n = Number(b.n);
      if (!Number.isInteger(n) || n < 0 || n >= r.parts) return bad("Bad part number");
      if (typeof b.data !== "string" || !b.data || b.data.length > MAX_PART_B64) return bad("Bad audio part");
      await partsStore().set(`${r.id}/${n}`, b.data);
      return json({ ok: true });
    }

    if (action === "run" && req.method === "POST") {
      const b = await body(req);
      const rs = reqStore();
      const r = await rs.get(String(b.id || ""), { type: "json" });
      if (!r || r.owner !== user.email || r.kind !== "transcribe") return bad("Upload not found", 404);
      if (r.status !== "uploading") return bad("Already started");
      r.status = "queued";
      await rs.setJSON(r.id, r);
      if (process.env.SYNC_CLAUDE === "true") await runTranscription(r.id);
      else {
        const resp = await fetch(new URL("/.netlify/functions/transcribe-run-background", req.url), {
          method: "POST", headers: { "content-type": "application/json", "x-internal": internalToken() },
          body: JSON.stringify({ id: r.id }),
        });
        if (resp.status >= 400) {
          await rs.setJSON(r.id, { ...r, status: "error", error: `Could not start transcription (${resp.status}).` });
        }
      }
      return json({ id: r.id });
    }

    if (action === "result" && req.method === "GET") {
      const id = new URL(req.url).searchParams.get("id");
      const r = id && (await reqStore().get(id, { type: "json" }));
      if (!r || r.owner !== user.email || r.kind !== "transcribe") return bad("Not found", 404);
      return json(r);
    }
    return bad("Not found", 404);
  } catch (e) {
    console.error(e);
    return bad(e.message || "Server error", 500);
  }
};

export const config = { path: "/api/transcribe/*" };
