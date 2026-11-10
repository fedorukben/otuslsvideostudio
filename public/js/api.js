// Thin wrapper around the site's API.
export async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const t = await r.text();
  let data;
  try { data = JSON.parse(t); } catch { data = { error: t || r.statusText }; }
  if (!r.ok) {
    const e = new Error(data.error || `Request failed (${r.status})`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// Listeners told about each finished call's cost: (jobId, costUsd) => void
export const costListeners = new Set();

// Runs one Claude stage through the metered proxy and waits for the reply.
export async function claude(jobId, stage, request, { onStatus, signal } = {}) {
  const { id } = await api("POST", "/api/claude/start", { jobId, stage, request });
  const t0 = Date.now();
  let delay = 1000;
  while (true) {
    if (signal?.aborted) throw new Error("Cancelled");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(4000, delay * 1.3);
    const r = await api("GET", `/api/claude/result?id=${encodeURIComponent(id)}`);
    onStatus?.(r.status, Math.round((Date.now() - t0) / 1000));
    if (r.status === "done") { for (const f of costListeners) try { f(jobId, r.costUsd || 0); } catch {} return r; }
    if (r.status === "error") throw new Error(r.error || "Claude call failed");
    if (Date.now() - t0 > 16 * 60 * 1000) throw new Error("Claude call timed out");
  }
}
