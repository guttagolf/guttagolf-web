// GET /api/availability?date=YYYY-MM-DD  →  { date, taken: [{ bay, start, len }] }  (no customer details)
const db = require("./_db.js");

module.exports = async (req, res) => {
  const date = String((req.query && req.query.date) || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Missing date." });
  if (!db.configured()) return res.status(503).json({ error: "Bookings database is not set up yet.", code: "not_configured" });
  try {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ date, taken: await db.takenOn(date) });
  } catch (err) {
    console.error("Availability lookup failed:", err.message);
    return res.status(502).json({ error: "We could not load bookings." });
  }
};
