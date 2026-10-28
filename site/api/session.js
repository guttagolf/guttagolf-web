// GET /api/session?id=cs_...  →  the booking a Stripe Checkout session paid for, for the confirmation on book.html
// A paid booking is saved to Supabase here (once per session, however often the page is reloaded).
const Stripe = require("stripe");
const db = require("./_db.js");

// Saves the paid booking unless it is already saved. Returns its status: confirmed, or conflict if the time was taken meanwhile.
async function saveBooking(s, b) {
  const found = await db.rest(`bookings?select=status&stripe_session_id=eq.${encodeURIComponent(s.id)}`);
  if (found.length) return found[0].status;
  const m = s.metadata || {};
  const row = {
    ...b, source: "online", stripeSessionId: s.id, stripePaymentIntent: typeof s.payment_intent === "string" ? s.payment_intent : null,
    amounts: { subtotal: +m.subtotal, tax: +m.tax, total: s.amount_total }
  };
  const detail = { date: b.date, bay: b.bay, start: b.start, len: b.len, name: b.name, phone: b.phone, email: b.email, total: s.amount_total / 100, session: s.id };
  try {
    const status = (await db.addBooking(row)).status;
    await db.log("payment", { action: "paid", actor: "customer", ref: b.code, detail });
    return status;
  } catch (err) {
    if (err.code === "23505") return "confirmed";                     // a second request for the same session got there first
    if (err.code !== "23P01") throw err;                              // anything but an overlap is a real failure
    const status = (await db.addBooking({ ...row, status: "conflict" })).status;
    await db.log("payment", { action: "paid_conflict", ok: false, actor: "customer", ref: b.code, detail });
    return status;
  }
}

module.exports = async (req, res) => {
  const id = String((req.query && req.query.id) || "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "Missing payment reference." });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "Online payment is not set up yet.", code: "not_configured" });

  let s;
  try {
    s = await Stripe(process.env.STRIPE_SECRET_KEY).checkout.sessions.retrieve(id);
  } catch (err) {
    console.error("Stripe session lookup failed:", err.message);
    return res.status(404).json({ error: "We could not find that payment." });
  }

  const m = s.metadata || {};
  const booking = {
    code: "GG-" + id.slice(-6).toUpperCase(),
    date: m.date, bay: +m.bay, start: +m.start, len: +m.len, name: m.name, phone: m.phone,
    email: s.customer_details ? s.customer_details.email : null
  };
  const paid = s.payment_status === "paid";
  let status = null;
  if (paid && db.configured()) {
    try { status = await saveBooking(s, booking); }
    catch (err) {
      console.error("Saving booking failed:", booking.code, err.message); status = "unsaved";
      await db.log("error", { action: "booking_save", ok: false, actor: "server", ref: booking.code, req, detail: { session: id, message: err.message } });
    }
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ...booking, paid, status, total: s.amount_total / 100 });
};
