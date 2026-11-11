// /api/jobs — a user's videos. The audio and the finished MP4 never come here;
// only titles, settings, the transcript text and the slide spec are stored.
import {
  jobsStore, json, bad, body, requireUser, getSettings, newId, nowIso, monthOf, jobsForMonth, checkSpend, activeKey, estimateVideoCost, costModel,
} from "../lib/lib.mjs";

const STATUSES = ["awaiting-approval", "new", "analysing", "review-transcript", "planning", "review-slides", "rendering", "done", "failed"];

export default async (req) => {
  const { user, error } = await requireUser(req);
  if (error) return error;
  const id = new URL(req.url).pathname.replace(/^\/api\/jobs\/?/, "").split("/")[0] || null;
  try {
    if (req.method === "GET" && !id) {
      const st = jobsStore();
      const { blobs } = await st.list();
      const all = (await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })))).filter(Boolean);
      const mine = all.filter((j) => j.owner === user.email && !j.deleted);
      const s = await getSettings();
      return json({
        jobs: mine.map(summary).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        asrModel: s.asrModel,
        asrProvider: s.asrProvider,
        allowAdvanced: s.allowAdvanced !== false,
        showCost: s.showCost !== false,
      });
    }

    if (req.method === "POST" && !id) {
      const b = await body(req);
      if (!b.title) return bad("Give the video a title");
      const s = await getSettings();
      if (!activeKey(s, "anthropic")) return bad("No Anthropic API key has been set up yet. Ask an admin to add one.");
      if (s.asrProvider === "assemblyai" && !activeKey(s, "assemblyai")) {
        return bad("Transcription is set to AssemblyAI, but no AssemblyAI key has been added. Ask an admin to add one or switch back to in-browser Whisper.");
      }
      const lim = user.monthlyVideoLimit ?? s.defaultUserMonthlyVideoLimit;
      if (lim != null) {
        const mine = (await jobsForMonth(monthOf())).filter((j) => j.owner === user.email).length;
        if (mine >= lim) return bad(`You've reached your limit of ${lim} videos this month. Ask an admin to raise it.`, 429);
      }
      const capMsg = await checkSpend(user);
      if (capMsg) return bad(capMsg, 429);
      const durationSec = Math.max(0, Math.min(4 * 3600, Number(b.durationSec) || 0));
      const model = await costModel();
      const estimateUsd = estimateVideoCost(s, durationSec, model);
      const needs = s.approvalMode === "always" || (s.approvalMode === "threshold" && estimateUsd > (s.approvalThresholdUsd ?? 1));
      const auto = needs && user.role === "admin"; // admins approve their own videos
      const approval = needs ? {
        required: true, status: auto ? "approved" : "pending", estimateUsd, limitUsd: auto ? null : null,
        requestedAt: nowIso(), ...(auto ? { decidedBy: user.email, decidedAt: nowIso(), note: "Admin's own video" } : {}),
      } : { required: false, estimateUsd };
      approval.estimateModel = { base: model.base, perMin: model.perMin, n: model.n };
      const job = {
        id: newId(), owner: user.email, ownerName: user.name, title: String(b.title).slice(0, 120), durationSec, approval,
        eyebrow: String(b.eyebrow || "").slice(0, 60), subtitle: String(b.subtitle || "").slice(0, 160),
        stream: ["cp", "chem", "phys"].includes(b.stream) ? b.stream : "math", status: approval.status === "pending" ? "awaiting-approval" : "new",
        createdAt: nowIso(), updatedAt: nowIso(),
        costUsd: 0, calls: 0, audioName: String(b.audioName || ""), state: { notes: String(b.notes || "").slice(0, 4000),
          script: String(b.script || "").slice(0, 60000), tipsheet: String(b.tipsheet || "").slice(0, 60000),
          advancedMode: s.allowAdvanced === false ? "off" : ["off", "auto", "requested"].includes(b.advancedMode) ? b.advancedMode : "auto",
          advancedNotes: String(b.advancedNotes || "").slice(0, 3000), enhance: b.enhance !== false },
      };
      await jobsStore().setJSON(job.id, job);
      return json({ job });
    }

    if (id) {
      const job = await jobsStore().get(id, { type: "json" });
      if (!job || (job.owner !== user.email && user.role !== "admin")) return bad("Video not found", 404);
      if (req.method === "GET") { const s = await getSettings(); return json({ job: { ...job, allowAdvanced: s.allowAdvanced !== false }, showCost: s.showCost !== false, asrProvider: s.asrProvider, asrModel: s.asrModel }); }
      if (req.method === "PATCH") {
        if (job.owner !== user.email) return bad("Only the owner can change this video", 403);
        const b = await body(req);
        const waiting = job.approval?.required && job.approval.status !== "approved";
        if (b.status && STATUSES.includes(b.status) && !waiting && b.status !== "awaiting-approval") job.status = b.status;
        if (b.state && typeof b.state === "object") job.state = { ...job.state, ...b.state };
        if (b.title) job.title = String(b.title).slice(0, 120);
        job.updatedAt = nowIso();
        const size = JSON.stringify(job).length;
        if (size > 4_000_000) return bad("Video data is too large to save", 413);
        await jobsStore().setJSON(id, job);
        return json({ job: summary(job) });
      }
      if (req.method === "DELETE") {
        if (job.owner !== user.email && user.role !== "admin") return bad("Not allowed", 403);
        job.deleted = true; // keep the record so metering history stays intact
        job.status = job.status === "done" ? "done" : "failed";
        job.state = {};
        await jobsStore().setJSON(id, job);
        return json({ ok: true });
      }
    }
    return bad("Not found", 404);
  } catch (e) {
    console.error(e);
    return bad(e.message || "Server error", 500);
  }
};

const summary = ({ state, ...j }) => j;

export const config = { path: ["/api/jobs", "/api/jobs/*"] };
