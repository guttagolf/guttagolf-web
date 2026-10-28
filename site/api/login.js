// Admin sign-in.
//   GET    /api/login                     →  { user } when signed in, 401 otherwise
//   POST   /api/login  { id, password }   →  sets the session cookie
//   DELETE /api/login                     →  signs out
// After 5 failed tries from one IP in 15 minutes, that IP must wait (counted from the logs table).
const auth = require("./_auth.js");
const db = require("./_db.js");

const MAX_FAILS = 5, WINDOW_MIN = 15;

async function tooManyFails(ip) {
  if (!db.configured() || !ip) return false;
  const since = new Date(Date.now() - WINDOW_MIN * 60e3).toISOString();
  try {
    const rows = await db.rest(`logs?select=id&category=eq.auth&action=eq.login_fail&ip=eq.${encodeURIComponent(ip)}&at=gte.${encodeURIComponent(since)}&limit=${MAX_FAILS}`);
    return rows.length >= MAX_FAILS;
  } catch (err) { console.error("Login rate check failed:", err.message); return false; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!auth.configured()) return res.status(503).json({ error: "ADMIN_PASSWORD 환경변수가 설정되지 않았습니다.", code: "not_configured" });

  if (req.method === "GET") {
    const u = auth.session(req);
    return u ? res.status(200).json({ user: u, db: db.configured() }) : res.status(401).json({ error: "로그인하세요." });
  }

  if (req.method === "DELETE") {
    const u = auth.session(req);
    auth.clearSession(req, res);
    if (u) await db.log("auth", { action: "logout", actor: u, req });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "POST") {
    const b = req.body || {}, id = String(b.id || "").trim().slice(0, 60), ip = auth.clientIp(req);
    if (await tooManyFails(ip)) {
      await db.log("auth", { action: "login_blocked", ok: false, actor: id || null, req });
      return res.status(429).json({ error: `로그인 실패가 너무 많습니다. ${WINDOW_MIN}분 뒤에 다시 시도하세요.` });
    }
    if (!auth.checkLogin(id, b.password)) {
      await db.log("auth", { action: "login_fail", ok: false, actor: id || null, req, detail: { agent: String(req.headers["user-agent"] || "").slice(0, 200) } });
      return res.status(401).json({ error: "아이디 또는 비밀번호가 맞지 않습니다." });
    }
    auth.setSession(req, res);
    await db.log("auth", { action: "login", actor: auth.user(), req, detail: { agent: String(req.headers["user-agent"] || "").slice(0, 200) } });
    return res.status(200).json({ user: auth.user(), db: db.configured() });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed." });
};
