import { layoutDiagram, drawDiagram, ease } from "./diagram.js";
import { AdvancedHost, AREA } from "./advanced.js";
// Draws slides in the Ontario Tech style onto a 1920×1080 canvas from the slide spec.
// Math is typeset by MathJax (SVG) and drawn as images.

export const W = 1920, H = 1080;
export const C = {
  futureBlue: "#003C71", simcoe: "#0077CA", tangerine: "#E75D2A", ink: "#414042",
  grey: "#5B6770", light: "#EEF2F6", white: "#FFFFFF",
};
const MARGIN_X = 120;
const CONTENT_TOP = 262;      // below heading + rule
const CONTENT_BOTTOM = 905;   // keep clear of captions
const CONTENT_W = W - MARGIN_X * 2;
const GAP = 34;

// ---------------- fonts ----------------
let fontsReady;
export function loadFonts(base = "/vendor/fonts/") {
  fontsReady ||= (async () => {
    const faces = [
      ["Ubuntu", "ubuntu-latin-300-normal.woff2", "300"],
      ["Ubuntu", "ubuntu-latin-400-normal.woff2", "400"],
      ["Ubuntu", "ubuntu-latin-500-normal.woff2", "500"],
      ["Ubuntu", "ubuntu-latin-700-normal.woff2", "700"],
      ["Ubuntu Condensed", "ubuntu-condensed-latin-400-normal.woff2", "400"],
    ];
    await Promise.all(faces.map(async ([fam, file, weight]) => {
      const f = new FontFace(fam, `url(${base}${file})`, { weight });
      await f.load();
      document.fonts.add(f);
    }));
  })();
  return fontsReady;
}

// ---------------- MathJax ----------------
let mjReady;
export function loadMathJax(src = "/vendor/mathjax/tex-svg-full.js") {
  mjReady ||= new Promise((resolve, reject) => {
    window.MathJax = {
      tex: {
        inlineMath: [["$", "$"], ["\\(", "\\)"]],
        packages: { "[+]": ["color", "cancel", "boldsymbol"] },
        macros: {
          blue: ["{\\color[RGB]{0,119,202}{#1}}", 1], orange: ["{\\color[RGB]{231,93,42}{#1}}", 1],
          navy: ["{\\color[RGB]{0,60,113}{#1}}", 1], grey: ["{\\color[RGB]{91,103,112}{#1}}", 1],
          tangerine: ["{\\color[RGB]{231,93,42}{#1}}", 1], simcoe: ["{\\color[RGB]{0,119,202}{#1}}", 1],
        },
      },
      svg: { fontCache: "none" },
      startup: { typeset: false, ready() { MathJax.startup.defaultReady(); MathJax.startup.promise.then(resolve); } },
    };
    const s = document.createElement("script");
    s.src = src; s.async = true; s.onerror = () => reject(new Error("Could not load MathJax"));
    document.head.appendChild(s);
  });
  return mjReady;
}

const MATH_SCALE = 1.12;
const mathCache = new Map();
// Returns {img, w, h, depth, error} with sizes in px for a given font size.
export async function mathImage(tex, px, { display = true, color = C.ink } = {}) {
  const key = `${display}|${px}|${color}|${tex}`;
  if (mathCache.has(key)) return mathCache.get(key);
  const p = (async () => {
    await loadMathJax();
    const node = MathJax.tex2svg(tex, { display });
    const svg = node.querySelector("svg");
    const err = svg.querySelector('[data-mml-node="merror"]');
    if (err) return { error: err.getAttribute("data-mjx-error") || err.textContent || "LaTeX error" };
    const ex = px * 0.5 * MATH_SCALE; // MathJax sizes in ex; scale so TeX x-height matches Ubuntu's
    const w = parseFloat(svg.getAttribute("width")) * ex;
    const h = parseFloat(svg.getAttribute("height")) * ex;
    const va = parseFloat((svg.getAttribute("style") || "").match(/vertical-align:\s*(-?[\d.]+)ex/)?.[1] || 0) * ex;
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("color", color);
    svg.setAttribute("style", `color:${color}`);
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const xml = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, color);
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    await img.decode();
    return { img, w, h, depth: -va };
  })();
  mathCache.set(key, p);
  return p;
}

