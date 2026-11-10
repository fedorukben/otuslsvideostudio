// Advanced scenes: Claude writes the body of draw(ctx, t, info) for one scene, and it runs inside a
// sandboxed iframe (scripts only, opaque origin). It can't reach the page, the site's API, cookies or
// the user's files. The page sends in the fonts and pre-rendered LaTeX it needs, asks for a frame at a
// time t, and gets back an ImageBitmap of the content area.

export const AREA = { x: 120, y: 262, w: 1680, h: 640 }; // content area on the 1920×1080 slide

// The drawing code runs in a Worker inside the sandboxed iframe, so a runaway loop can be stopped
// (the iframe terminates the worker after a timeout) without freezing the page.
const WORKER = `
"use strict";
let draw = null, canvas = null, ctx = null, tex = {}, colors = {};
const ease = { inOut: (p) => (p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2), out: (p) => 1 - Math.pow(1 - p, 3), in: (p) => p*p*p, linear: (p) => p };
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, p) => a + (b - a) * p;
function mkInfo(t, f) {
  return {
    w: canvas.width, h: canvas.height, t, build: f.build, since: f.since, builds: f.builds,
    colors, ease, clamp, lerp,
    progress: (t0, dur) => clamp((t - t0) / Math.max(0.001, dur)),
    math(key, x, y, o = {}) {
      const m = tex[key]; if (!m) throw new Error("No LaTeX called '" + key + "' (add it to the scene's tex list)");
      const s = (o.size || m.size) / m.size, w = m.w * s, h = m.h * s;
      const ax = o.align === "left" ? x : o.align === "right" ? x - w : x - w / 2;
      const ay = o.valign === "top" ? y : o.valign === "bottom" ? y - h : y - h / 2;
      ctx.save(); if (o.alpha != null) ctx.globalAlpha *= o.alpha; ctx.drawImage(m.bmp, ax, ay, w, h); ctx.restore();
      return { x: ax, y: ay, w, h };
    },
    text(str, x, y, o = {}) {
      ctx.save();
      ctx.font = (o.weight || 400) + " " + (o.size || 40) + "px " + (o.font === "condensed" ? '"Ubuntu Condensed"' : '"Ubuntu"');
      ctx.fillStyle = o.color || colors.ink; ctx.textAlign = o.align || "center"; ctx.textBaseline = o.baseline || "middle";
      if (o.alpha != null) ctx.globalAlpha *= o.alpha;
      ctx.fillText(String(str), x, y); ctx.restore();
    },
  };
}
onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === "init") {
      for (const f of m.fonts || []) { const ff = new FontFace(f.family, f.buffer, { weight: f.weight }); await ff.load(); self.fonts.add(ff); }
      tex = m.tex || {}; colors = m.colors || {};
      canvas = new OffscreenCanvas(m.w, m.h); ctx = canvas.getContext("2d");
      // Nothing the scene's code needs can reach the network.
      for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches"]) {
        try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
      }
      draw = new Function("ctx", "t", "info", '"use strict";\\n' + m.code);
      postMessage({ id: m.id, ok: true });
    } else if (m.type === "frame") {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save(); draw(ctx, m.t, mkInfo(m.t, m)); ctx.restore();
      const bmp = canvas.transferToImageBitmap();
      postMessage({ id: m.id, bitmap: bmp }, [bmp]);
    }
  } catch (e) { postMessage({ id: m.id, error: String(e && e.message || e) }); }
};`;

