// Local test server: serves public/, routes /api/* to the Netlify functions,
// keeps Blobs in memory, and (optionally) mocks the Claude API.
// Usage: node dev/server.mjs [port]   with MOCK_CLAUDE=1 to use dev/mock-claude.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.JWT_SECRET ||= "dev-jwt-secret-0123456789abcdef";
process.env.ENCRYPTION_SECRET ||= "dev-encryption-secret-0123456789";
process.env.SETUP_CODE ||= "letmein";

// ---- in-memory Blobs ----
const mem = new Map();
globalThis.__SVS_STORE_FACTORY = (name) => {
  if (!mem.has(name)) mem.set(name, new Map());
  const m = mem.get(name);
  return {
    async get(k, o) { const v = m.get(k); if (v === undefined) return null; return o?.type === "json" ? JSON.parse(v) : v; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    async list(o = {}) { return { blobs: [...m.keys()].filter((k) => !o.prefix || k.startsWith(o.prefix)).map((key) => ({ key })) }; },
  };
};
if (process.env.MOCK_CLAUDE) {
  const { mockFetch } = await import("./mock-claude.mjs");
  globalThis.__SVS_FETCH = mockFetch;
}

const fn = async (n) => (await import(path.join(root, "netlify/functions", n))).default;
const routes = [
  [/^\/api\/auth\//, "auth.mjs"],
  [/^\/api\/admin\//, "admin.mjs"],
  [/^\/api\/jobs(\/|$)/, "jobs.mjs"],
  [/^\/api\/claude\//, "claude.mjs"],
  [/^\/\.netlify\/functions\/claude-run-background/, "claude-run-background.mjs", true],
];
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".png": "image/png" };

const port = Number(process.argv[2] || 8888);
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = routes.find(([re]) => re.test(url.pathname));
  if (r) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, v);
    const request = new Request(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    try {
      const handler = await fn(r[1]);
      if (r[2]) { res.writeHead(202).end(); handler(request); return; } // background: reply first
      const out = await handler(request, {});
      const h = {};
      out.headers.forEach((v, k) => (h[k] = v));
      if (h["set-cookie"]) h["set-cookie"] = h["set-cookie"].replace("; Secure", ""); // http in dev
      res.writeHead(out.status, h).end(Buffer.from(await out.arrayBuffer()));
    } catch (e) { console.error(e); res.writeHead(500).end(String(e)); }
    return;
  }
  if (url.pathname.startsWith("/dev-fixture/")) {
    const f = path.join(root, "dev/fixtures", path.basename(url.pathname));
    return fs.existsSync(f) ? res.writeHead(200).end(fs.readFileSync(f)) : res.writeHead(404).end();
  }
  if (url.pathname === "/dev/render-test.html" || url.pathname === "/dev/pipeline-test.html") {
    return res.writeHead(200, { "content-type": "text/html" }).end(fs.readFileSync(path.join(root, url.pathname)));
  }
  let p = path.join(root, "public", decodeURIComponent(url.pathname));
  if (!p.startsWith(path.join(root, "public"))) return res.writeHead(403).end();
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!fs.existsSync(p)) p = path.join(root, "public/index.html");
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
}).listen(port, () => console.log(`dev server on http://localhost:${port}`));
