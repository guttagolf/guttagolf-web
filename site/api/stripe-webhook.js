// POST /api/stripe-webhook  ←  Stripe, on checkout.session.completed and checkout.session.async_payment_succeeded
// Saves the paid booking even when the customer closes the tab before coming back to book.html.
// The event body is not trusted: only the session id is read from it, and the session is fetched from Stripe with our key.
// Set up once in Stripe: Developers → Webhooks → Add endpoint → https://<site>/api/stripe-webhook, with those two events.
const db = require("./_db.js");
const { bookingOf, retrieve, saveBooking } = require("./_paid.js");

const EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Use POST." }); }
  if (!process.env.STRIPE_SECRET_KEY || !db.configured()) return res.status(503).json({ error: "Not configured." });

  const e = req.body || {}, id = String((e.data && e.data.object && e.data.object.id) || "");
  if (!EVENTS.includes(e.type)) return res.status(200).json({ ignored: true });
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "Missing session id." });

  let s;
  try { s = await retrieve(id); }
  catch (err) { return res.status(404).json({ error: "Unknown session." }); }
  if (s.payment_status !== "paid") return res.status(200).json({ paid: false });

  const booking = bookingOf(s);
  try {
    return res.status(200).json({ code: booking.code, status: await saveBooking(s, booking, "webhook") });
  } catch (err) {
    console.error("Webhook save failed:", booking.code, err.message);
    await db.log("error", { action: "booking_save", ok: false, actor: "server", ref: booking.code, req, detail: { session: id, message: err.message, via: "webhook" } });
    return res.status(500).json({ error: "Save failed." });   // Stripe retries on errors
  }
};
