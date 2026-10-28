// Admin data API. Every request needs the admin session cookie from /api/login.
//   GET    /api/admin?view=summary                         →  today's bookings, month sales, recent logs
//   GET    /api/admin?view=bookings&date=YYYY-MM-DD        →  { bookings } with customer name, phone and email
//   GET    /api/admin?view=payments&from=…&to=…            →  { payments, stripeTest } every booking (any status) in the date range
//   GET    /api/admin?view=customers&q=…                   →  { customers } with booking count and amount paid
//   GET    /api/admin?view=logs&from=ISO&to=ISO&category=…&q=…  →  { logs } newest first
//   POST   /api/admin  { date, bay, start, len, name, phone }  →  phone / walk-in booking, priced by pricing.js
//   DELETE /api/admin?code=GG-XXXXX                         →  cancels the booking (kept in the table as canceled)
const crypto = require("crypto");
const P = require("../pricing.js");
const db = require("./_db.js");
const auth = require("./_auth.js");
const { torontoNow } = require("./_booking.js");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_COLS = "code,date,bay,start_slot,len,subtotal_cents,tax_cents,total_cents,source,status,stripe_payment_intent,created_at,canceled_at,customers(name,phone,email)";

function newCode() { return "GG-" + crypto.randomBytes(4).toString("hex").slice(0, 5).toUpperCase(); }

function shape(b) {
  const c = b.customers || {};
  return {
    code: b.code, date: b.date, bay: b.bay, start: b.start_slot, len: b.len,
    subtotal: b.subtotal_cents / 100, tax: b.tax_cents / 100, total: b.total_cents / 100,
    source: b.source, status: b.status, paymentIntent: b.stripe_payment_intent, created: b.created_at, canceled: b.canceled_at,
    name: c.name, phone: c.phone, email: c.email
  };
}

async function bookingsOn(date) {
  const rows = await db.rest(`bookings?select=${BOOKING_COLS}&date=eq.${date}&status=neq.canceled&order=start_slot,bay`);
  return rows.map(shape);
}

async function payments(from, to) {
  const rows = await db.rest(`bookings?select=${BOOKING_COLS}&date=gte.${from}&date=lte.${to}&order=date.desc,start_slot.desc&limit=2000`);
  return rows.map(shape);
}

