// POST /api/reserve  { date, bay, start, len, name, phone }  →  { code, date, bay, start, len, name, total }
// Books without paying online: the customer pays at Gutta. Priced on the server from pricing.js like api/checkout.
// Unpaid bookings hold a bay for nothing, so one phone number and one IP can only hold a few at a time.
const { checkBooking, torontoNow } = require("./_booking.js");
const db = require("./_db.js");

const PER_PHONE = 2;   // upcoming unpaid bookings one phone number can hold
const PER_IP = 3;      // pay-at-Gutta bookings one IP can make in 24 hours

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Use POST." }); }
  if (!db.configured()) return res.status(503).json({ error: "Booking is not set up yet. Please call or text us to book.", code: "not_configured" });

  const check = checkBooking(req.body);
  if (check.error) return res.status(400).json({ error: check.error });
  const { booking, amounts } = check;
  const digits = booking.phone.replace(/\D/g, "");
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();

  try {
    const since = new Date(Date.now() - 864e5).toISOString();
    const [held, recent] = await Promise.all([
      db.rest(`bookings?select=code,customers!inner(phone_key)&customers.phone_key=eq.${digits}&status=eq.confirmed&paid_at=is.null&date=gte.${torontoNow().key}`),
      ip ? db.rest(`logs?select=id&action=eq.booking_venue&ip=eq.${encodeURIComponent(ip)}&at=gte.${encodeURIComponent(since)}`) : []
    ]);
    if (held.length >= PER_PHONE || recent.length >= PER_IP) {
      await db.log("booking", { action: "booking_venue_limit", ok: false, actor: "customer", req, detail: { phone: booking.phone, held: held.length, recent: recent.length } });
      return res.status(429).json({ error: "You already have bookings waiting to be paid. Pay now online for this one, or call or text us.", code: "limit" });
    }

    const row = await db.addWithCode({ ...booking, amounts, source: "online" });
    await db.log("booking", { action: "booking_venue", actor: "customer", ref: row.code, req,
      detail: { date: booking.date, bay: booking.bay, start: booking.start, len: booking.len, name: booking.name, phone: booking.phone, total: amounts.total / 100 } });
    return res.status(200).json({ code: row.code, date: booking.date, bay: booking.bay, start: booking.start, len: booking.len, name: booking.name, total: amounts.total / 100 });
  } catch (err) {
    if (err.code === "23P01") return res.status(409).json({ error: "Someone just booked that time. Pick another time or bay.", code: "taken" });
    console.error("Pay-at-Gutta booking failed:", err.message);
    await db.log("error", { action: "booking_venue", ok: false, actor: "customer", req, detail: { message: err.message } });
    return res.status(502).json({ error: "We could not save your booking. Please try again, or call or text us." });
  }
};
