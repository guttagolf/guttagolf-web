// Checks a booking request against the opening hours and works out the price on the server.
// Files starting with "_" are helpers, not API routes.
const P = require("../pricing.js");

// Today's date key and minutes since midnight in Toronto, whatever time zone the server runs in.
function torontoNow() {
  const parts = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: P.TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return { key: `${parts.year}-${parts.month}-${parts.day}`, mins: +parts.hour * 60 + +parts.minute };
}

function int(v) { return typeof v === "number" && Number.isInteger(v) ? v : NaN; }

const AGES = ["under18", "18-24", "25-34", "35-44", "45-54", "55-64", "65plus"];
const GENDERS = ["female", "male", "other", "na"];

// The optional "about you" answers: { postal, age, gender, smsOk }, or { error }. Also used for the admin's phone bookings.
function checkProfile(b) {
  const out = {};
  const postal = String(b.postal || "").trim().toUpperCase().replace(/\s+/g, "");
  if (postal) {
    if (!/^[A-Z]\d[A-Z](\d[A-Z]\d)?$/.test(postal)) return { error: "Check your postal code (like M3B 2M3), or leave it empty." };
    out.postal = postal.length === 6 ? postal.slice(0, 3) + " " + postal.slice(3) : postal;
  }
  if (AGES.includes(b.age)) out.age = b.age;
  if (GENDERS.includes(b.gender)) out.gender = b.gender;
  if (b.smsOk === true) out.smsOk = true;
  return out;
}

// Promo code and campaign ref as the page sent them; the code is checked against the database in _promo.js.
function promoOf(b) { const c = String(b.promo || "").trim().toUpperCase(); return /^[A-Z0-9]{3,16}$/.test(c) ? c : null; }
function refOf(b) { const r = String(b.src || "").trim().toLowerCase(); return /^[a-z0-9_-]{1,40}$/.test(r) ? r : null; }

// Returns { booking, amounts, label } or { error }.
function checkBooking(body) {
  const b = body || {};
  const bay = int(b.bay), start = int(b.start), len = int(b.len);
  const name = String(b.name || "").trim().slice(0, 80), phone = String(b.phone || "").trim().slice(0, 30);
  const day = P.parseDay(b.date), now = torontoNow(), today = P.parseDay(now.key);

  if (!day) return { error: "Pick a day." };
  const dayIdx = Math.round((day - today) / 864e5);
  if (dayIdx < 0 || dayIdx >= P.DAYS_AHEAD) return { error: `Bookings open up to ${P.DAYS_AHEAD} days ahead.` };
  if (!(bay >= 1 && bay <= P.BAYS)) return { error: "Pick a bay." };
  if (!(start >= 0 && len >= P.MIN_LEN && len <= P.MAX_LEN && start + len <= P.SLOTS)) return { error: "Pick a start and finish time." };
  if (dayIdx === 0) {
    if (P.slotMins(start) <= now.mins) return { error: "That start time has passed. Pick a later time." };
    if (P.isLate(start + len - 1) && now.mins >= P.LATE_BY * 60) return { error: "Tonight's late-night hours closed to new bookings at 9 PM." };
  }
  if (!name || phone.replace(/\D/g, "").length < 7) return { error: "Enter your name and phone number." };
  const profile = checkProfile(b);
  if (profile.error) return { error: profile.error };

  const amounts = P.cents(P.RATES, day, start, len);
  const dayLabel = day.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" });
  const label = `Bay ${bay} · ${dayLabel}, ${P.slotLabel(start)} – ${P.slotLabel(start + len)}`;
  return { booking: { date: b.date, bay, start, len, name, phone, ...profile, promo: promoOf(b), ref: refOf(b) }, amounts, label };
}

module.exports = { checkBooking, checkProfile, promoOf, refOf, torontoNow };
