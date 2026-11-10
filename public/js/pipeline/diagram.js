// Diagrams: shapes with text or LaTeX labels, drawn on the slide, that move between builds.
// A shape keeps its "id" from one build to the next; the renderer animates the change
// (grow, shrink, slide, fade). New shapes enter, removed shapes fade out.

const NUM_KEYS = ["x", "y", "w", "h", "cx", "cy", "r", "x1", "y1", "x2", "y2", "opacity", "fillOpacity", "strokeWidth", "offset", "size"];
const TYPES = new Set(["rect", "line", "circle", "text", "dim", "poly"]);

export const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2); // ease-in-out cubic
const lerp = (a, b, p) => a + (b - a) * p;

// colours: brand names or #RRGGBB
export function makeColor(C) {
  const NAMED = { blue: C.simcoe, simcoe: C.simcoe, tangerine: C.tangerine, orange: C.tangerine, navy: C.futureBlue,
    grey: C.grey, gray: C.grey, ink: C.ink, light: C.light, white: C.white, black: "#000000" };
  return (c, fallback) => (c === "none" ? null : NAMED[c] || (/^#[0-9a-f]{6}$/i.test(c || "") ? c : fallback));
}

// ---------- layout (measure labels, check bounds) ----------
export async function layoutDiagram(ctx, el, maxW, { mathImage, C, font }) {
  const color = makeColor(C);
  const errors = [];
  const w = Math.min(maxW, Number(el.width) || maxW);
  const h = Math.max(40, Math.min(640, Number(el.height) || 360));
  const shapes = (el.shapes || []).slice(0, 80);
  if ((el.shapes || []).length > 80) errors.push("A diagram can have at most 80 shapes");
  const byId = new Map();
  const items = [];
  for (const [i, raw] of shapes.entries()) {
    if (!TYPES.has(raw?.type)) { errors.push(`Unknown diagram shape "${raw?.type}" (use rect, line, circle, text, dim or poly)`); continue; }
    const s = { ...raw };
    const key = s.id ? `id:${s.id}` : `auto:${i}:${JSON.stringify(raw)}`;
    // labels: text shapes carry their own text/tex; others may have a label object
    const lab = s.type === "text" ? { tex: s.tex, text: s.text, color: s.color, size: s.size, align: s.align }
      : s.label ? { ...s.label } : null;
    let img = null;
    if (lab && (lab.tex || lab.text)) {
      const size = Number(lab.size) || 40;
      const col = color(lab.color, C.ink);
      if (lab.tex) {
        const mi = await mathImage(lab.tex, size, { display: false, color: col });
        if (mi.error) errors.push(`LaTeX error in diagram label "${lab.tex}": ${mi.error}`);
        else img = { kind: "math", mi, w: mi.w, h: mi.h, col };
      } else {
        ctx.font = font(lab.weight === "bold" ? 700 : 400, size);
        const tw = ctx.measureText(String(lab.text)).width;
        img = { kind: "text", text: String(lab.text), size, w: tw, h: size * 1.15, col, weight: lab.weight === "bold" ? 700 : 400 };
      }
    }
    const item = { key, s, lab, img };
    items.push(item);
    byId.set(key, item);
    // bounds check (2 px tolerance)
    const bb = shapeBox(s);
    if (bb && (bb.x < -2 || bb.y < -2 || bb.x + bb.w > w + 2 || bb.y + bb.h > h + 2)) {
      errors.push(`Diagram shape ${s.id ? `"${s.id}"` : `#${i + 1}`} (${s.type}) goes outside the ${Math.round(w)}×${Math.round(h)} diagram area`);
    }
  }
  // label boxes: inside the area, and not on top of each other
  const boxes = [];
  for (const it of items) {
    if (!it.img) continue;
    const lb = labelBox(it.s, it.lab, it.img);
    if (lb.x < -6 || lb.y < -6 || lb.x + lb.w > w + 6 || lb.y + lb.h > h + 6) {
      errors.push(`Label "${it.lab.tex || it.lab.text}" sticks out of the diagram area; move it or make the diagram taller`);
    }
    boxes.push({ lb, name: it.lab.tex || it.lab.text });
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i].lb, b = boxes[j].lb;
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    if (ix * iy > 0.2 * Math.min(a.w * a.h, b.w * b.h)) errors.push(`Diagram labels "${boxes[i].name}" and "${boxes[j].name}" overlap`);
  }
  return { type: "diagram", w, h, errors, items, byId, align: el.align || "center" };
}

function shapeBox(s) {
  switch (s.type) {
    case "rect": return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
    case "circle": return { x: s.cx - s.r, y: s.cy - s.r, w: 2 * s.r, h: 2 * s.r };
    case "line": case "dim": return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    case "poly": {
      const xs = (s.points || []).map((p) => p[0]), ys = (s.points || []).map((p) => p[1]);
      if (!xs.length) return null;
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    default: return null;
  }
}

// Where a label sits, given the shape's (possibly animated) geometry.
function labelBox(s, lab, img) {
  const gap = 10;
  if (s.type === "text") {
    const al = s.align || "center";
    const x = al === "left" ? s.x : al === "right" ? s.x - img.w : s.x - img.w / 2;
    return { x, y: s.y - img.h / 2, w: img.w, h: img.h };
  }
  let bb = shapeBox(s) || { x: 0, y: 0, w: 0, h: 0 };
  if (s.type === "dim") {
    // label beside the middle of the measured segment, on the offset side
    const [nx, ny] = normal(s);
    const off = (s.offset ?? 30) + (s.offset < 0 ? -1 : 1) * 26;
    const mx = (s.x1 + s.x2) / 2 + nx * off, my = (s.y1 + s.y2) / 2 + ny * off;
    return { x: mx - img.w / 2, y: my - img.h / 2, w: img.w, h: img.h };
  }
  if (s.type === "line") bb = { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2, w: 0, h: 0 };
  const pos = lab?.pos || (s.type === "line" ? "above" : "center");
  const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
  switch (pos) {
    case "above": return { x: cx - img.w / 2, y: bb.y - gap - img.h, w: img.w, h: img.h };
    case "below": return { x: cx - img.w / 2, y: bb.y + bb.h + gap, w: img.w, h: img.h };
    case "left": return { x: bb.x - gap - img.w, y: cy - img.h / 2, w: img.w, h: img.h };
    case "right": return { x: bb.x + bb.w + gap, y: cy - img.h / 2, w: img.w, h: img.h };
    case "inside-top": return { x: cx - img.w / 2, y: bb.y + gap, w: img.w, h: img.h };
    case "inside-bottom": return { x: cx - img.w / 2, y: bb.y + bb.h - gap - img.h, w: img.w, h: img.h };
    default: return { x: cx - img.w / 2, y: cy - img.h / 2, w: img.w, h: img.h };
  }
}
function normal(s) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len = Math.hypot(dx, dy) || 1;
  // perpendicular pointing "up" for horizontal segments, "left" for vertical ones
  let nx = dy / len, ny = -dx / len;
  if (ny > 0 || (ny === 0 && nx > 0)) { nx = -nx; ny = -ny; }
  return [nx, ny];
}

// ---------- drawing ----------
function drawShape(ctx, ox, oy, s, alpha, color, C) {
  if (alpha <= 0.001) return;
  const a = alpha * (s.opacity ?? 1);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  const stroke = color(s.stroke ?? s.color, s.type === "rect" || s.type === "circle" || s.type === "poly" ? C.futureBlue : C.ink);
  const fill = color(s.fill, null);
  const lw = s.strokeWidth ?? (s.type === "dim" ? 2 : 3);
  const fo = s.fillOpacity ?? (s.fill === "white" ? 1 : 0.18);
  ctx.lineWidth = lw;
  if (Array.isArray(s.dash)) ctx.setLineDash(s.dash);
  switch (s.type) {
    case "rect": {
      if (fill && Math.abs(s.w) > 0.5 && Math.abs(s.h) > 0.5) { ctx.globalAlpha = a * fo; ctx.fillStyle = fill; ctx.fillRect(s.x, s.y, s.w, s.h); }
      if (stroke && Math.abs(s.w) > 0.5 && Math.abs(s.h) > 0.5) { ctx.globalAlpha = a; ctx.strokeStyle = stroke; ctx.strokeRect(s.x, s.y, s.w, s.h); }
      break;
    }
    case "circle": {
      if (s.r <= 0.3) break;
      ctx.beginPath(); ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
      if (fill) { ctx.globalAlpha = a * fo; ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.globalAlpha = a; ctx.strokeStyle = stroke; ctx.stroke(); }
      break;
    }
    case "line": {
      ctx.globalAlpha = a; ctx.strokeStyle = stroke || C.ink;
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
      ctx.setLineDash([]);
      if (s.arrow === "end" || s.arrow === "both") arrowHead(ctx, s.x1, s.y1, s.x2, s.y2, lw, stroke || C.ink);
      if (s.arrow === "start" || s.arrow === "both") arrowHead(ctx, s.x2, s.y2, s.x1, s.y1, lw, stroke || C.ink);
      break;
    }
    case "dim": {
      const [nx, ny] = normal(s);
      const off = s.offset ?? 30;
      const ax = s.x1 + nx * off, ay = s.y1 + ny * off, bx = s.x2 + nx * off, by = s.y2 + ny * off;
      ctx.globalAlpha = a; ctx.strokeStyle = stroke || C.grey;
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      // end ticks across the dimension line
      for (const [px, py] of [[ax, ay], [bx, by]]) { ctx.moveTo(px - nx * 10, py - ny * 10); ctx.lineTo(px + nx * 10, py + ny * 10); }
      ctx.stroke();
      break;
    }
    case "poly": {
      const pts = s.points || [];
      if (pts.length < 2) break;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
      if (s.closed) ctx.closePath();
      if (fill && s.closed) { ctx.globalAlpha = a * fo; ctx.fillStyle = fill; ctx.fill(); }
      ctx.globalAlpha = a; ctx.strokeStyle = stroke || C.ink; ctx.lineJoin = "round"; ctx.stroke();
      break;
    }
  }
  ctx.restore();
}
function arrowHead(ctx, x1, y1, x2, y2, lw, col) {
  const ang = Math.atan2(y2 - y1, x2 - x1), L = 10 + lw * 3;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - L * Math.cos(ang - 0.4), y2 - L * Math.sin(ang - 0.4));
  ctx.lineTo(x2 - L * Math.cos(ang + 0.4), y2 - L * Math.sin(ang + 0.4));
  ctx.closePath(); ctx.fill();
}
function drawLabel(ctx, ox, oy, s, lab, img, alpha, font) {
  if (!img || alpha <= 0.001) return;
  const lb = labelBox(s, lab, img);
  ctx.save();
  ctx.globalAlpha = alpha * (s.opacity ?? 1);
  if (img.kind === "math") ctx.drawImage(img.mi.img, ox + lb.x, oy + lb.y, img.w, img.h);
  else {
    ctx.font = font(img.weight, img.size); ctx.fillStyle = img.col; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    ctx.fillText(img.text, ox + lb.x, oy + lb.y + img.size * 0.85);
  }
  ctx.restore();
}

// Interpolate two shape states (same type).
function mix(a, b, p) {
  const out = { ...b };
  for (const k of NUM_KEYS) if (typeof a[k] === "number" && typeof b[k] === "number") out[k] = lerp(a[k], b[k], p);
  if (a.type === "poly" && b.type === "poly" && a.points?.length === b.points?.length) {
    out.points = b.points.map((pt, i) => [lerp(a.points[i][0], pt[0], p), lerp(a.points[i][1], pt[1], p)]);
  }
  return out;
}
// A shape part-way through entering.
function entering(s, p) {
  const e = s.enter || (s.type === "line" || s.type === "dim" || s.type === "poly" ? "draw" : "fade");
  const q = ease(p);
  switch (e) {
    case "grow-right": return [{ ...s, w: s.w * q }, 1];
    case "grow-left": return [{ ...s, x: s.x + s.w * (1 - q), w: s.w * q }, 1];
    case "grow-down": return [{ ...s, h: s.h * q }, 1];
    case "grow-up": return [{ ...s, y: s.y + s.h * (1 - q), h: s.h * q }, 1];
    case "grow": {
      if (s.type === "circle") return [{ ...s, r: s.r * q }, 1];
      if (s.type === "rect") return [{ ...s, x: s.x + (s.w * (1 - q)) / 2, y: s.y + (s.h * (1 - q)) / 2, w: s.w * q, h: s.h * q }, 1];
      return [s, q];
    }
    case "draw": {
      if (s.type === "line" || s.type === "dim") return [{ ...s, x2: lerp(s.x1, s.x2, q), y2: lerp(s.y1, s.y2, q) }, 1];
      if (s.type === "poly" && s.points?.length > 1) {
        const n = s.points.length - 1, f = q * n, k = Math.floor(f);
        const pts = s.points.slice(0, k + 1);
        if (k < n) pts.push([lerp(s.points[k][0], s.points[k + 1][0], f - k), lerp(s.points[k][1], s.points[k + 1][1], f - k)]);
        return [{ ...s, points: pts, closed: q >= 1 && s.closed }, 1];
      }
      return [s, q];
    }
    case "none": return [s, 1];
    default: return [s, q];
  }
}
function exiting(s, p) {
  const q = ease(p);
  if ((s.exit === "shrink") && s.type === "rect") return [{ ...s, x: s.x + (s.w * q) / 2, y: s.y + (s.h * q) / 2, w: s.w * (1 - q), h: s.h * (1 - q) }, 1 - q];
  if ((s.exit === "shrink") && s.type === "circle") return [{ ...s, r: s.r * (1 - q) }, 1 - q];
  return [s, 1 - q];
}

// Draw a diagram at its final state, or part-way from `prev` (another diagram layout) at progress p.
// `fresh` = the whole diagram is new in this build (all shapes enter).
export function drawDiagram(ctx, lay, ox, oy, { prev = null, p = 1, fresh = false, C, font }) {
  const color = makeColor(C);
  const labelAlpha = (q) => Math.max(0, Math.min(1, (q - 0.35) / 0.65)); // labels follow their shape in
  if (p >= 1 || (!prev && !fresh)) {
    for (const it of lay.items) drawShape(ctx, ox, oy, it.s, 1, color, C);
    for (const it of lay.items) drawLabel(ctx, ox, oy, it.s, it.lab, it.img, 1, font);
    return;
  }
  const prevItems = prev ? prev.byId : new Map();
  // exits first (underneath)
  for (const [k, it] of prevItems) if (!lay.byId.has(k)) {
    const [s, a] = exiting(it.s, p);
    drawShape(ctx, ox, oy, s, a, color, C); drawLabel(ctx, ox, oy, s, it.lab, it.img, a, font);
  }
  for (const it of lay.items) {
    const old = prevItems.get(it.key);
    if (old && old.s.type === it.s.type) {
      const s = mix(old.s, it.s, ease(p));
      drawShape(ctx, ox, oy, s, 1, color, C);
      const sameLabel = (old.lab?.tex || old.lab?.text) === (it.lab?.tex || it.lab?.text);
      if (sameLabel) drawLabel(ctx, ox, oy, s, it.lab, it.img, 1, font);
      else { drawLabel(ctx, ox, oy, s, old.lab, old.img, 1 - ease(p), font); drawLabel(ctx, ox, oy, s, it.lab, it.img, ease(p), font); }
    } else {
      const [s, a] = entering(it.s, p);
      drawShape(ctx, ox, oy, s, a, color, C);
      drawLabel(ctx, ox, oy, s, it.lab, it.img, a * labelAlpha(p), font);
    }
  }
}