// ---------------- logo + arrow ----------------
let logoImg = null;
export async function loadLogo(url = "/assets/logo-reverse.svg") {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const img = new Image();
    img.src = URL.createObjectURL(await r.blob());
    await img.decode();
    logoImg = img;
  } catch { logoImg = null; }
  return logoImg;
}
const ARROW = new Path2D("M13.863 0 L0 0 L0 13.86 L13.863 13.86 L13.863 27.72 L27.726 27.72 L27.726 0Z");
function cornerArrow(ctx, size, color = C.tangerine) {
  const s = size / 27.726;
  ctx.save();
  ctx.translate(W - size, 0);
  ctx.scale(s, s);
  ctx.fillStyle = color;
  ctx.fill(ARROW);
  ctx.restore();
}

// ---------------- text helpers ----------------
function font(weight, size, family = "Ubuntu") { return `${weight} ${size}px "${family}"`; }
function setText(ctx, weight, size, color, family) {
  ctx.font = font(weight, size, family);
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
}
function wrapPlain(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Rich text: plain words plus inline $math$. Returns a layout you can measure and draw.
async function layoutRich(ctx, text, { size, weight = 400, color = C.ink, maxW, lineGap = 1.35 }) {
  const parts = [];
  const re = /\$([^$]+)\$/g;
  let last = 0, m;
  const s = String(text ?? "");
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push({ t: s.slice(last, m.index) });
    parts.push({ math: m[1] });
    last = re.lastIndex;
  }
  if (last < s.length) parts.push({ t: s.slice(last) });

  ctx.font = font(weight, size);
  const tokens = [];
  const errors = [];
  for (const p of parts) {
    if (p.math !== undefined) {
      const mi = await mathImage(p.math, size, { display: false, color });
      if (mi.error) { errors.push(`$${p.math}$: ${mi.error}`); continue; }
      tokens.push({ math: mi, w: mi.w, glue: false });
    } else {
      const pieces = p.t.split(/(\s+)/);
      for (const piece of pieces) {
        if (!piece) continue;
        if (/^\s+$/.test(piece)) tokens.push({ space: true, w: ctx.measureText(" ").width });
        else tokens.push({ t: piece, w: ctx.measureText(piece).width });
      }
    }
  }
  const lines = [[]];
  let x = 0;
  for (const tk of tokens) {
    if (tk.space) { if (lines.at(-1).length) { lines.at(-1).push(tk); x += tk.w; } continue; }
    if (x + tk.w > maxW && lines.at(-1).length) {
      while (lines.at(-1).at(-1)?.space) lines.at(-1).pop();
      lines.push([]); x = 0;
    }
    lines.at(-1).push(tk); x += tk.w;
  }
  const lh = size * lineGap;
  const lineInfo = lines.map((ln) => {
    const w = ln.reduce((a, t) => a + t.w, 0);
    let asc = size * 0.8, desc = size * 0.25;
    for (const t of ln) if (t.math) { asc = Math.max(asc, t.math.h - t.math.depth); desc = Math.max(desc, t.math.depth); }
    return { tokens: ln, w, asc, desc };
  });
  const height = lineInfo.reduce((a, l, i) => a + (i ? Math.max(lh, l.asc + l.desc + 8) : l.asc + l.desc), 0);
  const width = Math.max(0, ...lineInfo.map((l) => l.w));
  return {
    width, height, errors, overflow: lineInfo.some((l) => l.w > maxW + 1),
    draw(x0, y0, align = "left") {
      let y = y0;
      lineInfo.forEach((l, i) => {
        y += i ? Math.max(lh, l.asc + l.desc + 8) - lineInfo[i - 1].desc : l.asc;
        let x = align === "center" ? x0 + (maxW - l.w) / 2 : x0;
        setText(ctx, weight, size, color);
        for (const t of l.tokens) {
          if (t.math) ctx.drawImage(t.math.img, x, y - (t.math.h - t.math.depth), t.math.w, t.math.h);
          else if (!t.space) ctx.fillText(t.t, x, y);
          x += t.w;
        }
      });
    },
  };
}

// ---------------- element layout ----------------
const MATH_SIZE = { small: 46, normal: 58, large: 76 };
const TEXT_SIZE = { small: 32, normal: 40, large: 48 };
const COLOR = { blue: C.simcoe, simcoe: C.simcoe, tangerine: C.tangerine, orange: C.tangerine, navy: C.futureBlue, grey: C.grey, ink: C.ink };

