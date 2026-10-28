// Supabase (PostgREST) calls for bookings and customers. Server only: uses the service role key.
// Tables are in supabase/schema.sql. Files starting with "_" are helpers, not API routes.

function configured() { return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY); }

// One REST call. Throws an Error carrying the Postgres error code (e.g. 23P01 overlap, 23505 duplicate).
async function rest(path, opts) {
  const o = opts || {}, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method: o.method || "GET",
    headers: {
      apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      Prefer: o.prefer || "return=representation"
    },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  const text = await r.text(), data = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const err = new Error((data && data.message) || `Supabase ${r.status}`);
    err.code = data && data.code; err.status = r.status;
    throw err;
  }
  return data;
}

// Creates the customer, or updates the name (and email when given) of the one with the same phone digits.
// Without a phone number (a walk-in) it always creates a new customer.
async function saveCustomer({ name, phone, email }) {
  const digits = String(phone || "").replace(/\D/g, "");
  const row = { name, phone: phone || null, phone_key: digits || null, updated_at: new Date().toISOString() };
  if (email) row.email = email;
  if (!digits) return (await rest("customers", { method: "POST", body: row }))[0].id;
  const rows = await rest("customers?on_conflict=phone_key", {
    method: "POST", body: row, prefer: "resolution=merge-duplicates,return=representation"
  });
  return rows[0].id;
}

// Confirmed bookings on a day: [{ bay, start, len }] (no customer details).
async function takenOn(date) {
  const rows = await rest(`bookings?select=bay,start_slot,len&status=eq.confirmed&date=eq.${encodeURIComponent(date)}`);
  return rows.map((b) => ({ bay: b.bay, start: b.start_slot, len: b.len }));
}

async function isFree(date, bay, start, len) {
  return (await takenOn(date)).every((b) => b.bay !== bay || b.start + b.len <= start || start + len <= b.start);
}

// Inserts a booking. booking: { code, date, bay, start, len, name, phone, email, amounts, source, stripeSessionId, status, payMethod }
// payMethod (stripe, card, cash, other) means it is paid now; without it the booking is paid at Gutta later.
async function addBooking(b) {
  const customer_id = await saveCustomer(b);
  const rows = await rest("bookings", {
    method: "POST",
    body: {
      code: b.code, customer_id, date: b.date, bay: b.bay, start_slot: b.start, len: b.len,
      subtotal_cents: b.amounts.subtotal, tax_cents: b.amounts.tax, total_cents: b.amounts.total,
      source: b.source, status: b.status || "confirmed", stripe_session_id: b.stripeSessionId || null,
      stripe_payment_intent: b.stripePaymentIntent || null,
      pay_method: b.payMethod || null, paid_at: b.payMethod ? new Date().toISOString() : null
    }
  });
  return rows[0];
}

function newCode() { return "GG-" + require("crypto").randomBytes(4).toString("hex").slice(0, 5).toUpperCase(); }

// Inserts a booking under a new GG- code, trying another code if that one is already used. An overlap still throws (23P01).
async function addWithCode(b) {
  for (let i = 0; i < 3; i++) {
    try { return await addBooking({ ...b, code: newCode() }); }
    catch (err) { if (err.code !== "23505") throw err; }
  }
  throw new Error("Could not make a unique booking code.");
}

// Writes one line to the logs table. Never throws: a failed log must not break the request it records.
//   category: auth | booking | payment | door | system | error
//   entry: { action, ok, actor, ref, detail, req }  (req gives the IP)
async function log(category, entry) {
  if (!configured()) return;
  const e = entry || {}, req = e.req;
  const ip = req ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null : null;
  try {
    await rest("logs", {
      method: "POST", prefer: "return=minimal",
      body: { category, action: e.action, ok: e.ok !== false, actor: e.actor || null, ref: e.ref || null, ip, detail: e.detail || null }
    });
  } catch (err) { console.error("Log write failed:", category, e.action, err.message); }
}

module.exports = { configured, rest, saveCustomer, takenOn, isFree, addBooking, addWithCode, log };
