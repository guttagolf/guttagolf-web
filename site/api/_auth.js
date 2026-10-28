// Admin login session: a signed cookie, checked by every admin API. Files starting with "_" are helpers, not API routes.
// Env: ADMIN_PASSWORD (required), ADMIN_USER (default "guttagolf").
// The signing key is derived from the password and the Supabase key, so changing the password signs everyone out.
const crypto = require("crypto");

const COOKIE = "gg_admin";
const HOURS = 12;

function user() { return process.env.ADMIN_USER || "guttagolf"; }
function configured() { return !!process.env.ADMIN_PASSWORD; }

function secret() {
  return crypto.createHash("sha256").update("gg-session|" + process.env.ADMIN_PASSWORD + "|" + (process.env.SUPABASE_SERVICE_ROLE_KEY || "")).digest();
}
function sign(data) { return crypto.createHmac("sha256", secret()).update(data).digest("base64url"); }
function same(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function checkLogin(id, password) {
  // Evaluate both so a wrong ID and a wrong password take the same time.
  const okId = same(String(id || "").trim().toLowerCase(), user().toLowerCase());
  const okPw = same(String(password || ""), process.env.ADMIN_PASSWORD);
  return okId && okPw;
}

function cookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function isLocal(req) { return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || "")); }

function setSession(req, res) {
  const data = Buffer.from(JSON.stringify({ u: user(), exp: Date.now() + HOURS * 3600e3 })).toString("base64url");
  res.setHeader("Set-Cookie", `${COOKIE}=${data}.${sign(data)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${HOURS * 3600}` + (isLocal(req) ? "" : "; Secure"));
}
function clearSession(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0` + (isLocal(req) ? "" : "; Secure"));
}

// The signed-in admin's user name, or null.
function session(req) {
  if (!configured()) return null;
  const raw = cookies(req)[COOKIE] || "", dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const data = raw.slice(0, dot);
  if (!same(raw.slice(dot + 1), sign(data))) return null;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString());
    return s.exp > Date.now() ? s.u : null;
  } catch (e) { return null; }
}

// Sends the error and returns null when the request is not from a signed-in admin.
function requireAdmin(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!configured()) { res.status(503).json({ error: "ADMIN_PASSWORD 환경변수가 설정되지 않았습니다.", code: "not_configured" }); return null; }
  const u = session(req);
  if (!u) { res.status(401).json({ error: "다시 로그인하세요.", code: "unauthorized" }); return null; }
  // Changes must come as JSON from our own page (blocks plain cross-site form posts).
  if (req.method !== "GET" && !/application\/json/.test(String(req.headers["content-type"] || ""))) {
    res.status(415).json({ error: "JSON으로 보내야 합니다." }); return null;
  }
  return u;
}

function clientIp(req) { return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || ""; }

module.exports = { configured, checkLogin, setSession, clearSession, session, requireAdmin, clientIp, user };
