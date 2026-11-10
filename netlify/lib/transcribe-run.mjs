// Sends one recording to AssemblyAI, waits for the transcript, records usage + cost,
// then deletes the transcript from AssemblyAI and the uploaded parts from Netlify Blobs.
import {
  store, reqStore, jobsStore, usageStore, getSettings, decrypt, nowIso, monthOf, newId, activeKey,
} from "./lib.mjs";

const API = "https://api.assemblyai.com";
export const partsStore = () => store("audio-parts");

export async function runTranscription(id) {
  const rs = reqStore();
  const r = await rs.get(id, { type: "json" });
  if (!r || r.status !== "queued") return;
  Object.assign(r, { status: "running", startedAt: nowIso() });
  await rs.setJSON(id, r);
  const fetcher = globalThis.__SVS_FETCH || fetch;
  let transcriptId = null, auth = null;
  try {
    const s = await getSettings();
    const key = activeKey(s, "assemblyai");
    if (!key) throw new Error("No active AssemblyAI key");
    auth = { authorization: decrypt(key.enc) };

    // Reassemble the audio from its uploaded parts.
    const ps = partsStore();
    const bufs = [];
    for (let n = 0; n < r.parts; n++) {
      const b64 = await ps.get(`${id}/${n}`);
      if (!b64) throw new Error(`Audio part ${n + 1} of ${r.parts} is missing; upload it again`);
      bufs.push(Buffer.from(b64, "base64"));
    }
    const audio = Buffer.concat(bufs);

    const up = await fetcher(`${API}/v2/upload`, { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: audio });
    if (!up.ok) throw new Error(`AssemblyAI upload failed (${up.status}): ${(await up.text()).slice(0, 300)}`);
    const { upload_url } = await up.json();

    const keyterms = (r.keyterms || []).slice(0, 200);
    const request = async (models) => fetcher(`${API}/v2/transcript`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        audio_url: upload_url, speech_models: models, language_code: "en", punctuate: true, format_text: true,
        ...(keyterms.length ? { keyterms_prompt: keyterms } : {}),
      }),
    });
    let tr = await request(s.assemblyaiModels);
    if (tr.status === 400) {
      // Fall back if the preferred model name isn't accepted.
      const msg = await tr.text();
      if (/speech_model/i.test(msg)) tr = await request(["universal-3-pro", "universal-2"]);
      else throw new Error(`AssemblyAI rejected the request: ${msg.slice(0, 300)}`);
    }
    if (!tr.ok) throw new Error(`AssemblyAI request failed (${tr.status}): ${(await tr.text()).slice(0, 300)}`);
    transcriptId = (await tr.json()).id;

    // Poll until done (a 5-minute recording usually takes well under a minute).
    let result;
    const t0 = Date.now();
    while (true) {
      await new Promise((res) => setTimeout(res, globalThis.__SVS_FETCH ? 50 : 3000));
      const g = await fetcher(`${API}/v2/transcript/${transcriptId}`, { headers: auth });
      if (!g.ok) throw new Error(`AssemblyAI status check failed (${g.status})`);
      result = await g.json();
      if (result.status === "completed") break;
      if (result.status === "error") throw new Error(`AssemblyAI couldn't transcribe this audio: ${result.error}`);
      if (Date.now() - t0 > 13 * 60 * 1000) throw new Error("AssemblyAI took too long");
    }

    const seconds = Number(result.audio_duration) || r.durationSec || 0;
    const model = result.speech_model_used || (s.assemblyaiModels || [])[0] || "universal-2";
    const tp = s.transcriptionPrices;
    const perHour = (tp.perHour[model] ?? tp.perHour["universal-3-5-pro"] ?? 0.21) + (keyterms.length ? tp.keytermsPerHour : 0);
    const cost = (seconds / 3600) * perHour;
    const ts = nowIso();
    await usageStore().setJSON(`${monthOf()}/${ts}-${newId()}`, {
      ts, user: r.owner, jobId: r.jobId, jobTitle: r.jobTitle, stage: "transcribe", model: `assemblyai/${model}`,
      input: 0, output: 0, cacheWrite: 0, cacheRead: 0, audioSeconds: Math.round(seconds), keyterms: keyterms.length,
      costUsd: cost, priced: true,
    });
    const js = jobsStore();
    const job = await js.get(r.jobId, { type: "json" });
    if (job) { job.costUsd = (job.costUsd || 0) + cost; job.calls = (job.calls || 0) + 1; await js.setJSON(job.id, job); }

    const words = (result.words || []).map((w) => ({ w: w.text, s: w.start / 1000, e: w.end / 1000, c: w.confidence }));
    Object.assign(r, { status: "done", words, text: result.text || "", model, audioSeconds: seconds, costUsd: cost, finishedAt: nowIso() });
    await rs.setJSON(id, r);
  } catch (e) {
    console.error(e);
    Object.assign(r, { status: "error", error: String(e.message || e), finishedAt: nowIso() });
    await rs.setJSON(id, r);
  } finally {
    // Privacy: remove the audio parts here and the transcript (and its audio) at AssemblyAI.
    for (let n = 0; n < (r.parts || 0); n++) { try { await partsStore().delete(`${id}/${n}`); } catch {} }
    if (transcriptId && auth) { try { await fetcher(`${API}/v2/transcript/${transcriptId}`, { method: "DELETE", headers: auth }); } catch {} }
  }
}