// Each layout returns {w, h, errors[], draw(x, y, colW)}.
async function layoutElement(ctx, el, maxW) {
  const errors = [];
  switch (el.type) {
    case "math": {
      const px = MATH_SIZE[el.size] || MATH_SIZE.normal;
      const mi = await mathImage(el.tex || "", px, { display: true });
      if (mi.error) return { w: 0, h: 0, errors: [`LaTeX error in "${el.tex}": ${mi.error}`], draw() {} };
      const pad = el.boxed ? 28 : 0;
      const w = mi.w + pad * 2, h = mi.h + pad * 2;
      if (w > maxW) errors.push(`Math is ${Math.round(w)}px wide but only ${Math.round(maxW)}px fit: "${el.tex}"`);
      return { w, h, errors, draw(x, y, colW) {
        const left = el.align === "left" ? x : x + (colW - w) / 2;
        if (el.boxed) { ctx.strokeStyle = C.futureBlue; ctx.lineWidth = 5; ctx.strokeRect(left + 2.5, y + 2.5, w - 5, h - 5); }
        ctx.drawImage(mi.img, left + pad, y + pad, mi.w, mi.h);
      } };
    }
    case "text": case "note": {
      const isNote = el.type === "note";
      const size = isNote ? 34 : TEXT_SIZE[el.size] || TEXT_SIZE.normal;
      const indent = isNote ? 36 : 0;
      const lay = await layoutRich(ctx, el.text, { size, weight: isNote ? 300 : 400,
        color: COLOR[el.color] || C.ink, maxW: maxW - indent });
      return { w: lay.width + indent, h: lay.height, errors: lay.errors, draw(x, y, colW) {
        if (isNote) { ctx.fillStyle = C.tangerine; ctx.fillRect(x, y, 9, lay.height); }
        lay.draw(x + indent, y, el.align === "center" ? "center" : "left");
      } };
    }
    case "label": {
      const size = 32;
      ctx.font = font(400, size, "Ubuntu Condensed");
      const txt = String(el.text || "").toUpperCase();
      const w = ctx.measureText(txt).width;
      if (w > maxW) errors.push(`Label too wide: "${el.text}"`);
      return { w, h: size, errors, draw(x, y, colW) {
        setText(ctx, 400, size, COLOR[el.color] || C.futureBlue, "Ubuntu Condensed");
        ctx.letterSpacing = "2px";
        const left = el.align === "center" ? x + (colW - w) / 2 : x;
        ctx.fillText(txt, left, y + size * 0.82);
        ctx.letterSpacing = "0px";
      } };
    }
    case "bullets": {
      const size = TEXT_SIZE[el.size] || TEXT_SIZE.normal;
      const lays = [];
      for (const it of el.items || []) lays.push(await layoutRich(ctx, it, { size, maxW: maxW - 48 }));
      const h = lays.reduce((a, l) => a + l.height, 0) + Math.max(0, lays.length - 1) * 20;
      return { w: maxW, h, errors: lays.flatMap((l) => l.errors), draw(x, y) {
        let yy = y;
        for (const l of lays) {
          ctx.fillStyle = C.tangerine; ctx.fillRect(x, yy + size * 0.35, 14, 14);
          l.draw(x + 48, yy); yy += l.height + 20;
        }
      } };
    }
    case "row": {
      const items = el.items || [];
      const n = Math.max(1, items.length);
      const colGap = 48;
      const colW = (maxW - colGap * (n - 1)) / n;
      const lays = [];
      for (const it of items) lays.push(await layoutElement(ctx, it, colW));
      const h = Math.max(0, ...lays.map((l) => l.h));
      return { w: maxW, h, errors: lays.flatMap((l) => l.errors), draw(x, y) {
        lays.forEach((l, i) => l.draw(x + i * (colW + colGap), y + (el.valign === "top" ? 0 : (h - l.h) / 2), colW));
      } };
    }
    case "trap": {
      const rows = [];
      for (const it of el.items || []) {
        const color = it.correct ? C.simcoe : C.grey;
        const lay = it.tex !== undefined
          ? await (async () => { const mi = await mathImage(it.tex, 50, { display: true, color });
              return mi.error ? { errors: [`LaTeX error in "${it.tex}": ${mi.error}`], width: 0, height: 0, draw() {} }
                : { errors: [], width: mi.w, height: mi.h, draw(x, y) { ctx.drawImage(mi.img, x, y, mi.w, mi.h); } }; })()
          : await layoutRich(ctx, it.text, { size: 40, color, maxW: maxW - 260 });
        const note = it.note ? await layoutRich(ctx, it.note, { size: 30, weight: 300, color: C.grey, maxW: maxW - 260 }) : null;
        rows.push({ it, lay, note, h: Math.max(64, lay.height + (note ? note.height + 10 : 0)) + 32 });
      }
      const h = rows.reduce((a, r) => a + r.h, 0) + Math.max(0, rows.length - 1) * 16;
      const errors = rows.flatMap((r) => [...r.lay.errors, ...(r.note?.errors || [])]);
      for (const r of rows) if (r.lay.width > maxW - 200) errors.push(`Trap row too wide: "${r.it.tex || r.it.text}"`);
      return { w: maxW, h, errors, draw(x, y) {
        let yy = y;
        for (const r of rows) {
          if (r.it.correct) { ctx.strokeStyle = C.futureBlue; ctx.lineWidth = 5; ctx.strokeRect(x + 2.5, yy + 2.5, maxW - 5, r.h - 5); }
          setText(ctx, 700, 56, r.it.correct ? C.simcoe : C.grey);
          ctx.fillText(r.it.correct ? "✓" : "✗", x + 36, yy + r.h / 2 + 20);
          const top = yy + (r.h - (r.lay.height + (r.note ? r.note.height + 10 : 0))) / 2;
          r.lay.draw(x + 130, top);
          if (r.note) r.note.draw(x + 130, top + r.lay.height + 10);
          yy += r.h + 16;
        }
      } };
    }
    case "sequence": {
      const items = el.items || [];
      const gap = 16;
      const n = Math.max(1, items.length);
      const box = Math.min(150, (maxW - gap * (n - 1)) / n);
      const hl = new Set(el.highlight || []);
      const imgs = [];
      for (let i = 0; i < items.length; i++) {
        imgs.push(await layoutRich(ctx, String(items[i]), { size: 40, maxW: box - 16, color: hl.has(i) ? C.white : C.ink }));
      }
      const caps = [];
      for (const c of el.captions || []) caps.push(await layoutRich(ctx, String(c), { size: 28, weight: 300, color: C.grey, maxW: box }));
      const capH = Math.max(0, ...caps.map((c) => c.height));
      const totalW = n * box + (n - 1) * gap;
      return { w: totalW, h: box + (capH ? capH + 14 : 0), errors: [...imgs, ...caps].flatMap((l) => l.errors), draw(x, y, colW) {
        const left = x + (colW - totalW) / 2;
        imgs.forEach((im, i) => {
          const bx = left + i * (box + gap);
          const on = hl.has(i);
          ctx.fillStyle = on ? C.simcoe : C.light; ctx.fillRect(bx, y, box, box);
          ctx.strokeStyle = on ? C.simcoe : C.futureBlue; ctx.lineWidth = 3; ctx.strokeRect(bx + 1.5, y + 1.5, box - 3, box - 3);
          im.draw(bx + (box - im.width) / 2, y + (box - im.height) / 2);
          if (caps[i]) caps[i].draw(bx + (box - caps[i].width) / 2, y + box + 14);
        });
      } };
    }
    case "diagram": {
      const d = await layoutDiagram(ctx, el, maxW, { mathImage, C, font });
      return { w: d.w, h: d.h, errors: d.errors, diagram: d, draw(x, y, colW, tw) {
        const ox = d.align === "left" ? x : x + (colW - d.w) / 2;
        drawDiagram(ctx, d, ox, y, { prev: tw?.prevDiagram || null, p: tw?.p ?? 1, fresh: !!tw?.fresh, C, font });
      } };
    }
    default:
      return { w: 0, h: 0, errors: [`Unknown element type "${el.type}"`], draw() {} };
  }
}

