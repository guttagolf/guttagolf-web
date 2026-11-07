// Saving a paid Stripe Checkout session as a booking. Used by api/session (customer back on book.html)
// and api/stripe-webhook (Stripe calling us, so a payer who closes the tab is still saved).
// Files starting with "_" are helpers, not API routes.
const Stripe = require("stripe");
const db = require("./_db.js");
const notify = require("./_notify.js");

// The booking a session paid for, from the metadata api/checkout put on it.
function bookingOf(s) {
  const m = s.metadata || {};
  return {
    code: m.code || "GG-" + s.id.slice(-6).toUpperCase(),     // m.code: the payment hold api/checkout made
    date: m.date, bay: +m.bay, start: +m.start, len: +m.len, name: m.name, phone: m.phone,
    email: s.customer_details ? s.customer_details.email : null,
    postal: m.postal || null, age: m.age || null, gender: m.gender || null, smsOk: m.sms === "1",
    promo: m.promo || null, ref: m.ref || null
  };
}

async function retrieve(id) { return Stripe(process.env.STRIPE_SECRET_KEY).checkout.sessions.retrieve(id); }

// Saves the paid booking unless it is already saved: confirms its payment hold, or inserts it when there is none (or it expired).
// Returns its status: confirmed, or conflict if the time was taken meanwhile. Only the call that saves it texts the customer.
async function saveBooking(s, b, actor) {
  const m = s.metadata || {};
  // The held booking by its code, or (sessions from before payment holds) by the session.
  const byBooking = "bookings?" + (m.code ? `code=eq.${encodeURIComponent(m.code)}` : `stripe_session_id=eq.${encodeURIComponent(s.id)}`);
  const found = await db.rest(`${byBooking}&select=status`);
  if (found.length && found[0].status !== "pending") return found[0].status;
  const pi = typeof s.payment_intent === "string" ? s.payment_intent : null;
  const detail = { date: b.date, bay: b.bay, start: b.start, len: b.len, name: b.name, phone: b.phone, email: b.email, total: s.amount_total / 100, session: s.id, via: actor };
  const text = () => notify.bookingConfirmed({ ...b, total: s.amount_total / 100 }, true);

  if (found.length) {
    const rows = await db.rest(`${byBooking}&status=eq.pending`, {
      method: "PATCH", body: { status: "confirmed", hold_until: null, pay_method: "stripe", paid_at: new Date().toISOString(), stripe_session_id: s.id, stripe_payment_intent: pi }
    });
    if (!rows.length) return (await db.rest(`${byBooking}&select=status`))[0].status;   // the other path confirmed it a moment ago
    if (b.email) await db.saveCustomer({ name: b.name, phone: b.phone, email: b.email }).catch(() => {});
    await db.log("payment", { action: "paid", actor: "customer", ref: b.code, detail });
    await text();
    return "confirmed";
  }

  const row = {
    ...b, source: "online", payMethod: "stripe", stripeSessionId: s.id, stripePaymentIntent: pi,
    amounts: { subtotal: +m.subtotal, tax: +m.tax, total: s.amount_total, discount: +m.discount || 0 }
  };
  try {
    const status = (await db.addBooking(row)).status;
    await db.log("payment", { action: "paid", actor: "customer", ref: b.code, detail });
    await text();
    return status;
  } catch (err) {
    if (err.code === "23505") return "confirmed";                     // the other path (page or webhook) saved it first
    if (err.code !== "23P01") throw err;                              // anything but an overlap is a real failure
    // The overlap may be with this very booking, saved by the other path a moment ago.
    const again = await db.rest(`${byBooking}&select=status`);
    if (again.length) return again[0].status;
    const status = (await db.addBooking({ ...row, status: "conflict" })).status;
    await db.log("payment", { action: "paid_conflict", ok: false, actor: "customer", ref: b.code, detail });
    return status;
  }
}

module.exports = { bookingOf, retrieve, saveBooking };
