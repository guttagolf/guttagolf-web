// Booking texts to the customer (Twilio). Not marketing: these go to every customer who books, consent or not, and never block a booking.
// Files starting with "_" are helpers, not API routes.
const P = require("../pricing.js");
const db = require("./_db.js");
const M = require("./_marketing.js");

// b: { code, date, bay, start, len, phone, total (dollars) }, paid: true when it was paid online.
function confirmText(b, paid, info) {
  const d = P.parseDay(b.date);
  const day = d ? d.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" }) : b.date;
  const pay = paid ? `Paid $${b.total.toFixed(2)}.` : `Pay $${b.total.toFixed(2)} at Gutta by card or cash.`;
  return `Gutta Golf: You're booked. ${day}, ${P.slotLabel(b.start)} – ${P.slotLabel(b.start + b.len)}, Bay ${b.bay}. Code ${b.code}. ${pay} ` +
    `To cancel, call or text ${info.phone} at least 24 hours ahead. ${info.address1}.`;
}

// Sends the confirmation and logs the result. Returns true when sent.
async function bookingConfirmed(b, paid) {
  const to = M.e164(b.phone);
  if (!M.twilioConfigured() || !to) return false;
  let info = { phone: "437-655-4161", address1: "244 Lesmill Rd" };
  try { info = { ...info, ...(await db.siteSettings()).info }; } catch (e) { /* defaults are fine */ }
  try {
    const sid = await M.twilioSend(to, confirmText(b, paid, info));
    await db.log("booking", { action: "sms_confirm", actor: "server", ref: b.code, detail: { phone: b.phone, sid } });
    return true;
  } catch (err) {
    await db.log("error", { action: "sms_confirm", ok: false, actor: "server", ref: b.code, detail: { phone: b.phone, message: err.message } });
    return false;
  }
}

module.exports = { bookingConfirmed, confirmText };