// ---------------- scene chrome ----------------
function contentChrome(ctx, spec, scene) {
  ctx.fillStyle = C.white; ctx.fillRect(0, 0, W, H);
  setText(ctx, 700, 22, C.futureBlue);
  ctx.letterSpacing = "3px";
  ctx.fillText(`THE ${String(spec.eyebrow || spec.title).toUpperCase()}`, MARGIN_X, 112);
  ctx.letterSpacing = "0px";
  setText(ctx, 700, 52, C.simcoe);
  ctx.fillText(scene.heading || "", MARGIN_X, 178);
  ctx.fillStyle = C.tangerine; ctx.fillRect(MARGIN_X, 204, 72, 9);
  cornerArrow(ctx, 84);
}

function titleCard(ctx, spec) {
  ctx.fillStyle = C.futureBlue; ctx.fillRect(0, 0, W, H);
  if (logoImg) {
    const w = 360, h = (logoImg.naturalHeight / logoImg.naturalWidth) * w || 100;
    ctx.drawImage(logoImg, MARGIN_X, 96, w, h);
  }
  setText(ctx, 400, 34, C.white, "Ubuntu Condensed");
  ctx.letterSpacing = "4px";
  ctx.fillText("STUDENT LEARNING SUPPORT", MARGIN_X, 470);
  ctx.letterSpacing = "0px";
  setText(ctx, 700, 120, C.white);
  const lines = wrapPlain(ctx, spec.title || "", W - MARGIN_X * 2 - 200);
  let y = 600;
  for (const l of lines) { ctx.fillText(l, MARGIN_X, y); y += 132; }
  ctx.fillStyle = C.tangerine; ctx.fillRect(MARGIN_X, y - 70, 120, 12);
  if (spec.subtitle) {
    setText(ctx, 300, 48, C.white);
    let sy = y + 20;
    for (const l of wrapPlain(ctx, spec.subtitle, W - MARGIN_X * 2 - 200)) { ctx.fillText(l, MARGIN_X, sy); sy += 60; }
  }
  cornerArrow(ctx, 168);
}