const RUNNER = `<!doctype html><meta charset="utf-8"><script>
"use strict";
const src = ${JSON.stringify(WORKER)};
let worker = null, dead = null, timers = new Map();
function start() {
  worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  worker.onmessage = (ev) => { const t = timers.get(ev.data.id); clearTimeout(t); timers.delete(ev.data.id);
    parent.postMessage(ev.data, "*", ev.data.bitmap ? [ev.data.bitmap] : []); };
  worker.onerror = (e) => { e.preventDefault(); };
}
try { start(); } catch (e) { dead = "This browser can't run advanced scenes (" + e.message + ")"; }
addEventListener("message", (ev) => {
  const m = ev.data || {};
  if (dead) return parent.postMessage({ id: m.id, error: dead }, "*");
  const limit = m.type === "init" ? 20000 : 3000;
  timers.set(m.id, setTimeout(() => {
    worker.terminate(); dead = "The scene's code took too long (over " + limit / 1000 + " s) and was stopped";
    parent.postMessage({ id: m.id, error: dead }, "*");
  }, limit));
  const transfer = [];
  if (m.tex) for (const k in m.tex) transfer.push(m.tex[k].bmp);
  worker.postMessage(m, transfer);
});
<\/script>`;

let fontCache = null;
async function fontBuffers() {
  fontCache ||= Promise.all([
    ["Ubuntu", "ubuntu-latin-300-normal.woff2", "300"], ["Ubuntu", "ubuntu-latin-400-normal.woff2", "400"],
    ["Ubuntu", "ubuntu-latin-500-normal.woff2", "500"], ["Ubuntu", "ubuntu-latin-700-normal.woff2", "700"],
    ["Ubuntu Condensed", "ubuntu-condensed-latin-400-normal.woff2", "400"],
  ].map(async ([family, file, weight]) => ({ family, weight, buffer: await (await fetch(`/vendor/fonts/${file}`)).arrayBuffer() })));
  return fontCache;
}

export class AdvancedHost {
  constructor() { this.seq = 0; this.waiting = new Map(); this.frame = null; }
  async start({ code, tex, colors, mathImage }) {
    // Pre-render every LaTeX string the scene declares.
    const texOut = {};
    const errors = [];
    for (const [key, val] of Object.entries(tex || {})) {
      const t = typeof val === "string" ? { tex: val } : val || {};
      const size = Number(t.size) || 56;
      const mi = await mathImage(String(t.tex || ""), size, { display: false, color: t.color && colors[t.color] ? colors[t.color] : colors.ink });
      if (mi.error) { errors.push(`LaTeX error in "${key}": ${mi.error}`); continue; }
      texOut[key] = { bmp: await createImageBitmap(mi.img, { resizeWidth: Math.max(1, Math.round(mi.w * 2)), resizeHeight: Math.max(1, Math.round(mi.h * 2)) }), w: mi.w, h: mi.h, size };
    }
    this.frame = document.createElement("iframe");
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;border:0";
    this.frame.srcdoc = RUNNER;
    this.onMsg = (ev) => {
      if (ev.source !== this.frame?.contentWindow) return;
      const w = this.waiting.get(ev.data?.id);
      if (!w) return;
      this.waiting.delete(ev.data.id);
      clearTimeout(w.timer);
      ev.data.error ? w.reject(new Error(ev.data.error)) : w.resolve(ev.data);
    };
    addEventListener("message", this.onMsg);
    document.body.appendChild(this.frame);
    await new Promise((r) => (this.frame.onload = r));
    await this.call({ type: "init", code: String(code || ""), tex: texOut, colors, fonts: await fontBuffers(), w: AREA.w, h: AREA.h },
      [...Object.values(texOut).map((t) => t.bmp)], 20000);
    return errors;
  }
  call(msg, transfer = [], timeout = 4000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error("The scene's code took too long to draw a frame")); }, timeout + 1000);
      this.waiting.set(id, { resolve, reject, timer });
      this.frame.contentWindow.postMessage({ ...msg, id }, "*", transfer);
    });
  }
  // t: seconds since the scene started; builds: scene-relative start times of its builds.
  async drawAt(t, builds) {
    let b = 0;
    while (b + 1 < builds.length && builds[b + 1] <= t) b++;
    const r = await this.call({ type: "frame", t, build: b, since: t - builds[b], builds });
    return r.bitmap;
  }
  stop() {
    removeEventListener("message", this.onMsg);
    this.frame?.remove();
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error("stopped")); }
    this.waiting.clear();
  }
}
