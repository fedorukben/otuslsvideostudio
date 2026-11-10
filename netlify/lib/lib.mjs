// Shared helpers for SLS Video Studio functions.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// ---------- storage ----------
// Tests can swap in an in-memory store via globalThis.__SVS_STORE_FACTORY.
export function store(name) {
  if (globalThis.__SVS_STORE_FACTORY) return globalThis.__SVS_STORE_FACTORY(name);
  return getStore({ name, consistency: "strong" });
}
export const users = () => store("users");
export const settingsStore = () => store("settings");
export const usageStore = () => store("usage");
export const jobsStore = () => store("jobs");
export const reqStore = () => store("claude-requests");

// ---------- responses ----------
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
export const bad = (msg, status = 400) => json({ error: msg }, status);

export async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

// ---------- secrets ----------
function secret(name) {
  const v = process.env[name];
  if (!v || v.length < 16) throw new Error(`Environment variable ${name} is missing or shorter than 16 characters`);
  return v;
}
export const internalToken = () =>
  crypto.createHash("sha256").update("internal:" + secret("JWT_SECRET")).digest("hex");

// ---------- passwords ----------
export function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(pw, salt, 210000, 32, "sha256").toString("hex");
  return { salt, hash };
}
export function checkPassword(pw, user) {
  if (!user?.hash) return false;
  const { hash } = hashPassword(pw, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}
export function validPassword(pw) {
  return typeof pw === "string" && pw.length >= 10;
}

// ---------- sessions (HS256 JWT in an HttpOnly cookie) ----------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
export function signToken(payload, ttlSec = 60 * 60 * 12) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = crypto.createHmac("sha256", secret("JWT_SECRET")).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
export function verifyToken(tok) {
  if (!tok) return null;
  const [head, body, sig] = tok.split(".");
  if (!sig) return null;
  const want = crypto.createHmac("sha256", secret("JWT_SECRET")).update(`${head}.${body}`).digest("base64url");
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  if (p.exp < Date.now() / 1000) return null;
  return p;
}
export const COOKIE = "svs_session";
export function sessionCookie(token, maxAge = 60 * 60 * 12) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
export const emailKey = (e) => String(e || "").trim().toLowerCase();

// Returns the signed-in user record (fresh from storage) or null.
export async function currentUser(req) {
  const p = verifyToken(readCookie(req, COOKIE));
  if (!p) return null;
  const u = await users().get(emailKey(p.sub), { type: "json" });
  if (!u || u.active === false) return null;
  if ((u.sessionVersion || 0) !== (p.sv || 0)) return null; // password reset / sign-out-everywhere
  return u;
}
export async function requireUser(req, role) {
  const u = await currentUser(req);
  if (!u) return { error: bad("Not signed in", 401) };
  if (role === "admin" && u.role !== "admin") return { error: bad("Admins only", 403) };
  // Light CSRF guard: state-changing requests must be JSON (forms can't send that cross-site).
  if (req.method !== "GET" && !(req.headers.get("content-type") || "").includes("application/json")) {
    return { error: bad("Expected JSON", 415) };
  }
  return { user: u };
}
export const publicUser = (u) => ({
  email: u.email, name: u.name, role: u.role, active: u.active !== false,
  monthlyLimitUsd: u.monthlyLimitUsd ?? null, monthlyVideoLimit: u.monthlyVideoLimit ?? null,
  createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
});

// ---------- API key encryption (AES-256-GCM) ----------
const encKey = () => crypto.createHash("sha256").update(secret("ENCRYPTION_SECRET")).digest();
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
export function decrypt(blob) {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// ---------- settings ----------
// Prices are USD per million tokens. Admins can edit them in Settings.
export const DEFAULT_SETTINGS = {
  monthlyCapUsd: 50,
  defaultUserMonthlyLimitUsd: null,
  defaultUserMonthlyVideoLimit: null,
  asrModel: "Xenova/whisper-small.en",
  stageModels: {
    "math-pass": "claude-haiku-5-5",
    "plan": "claude-opus-5-5",
    "fix": "claude-sonnet-5-5",
    "revise": "claude-sonnet-5-5",
    "frame-check": "claude-haiku-5-5",
  },
  prices: {
    "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
    "claude-haiku-5-5": {
      input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01,
      longPromptOver: 100000,
      long: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
    },
  },
  keys: [], // [{id, label, last4, enc, active, addedAt, addedBy}]
};
export async function getSettings() {
  const s = (await settingsStore().get("config", { type: "json" })) || {};
  return {
    ...DEFAULT_SETTINGS, ...s,
    stageModels: { ...DEFAULT_SETTINGS.stageModels, ...(s.stageModels || {}) },
    prices: { ...DEFAULT_SETTINGS.prices, ...(s.prices || {}) },
    keys: s.keys || [],
  };
}
export const saveSettings = (s) => settingsStore().setJSON("config", s);

export function costOf(prices, model, u) {
  let p = prices[model];
  if (!p) return null;
  const promptTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  if (p.longPromptOver && p.long && promptTokens > p.longPromptOver) p = { ...p, ...p.long };
  return (
    (u.input_tokens || 0) * p.input +
    (u.output_tokens || 0) * p.output +
    (u.cache_creation_input_tokens || 0) * (p.cacheWrite ?? p.input * 1.25) +
    (u.cache_read_input_tokens || 0) * (p.cacheRead ?? p.input * 0.1)
  ) / 1e6;
}

// ---------- usage ----------
export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);
export async function usageForMonth(month) {
  const st = usageStore();
  const { blobs } = await st.list({ prefix: `${month}/` });
  const rows = await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })));
  return rows.filter(Boolean).sort((a, b) => a.ts.localeCompare(b.ts));
}
export async function jobsForMonth(month) {
  const st = jobsStore();
  const { blobs } = await st.list();
  const rows = await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })));
  return rows.filter((j) => j && (j.createdAt || "").startsWith(month));
}

// Throws a Response if a new spend would break a cap.
export async function checkSpend(user) {
  const s = await getSettings();
  const rows = await usageForMonth(monthOf());
  const total = rows.reduce((a, r) => a + (r.costUsd || 0), 0);
  if (s.monthlyCapUsd != null && total >= s.monthlyCapUsd) {
    return `This month's spending cap ($${Number(s.monthlyCapUsd).toFixed(2)}) has been reached. Ask an admin to raise it.`;
  }
  const lim = user.monthlyLimitUsd ?? s.defaultUserMonthlyLimitUsd;
  if (lim != null) {
    const mine = rows.filter((r) => r.user === user.email).reduce((a, r) => a + (r.costUsd || 0), 0);
    if (mine >= lim) return `You've reached your monthly limit of $${Number(lim).toFixed(2)}. Ask an admin to raise it.`;
  }
  return null;
}

export const newId = () => crypto.randomBytes(9).toString("base64url");
export const nowIso = () => new Date().toISOString();