const PRACTICE = {
  math: "Math Study Hall · 1:1 appointments · Workshops · Tipsheets and videos on nool",
  cp: "C&P Study Hall · 1:1 appointments · Workshops · Tipsheets and videos on nool",
};
async function summaryBody(ctx, spec, scene, steps) {
  const lays = [];
  for (const s of steps) lays.push(await layoutRich(ctx, s, { size: 42, maxW: CONTENT_W - 140 }));
  const tile = 84;
  let y = CONTENT_TOP + 10;
  const rows = lays.map((l) => { const h = Math.max(tile, l.height); const r = { l, y, h }; y += h + 36; return r; });
  const bandY = Math.max(y + 10, 760);
  return {
    errors: [...lays.flatMap((l) => l.errors), ...(bandY + 130 > CONTENT_BOTTOM + 20 ? ["Summary has too many or too long steps; keep it to 3 short steps"] : [])],
    draw() {
      rows.forEach((r, i) => {
        ctx.fillStyle = C.futureBlue; ctx.fillRect(MARGIN_X, r.y, tile, tile);
        setText(ctx, 700, 48, C.white); ctx.textAlign = "center";
        ctx.fillText(String(i + 1), MARGIN_X + tile / 2, r.y + tile / 2 + 17); ctx.textAlign = "left";
        r.l.draw(MARGIN_X + tile + 40, r.y + (r.h - r.l.height) / 2);
      });
      ctx.fillStyle = C.futureBlue; ctx.fillRect(0, bandY, W, 130);
      setText(ctx, 700, 40, C.white);
      ctx.fillText("More practice?", MARGIN_X, bandY + 56);
      setText(ctx, 300, 34, C.white);
      ctx.fillText(PRACTICE[spec.stream] || PRACTICE.math, MARGIN_X, bandY + 104);
    },
  };
}

// ---------------- builds ----------------
// Each build adds/sets/removes elements cumulatively within its scene.
export function resolveBuilds(scene) {
  let els = [];
  return (scene.builds || []).map((b) => {
    if (b.clear) els = [];
    if (b.remove) els = els.filter((e) => !b.remove.includes(e.id));
    for (const s of b.set || []) {
      const i = els.findIndex((e) => e.id && e.id === s.id);
      if (i >= 0) els[i] = s; else els.push(s);
    }
    els = els.concat(b.add || []);
    return els.slice();
  });
}