// Characters that would break a PostgREST or=(…) filter are dropped.
function clean(q) { return String(q || "").replace(/[,()*%\\:"']/g, " ").trim().slice(0, 60); }

async function customers(q) {
  const s = clean(q), digits = s.replace(/\D/g, "");
  let filter = "";
  if (s) {
    const parts = [`name.ilike.*${s}*`, `email.ilike.*${s}*`];
    if (digits.length >= 3) parts.push(`phone_key.like.*${digits}*`);
    filter = "&or=" + encodeURIComponent("(" + parts.join(",") + ")");
  }
  const rows = await db.rest(`customers?select=id,name,phone,email,created_at,bookings(date,total_cents,status)${filter}&order=updated_at.desc&limit=300`);
  return rows.map((c) => {
    const live = (c.bookings || []).filter((b) => b.status !== "canceled");
    return {
      name: c.name, phone: c.phone, email: c.email, created: c.created_at,
      count: live.length, spent: live.reduce((n, b) => n + b.total_cents, 0) / 100,
      last: live.map((b) => b.date).sort().pop() || null
    };
  });
}

async function logs(q) {
  let path = "logs?select=*&order=at.desc";
  if (q.from && !isNaN(Date.parse(q.from))) path += "&at=gte." + encodeURIComponent(new Date(q.from).toISOString());
  if (q.to && !isNaN(Date.parse(q.to))) path += "&at=lt." + encodeURIComponent(new Date(q.to).toISOString());
  if (/^(auth|booking|payment|door|system|error)$/.test(String(q.category || ""))) path += "&category=eq." + q.category;
  const s = clean(q.q);
  if (s) path += "&or=" + encodeURIComponent(`(action.ilike.*${s}*,ref.ilike.*${s}*,actor.ilike.*${s}*,ip.ilike.*${s}*)`);
  path += "&limit=" + Math.min(Math.max(+q.limit || 500, 1), 2000);
  return db.rest(path);
}

async function summary() {
  const now = torontoNow(), today = now.key, month = today.slice(0, 8) + "01";
  const [todayRows, monthRows, conflicts, recent] = await Promise.all([
    bookingsOn(today),
    db.rest(`bookings?select=total_cents,tax_cents,source&status=eq.confirmed&date=gte.${month}&date=lte.${today}`),
    db.rest(`bookings?select=${BOOKING_COLS}&status=eq.conflict&date=gte.${today}&order=date,start_slot`),
    db.rest("logs?select=*&order=at.desc&limit=12")
  ]);
  const sum = (rows, f) => rows.reduce((n, r) => n + r[f], 0) / 100;
  return {
    today, nowMins: now.mins, bookings: todayRows,
    month: { from: month, count: monthRows.length, total: sum(monthRows, "total_cents"), tax: sum(monthRows, "tax_cents"),
      online: sum(monthRows.filter((r) => r.source === "online"), "total_cents") },
    conflicts: conflicts.map(shape), logs: recent
  };
}

async function add(body, actor, req) {
  const b = body || {};
  const day = P.parseDay(b.date), bay = +b.bay, start = +b.start, len = +b.len;
  const name = String(b.name || "").trim().slice(0, 80), phone = String(b.phone || "").trim().slice(0, 30);
  if (!day) return { status: 400, error: "날짜를 확인하세요." };
  if (!(bay >= 1 && bay <= P.BAYS)) return { status: 400, error: "Bay를 확인하세요." };
  if (!(start >= 0 && len >= P.MIN_LEN && len <= P.MAX_LEN && start + len <= P.SLOTS)) return { status: 400, error: "영업 종료 시간을 넘습니다. 시작 시간이나 이용 시간을 줄여 주세요." };
  if (!name || phone.replace(/\D/g, "").length < 7) return { status: 400, error: "이름과 전화번호를 입력하세요." };

  const amounts = P.cents(P.RATES, day, start, len);
  for (let i = 0; i < 3; i++) {
    try {
      const row = await db.addBooking({ code: newCode(), date: b.date, bay, start, len, name, phone, amounts, source: "admin" });
      await db.log("booking", { action: "booking_add", actor, ref: row.code, req,
        detail: { date: b.date, bay, time: `${P.slotLabel(start)} – ${P.slotLabel(start + len)}`, name, phone, total: amounts.total / 100 } });
      return { status: 200, code: row.code };
    } catch (err) {
      if (err.code === "23P01") return { status: 409, error: `Bay ${bay}는 그 시간에 이미 예약이 있습니다.` };
      if (err.code !== "23505") throw err;                     // duplicate code: try another
    }
  }
  throw new Error("Could not make a unique booking code.");
}

module.exports = async (req, res) => {
  const actor = auth.requireAdmin(req, res);
  if (!actor) return;
  if (!db.configured()) return res.status(503).json({ error: "Supabase 환경변수가 설정되지 않았습니다.", code: "not_configured" });

  const q = req.query || {};
  try {
    if (req.method === "GET") {
      switch (q.view) {
        case "summary": return res.status(200).json(await summary());
        case "bookings":
          if (!DATE.test(String(q.date || ""))) return res.status(400).json({ error: "날짜를 확인하세요." });
          return res.status(200).json({ bookings: await bookingsOn(q.date) });
        case "payments":
          if (!DATE.test(String(q.from || "")) || !DATE.test(String(q.to || ""))) return res.status(400).json({ error: "기간을 확인하세요." });
          return res.status(200).json({ payments: await payments(q.from, q.to), stripeTest: !/^sk_live_/.test(process.env.STRIPE_SECRET_KEY || "") });
        case "customers": return res.status(200).json({ customers: await customers(q.q) });
        case "logs": return res.status(200).json({ logs: await logs(q) });
        default: return res.status(400).json({ error: "알 수 없는 화면입니다." });
      }
    }
    if (req.method === "POST") {
      const r = await add(req.body, actor, req);
      return r.error ? res.status(r.status).json({ error: r.error }) : res.status(200).json({ code: r.code });
    }
    if (req.method === "DELETE") {
      const code = String(q.code || "");
      if (!/^GG-[A-Z0-9]+$/.test(code)) return res.status(400).json({ error: "예약 코드를 확인하세요." });
      const rows = await db.rest(`bookings?code=eq.${encodeURIComponent(code)}&status=neq.canceled&select=code,date,bay,start_slot,len,total_cents,source`, {
        method: "PATCH", body: { status: "canceled", canceled_at: new Date().toISOString() }
      });
      if (!rows.length) return res.status(404).json({ error: "예약을 찾지 못했습니다." });
      const b = rows[0];
      await db.log("booking", { action: "booking_cancel", actor, ref: code, req,
        detail: { date: b.date, bay: b.bay, time: `${P.slotLabel(b.start_slot)} – ${P.slotLabel(b.start_slot + b.len)}`, total: b.total_cents / 100, source: b.source } });
      return res.status(200).json({ ok: true });
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    console.error("Admin API failed:", err.message);
    if (err.code === "PGRST205" || /Could not find the table/.test(err.message)) {
      return res.status(503).json({ error: "Supabase에 테이블이 아직 없습니다. Supabase → SQL Editor에서 supabase/schema.sql을 실행하세요.", code: "no_tables" });
    }
    await db.log("error", { action: "admin_api", ok: false, actor, req, detail: { method: req.method, view: q.view || null, message: err.message } });
    return res.status(502).json({ error: "데이터베이스 요청이 실패했습니다: " + err.message });
  }
};
