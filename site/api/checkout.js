// POST /api/checkout  { date, bay, start, len, name, phone, postal?, age?, gender?, smsOk?, promo?, src? }  →  { url } of a Stripe Checkout page
// The price (and any promo discount) is worked out here from pricing.js and the promos table; the amount the page shows is never trusted.
// The bay is held (a 'pending' booking) while the Stripe page is open, so nobody else can pay for the same time.
//   POST /api/checkout?release=GG-XXXXX  →  frees that hold when the customer cancels on the Stripe page
const Stripe = require("stripe");
const { checkBooking } = require("./_booking.js");
const db = require("./_db.js");
const promo = require("./_promo.js");

const HOLD_MIN = 32;   // the Stripe page expires after 30 minutes; the hold lasts a little longer

// Frees a payment hold when its Stripe page was canceled. Stripe is asked first, so a paid booking is never released.
async function release(code, res) {
  if (!/^GG-[A-Z0-9]+$/.test(code) || !db.configured()) return res.status(400).json({ error: "Missing booking code." });
  try {
    const rows = await db.rest(`bookings?select=stripe_session_id&code=eq.${encodeURIComponent(code)}&status=eq.pending`);
    if (!rows.length) return res.status(200).json({ released: false });
    const id = rows[0].stripe_session_id;
    if (id) {
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY), s = await stripe.checkout.sessions.retrieve(id);
      if (s.payment_status === "paid") return res.status(200).json({ released: false });
      if (s.status === "open") await stripe.checkout.sessions.expire(id);
    }
    await db.rest(`bookings?code=eq.${encodeURIComponent(code)}&status=eq.pending`, { method: "DELETE", prefer: "return=minimal" });
    return res.status(200).json({ released: true });
  } catch (err) {
    console.error("Releasing hold failed:", code, err.message);
    return res.status(502).json({ error: "Could not release the hold." });   // it still expires by itself
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Use POST." }); }
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "Online payment is not set up yet. Please call or text us to book.", code: "not_configured" });
  if (req.query && req.query.release) return release(String(req.query.release), res);

  const check = checkBooking(req.body);
  if (check.error) return res.status(400).json({ error: check.error });
  const { booking } = check;
  let { amounts, label } = check, ref = booking.ref, hold = null;
  const TAKEN = { error: "Someone just booked that time. Pick another time or bay.", code: "taken" };

  if (db.configured()) {
    try {
      if (!(await db.isFree(booking.date, booking.bay, booking.start, booking.len))) return res.status(409).json(TAKEN);
      const pr = await promo.apply(booking, amounts);
      if (pr.error) return res.status(400).json({ error: pr.error, code: "promo" });
      amounts = pr.amounts; ref = pr.ref;
      if (pr.promo) label += ` · ${pr.promo.code} ${pr.promo.percent_off}% off`;
    } catch (err) {
      console.error("Availability check failed:", err.message);
      return res.status(502).json({ error: "We could not check that time. Please try again, or call or text us." });
    }
    try {
      hold = await db.addWithCode({ ...booking, amounts, ref, source: "online", status: "pending", holdUntil: new Date(Date.now() + HOLD_MIN * 60e3).toISOString() });
    } catch (err) {
      if (err.code === "23P01") return res.status(409).json(TAKEN);
      // 23514 / 42703 / PGRST204: the database has no payment holds yet (schema.sql not run again). Pay without a hold, as before.
      if (!["23514", "42703", "PGRST204"].includes(err.code)) {
        console.error("Payment hold failed:", err.message);
        return res.status(502).json({ error: "We could not hold that time. Please try again, or call or text us." });
      }
    }
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || (host && host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;
  // Stripe metadata values must be strings.
  const metadata = {
    date: booking.date, bay: String(booking.bay), start: String(booking.start), len: String(booking.len),
    name: booking.name, phone: booking.phone, subtotal: String(amounts.subtotal), tax: String(amounts.tax),
    postal: booking.postal || "", age: booking.age || "", gender: booking.gender || "", sms: booking.smsOk ? "1" : "",
    promo: amounts.discount != null && booking.promo || "", discount: String(amounts.discount || 0), ref: ref || "",
    code: hold ? hold.code : ""      // the held booking this payment confirms
  };

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        { quantity: 1, price_data: { currency: "cad", unit_amount: amounts.subtotal, product_data: { name: label, description: "Private simulator bay, up to 4 players" } } },
        { quantity: 1, price_data: { currency: "cad", unit_amount: amounts.tax, product_data: { name: "HST 13%" } } }
      ],
      metadata,
      payment_intent_data: { description: label, metadata },
      success_url: `${origin}/book.html?paid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/book.html?canceled=1` + (hold ? `&hold=${hold.code}` : ""),
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60   // the shortest Stripe allows
    });
    if (hold) await db.rest(`bookings?code=eq.${hold.code}`, { method: "PATCH", prefer: "return=minimal", body: { stripe_session_id: session.id } });
    await db.log("payment", { action: "checkout_start", actor: "customer", ref: session.id, req,
      detail: { date: booking.date, bay: booking.bay, start: booking.start, len: booking.len, name: booking.name, phone: booking.phone, total: amounts.total / 100 } });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout failed:", err.message);
    if (hold) await db.rest(`bookings?code=eq.${hold.code}&status=eq.pending`, { method: "DELETE", prefer: "return=minimal" }).catch(() => {});
    await db.log("error", { action: "checkout", ok: false, actor: "customer", req, detail: { message: err.message } });
    return res.status(502).json({ error: "We could not open the payment page. Please try again, or call or text us." });
  }
};