// Lays out a build. Returns {errors, draw()} — draw paints onto ctx.
export async function layoutBuild(ctx, spec, sceneIdx, buildIdx) {
  await loadFonts();
  const scene = spec.scenes[sceneIdx];
  if (scene.kind === "title") return { errors: [], draw: () => titleCard(ctx, spec) };
  if (scene.kind === "advanced") return { errors: [], advanced: true, draw: () => contentChrome(ctx, spec, scene) };
  const els = resolveBuilds(scene)[buildIdx] || [];
  if (scene.kind === "summary") {
    const steps = els.filter((e) => e.type === "step").map((e) => e.text);
    const body = await summaryBody(ctx, spec, scene, steps);
    return { errors: body.errors, draw() { contentChrome(ctx, spec, scene); body.draw(); } };
  }
  const lays = [];
  let yy = 0;
  for (const el of els) {
    const lay = await layoutElement(ctx, el, CONTENT_W);
    lays.push({ el, lay, y: yy });
    yy += lay.h + GAP;
  }
  const total = lays.reduce((a, l) => a + l.lay.h, 0) + GAP * Math.max(0, lays.length - 1);
  const room = CONTENT_BOTTOM - CONTENT_TOP;
  const errors = lays.flatMap((l) => l.lay.errors);
  if (total > room) errors.push(`Content is ${Math.round(total - room)}px too tall for the slide; split it into another scene or shorten it`);
  const self = {
    errors, height: total, items: lays, els,
    hasDiagram: lays.some((l) => l.lay.diagram),
    // yOffset centres the scene's tallest build; every build in a scene uses the same offset so nothing jumps.
    // With `from` (the previous build's layout) and p < 1, draws the animated transition between them.
    draw(yOffset = 0, from = null, p = 1) {
      contentChrome(ctx, spec, scene);
      const top = CONTENT_TOP + 8 + yOffset;
      if (!from || p >= 1) { for (const { lay, y } of lays) lay.draw(MARGIN_X, top + y, CONTENT_W); return; }
      const q = ease(p);
      const matched = new Set();
      for (const it of lays) {
        // same element object as before: unchanged
        let prev = from.items.find((f) => f.el === it.el);
        if (!prev && it.el.id) prev = from.items.find((f) => f.el.id === it.el.id);
        if (prev) matched.add(prev);
        if (prev && prev.el === it.el) { it.lay.draw(MARGIN_X, top + it.y, CONTENT_W); continue; }
        if (it.lay.diagram) {
          ctx.save();
          it.lay.draw(MARGIN_X, top + it.y, CONTENT_W, { p, prevDiagram: prev?.lay.diagram || null, fresh: !prev?.lay.diagram });
          ctx.restore();
        } else {
          if (prev) { ctx.save(); ctx.globalAlpha = 1 - q; prev.lay.draw(MARGIN_X, top + prev.y, CONTENT_W); ctx.restore(); }
          ctx.save(); ctx.globalAlpha = q; it.lay.draw(MARGIN_X, top + it.y, CONTENT_W); ctx.restore();
        }
      }
      for (const f of from.items) if (!matched.has(f)) { // removed: fade out where it was
        ctx.save(); ctx.globalAlpha = 1 - q; f.lay.draw(MARGIN_X, top + f.y, CONTENT_W); ctx.restore();
      }
    },
  };
  return self;
}

// ---------------- captions ----------------
export function wrapCaption(text, max = 76) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}
export function drawCaption(ctx, text) {
  if (!text) return;
  const lines = wrapCaption(text).slice(0, 2);
  setText(ctx, 400, 34, C.white);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 56;
  const lh = 46;
  const h = lines.length * lh + 28;
  const x = (W - w) / 2, y = H - 40 - h;
  ctx.fillStyle = C.futureBlue; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = C.white; ctx.textAlign = "center";
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y + 14 + lh * (i + 1) - 12));
  ctx.textAlign = "left";
}

export function sceneOffset(lays) {
  const maxH = Math.max(0, ...lays.map((l) => l.height || 0));
  const room = CONTENT_BOTTOM - CONTENT_TOP - 8;
  return maxH ? Math.max(0, (room - maxH) * 0.42) : 0;
}

// How each build arrives: "morph" (shapes animate) when its scene has a diagram that changed, else a quick fade.
export function transitionFor(spec, sceneIdx, buildIdx, lay, prevLay) {
  const b = spec.scenes[sceneIdx]?.builds?.[buildIdx] || {};
  const t = b.transition || {};
  if (t.type === "cut") return { kind: "cut", dur: 0 };
  if (buildIdx > 0 && prevLay && (t.type === "morph" || (t.type !== "fade" && lay?.hasDiagram))) {
    return { kind: "morph", dur: Math.min(3, Math.max(0.3, Number(t.duration) || 0.9)) };
  }
  return { kind: "fade", dur: Math.min(1.5, Math.max(0.15, Number(t.duration) || 0.35)) };
}

