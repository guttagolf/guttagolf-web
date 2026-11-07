// Public marketing endpoints used by site.js and book.js, plus Twilio's incoming-text webhook.
//   POST /api/site?do=track  { type, page, sid, vid, src, referrer, device }  →  204   (one website event, no personal data)
//   GET  /api/site?do=popup&page=home                                        →  { popup } the popup to show, or null
//   GET  /api/site?do=promo&code=AM20                                        →  { code, percent_off } or 404
//   GET  /api/site?do=settings                                               →  { info, notice } the admin saved (api/admin?view=settings)
//   POST /api/site?do=sms-in   ←  Twilio (form fields From, Body). STOP / START replies turn marketing texts off / on.
//        Set once in Twilio: Phone Numbers → your number → Messaging → "A message comes in" → https://<site>/api/site?do=sms-in (HTTP POST).
const db = require("./_db.js");
const M = require("./_marketing.js");
const promo = require("./_promo.js");

const TYPES = /^(view|popup_view|popup_click|popup_close|book_start|booked)$/;
const word = (v, n) => { const s = String(v || "").trim().slice(0, n || 40); return /^[\w.:-]+$/.test(s) ? s : null; };

async function track(b) {
  if (!TYPES.test(String(b.type || ""))) return;
  await db.rest("events", {
    method: "POST", prefer: "return=minimal",
    body: {
      type: b.type, page: word(b.page, 20), sid: word(b.sid, 40), vid: word(b.vid, 40),
      src: word(String(b.src || "").toLowerCase(), 40), referrer: word(String(b.referrer || "").toLowerCase(), 80),
      device: b.device === "mobile" ? "mobile" : b.device === "desktop" ? "desktop" : null
    }
  });
}

module.exports = async (req, res) => {
  const q = req.query || {};
  if (!db.configured()) return res.status(503).json({ error: "Not configured." });

  try {
    if (req.method === "POST" && q.do === "track") {
      try { await track(typeof req.body === "string" ? JSON.parse(req.body) : req.body || {}); }
      catch (err) { console.error("Track failed:", err.message); }      // tracking must never bother the visitor
      return res.status(204).end();
    }

    if (req.method === "GET" && q.do === "popup") {
      res.setHeader("Cache-Control", "public, s-maxage=60, max-age=0");
      let popup = null;
      try { if (M.PAGES.includes(q.page)) popup = await M.livePopup(q.page); } catch (err) { console.error("Popup lookup failed:", err.message); }
      return res.status(200).json({ popup });
    }

    if (req.method === "GET" && q.do === "settings") {
      res.setHeader("Cache-Control", "public, s-maxage=30, max-age=0");
      return res.status(200).json(await db.siteSettings());
    }

    if (req.method === "GET" && q.do === "promo") {
      res.setHeader("Cache-Control", "no-store");
      const p = await promo.find(String(q.code || "").trim().toUpperCase());
      return p ? res.status(200).json({ code: p.code, percent_off: p.percent_off, ends_on: p.ends_on })
        : res.status(404).json({ error: "That promo code is not valid right now." });
    }

    if (req.method === "POST" && q.do === "sms-in") {
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      if (!M.twilioSignatureOk(req, `https://${host}${req.url}`)) return res.status(403).send("Bad signature");
      const b = req.body || {}, result = await M.smsReply(b.From, b.Body);
      if (result) await db.log("marketing", { action: result === "opt_out" ? "sms_opt_out" : "sms_opt_in", actor: "customer", ref: String(b.From || "").slice(-4), detail: { phone: b.From } });
      res.setHeader("Content-Type", "text/xml");
      return res.status(200).send("<Response/>");      // Twilio's own opt-out handling sends the reply text
    }

    return res.status(400).json({ error: "Unknown request." });
  } catch (err) {
    console.error("Site API failed:", q.do, err.message);
    return res.status(502).json({ error: "Something went wrong. Please try again." });
  }
};
