// Promo codes (promos table): a percentage off the subtotal, before HST. Used by api/checkout, api/reserve and api/site.
// A code works only while it is active (its campaign was sent or published) and today is inside its dates.
// Files starting with "_" are helpers, not API routes.
const P = require("../pricing.js");
const db = require("./_db.js");
const { torontoNow } = require("./_booking.js");

// The usable promo for a code today, or null.
async function find(code) {
  if (!code || !/^[A-Z0-9]{3,16}$/.test(code) || !db.configured()) return null;
  const rows = await db.rest(`promos?select=code,percent_off,starts_on,ends_on,campaign_ref&code=eq.${code}&active=is.true`);
  const p = rows[0], today = torontoNow().key;
  if (!p || (p.starts_on && today < p.starts_on) || (p.ends_on && today > p.ends_on)) return null;
  return p;
}

// Amounts in cents with percent off the subtotal, rounded like P.cents. discount is what was taken off.
function discounted(amounts, percent) {
  const discount = Math.round(amounts.subtotal * percent / 100), subtotal = amounts.subtotal - discount, tax = Math.round(subtotal * P.TAX);
  return { subtotal, tax, total: subtotal + tax, discount };
}

// { amounts, promo, ref } for a checked booking, or { error } when it carries a code that does not work.
// A booking that came in with a code but no ?src= is credited to the code's campaign.
async function apply(booking, amounts) {
  if (!booking.promo) return { amounts: { ...amounts, discount: 0 }, promo: null, ref: booking.ref };
  const p = await find(booking.promo);
  if (!p) return { error: "That promo code is not valid right now. Remove it to book at the regular price." };
  return { amounts: discounted(amounts, p.percent_off), promo: p, ref: booking.ref || p.campaign_ref || null };
}

module.exports = { find, discounted, apply };
