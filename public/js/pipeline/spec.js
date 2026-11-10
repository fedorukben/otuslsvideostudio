// Checks a slide spec: structure, timing anchors, LaTeX and layout.
import { layoutBuild, mathImage, C, W, H } from "./render.js";
import { AdvancedHost } from "./advanced.js";
import { phrasePosition, startsWithScore } from "./timing.js";

const TYPES = new Set(["math", "text", "label", "bullets", "note", "row", "sequence", "trap", "step", "diagram"]);

export async function checkSpec(spec, chunks, { allowAdvanced = true } = {}) {
  const errors = [];
  if (!spec || !Array.isArray(spec.scenes) || !spec.scenes.length) return ["The spec has no scenes"];
  const byId = new Map(chunks.map((c) => [c.id, c]));
  let lastChunk = -1;
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d");
  for (let si = 0; si < spec.scenes.length; si++) {
    const sc = spec.scenes[si];
    const where = `Scene ${si + 1}${sc.heading ? ` ("${sc.heading}")` : ""}`;
    if (!["title", "content", "summary", "advanced"].includes(sc.kind)) errors.push(`${where}: kind must be title, content, summary or advanced`);
    if (sc.kind === "advanced") {
      if (!allowAdvanced) errors.push(`${where}: advanced scenes are turned off for this video; rebuild it with a diagram element instead`);
      else errors.push(...(await checkAdvanced(sc, where)));
    }
    if (!Array.isArray(sc.builds) || !sc.builds.length) { errors.push(`${where}: needs at least one build`); continue; }
    if (sc.kind !== "title" && !sc.heading) errors.push(`${where}: needs a heading`);
    if (sc.kind === "summary") {
      const steps = sc.builds.flatMap((b) => (b.add || []).filter((e) => e.type === "step"));
      if (steps.length < 2 || steps.length > 4) errors.push(`${where}: a summary needs three "step" elements`);
    }
    for (let bi = 0; bi < sc.builds.length; bi++) {
      const b = sc.builds[bi];
      const bw = `${where}, build ${bi + 1}`;
      const ch = byId.get(b.start?.chunk);
      if (!ch) errors.push(`${bw}: start.chunk ${b.start?.chunk} is not a chunk id`);
      else {
        if (b.start.chunk < lastChunk) errors.push(`${bw}: starts at chunk ${b.start.chunk}, before the previous build (chunk ${lastChunk}); builds must be in time order`);
        lastChunk = b.start.chunk;
        const cap = ch.caption ?? ch.text;
        if (b.start.phrase && startsWithScore(cap, b.start.phrase) < 0.67 && phrasePosition(cap, b.start.phrase) == null) {
          errors.push(`${bw}: phrase "${b.start.phrase}" isn't in chunk ${ch.id}'s caption ("${cap.slice(0, 80)}…"); copy 3-6 words exactly`);
        }
      }
      if (sc.kind === "advanced") continue;
      for (const el of [...(b.add || []), ...(b.set || [])]) {
        const check = (e) => {
          if (!TYPES.has(e?.type)) errors.push(`${bw}: unknown element type "${e?.type}"`);
          if (e?.type === "row") (e.items || []).forEach(check);
        };
        check(el);
      }
      try {
        const lay = await layoutBuild(ctx, spec, si, bi);
        for (const e of lay.errors) errors.push(`${bw}: ${e}`);
      } catch (e) {
        errors.push(`${bw}: could not be drawn (${e.message})`);
      }
    }
  }
  return [...new Set(errors)];
}

// Runs an advanced scene's code at several moments to catch errors before rendering.
async function checkAdvanced(sc, where) {
  const errors = [];
  if (typeof sc.code !== "string" || !sc.code.trim()) return [`${where}: an advanced scene needs "code"`];
  if (sc.code.length > 20000) errors.push(`${where}: the scene's code is too long (keep it under 20,000 characters)`);
  const nb = Math.max(1, (sc.builds || []).length);
  const rel = Array.from({ length: nb }, (_, i) => i * 4);
  const host = new AdvancedHost();
  try {
    const colors = { blue: C.simcoe, tangerine: C.tangerine, navy: C.futureBlue, ink: C.ink, grey: C.grey, light: C.light, white: C.white };
    errors.push(...(await host.start({ code: sc.code, tex: sc.tex, colors, mathImage })).map((e) => `${where}: ${e}`));
    for (const t of [0, 0.5, ...rel.map((r) => r + 0.2), ...rel.map((r) => r + 2), rel.at(-1) + 6]) {
      try { const bmp = await host.drawAt(t, rel); bmp.close?.(); }
      catch (e) { errors.push(`${where}: the scene's code failed at t = ${t.toFixed(1)} s: ${e.message}`); break; }
    }
  } catch (e) {
    errors.push(`${where}: the scene's code could not start: ${e.message}`);
  } finally { host.stop(); }
  return errors;
}
