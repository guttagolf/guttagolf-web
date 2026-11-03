// GET /api/session?id=cs_...  →  the booking a Stripe Checkout session paid for, for the confirmation on book.html
// A paid booking is saved to Supabase here (once per session, however often the page is reloaded); api/stripe-webhook saves it too.
const db = require("./_db.js");
const { bookingOf, retrieve, saveBooking } = require("./_paid.js");

module.exports = async (req, res) => {
  const id = String((req.query && req.query.id) || "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "Missing payment reference." });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "Online payment is not set up yet.", code: "not_configured" });

  let s;
  try {
    s = await retrieve(id);
  } catch (err) {
    console.error("Stripe session lookup failed:", err.message);
    return res.status(404).json({ error: "We could not find that payment." });
  }

  const booking = bookingOf(s);
  const paid = s.payment_status === "paid";
  let status = null;
  if (paid && db.configured()) {
    try { status = await saveBooking(s, booking, "page"); }
    catch (err) {
      console.error("Saving booking failed:", booking.code, err.message); status = "unsaved";
      await db.log("error", { action: "booking_save", ok: false, actor: "server", ref: booking.code, req, detail: { session: id, message: err.message } });
    }
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ...booking, paid, status, total: s.amount_total / 100 });
};
