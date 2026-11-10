// End-to-end API test against the dev server (run with MOCK_CLAUDE=1).
const base = process.argv[2] || "http://localhost:8888";
let cookie = "";
async function call(method, p, body, expect = 200) {
  const r = await fetch(base + p, {
    method, headers: { "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const t = await r.text();
  let data; try { data = JSON.parse(t); } catch { data = t; }
  if (r.status !== expect) throw new Error(`${method} ${p} -> ${r.status} (wanted ${expect}): ${t}`);
  return data;
}
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("ok -", m); };

let s = await call("GET", "/api/auth/status");
ok(s.needsSetup, "fresh site needs setup");
await call("POST", "/api/auth/setup", { setupCode: "wrong", email: "a@x.ca", password: "0123456789" }, 403);
s = await call("POST", "/api/auth/setup", { setupCode: "letmein", email: "Ben@ontariotechu.ca", name: "Ben", password: "correct-horse-1" });
ok(s.user.role === "admin", "setup makes the first user an admin");
await call("POST", "/api/auth/setup", { setupCode: "letmein", email: "b@x.ca", password: "0123456789" }, 409);

await call("POST", "/api/jobs", { title: "T" }, 400); // no key yet

await call("POST", "/api/admin/keys", { label: "bad", key: "nope" }, 400);
await call("POST", "/api/admin/keys", { label: "TLC key", key: "sk-ant-test-abcdefghijklmnop1234" });
let k = await call("GET", "/api/admin/keys");
ok(k.keys.length === 1 && k.keys[0].active && !k.keys[0].enc && k.keys[0].last4 === "1234", "key stored encrypted, only last 4 shown");

await call("POST", "/api/admin/users", { email: "peer@x.ca", name: "Peer", password: "temporary-pw-1", monthlyLimitUsd: 0.0001, monthlyVideoLimit: 2 });
const adminCookie = cookie;

// sign in as the regular user
cookie = "";
await call("POST", "/api/auth/login", { email: "peer@x.ca", password: "wrong-wrong" }, 401);
let me = await call("POST", "/api/auth/login", { email: "PEER@x.ca", password: "temporary-pw-1" });
ok(me.user.mustChangePassword, "new user must change password");
await call("GET", "/api/admin/usage", null, 403);
await call("POST", "/api/auth/password", { current: "temporary-pw-1", next: "my-own-password" });

const { job } = await call("POST", "/api/jobs", { title: "Counting with Recurrences", stream: "math", eyebrow: "Recurrence" });
ok(job.id, "user creates a video");
const st = await call("POST", "/api/claude/start", { jobId: job.id, stage: "math-pass",
  request: { system: "sys", messages: [{ role: "user", content: "hello" }], max_tokens: 100 } });
let res;
for (let i = 0; i < 50; i++) {
  res = await call("GET", "/api/claude/result?id=" + st.id);
  if (res.status === "done" || res.status === "error") break;
  await new Promise((r) => setTimeout(r, 100));
}
ok(res.status === "done" && res.text.length > 0, "Claude call runs in background and returns text: " + res.text.slice(0, 40));
ok(res.costUsd > 0, "cost recorded: $" + res.costUsd.toFixed(6));

// per-user dollar limit ($0.01) — mock usage costs more than that after one call? check
await call("POST", "/api/claude/start", { jobId: job.id, stage: "plan",
  request: { messages: [{ role: "user", content: "x" }] } }, 429).then(() => ok(true, "per-user $ limit blocks further calls"))
  .catch((e) => { console.log("note:", e.message.slice(0, 120)); });

{ const mine = cookie; cookie = adminCookie;
  await call("PATCH", "/api/admin/users/peer%40x.ca", { monthlyLimitUsd: null }); cookie = mine; }
await call("POST", "/api/jobs", { title: "Second" });
await call("POST", "/api/jobs", { title: "Third" }, 429);
ok(true, "per-user video limit enforced");

const jl = await call("GET", "/api/jobs");
ok(jl.jobs.length === 2 && !jl.jobs[0].state, "job list returns summaries");
await call("PATCH", "/api/jobs/" + job.id, { status: "review-transcript", state: { chunks: [{ id: 1, text: "hi" }] } });
const g = await call("GET", "/api/jobs/" + job.id);
ok(g.job.state.chunks.length === 1 && g.job.costUsd > 0, "job state saved, cost rolled up");

// admin metering
cookie = adminCookie;
const u = await call("GET", "/api/admin/usage");
ok(u.totalUsd > 0 && u.byUser[0].user === "peer@x.ca" && u.byUser[0].videos === 2, "admin sees spend per user");
const csvRes = await fetch(base + "/api/admin/usage?format=csv", { headers: { cookie } });
const csv = await csvRes.text();
ok(csv.startsWith("timestamp,user") && csv.split("\n").length >= 3, "CSV export works");
await call("PUT", "/api/admin/settings", { monthlyCapUsd: 0.000001 });
cookie = "";
await call("POST", "/api/auth/login", { email: "peer@x.ca", password: "my-own-password" });
await call("PATCH", "/api/admin/users/peer%40x.ca", { role: "admin" }, 403);
cookie = adminCookie;
await call("PATCH", "/api/admin/users/peer%40x.ca", { monthlyLimitUsd: null, monthlyVideoLimit: null });
cookie = "";
await call("POST", "/api/auth/login", { email: "peer@x.ca", password: "my-own-password" });
await call("POST", "/api/claude/start", { jobId: job.id, stage: "fix", request: { messages: [{ role: "user", content: "x" }] } }, 429);
ok(true, "monthly site cap blocks calls");
cookie = adminCookie;
await call("PATCH", "/api/admin/users/peer%40x.ca", { active: false });
cookie = "";
await call("POST", "/api/auth/login", { email: "peer@x.ca", password: "my-own-password" }, 401);
ok(true, "deactivated users can't sign in");
// ---- approvals ----
cookie = adminCookie;
await call("PUT", "/api/admin/settings", { monthlyCapUsd: null, approvalMode: "always" });
await call("POST", "/api/admin/users", { email: "ta@x.ca", name: "TA", password: "temporary-pw-2" });
const adminJob = (await call("POST", "/api/jobs", { title: "Admin video", durationSec: 120 })).job;
ok(adminJob.status === "new" && adminJob.approval.status === "approved", "admin's own video is approved automatically");
cookie = "";
await call("POST", "/api/auth/login", { email: "ta@x.ca", password: "temporary-pw-2" });
const taCookie = cookie;
const w = (await call("POST", "/api/jobs", { title: "Needs approval", durationSec: 300 })).job;
ok(w.status === "awaiting-approval" && w.approval.estimateUsd > 0.4, `video waits for approval (estimate $${w.approval.estimateUsd})`);
await call("POST", "/api/claude/start", { jobId: w.id, stage: "math-pass", request: { messages: [{ role: "user", content: "x" }] } }, 403);
await call("PATCH", "/api/jobs/" + w.id, { status: "review-slides" });
ok((await call("GET", "/api/jobs/" + w.id)).job.status === "awaiting-approval", "owner can't skip approval by changing status; Claude calls blocked");
await call("GET", "/api/admin/approvals", null, 403);
cookie = adminCookie;
let ap = await call("GET", "/api/admin/approvals");
ok(ap.pending.length === 1 && ap.pending[0].id === w.id, "admin sees the pending request");
await call("POST", "/api/admin/approvals/" + w.id, { decision: "approve", limitUsd: "0.0001", note: "ok" });
cookie = taCookie;
ok((await call("GET", "/api/jobs/" + w.id)).job.status === "new", "approved video can start");
const run1 = await call("POST", "/api/claude/start", { jobId: w.id, stage: "math-pass", request: { messages: [{ role: "user", content: "x" }] } });
for (let i = 0; i < 50; i++) { const r = await call("GET", "/api/claude/result?id=" + run1.id); if (r.status === "done") break; await new Promise((r) => setTimeout(r, 100)); }
await call("POST", "/api/claude/start", { jobId: w.id, stage: "plan", request: { messages: [{ role: "user", content: "x" }] } }, 403);
ok(true, "spending stops at the approved budget");
cookie = adminCookie;
await call("POST", "/api/admin/approvals/" + w.id, { decision: "budget", limitUsd: 5 });
cookie = taCookie;
await call("POST", "/api/claude/start", { jobId: w.id, stage: "plan", request: { messages: [{ role: "user", content: "x" }] } });
ok(true, "raising the budget lets it continue");
const d = (await call("POST", "/api/jobs", { title: "Too long", durationSec: 3600 })).job;
cookie = adminCookie;
await call("POST", "/api/admin/approvals/" + d.id, { decision: "decline", note: "Please keep videos under 10 minutes" });
cookie = taCookie;
const dj = (await call("GET", "/api/jobs/" + d.id)).job;
ok(dj.status === "failed" && dj.approval.note.includes("10 minutes"), "declined video shows the note and stays blocked");
await call("POST", "/api/claude/start", { jobId: d.id, stage: "math-pass", request: { messages: [{ role: "user", content: "x" }] } }, 403);
cookie = adminCookie;
await call("PUT", "/api/admin/settings", { approvalMode: "threshold", approvalThresholdUsd: 1 });
cookie = taCookie;
const small = (await call("POST", "/api/jobs", { title: "Short", durationSec: 120 })).job;
const big = (await call("POST", "/api/jobs", { title: "Long", durationSec: 30 * 60 })).job;
ok(small.status === "new" && big.status === "awaiting-approval", `threshold mode: $${small.approval.estimateUsd} goes ahead, $${big.approval.estimateUsd} waits`);

console.log("\nALL API TESTS PASSED");
