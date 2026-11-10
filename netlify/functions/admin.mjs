// /api/admin/* — users, API keys, settings, metering. Admin role only.
import {
  users, json, bad, body, requireUser, publicUser, emailKey, hashPassword, validPassword, nowIso,
  getSettings, saveSettings, encrypt, newId, usageForMonth, jobsForMonth, monthOf, PROVIDERS, jobsStore, costModel, estimateVideoCost,
} from "../lib/lib.mjs";

export default async (req) => {
  const { user: admin, error } = await requireUser(req, "admin");
  if (error) return error;
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/admin\/?/, "").split("/").filter(Boolean);
  const [area, id] = parts;
  try {
    // ----- users -----
    if (area === "users") {
      if (req.method === "GET") {
        const { blobs } = await users().list();
        const all = await Promise.all(blobs.map((b) => users().get(b.key, { type: "json" })));
        return json({ users: all.filter(Boolean).map(publicUser).sort((a, b) => a.email.localeCompare(b.email)) });
      }
      if (req.method === "POST" && !id) {
        const b = await body(req);
        const email = emailKey(b.email);
        if (!email.includes("@")) return bad("Enter a valid email");
        if (await users().get(email, { type: "json" })) return bad("That user already exists", 409);
        if (!validPassword(b.password)) return bad("Temporary password must be at least 10 characters");
        const u = {
          email, name: b.name || email, role: b.role === "admin" ? "admin" : "user", active: true,
          monthlyLimitUsd: num(b.monthlyLimitUsd), monthlyVideoLimit: num(b.monthlyVideoLimit),
          createdAt: nowIso(), createdBy: admin.email, sessionVersion: 0, mustChangePassword: true,
          ...hashPassword(b.password),
        };
        await users().setJSON(email, u);
        return json({ user: publicUser(u) });
      }
      if (req.method === "PATCH" && id) {
        const email = emailKey(decodeURIComponent(id));
        const u = await users().get(email, { type: "json" });
        if (!u) return bad("No such user", 404);
        const b = await body(req);
        if (email === admin.email && (b.role === "user" || b.active === false)) {
          return bad("You can't remove your own admin role or deactivate yourself");
        }
        if (b.name !== undefined) u.name = b.name;
        if (b.role !== undefined) u.role = b.role === "admin" ? "admin" : "user";
        if (b.active !== undefined) { u.active = !!b.active; u.sessionVersion = (u.sessionVersion || 0) + 1; }
        if (b.monthlyLimitUsd !== undefined) u.monthlyLimitUsd = num(b.monthlyLimitUsd);
        if (b.monthlyVideoLimit !== undefined) u.monthlyVideoLimit = num(b.monthlyVideoLimit);
        if (b.password) {
          if (!validPassword(b.password)) return bad("Password must be at least 10 characters");
          Object.assign(u, hashPassword(b.password), { mustChangePassword: true, sessionVersion: (u.sessionVersion || 0) + 1 });
        }
        await users().setJSON(email, u);
        return json({ user: publicUser(u) });
      }
      if (req.method === "DELETE" && id) {
        const email = emailKey(decodeURIComponent(id));
        if (email === admin.email) return bad("You can't delete yourself");
        await users().delete(email);
        return json({ ok: true });
      }
    }

    // ----- API keys -----
    if (area === "keys") {
      const s = await getSettings();
      if (req.method === "GET") return json({ keys: s.keys.map(({ enc, ...k }) => k) });
      if (req.method === "POST" && !id) {
        const b = await body(req);
        const key = String(b.key || "").trim();
        const provider = PROVIDERS.includes(b.provider) ? b.provider : "anthropic";
        if (provider === "anthropic" && !key.startsWith("sk-ant-")) return bad("That doesn't look like an Anthropic API key (it should start with sk-ant-)");
        if (provider === "assemblyai" && !/^[A-Za-z0-9_-]{20,}$/.test(key)) return bad("That doesn't look like an AssemblyAI API key");
        const k = { id: newId(), provider, label: b.label || (provider === "assemblyai" ? "AssemblyAI key" : "Anthropic key"),
          last4: key.slice(-4), enc: encrypt(key), active: !s.keys.some((x) => x.provider === provider && x.active),
          addedAt: nowIso(), addedBy: admin.email };
        s.keys.push(k);
        await saveSettings(s);
        return json({ ok: true });
      }
      if (req.method === "PATCH" && id) {
        const b = await body(req);
        const target = s.keys.find((k) => k.id === id);
        if (!target) return bad("No such key", 404);
        if (b.active) s.keys.forEach((k) => { if (k.provider === target.provider) k.active = k.id === id; });
        if (b.label) s.keys.forEach((k) => { if (k.id === id) k.label = b.label; });
        await saveSettings(s);
        return json({ ok: true });
      }
      if (req.method === "DELETE" && id) {
        s.keys = s.keys.filter((k) => k.id !== id);
        for (const p of PROVIDERS) {
          const mine = s.keys.filter((k) => k.provider === p);
          if (mine.length && !mine.some((k) => k.active)) mine[0].active = true;
        }
        await saveSettings(s);
        return json({ ok: true });
      }
    }

    // ----- approvals -----
    if (area === "approvals") {
      const st = jobsStore();
      if (req.method === "GET") {
        const { blobs } = await st.list();
        const all = (await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })))).filter((j) => j && !j.deleted && j.approval?.required);
        const view = ({ state, ...j }) => j;
        return json({
          pending: all.filter((j) => j.approval.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(view),
          recent: all.filter((j) => j.approval.status !== "pending").sort((a, b) => (b.approval.decidedAt || "").localeCompare(a.approval.decidedAt || "")).slice(0, 25).map(view),
        });
      }
      if (req.method === "POST" && id) {
        const job = await st.get(id, { type: "json" });
        if (!job?.approval?.required) return bad("That video doesn't need approval", 404);
        const b = await body(req);
        if (b.decision === "approve") {
          const lim = b.limitUsd === "" || b.limitUsd == null ? null : Number(b.limitUsd);
          if (lim != null && !(lim > 0)) return bad("Budget must be a positive amount, or blank for no per-video limit");
          job.approval = { ...job.approval, status: "approved", limitUsd: lim, decidedBy: admin.email, decidedAt: nowIso(), note: String(b.note || "").slice(0, 500) };
          if (job.status === "awaiting-approval" || job.status === "failed") job.status = "new";
        } else if (b.decision === "decline") {
          job.approval = { ...job.approval, status: "declined", decidedBy: admin.email, decidedAt: nowIso(), note: String(b.note || "").slice(0, 500) };
          job.status = "failed";
        } else if (b.decision === "budget") {
          const lim = Number(b.limitUsd);
          if (!(lim > 0)) return bad("Enter a positive budget");
          job.approval = { ...job.approval, limitUsd: lim, decidedBy: admin.email, decidedAt: nowIso() };
        } else return bad("decision must be approve, decline or budget");
        job.updatedAt = nowIso();
        await st.setJSON(id, job);
        return json({ ok: true });
      }
    }

    // ----- settings -----
    if (area === "settings") {
      const s = await getSettings();
      if (req.method === "GET") { const { keys, ...rest } = s; return json({ settings: rest }); }
      if (req.method === "PUT") {
        const b = await body(req);
        for (const f of ["monthlyCapUsd", "defaultUserMonthlyLimitUsd", "defaultUserMonthlyVideoLimit"]) {
          if (b[f] !== undefined) s[f] = num(b[f]);
        }
        if (typeof b.asrModel === "string" && b.asrModel) s.asrModel = b.asrModel;
        if (["browser", "assemblyai"].includes(b.asrProvider)) s.asrProvider = b.asrProvider;
        if (b.transcriptionPrices && typeof b.transcriptionPrices === "object") {
          const tp = b.transcriptionPrices;
          if (typeof tp.keytermsPerHour !== "number" || !tp.perHour || Object.values(tp.perHour).some((v) => typeof v !== "number")) {
            return bad("Transcription prices need numeric perHour values and keytermsPerHour");
          }
          s.transcriptionPrices = tp;
        }
        if (typeof b.showCost === "boolean") s.showCost = b.showCost;
        if (typeof b.allowAdvanced === "boolean") s.allowAdvanced = b.allowAdvanced;
        if (["none", "threshold", "always"].includes(b.approvalMode)) s.approvalMode = b.approvalMode;
        if (b.approvalThresholdUsd !== undefined) {
          const t = num(b.approvalThresholdUsd);
          if (t == null || t < 0) return bad("Approval threshold must be a dollar amount");
          s.approvalThresholdUsd = t;
        }
        if (b.stageModels && typeof b.stageModels === "object") s.stageModels = { ...s.stageModels, ...b.stageModels };
        if (b.prices && typeof b.prices === "object") {
          for (const [m, p] of Object.entries(b.prices)) {
            if (!p || typeof p.input !== "number" || typeof p.output !== "number") return bad(`Prices for ${m} need numeric input and output`);
          }
          s.prices = b.prices;
        }
        await saveSettings(s);
        const { keys, ...rest } = s;
        return json({ settings: rest });
      }
    }

    // ----- metering -----
    if (area === "usage" && req.method === "GET") {
      const month = url.searchParams.get("month") || monthOf();
      const [rows, jobs, s] = await Promise.all([usageForMonth(month), jobsForMonth(month), getSettings()]);
      if (url.searchParams.get("format") === "csv") {
        const head = ["timestamp", "user", "job_id", "job_title", "stage", "model", "input_tokens", "output_tokens",
          "cache_write_tokens", "cache_read_tokens", "audio_seconds", "cost_usd"];
        const lines = rows.map((r) => [r.ts, r.user, r.jobId, r.jobTitle, r.stage, r.model, r.input, r.output,
          r.cacheWrite, r.cacheRead, r.audioSeconds ?? "", (r.costUsd || 0).toFixed(6)].map(csv).join(","));
        return new Response([head.join(","), ...lines].join("\n") + "\n", {
          headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="sls-video-usage-${month}.csv"` },
        });
      }
      const total = rows.reduce((a, r) => a + (r.costUsd || 0), 0);
      const byUser = {}, byStage = {}, byJob = {};
      for (const r of rows) {
        const u = (byUser[r.user] ||= { user: r.user, costUsd: 0, calls: 0, videos: 0 });
        u.costUsd += r.costUsd || 0; u.calls++;
        const st = (byStage[`${r.stage}|${r.model}`] ||= { stage: r.stage, model: r.model, costUsd: 0, calls: 0, input: 0, output: 0, audioSeconds: 0 });
        st.audioSeconds += r.audioSeconds || 0;
        st.costUsd += r.costUsd || 0; st.calls++; st.input += (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0); st.output += r.output || 0;
        const j = (byJob[r.jobId] ||= { jobId: r.jobId, title: r.jobTitle, user: r.user, costUsd: 0, calls: 0 });
        j.costUsd += r.costUsd || 0; j.calls++;
      }
      for (const j of jobs) (byUser[j.owner] ||= { user: j.owner, costUsd: 0, calls: 0, videos: 0 }).videos++;
      for (const j of jobs) if (byJob[j.id]) Object.assign(byJob[j.id], { status: j.status, createdAt: j.createdAt });
      const cm = await costModel();
      const estimates = {
        base: cm.base, perMin: cm.perMin, n: cm.n, weight: cm.weight ?? 0, source: cm.source,
        example5min: estimateVideoCost(s, 300, cm),
        recent: (cm.points || []).sort((a, b) => (b.finishedAt || "").localeCompare(a.finishedAt || "")).slice(0, 20),
      };
      return json({
        estimates,
        month, totalUsd: total, capUsd: s.monthlyCapUsd, calls: rows.length, videos: jobs.length,
        byUser: Object.values(byUser).sort((a, b) => b.costUsd - a.costUsd),
        byStage: Object.values(byStage).sort((a, b) => b.costUsd - a.costUsd),
        byJob: Object.values(byJob).sort((a, b) => b.costUsd - a.costUsd),
        recent: rows.slice(-50).reverse(),
      });
    }
    return bad("Not found", 404);
  } catch (e) {
    console.error(e);
    return bad(e.message || "Server error", 500);
  }
};

const num = (v) => (v === null || v === "" || v === undefined || isNaN(Number(v)) ? null : Number(v));
const csv = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const config = { path: ["/api/admin/*"] };
