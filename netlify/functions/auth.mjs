// /api/auth/* — first-run setup, sign in/out, current user, change password.
import {
  users, json, bad, body, hashPassword, checkPassword, validPassword, signToken, sessionCookie,
  currentUser, requireUser, publicUser, emailKey, nowIso,
} from "../lib/lib.mjs";

export default async (req) => {
  const action = new URL(req.url).pathname.split("/").pop();
  try {
    if (action === "status" && req.method === "GET") {
      const { blobs } = await users().list();
      const u = await currentUser(req);
      return json({ needsSetup: blobs.length === 0, user: u ? publicUser(u) : null });
    }

    if (action === "setup" && req.method === "POST") {
      const { blobs } = await users().list();
      if (blobs.length) return bad("Setup has already been done", 409);
      const b = await body(req);
      if (!process.env.SETUP_CODE || b.setupCode !== process.env.SETUP_CODE) return bad("Setup code is wrong", 403);
      const email = emailKey(b.email);
      if (!email.includes("@")) return bad("Enter a valid email");
      if (!validPassword(b.password)) return bad("Password must be at least 10 characters");
      const user = { email, name: b.name || email, role: "admin", active: true, createdAt: nowIso(),
        sessionVersion: 0, ...hashPassword(b.password) };
      await users().setJSON(email, user);
      return signIn(user);
    }

    if (action === "login" && req.method === "POST") {
      const b = await body(req);
      const user = await users().get(emailKey(b.email), { type: "json" });
      if (!user || user.active === false || !checkPassword(String(b.password || ""), user)) {
        await new Promise((r) => setTimeout(r, 600));
        return bad("Email or password is incorrect", 401);
      }
      user.lastLoginAt = nowIso();
      await users().setJSON(user.email, user);
      return signIn(user);
    }

    if (action === "logout" && req.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
    }

    if (action === "password" && req.method === "POST") {
      const { user, error } = await requireUser(req);
      if (error) return error;
      const b = await body(req);
      if (!checkPassword(String(b.current || ""), user)) return bad("Current password is incorrect", 403);
      if (!validPassword(b.next)) return bad("New password must be at least 10 characters");
      Object.assign(user, hashPassword(b.next), { sessionVersion: (user.sessionVersion || 0) + 1, mustChangePassword: false });
      await users().setJSON(user.email, user);
      return signIn(user);
    }
    return bad("Not found", 404);
  } catch (e) {
    console.error(e);
    return bad(e.message || "Server error", 500);
  }
};

function signIn(user) {
  const token = signToken({ sub: user.email, sv: user.sessionVersion || 0 });
  return json({ user: { ...publicUser(user), mustChangePassword: !!user.mustChangePassword } }, 200,
    { "set-cookie": sessionCookie(token) });
}

export const config = { path: "/api/auth/*" };
