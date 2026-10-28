// POST /api/checkout  { date, bay, start, len, name, phone }  →  { url } of a Stripe Checkout page
// The price is worked out here from pricing.js; the amount the page shows is never trusted.
const Stripe = require("stripe");
const { checkBooking } = require("./_booking.js");
const db = require("./_db.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Use POST." }); }
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "Online payment is not set up yet. Please call or text us to book.", code: "not_configured" });

  const check = checkBooking(req.body);
  if (check.error) return res.status(400).json({ error: check.error });
  const { booking, amounts, label } = check;

  if (db.configured()) {
    try {
      if (!(await db.isFree(booking.date, booking.bay, booking.start, booking.len))) return res.status(409).json({ error: "Someone just booked that time. Pick another time or bay.", code: "taken" });
    } catch (err) {
      console.error("Availability check failed:", err.message);
      return res.status(502).json({ error: "We could not check that time. Please try again, or call or text us." });
    }
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || (host && host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;
  // Stripe metadata values must be strings.
  const metadata = {
    date: booking.date, bay: String(booking.bay), start: String(booking.start), len: String(booking.len),
    name: booking.name, phone: booking.phone, subtotal: String(amounts.subtotal), tax: String(amounts.tax)
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
      cancel_url: `${origin}/book.html?canceled=1`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60   // the shortest Stripe allows
    });
    await db.log("payment", { action: "checkout_start", actor: "customer", ref: session.id, req,
      detail: { date: booking.date, bay: booking.bay, start: booking.start, len: booking.len, name: booking.name, phone: booking.phone, total: amounts.total / 100 } });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout failed:", err.message);
    await db.log("error", { action: "checkout", ok: false, actor: "customer", req, detail: { message: err.message } });
    return res.status(502).json({ error: "We could not open the payment page. Please try again, or call or text us." });
  }
};
