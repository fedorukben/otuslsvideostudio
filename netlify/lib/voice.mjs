// Voice patching with ElevenLabs: each person's own Instant Voice Clone, used to re-say a line of narration.
// The voice sample is uploaded in parts, sent to ElevenLabs once, then deleted here.
import {
  store, reqStore, jobsStore, usageStore, getSettings, decrypt, nowIso, monthOf, newId, activeKey, emailKey,
} from "./lib.mjs";

export const API = "https://api.elevenlabs.io";
export const voices = () => store("voices");
export const samplePartsStore = () => store("voice-sample-parts");
const fetcher = () => globalThis.__SVS_FETCH || fetch;

export const DEFAULT_VOICE_SETTINGS = { stability: 0.5, similarity: 0.8, style: 0, speed: 1 };

// What the person sees about their own voice (never the ElevenLabs key).
export function publicVoice(v) {
  if (!v) return { enabled: false, status: "none", settings: { ...DEFAULT_VOICE_SETTINGS } };
  return {
    enabled: !!v.enabled, status: v.status || "none", error: v.error || null,
    hasVoice: !!v.voiceId, sampleName: v.sampleName || null, sampleSeconds: v.sampleSeconds || null,
    createdAt: v.createdAt || null, consentAt: v.consentAt || null, removedNoise: !!v.removedNoise,
    settings: { ...DEFAULT_VOICE_SETTINGS, ...(v.settings || {}) },
  };
}

export async function elevenAuth() {
  const s = await getSettings();
  const key = activeKey(s, "elevenlabs");
  if (!key) throw new Error("No ElevenLabs key has been set up. Ask an admin to add one.");
  return { s, headers: { "xi-api-key": decrypt(key.enc) } };
}

// Removes a voice at ElevenLabs (if any) and the record here.
export async function deleteVoice(email) {
  const vs = voices();
  const v = await vs.get(emailKey(email), { type: "json" });
  if (!v) return;
  if (v.voiceId) {
    try {
      const { headers } = await elevenAuth();
      const r = await fetcher()(`${API}/v1/voices/${encodeURIComponent(v.voiceId)}`, { method: "DELETE", headers });
      if (!r.ok && r.status !== 404) throw new Error(`ElevenLabs couldn't delete the voice (${r.status})`);
    } catch (e) { console.error(e); throw e; }
  }
  await vs.delete(emailKey(email));
}

// Background step: build the sample from its parts, create the clone, replace any older voice.
export async function runClone(id) {
  const rs = reqStore();
  const r = await rs.get(id, { type: "json" });
  if (!r || r.status !== "queued") return;
  Object.assign(r, { status: "running", startedAt: nowIso() });
  await rs.setJSON(id, r);
  const vs = voices();
  const email = emailKey(r.owner);
  try {
    const { headers } = await elevenAuth();
    const ps = samplePartsStore();
    const bufs = [];
    for (let n = 0; n < r.parts; n++) {
      const b64 = await ps.get(`${id}/${n}`);
      if (!b64) throw new Error(`Sample part ${n + 1} of ${r.parts} is missing; upload it again`);
      bufs.push(Buffer.from(b64, "base64"));
    }
    const audio = Buffer.concat(bufs);
    const form = new FormData();
    form.append("name", `SLS – ${r.ownerName || email}`.slice(0, 90));
    form.append("description", `SLS Video Studio voice for ${email}. Consent recorded ${r.consentAt}.`);
    form.append("remove_background_noise", r.removeNoise ? "true" : "false");
    form.append("labels", JSON.stringify({ app: "sls-video-studio" }));
    form.append("files", new Blob([audio], { type: r.mime || "audio/mpeg" }), r.sampleName || "sample.m4a");
    const resp = await fetcher()(`${API}/v1/voices/add`, { method: "POST", headers, body: form });
    if (!resp.ok) throw new Error(`ElevenLabs couldn't create the voice (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
    const out = await resp.json();
    if (!out.voice_id) throw new Error("ElevenLabs didn't return a voice id");

    const old = await vs.get(email, { type: "json" });
    if (old?.voiceId && old.voiceId !== out.voice_id) {
      try { await fetcher()(`${API}/v1/voices/${encodeURIComponent(old.voiceId)}`, { method: "DELETE", headers }); } catch {}
    }
    await vs.setJSON(email, {
      ...(old || {}), email, status: "ready", error: null, voiceId: out.voice_id,
      sampleName: r.sampleName, sampleSeconds: r.durationSec, removedNoise: !!r.removeNoise,
      createdAt: nowIso(), consentAt: r.consentAt, consentText: r.consentText,
      enabled: old ? old.enabled : true, settings: old?.settings || { ...DEFAULT_VOICE_SETTINGS },
    });
    Object.assign(r, { status: "done", finishedAt: nowIso() });
    await rs.setJSON(id, r);
  } catch (e) {
    console.error(e);
    const old = await vs.get(email, { type: "json" });
    if (old) await vs.setJSON(email, { ...old, status: old.voiceId ? "ready" : "error", error: String(e.message || e) });
    Object.assign(r, { status: "error", error: String(e.message || e), finishedAt: nowIso() });
    await rs.setJSON(id, r);
  } finally {
    for (let n = 0; n < (r.parts || 0); n++) { try { await samplePartsStore().delete(`${id}/${n}`); } catch {} }
  }
}

// One take of one line, in the person's voice. Returns { audio: Buffer, mime, chars, costUsd, model }.
export async function speak({ user, voice, text, previousText, nextText, seed, job }) {
  const { s, headers } = await elevenAuth();
  const model = s.elevenlabsModel || "eleven_multilingual_v2";
  const st = { ...DEFAULT_VOICE_SETTINGS, ...(voice.settings || {}) };
  const resp = await fetcher()(`${API}/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}?output_format=mp3_44100_128`, {
    method: "POST", headers: { ...headers, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text, model_id: model,
      voice_settings: { stability: st.stability, similarity_boost: st.similarity, style: st.style, speed: st.speed, use_speaker_boost: true },
      ...(previousText ? { previous_text: previousText } : {}), ...(nextText ? { next_text: nextText } : {}),
      ...(Number.isInteger(seed) ? { seed } : {}),
    }),
  });
  if (!resp.ok) {
    const msg = (await resp.text()).slice(0, 300);
    if (resp.status === 404) throw new Error("ElevenLabs can't find your voice any more. Set it up again on the Voice page.");
    throw new Error(`ElevenLabs couldn't make the audio (${resp.status}): ${msg}`);
  }
  const audio = Buffer.from(await resp.arrayBuffer());
  const chars = Number(resp.headers.get("character-cost") || resp.headers.get("x-character-count")) || text.length;
  const per1k = s.voicePrices?.[model] ?? 0.1;
  const costUsd = (chars / 1000) * per1k;
  const ts = nowIso();
  await usageStore().setJSON(`${monthOf()}/${ts}-${newId()}`, {
    ts, user: user.email, jobId: job?.id || null, jobTitle: job?.title || "(voice test)", stage: "voice", model: `elevenlabs/${model}`,
    input: 0, output: 0, cacheWrite: 0, cacheRead: 0, characters: chars, costUsd, priced: true,
  });
  if (job) {
    const js = jobsStore();
    const j = await js.get(job.id, { type: "json" });
    if (j) { j.costUsd = (j.costUsd || 0) + costUsd; j.calls = (j.calls || 0) + 1; await js.setJSON(j.id, j); }
  }
  return { audio, mime: resp.headers.get("content-type") || "audio/mpeg", chars, costUsd, model };
}