/**
 * Prepares every build of a video. Returns an array of {scene, build, bitmap, errors, transition} (the bitmap is
 * the build's settled look, captions not included) with helpers attached:
 *   drawMorph(i, p)  → canvas showing build i part-way (0..1) through its animated arrival
 *   drawAdvanced(sceneIdx, t) → canvas with an advanced scene at t seconds after it started
 *   sceneTimes(sceneIdx) → scene-relative build start times used for advanced scenes
 *   dispose()        → stop advanced-scene sandboxes
 * `times` (optional): absolute start time of every build, in order; used to time advanced scenes.
 */
export async function renderAllBuilds(spec, onProgress, { times = null } = {}) {
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d");
  const out = [];
  const total = spec.scenes.reduce((a, s) => a + Math.max(1, (s.builds || []).length), 0);
  const layAt = [], offAt = [], hosts = new Map(), sceneBuildTimes = new Map();
  const colors = { blue: C.simcoe, tangerine: C.tangerine, navy: C.futureBlue, ink: C.ink, grey: C.grey, light: C.light, white: C.white };
  let n = 0, gi = 0;
  for (let si = 0; si < spec.scenes.length; si++) {
    const scene = spec.scenes[si];
    const nb = Math.max(1, (scene.builds || []).length);
    // scene-relative build times (real ones when known, else 4 s apart)
    const rel = [];
    for (let bi = 0; bi < nb; bi++) rel.push(times ? Math.max(0, times[gi + bi] - times[gi]) : bi * 4);
    sceneBuildTimes.set(si, rel);
    if (scene.kind === "advanced") {
      const host = new AdvancedHost();
      const texErr = await host.start({ code: scene.code, tex: scene.tex, colors, mathImage });
      hosts.set(si, host);
      for (let bi = 0; bi < nb; bi++) {
        const errors = texErr.map((e) => `Advanced scene: ${e}`);
        let bitmap;
        try {
          const settle = bi + 1 < nb ? Math.min(rel[bi + 1] - 0.05, rel[bi] + 2.5) : rel[bi] + 2.5;
          const c = await drawAdvancedInto(ctx, spec, scene, host, settle, rel);
          bitmap = await createImageBitmap(c);
        } catch (e) {
          errors.push(`Advanced scene code failed: ${e.message}`);
          ctx.clearRect(0, 0, W, H); contentChrome(ctx, spec, scene); bitmap = await createImageBitmap(cv);
        }
        out.push({ scene: si, build: bi, bitmap, errors, transition: { kind: bi === 0 ? "fade" : "none", dur: bi === 0 ? 0.35 : 0 }, advanced: true });
        layAt.push(null); offAt.push(0);
        onProgress?.(++n / total);
      }
      gi += nb;
      continue;
    }
    const lays = [];
    for (let bi = 0; bi < nb; bi++) lays.push(await layoutBuild(ctx, spec, si, bi));
    const off = sceneOffset(lays);
    for (let bi = 0; bi < nb; bi++) {
      const lay = lays[bi];
      ctx.clearRect(0, 0, W, H);
      lay.draw(off);
      out.push({ scene: si, build: bi, bitmap: await createImageBitmap(cv), errors: lay.errors,
        transition: transitionFor(spec, si, bi, lay, bi > 0 ? lays[bi - 1] : null) });
      layAt.push(lay); offAt.push(off);
      onProgress?.(++n / total);
    }
    gi += nb;
  }
  async function drawAdvancedInto(c2, spec2, scene, host, t, rel) {
    const frame = await host.drawAt(t, rel);
    c2.clearRect(0, 0, W, H);
    contentChrome(c2, spec2, scene);
    c2.drawImage(frame, AREA.x, AREA.y);
    frame.close?.();
    return cv;
  }
  out.drawMorph = (i, p) => {
    const lay = layAt[i], prev = i > 0 && out[i - 1].scene === out[i].scene ? layAt[i - 1] : null;
    ctx.clearRect(0, 0, W, H);
    lay.draw(offAt[i], prev, p);
    return cv;
  };
  out.drawAdvanced = async (si, t) => drawAdvancedInto(ctx, spec, spec.scenes[si], hosts.get(si), t, sceneBuildTimes.get(si));
  out.sceneTimes = (si) => sceneBuildTimes.get(si);
  out.dispose = () => { for (const h of hosts.values()) h.stop(); hosts.clear(); };
  return out;
}
