// /api/voice/* — each person's optional AI voice, used to patch a line of narration.
//   GET  /api/voice/me             status, site availability, price
//   PUT  /api/voice/me             { enabled?, settings? }
//   POST /api/voice/sample/start   { parts, durationSec, sampleName, mime, consent, removeNoise }
//   POST /api/voice/sample/part    { id, n, data }
//   POST /api/voice/sample/run     { id }   → clone made in the background
//   GET  /api/voice/sample/result?id=
//   POST /api/voice/delete         {}       → removes the voice at ElevenLabs and here
//   POST /api/voice/speak          { text, previousText?, nextText?, seed?, jobId? } → one take (base64 audio)
import {
  reqStore, jobsStore, json, bad, body, requireUser, getSettings, checkSpend, newId, nowIso, internalToken, activeKey, approvalBlock, emailKey,
} from "../lib/lib.mjs";
import { voices, samplePartsStore, publicVoice, runClone, deleteVoice, speak, DEFAULT_VOICE_SETTINGS } from "../lib/voice.mjs";

const MAX_PARTS = 4;              // 4 × 3 MB; ElevenLabs takes files up to 10 MB
const MAX_PART_B64 = 4_200_000;
const MAX_TEXT = 600;             // one line or a couple of sentences
const CONSENT = "This is my own voice. I agree to it being cloned with ElevenLabs so I can use it to re-say lines in my own videos, and I know I can delete it at any time.";

async function availability() {
  const s = await getSettings();
  const hasKey = !!activeKey(s, "elevenlabs");
  const model = s.elevenlabsModel || "eleven_multilingual_v2";
  return {
    available: s.allowVoice !== false && hasKey,
    reason: s.allowVoice === false ? "An admin has turned voice patching off for this site." : !hasKey ? "An admin needs to add an ElevenLabs API key before voices can be set up." : null,
    model, pricePer1kChars: s.voicePrices?.[model] ?? 0.1, s,
  };
}

