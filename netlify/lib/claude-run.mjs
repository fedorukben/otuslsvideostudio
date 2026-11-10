// Makes one queued Claude call, streams the reply, and records usage + cost.
import {
  reqStore, jobsStore, usageStore, getSettings, decrypt, costOf, nowIso, monthOf, newId, activeKey,
} from "./lib.mjs";

export async function runRequest(id) {
  const rs = reqStore();
  const r = await rs.get(id, { type: "json" });
  if (!r || r.status !== "queued") return;
  r.status = "running";
  r.startedAt = nowIso();
  await rs.setJSON(id, r);

  try {
    const s = await getSettings();
    const key = activeKey(s, "anthropic");
    if (!key) throw new Error("No active Anthropic API key");
    const apiKey = decrypt(key.enc);
    const req = r.request;
    const payload = {
      model: r.model,
      max_tokens: req.max_tokens,
      stream: true,
      messages: req.messages,
      ...(req.system ? { system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    const fetcher = globalThis.__SVS_FETCH || fetch;
    const resp = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const t = await resp.text();
      let msg = t;
      try { msg = JSON.parse(t).error?.message || t; } catch {}
      throw new Error(`Claude API error ${resp.status}: ${msg}`.slice(0, 600));
    }

    // Parse the server-sent event stream.
    let text = "", usage = {}, stopReason = null, buf = "";
    const dec = new TextDecoder();
    for await (const chunk of resp.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const ev = JSON.parse(dataLine.slice(5));
        if (ev.type === "message_start") usage = { ...ev.message.usage };
        else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") text += ev.delta.text;
        else if (ev.type === "message_delta") {
          usage = { ...usage, ...ev.usage };
          stopReason = ev.delta?.stop_reason || stopReason;
        } else if (ev.type === "error") throw new Error(ev.error?.message || "Stream error");
      }
    }

    const cost = costOf(s.prices, r.model, usage) ?? 0;
    const ts = nowIso();
    await usageStore().setJSON(`${monthOf()}/${ts}-${newId()}`, {
      ts, user: r.owner, jobId: r.jobId, jobTitle: r.jobTitle, stage: r.stage, model: r.model,
      input: usage.input_tokens || 0, output: usage.output_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0, cacheRead: usage.cache_read_input_tokens || 0,
      costUsd: cost, priced: s.prices[r.model] ? true : false,
    });
    const js = jobsStore();
    const job = await js.get(r.jobId, { type: "json" });
    if (job) {
      job.costUsd = (job.costUsd || 0) + cost;
      job.calls = (job.calls || 0) + 1;
      await js.setJSON(job.id, job);
    }
    Object.assign(r, { status: "done", text, usage, costUsd: cost, stopReason, finishedAt: nowIso() });
    delete r.request; // don't keep prompts longer than needed
    await rs.setJSON(id, r);
  } catch (e) {
    console.error(e);
    Object.assign(r, { status: "error", error: String(e.message || e), finishedAt: nowIso() });
    delete r.request;
    await rs.setJSON(id, r);
  }
}
