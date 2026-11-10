// Checks a slide spec: structure, timing anchors, LaTeX and layout.
import { layoutBuild, W, H } from "./render.js";
import { phrasePosition, startsWithScore } from "./timing.js";

const TYPES = new Set(["math", "text", "label", "bullets", "note", "row", "sequence", "trap", "step"]);

export async function checkSpec(spec, chunks) {
  const errors = [];
  if (!spec || !Array.isArray(spec.scenes) || !spec.scenes.length) return ["The spec has no scenes"];
  const byId = new Map(chunks.map((c) => [c.id, c]));
  let lastChunk = -1;
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d");
  for (let si = 0; si < spec.scenes.length; si++) {
    const sc = spec.scenes[si];
    const where = `Scene ${si + 1}${sc.heading ? ` ("${sc.heading}")` : ""}`;
    if (!["title", "content", "summary"].includes(sc.kind)) errors.push(`${where}: kind must be title, content or summary`);
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