export default async (req) => {
  const { user, error } = await requireUser(req);
  if (error) return error;
  const parts = new URL(req.url).pathname.replace(/^\/api\/voice\/?/, "").split("/");
  const route = parts.join("/");
  const vs = voices();
  const me = emailKey(user.email);
  try {
    if (route === "me" && req.method === "GET") {
      const a = await availability();
      const v = await vs.get(me, { type: "json" });
      return json({ available: a.available, reason: a.reason, model: a.model, pricePer1kChars: a.pricePer1kChars, consentText: CONSENT, voice: publicVoice(v) });
    }

    if (route === "me" && req.method === "PUT") {
      const b = await body(req);
      const v = (await vs.get(me, { type: "json" })) || { email: me, status: "none", enabled: false, settings: { ...DEFAULT_VOICE_SETTINGS } };
      if (typeof b.enabled === "boolean") v.enabled = b.enabled;
      if (b.settings && typeof b.settings === "object") {
        const clamp = (x, lo, hi, d) => (typeof x === "number" && isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
        const cur = { ...DEFAULT_VOICE_SETTINGS, ...(v.settings || {}) };
        v.settings = {
          stability: clamp(b.settings.stability, 0, 1, cur.stability), similarity: clamp(b.settings.similarity, 0, 1, cur.similarity),
          style: clamp(b.settings.style, 0, 1, cur.style), speed: clamp(b.settings.speed, 0.7, 1.2, cur.speed),
        };
      }
      v.updatedAt = nowIso();
      await vs.setJSON(me, v);
      return json({ voice: publicVoice(v) });
    }

    if (route === "sample/start" && req.method === "POST") {
      const a = await availability();
      if (!a.available) return bad(a.reason, 503);
      const b = await body(req);
      if (b.consent !== true) return bad("Please confirm that this is your own voice and that you agree to it being cloned.");
      const n = Number(b.parts);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) return bad("That sample is too large. Keep it under 10 MB (about 5 minutes of phone audio).");
      const dur = Number(b.durationSec) || 0;
      if (dur && dur < 30) return bad("That sample is too short. Record at least a minute; 2 to 5 minutes works best.");
      const id = newId();
      await reqStore().setJSON(id, {
        id, kind: "voice-sample", owner: user.email, ownerName: user.name || "", status: "uploading", parts: n, received: 0,
        durationSec: dur, sampleName: String(b.sampleName || "sample").slice(0, 120), mime: String(b.mime || "audio/mpeg").slice(0, 60),
        removeNoise: b.removeNoise === true, consentAt: nowIso(), consentText: CONSENT, createdAt: nowIso(),
      });
      return json({ id });
    }

    if (route === "sample/part" && req.method === "POST") {
      const b = await body(req);
      const r = await reqStore().get(String(b.id || ""), { type: "json" });
      if (!r || r.owner !== user.email || r.kind !== "voice-sample") return bad("Upload not found", 404);
      if (r.status !== "uploading") return bad("This sample has already been sent");
      const n = Number(b.n);
      if (!Number.isInteger(n) || n < 0 || n >= r.parts) return bad("Bad part number");
      if (typeof b.data !== "string" || !b.data || b.data.length > MAX_PART_B64) return bad("Bad audio part");
      await samplePartsStore().set(`${r.id}/${n}`, b.data);
      return json({ ok: true });
    }

    if (route === "sample/run" && req.method === "POST") {
      const b = await body(req);
      const rs = reqStore();
      const r = await rs.get(String(b.id || ""), { type: "json" });
      if (!r || r.owner !== user.email || r.kind !== "voice-sample") return bad("Upload not found", 404);
      if (r.status !== "uploading") return bad("Already started");
      r.status = "queued";
      await rs.setJSON(r.id, r);
      const v = await vs.get(me, { type: "json" });
      await vs.setJSON(me, { ...(v || { email: me, enabled: true, settings: { ...DEFAULT_VOICE_SETTINGS } }), status: v?.voiceId ? "ready" : "creating", error: null, pendingId: r.id });
      if (process.env.SYNC_CLAUDE === "true") await runClone(r.id);
      else {
        const resp = await fetch(new URL("/.netlify/functions/voice-clone-background", req.url), {
          method: "POST", headers: { "content-type": "application/json", "x-internal": internalToken() }, body: JSON.stringify({ id: r.id }),
        });
        if (resp.status >= 400) await rs.setJSON(r.id, { ...r, status: "error", error: `Could not start (${resp.status}).` });
      }
      return json({ id: r.id });
    }

    if (route === "sample/result" && req.method === "GET") {
      const id = new URL(req.url).searchParams.get("id");
      const r = id && (await reqStore().get(id, { type: "json" }));
      if (!r || r.owner !== user.email || r.kind !== "voice-sample") return bad("Not found", 404);
      const v = await vs.get(me, { type: "json" });
      return json({ status: r.status, error: r.error || null, voice: publicVoice(v) });
    }

    if (route === "delete" && req.method === "POST") {
      await deleteVoice(me);
      return json({ voice: publicVoice(null) });
    }

    if (route === "speak" && req.method === "POST") {
      const a = await availability();
      if (!a.available) return bad(a.reason, 503);
      const v = await vs.get(me, { type: "json" });
      if (!v?.voiceId || v.status !== "ready") return bad("Set up your voice on the Voice page first.", 409);
      if (!v.enabled) return bad("Your AI voice is turned off. Turn it on from the Voice page.", 409);
      const b = await body(req);
      const text = String(b.text || "").replace(/\s+/g, " ").trim();
      if (!text) return bad("Type the words to say");
      if (text.length > MAX_TEXT) return bad(`Keep a patch to ${MAX_TEXT} characters or fewer (about two sentences).`);
      let job = null;
      if (b.jobId) {
        job = await jobsStore().get(String(b.jobId), { type: "json" });
        if (!job || job.owner !== user.email) return bad("Video not found", 404);
        const blocked = approvalBlock(job);
        if (blocked) return bad(blocked, 403);
      }
      const capMsg = await checkSpend(user);
      if (capMsg) return bad(capMsg, 429);
      const ctx = (x) => String(x || "").replace(/\s+/g, " ").trim().slice(-400);
      const out = await speak({ user, voice: v, text, previousText: ctx(b.previousText), nextText: String(b.nextText || "").replace(/\s+/g, " ").trim().slice(0, 400),
        seed: Number.isInteger(b.seed) ? b.seed : undefined, job });
      return json({ audio: out.audio.toString("base64"), mime: out.mime, chars: out.chars, costUsd: out.costUsd, model: out.model });
    }
    return bad("Not found", 404);
  } catch (e) {
    console.error(e);
    return bad(e.message || "Server error", 500);
  }
};

export const config = { path: "/api/voice/*" };
