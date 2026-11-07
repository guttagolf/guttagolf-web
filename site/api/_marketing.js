// Marketing data for Green (ElevenLabs agent, api/_green.js) and the admin's Green tab (api/green.js):
// booking and customer analysis, website events, text campaigns (Twilio) and website popups.
// Analysis returns totals only, never names or phone numbers, except topCustomers (first name + initial).
// Files starting with "_" are helpers, not API routes.
const crypto = require("crypto");
const P = require("../pricing.js");
const db = require("./_db.js");
const { torontoNow } = require("./_booking.js");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_HOURS = P.SLOTS / P.PER_HOUR;                 // bookable hours per bay per day (9 AM – 6 AM)
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LAPSED_DAYS = 60, NEW_DAYS = 30;

// ---------- dates ----------
function addDays(key, n) { const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5); }
// { from, to } from the request, the last 30 days by default, at most two years.
function range(from, to) {
  const today = torontoNow().key;
  const t = DATE.test(to || "") ? to : today;
  let f = DATE.test(from || "") ? from : addDays(t, -29);
  if (f > t) f = t;
  if (daysBetween(f, t) > 731) f = addDays(t, -731);
  return { from: f, to: t };
}
function eachDay(from, to, fn) { for (let k = from; k <= to; k = addDays(k, 1)) fn(k); }
function weekOf(key) { const d = P.parseDay(key); return addDays(key, -((d.getDay() + 6) % 7)); }   // Monday

// Every row of a PostgREST query, 1000 at a time (Supabase returns at most 1000 per request).
async function all(path, max) {
  const out = [], cap = max || 50000;
  for (let offset = 0; offset < cap; offset += 1000) {
    const rows = await db.rest(`${path}&limit=1000&offset=${offset}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const money = (cents) => Math.round(cents) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

// ---------- bookings ----------
const BOOKING_GROUPS = ["day", "week", "month", "weekday", "hour", "rate_band", "bay", "source", "pay_method", "promo", "campaign", "season"];

function rateBand(d, s) {
  if (P.isLate(s)) return "late (12–6 AM)";
  if (P.weekendRate(d)) return "weekend/holiday";
  return P.slotMins(s) >= P.RATES.eveFrom * 60 ? "weekday evening" : "weekday day";
}

// Booked hours, revenue and bay utilization grouped one way. Revenue is before HST and after promo discounts.
async function bookingStats({ from, to, group_by }) {
  const r = range(from, to), g = BOOKING_GROUPS.includes(group_by) ? group_by : "day";
  const rows = await all(`bookings?select=id,date,bay,start_slot,len,subtotal_cents,discount_cents,source,pay_method,promo_code,campaign_ref,customer_id&status=eq.confirmed&date=gte.${r.from}&date=lte.${r.to}&order=id`);
  const buckets = {};
  const get = (k) => buckets[k] || (buckets[k] = { key: k, bookings: 0, hours: 0, revenue: 0, discount: 0, customers: new Set(), capacity: 0 });
  const dayKey = (date) => g === "week" ? weekOf(date) : g === "month" ? date.slice(0, 7) : g === "weekday" ? WEEKDAYS[P.parseDay(date).getDay()] : g === "season" ? P.season(P.parseDay(date)) : date;

  rows.forEach((b) => {
    const d = P.parseDay(b.date), perSlot = b.subtotal_cents / b.len;
    if (g === "hour" || g === "rate_band") {
      // Spread the booking over the hours (or rate bands) it covers.
      for (let k = 0; k < b.len; k++) {
        const s = b.start_slot + k;
        const key = g === "hour" ? String(Math.floor(P.slotMins(s) / 60) % 24).padStart(2, "0") + ":00" : rateBand(d, s);
        const x = get(key);
        x.hours += 1 / P.PER_HOUR; x.revenue += perSlot; x.customers.add(b.customer_id);
        if (k === 0) x.bookings++;
      }
      return;
    }
    const key = g === "bay" ? "Bay " + b.bay : g === "source" ? b.source : g === "pay_method" ? (b.pay_method || "unpaid") :
      g === "promo" ? (b.promo_code || "(none)") : g === "campaign" ? (b.campaign_ref || "(none)") : dayKey(b.date);
    const x = get(key);
    x.bookings++; x.hours += b.len / P.PER_HOUR; x.revenue += b.subtotal_cents; x.discount += b.discount_cents || 0; x.customers.add(b.customer_id);
  });

  // Bay-hours that could have been sold, for utilization.
  let capacity = 0;
  eachDay(r.from, r.to, (k) => {
    capacity += P.BAYS * DAY_HOURS;
    if (["day", "week", "month", "weekday", "season"].includes(g)) get(dayKey(k)).capacity += P.BAYS * DAY_HOURS;
    else if (g === "bay") for (let n = 1; n <= P.BAYS; n++) get("Bay " + n).capacity += DAY_HOURS;
    else if (g === "hour") for (let s = 0; s < P.SLOTS; s += P.PER_HOUR) get(String(Math.floor(P.slotMins(s) / 60) % 24).padStart(2, "0") + ":00").capacity += P.BAYS;
    else if (g === "rate_band") { const d = P.parseDay(k); for (let s = 0; s < P.SLOTS; s++) get(rateBand(d, s)).capacity += P.BAYS / P.PER_HOUR; }
  });

  const out = Object.values(buckets).map((x) => ({
    key: x.key, bookings: x.bookings, hours: round1(x.hours), revenue: money(x.revenue), discount: money(x.discount),
    customers: x.customers.size, utilization_pct: x.capacity ? round1(x.hours / x.capacity * 100) : null
  })).sort((a, b) => g === "weekday" ? WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key) : g === "hour" ? ((+a.key.slice(0, 2) + 15) % 24) - ((+b.key.slice(0, 2) + 15) % 24) : String(a.key).localeCompare(String(b.key)));
  const hours = rows.reduce((n, b) => n + b.len, 0) / P.PER_HOUR;
  return {
    from: r.from, to: r.to, group_by: g,
    totals: { bookings: rows.length, hours: round1(hours), revenue: money(rows.reduce((n, b) => n + b.subtotal_cents, 0)),
      discount: money(rows.reduce((n, b) => n + (b.discount_cents || 0), 0)), customers: new Set(rows.map((b) => b.customer_id)).size,
      utilization_pct: round1(hours / capacity * 100) },
    rows: out,
    note: "revenue is before HST and after promo discounts; utilization = booked bay-hours / open bay-hours (8 bays, 9 AM – 6 AM)"
  };
}

// ---------- customers ----------
const CUSTOMER_DIMS = ["region", "area", "age_band", "gender", "segment", "sms_opt_in", "first_month"];

// Every customer with their confirmed bookings and a segment, as of today.
async function customersWithBookings() {
  const today = torontoNow().key;
  const rows = await all("customers?select=id,name,phone_key,postal_code,age_band,gender,sms_opt_in,created_at,bookings(date,len,subtotal_cents,status)&order=id");
  return rows.map((c) => {
    const bs = (c.bookings || []).filter((b) => b.status === "confirmed");
    const dates = bs.map((b) => b.date).sort(), past = dates.filter((d) => d <= today);
    const first = dates[0] || null, last = past[past.length - 1] || null, count = bs.length;
    let segment = "no_booking";
    if (count) {
      if (count >= 2 && last && daysBetween(last, today) > LAPSED_DAYS && !dates.some((d) => d > today)) segment = "lapsed";
      else if (count >= 5) segment = "vip";
      else if (count >= 2) segment = "regular";
      else if (first && daysBetween(first, today) <= NEW_DAYS) segment = "new";
      else segment = "one_time";
    }
    const fsa = c.postal_code ? c.postal_code.slice(0, 3) : null;
    return { ...c, bookings: bs, count, first, last, segment, fsa };
  });
}

function dimValue(c, dim) {
  switch (dim) {
    case "region": return c.fsa || "(unknown)";
    case "area": return c.fsa ? c.fsa.slice(0, 2) + "*" : "(unknown)";
    case "age_band": return c.age_band || "(unknown)";
    case "gender": return c.gender || "(unknown)";
    case "segment": return c.segment;
    case "sms_opt_in": return c.sms_opt_in ? "opted in" : "not opted in";
    case "first_month": return c.first ? c.first.slice(0, 7) : "(no booking)";
  }
  return "all";
}

// Customers grouped by one or two dimensions. Bookings, hours and revenue count only the date range.
async function customerAnalysis({ dimension, by, from, to, top }) {
  const dim = CUSTOMER_DIMS.includes(dimension) ? dimension : "segment", second = CUSTOMER_DIMS.includes(by) && by !== dim ? by : null;
  const r = range(from, to), list = await customersWithBookings();
  const buckets = {};
  list.forEach((c) => {
    const key = dimValue(c, dim) + (second ? " | " + dimValue(c, second) : "");
    const x = buckets[key] || (buckets[key] = { key, customers: 0, active: 0, bookings: 0, hours: 0, revenue: 0, lifetime_bookings: 0, sms_reachable: 0 });
    const inRange = c.bookings.filter((b) => b.date >= r.from && b.date <= r.to);
    x.customers++; x.lifetime_bookings += c.count;
    if (inRange.length) x.active++;
    x.bookings += inRange.length;
    x.hours += inRange.reduce((n, b) => n + b.len, 0) / P.PER_HOUR;
    x.revenue += inRange.reduce((n, b) => n + b.subtotal_cents, 0);
    if (c.sms_opt_in && c.phone_key) x.sms_reachable++;
  });
  const rows = Object.values(buckets).map((x) => ({ ...x, hours: round1(x.hours), revenue: money(x.revenue),
    revenue_per_active: x.active ? money(x.revenue / x.active) : 0 })).sort((a, b) => b.customers - a.customers);
  const n = list.length || 1;
  const out = {
    from: r.from, to: r.to, dimension: dim, by: second, total_customers: list.length, rows,
    data_coverage_pct: {
      postal_code: round1(list.filter((c) => c.postal_code).length / n * 100),
      age_band: round1(list.filter((c) => c.age_band).length / n * 100),
      gender: round1(list.filter((c) => c.gender).length / n * 100),
      sms_opt_in: round1(list.filter((c) => c.sms_opt_in).length / n * 100)
    },
    segments_defined: `new = 1 booking in the last ${NEW_DAYS} days; one_time = 1 booking, older; regular = 2–4; vip = 5+; lapsed = 2+ bookings but none in ${LAPSED_DAYS} days and none upcoming`
  };
  if (top) {
    out.top_customers = list.filter((c) => c.count).sort((a, b) => b.bookings.reduce((n, x) => n + x.subtotal_cents, 0) - a.bookings.reduce((n, x) => n + x.subtotal_cents, 0))
      .slice(0, Math.min(+top || 10, 25)).map((c) => {
        const parts = String(c.name || "").trim().split(/\s+/);
        return { name: parts[0] + (parts[1] ? " " + parts[1][0] + "." : ""), bookings: c.count, revenue: money(c.bookings.reduce((n, x) => n + x.subtotal_cents, 0)),
          last_visit: c.last, segment: c.segment, region: c.fsa, sms_opt_in: !!c.sms_opt_in };
      });
  }
  return out;
}

// ---------- website ----------
const SITE_GROUPS = ["day", "weekday", "hour", "page", "src", "device", "referrer"];

async function siteAnalytics({ from, to, group_by }) {
  const r = range(from, to), g = SITE_GROUPS.includes(group_by) ? group_by : "day";
  const start = new Date(r.from + "T05:00:00Z").toISOString(), end = new Date(addDays(r.to, 1) + "T05:00:00Z").toISOString();
  const rows = await all(`events?select=at,type,page,sid,vid,src,referrer,device&at=gte.${encodeURIComponent(start)}&at=lt.${encodeURIComponent(end)}&order=id`, 100000);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: P.TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short" });
  const local = (iso) => { const o = {}; fmt.formatToParts(new Date(iso)).forEach((x) => { o[x.type] = x.value; }); return o; };
  const buckets = {};
  rows.forEach((e) => {
    let key;
    if (g === "day" || g === "weekday" || g === "hour") {
      const t = local(e.at);
      key = g === "day" ? `${t.year}-${t.month}-${t.day}` : g === "weekday" ? t.weekday : t.hour + ":00";
    } else key = e[g] || "(none)";
    const x = buckets[key] || (buckets[key] = { key, views: 0, visitors: new Set(), sessions: new Set(), book_page_sessions: new Set(), book_starts: 0, booked: 0, popup_views: 0, popup_clicks: 0, popup_closes: 0 });
    if (e.type === "view") { x.views++; if (e.page === "book") x.book_page_sessions.add(e.sid); }
    if (e.vid) x.visitors.add(e.vid);
    if (e.sid) x.sessions.add(e.sid);
    if (e.type === "book_start") x.book_starts++;
    if (e.type === "booked") x.booked++;
    if (e.type === "popup_view") x.popup_views++;
    if (e.type === "popup_click") x.popup_clicks++;
    if (e.type === "popup_close") x.popup_closes++;
  });
  const out = Object.values(buckets).map((x) => ({ ...x, visitors: x.visitors.size, sessions: x.sessions.size, book_page_sessions: x.book_page_sessions.size,
    booking_rate_pct: x.sessions.size ? round1(x.booked / x.sessions.size * 100) : 0 })).sort((a, b) => g === "day" || g === "hour" ? a.key.localeCompare(b.key) : b.views - a.views);
  return {
    from: r.from, to: r.to, group_by: g, events: rows.length,
    totals: { views: rows.filter((e) => e.type === "view").length, visitors: new Set(rows.map((e) => e.vid).filter(Boolean)).size,
      sessions: new Set(rows.map((e) => e.sid).filter(Boolean)).size, booked: rows.filter((e) => e.type === "booked").length },
    rows: out.slice(0, 200),
    note: "src is the ?src= campaign ref or utm_source; booked counts online bookings finished on the site"
  };
}

// ---------- campaigns ----------
function newRef(kind) { return (kind === "sms" ? "sms-" : "pop-") + crypto.randomBytes(4).toString("hex").slice(0, 6); }

// SMS segments: 160 / 153 characters in the GSM alphabet, 70 / 67 otherwise (e.g. Korean or emoji).
const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
function segments(text) {
  const gsm = GSM.test(text), len = [...text].length + (gsm ? (text.match(/[\^{}\\[~\]|€]/g) || []).length : 0);
  const one = gsm ? 160 : 70, many = gsm ? 153 : 67;
  return { chars: len, encoding: gsm ? "GSM-7" : "UCS-2", segments: len <= one ? 1 : Math.ceil(len / many) };
}

function siteUrl(origin) { return String(process.env.SITE_URL || origin || "").replace(/\/+$/, ""); }
function bookLink(c, origin) { return `${siteUrl(origin)}/book.html?src=${c.ref}` + (c.promo_code ? `&promo=${c.promo_code}` : ""); }

// The text as it will go out: {name} and {link} filled in, "Gutta Golf" named and a STOP line added when missing (CASL).
function smsText(c, firstName, origin) {
  let t = String(c.content.text || "").replace(/\{name\}/g, firstName || "there").replace(/\{link\}/g, bookLink(c, origin)).trim();
  if (!/gutta/i.test(t)) t = "Gutta Golf: " + t;
  if (!/\bSTOP\b/.test(t)) t += "\nReply STOP to opt out.";
  return t;
}

const AUDIENCE_KEYS = ["segments", "regions", "age_bands", "genders", "min_bookings", "last_visit_within_days", "last_visit_more_than_days"];
function cleanAudience(a) {
  const x = a || {}, out = {};
  const list = (v, re) => Array.isArray(v) ? [...new Set(v.map((s) => String(s).trim()).filter((s) => re.test(s)))].slice(0, 30) : [];
  const segs = list(x.segments, /^(new|one_time|regular|vip|lapsed)$/); if (segs.length) out.segments = segs;
  const regions = list((x.regions || []).map((s) => String(s).toUpperCase()), /^[A-Z]\d?[A-Z]?$/); if (regions.length) out.regions = regions;
  const ages = list(x.age_bands, /^(under18|18-24|25-34|35-44|45-54|55-64|65plus)$/); if (ages.length) out.age_bands = ages;
  const genders = list(x.genders, /^(female|male|other|na)$/); if (genders.length) out.genders = genders;
  ["min_bookings", "last_visit_within_days", "last_visit_more_than_days"].forEach((k) => { if (Number.isInteger(x[k]) && x[k] > 0 && x[k] < 3650) out[k] = x[k]; });
  return out;
}

// Opted-in customers with a phone number who match the audience.
async function audienceList(audience) {
  const a = cleanAudience(audience), today = torontoNow().key;
  return (await customersWithBookings()).filter((c) => {
    if (!c.sms_opt_in || !c.phone_key) return false;
    if (a.segments && !a.segments.includes(c.segment)) return false;
    if (a.regions && !a.regions.some((p) => (c.fsa || "").startsWith(p))) return false;
    if (a.age_bands && !a.age_bands.includes(c.age_band)) return false;
    if (a.genders && !a.genders.includes(c.gender)) return false;
    if (a.min_bookings && c.count < a.min_bookings) return false;
    const since = c.last ? daysBetween(c.last, today) : Infinity;
    if (a.last_visit_within_days && !(since <= a.last_visit_within_days)) return false;
    if (a.last_visit_more_than_days && !(since > a.last_visit_more_than_days)) return false;
    return true;
  });
}

async function audiencePreview(audience) {
  const a = cleanAudience(audience), list = await audienceList(a);
  const by = (f) => list.reduce((o, c) => { const k = f(c) || "(unknown)"; o[k] = (o[k] || 0) + 1; return o; }, {});
  return { audience: a, reachable: list.length, by_segment: by((c) => c.segment), by_age_band: by((c) => c.age_band), by_gender: by((c) => c.gender),
    note: "only customers who agreed to marketing texts (sms_opt_in) and have a phone number are counted" };
}

function cleanPromo(p) {
  if (!p || !p.code) return null;
  const code = String(p.code).trim().toUpperCase(), pct = +p.percent_off;
  if (!/^[A-Z0-9]{3,16}$/.test(code)) throw new Error("Promo code must be 3–16 capital letters or digits.");
  if (!(Number.isInteger(pct) && pct >= 1 && pct <= 50)) throw new Error("percent_off must be a whole number from 1 to 50.");
  return { code, percent_off: pct, starts_on: DATE.test(p.starts_on || "") ? p.starts_on : null, ends_on: DATE.test(p.ends_on || "") ? p.ends_on : null };
}

async function insertCampaign(row, promo) {
  if (promo) {
    try { await db.rest("promos", { method: "POST", prefer: "return=minimal", body: { ...promo, active: false, campaign_ref: row.ref, note: row.name } }); }
    catch (err) { if (err.code === "23505") throw new Error(`Promo code ${promo.code} already exists. Pick another code.`); throw err; }
  }
  return (await db.rest("campaigns", { method: "POST", body: { ...row, promo_code: promo ? promo.code : null } }))[0];
}

async function createSmsDraft(input, actor) {
  const text = String(input.text || "").trim();
  if (!text || text.length > 600) throw new Error("Text must be 1–600 characters.");
  const promo = cleanPromo(input.promo), audience = cleanAudience(input.audience);
  const c = await insertCampaign({ ref: newRef("sms"), kind: "sms", name: String(input.name || "Text campaign").slice(0, 80), content: { text }, audience,
    starts_on: promo && promo.starts_on, ends_on: promo && promo.ends_on, created_by: actor }, promo);
  const sample = smsText(c, "Alex");
  return { ref: c.ref, status: "draft", promo_code: c.promo_code, reachable: (await audienceList(audience)).length, preview: sample, ...segments(sample) };
}

const PAGES = ["home", "book", "how", "rates", "lessons", "faq", "about"];
async function createPopupDraft(input, actor) {
  const title = String(input.title || "").trim().slice(0, 80), body = String(input.body || "").trim().slice(0, 300);
  if (!title || !body) throw new Error("A popup needs a title and body text.");
  const pages = Array.isArray(input.pages) ? input.pages.filter((p) => PAGES.includes(p)) : [];
  const promo = cleanPromo(input.promo);
  const c = await insertCampaign({ ref: newRef("popup"), kind: "popup", name: String(input.name || title).slice(0, 80),
    content: { title, body, cta: String(input.cta || "Book a bay").trim().slice(0, 30), pages: pages.length ? pages : PAGES },
    starts_on: DATE.test(input.starts_on || "") ? input.starts_on : (promo && promo.starts_on), ends_on: DATE.test(input.ends_on || "") ? input.ends_on : (promo && promo.ends_on),
    created_by: actor }, promo);
  return { ref: c.ref, status: "draft", promo_code: c.promo_code, content: c.content, starts_on: c.starts_on, ends_on: c.ends_on };
}

// Every campaign (newest first) with what it brought in: visits from its links, bookings and revenue credited to it.
async function campaignResults(ref) {
  const filter = ref && /^[a-z0-9-]{3,40}$/.test(ref) ? `&ref=eq.${ref}` : "";
  const list = await db.rest(`campaigns?select=*,promos(percent_off,active)${filter}&order=created_at.desc&limit=100`);
  if (!list.length) return [];
  const refs = list.map((c) => c.ref).join(","), codes = list.map((c) => c.promo_code).filter(Boolean);
  const [bookings, events, promoBookings] = await Promise.all([
    all(`bookings?select=campaign_ref,promo_code,subtotal_cents,discount_cents,customer_id&status=eq.confirmed&campaign_ref=in.(${refs})&order=id`),
    all(`events?select=src,type,sid&src=in.(${refs})&order=id`, 100000),
    codes.length ? all(`bookings?select=promo_code&status=eq.confirmed&promo_code=in.(${codes.join(",")})&order=id`) : []
  ]);
  return list.map((c) => {
    const bs = bookings.filter((b) => b.campaign_ref === c.ref), es = events.filter((e) => e.src === c.ref);
    const sessions = new Set(es.filter((e) => e.type === "view").map((e) => e.sid));
    const r = {
      ref: c.ref, kind: c.kind, status: c.status, name: c.name, created: c.created_at, sent_at: c.sent_at, starts_on: c.starts_on, ends_on: c.ends_on,
      promo_code: c.promo_code, percent_off: c.promos ? c.promos.percent_off : null, promo_active: c.promos ? c.promos.active : null,
      content: c.content, audience: c.audience, stats: c.stats,
      visits: sessions.size, bookings: bs.length, customers: new Set(bs.map((b) => b.customer_id)).size,
      revenue: money(bs.reduce((n, b) => n + b.subtotal_cents, 0)), discount_given: money(bs.reduce((n, b) => n + (b.discount_cents || 0), 0)),
      promo_uses: c.promo_code ? promoBookings.filter((b) => b.promo_code === c.promo_code).length : 0
    };
    if (c.kind === "popup") {
      const views = new Set(es.filter((e) => e.type === "popup_view").map((e) => e.sid)).size, clicks = new Set(es.filter((e) => e.type === "popup_click").map((e) => e.sid)).size;
      Object.assign(r, { popup_views: views, popup_clicks: clicks, click_rate_pct: views ? round1(clicks / views * 100) : 0, booking_rate_pct: views ? round1(bs.length / views * 100) : 0 });
    } else if (c.stats && c.stats.sent) {
      Object.assign(r, { visit_rate_pct: round1(sessions.size / c.stats.sent * 100), booking_rate_pct: round1(bs.length / c.stats.sent * 100) });
    }
    return r;
  });
}

async function getCampaign(ref) {
  if (!/^(sms|pop)-[a-z0-9]{3,10}$/.test(String(ref || ""))) return null;
  return (await db.rest(`campaigns?select=*&ref=eq.${ref}`))[0] || null;
}

// The admin edits a draft before sending or publishing it.
async function updateDraft(ref, input) {
  const c = await getCampaign(ref);
  if (!c || c.status !== "draft") throw new Error("초안만 고칠 수 있습니다.");
  const patch = {};
  if (input.name) patch.name = String(input.name).slice(0, 80);
  if (c.kind === "sms" && input.text != null) {
    const text = String(input.text).trim();
    if (!text || text.length > 600) throw new Error("문자는 1–600자여야 합니다.");
    patch.content = { text };
  }
  if (c.kind === "popup" && input.content) {
    const x = input.content;
    patch.content = { ...c.content, title: String(x.title || c.content.title).slice(0, 80), body: String(x.body || c.content.body).slice(0, 300), cta: String(x.cta || c.content.cta).slice(0, 30) };
  }
  if ("starts_on" in input) patch.starts_on = DATE.test(input.starts_on || "") ? input.starts_on : null;
  if ("ends_on" in input) patch.ends_on = DATE.test(input.ends_on || "") ? input.ends_on : null;
  if (Object.keys(patch).length) await db.rest(`campaigns?ref=eq.${ref}`, { method: "PATCH", prefer: "return=minimal", body: patch });
  return getCampaign(ref);
}

async function deleteDraft(ref) {
  const c = await getCampaign(ref);
  if (!c || c.status !== "draft") throw new Error("초안만 지울 수 있습니다.");
  await db.rest(`campaigns?ref=eq.${ref}`, { method: "DELETE", prefer: "return=minimal" });
  if (c.promo_code) await db.rest(`promos?code=eq.${c.promo_code}&campaign_ref=eq.${ref}`, { method: "DELETE", prefer: "return=minimal" });
}

async function setPromoActive(c, active) {
  if (c.promo_code) await db.rest(`promos?code=eq.${c.promo_code}&campaign_ref=eq.${c.ref}`, { method: "PATCH", prefer: "return=minimal", body: { active } });
}

async function publishPopup(ref) {
  const c = await getCampaign(ref);
  if (!c || c.kind !== "popup" || !["draft", "ended"].includes(c.status)) throw new Error("게시할 수 있는 팝업이 아닙니다.");
  await db.rest(`campaigns?ref=eq.${ref}`, { method: "PATCH", prefer: "return=minimal", body: { status: "active", sent_at: c.sent_at || new Date().toISOString() } });
  await setPromoActive(c, true);
}

// Stops a popup (and its promo code), or turns off a sent text's promo code.
async function endCampaign(ref) {
  const c = await getCampaign(ref);
  if (!c || !["active", "sent"].includes(c.status)) throw new Error("진행 중인 캠페인이 아닙니다.");
  await db.rest(`campaigns?ref=eq.${ref}`, { method: "PATCH", prefer: "return=minimal", body: { status: "ended" } });
  await setPromoActive(c, false);
}

// The popup to show on a page right now, for site.js. Newest published first.
async function livePopup(page) {
  const today = torontoNow().key;
  const rows = await db.rest("campaigns?select=ref,content,promo_code,starts_on,ends_on,promos(percent_off,active)&kind=eq.popup&status=eq.active&order=sent_at.desc&limit=10");
  const c = rows.find((x) => (!x.starts_on || x.starts_on <= today) && (!x.ends_on || x.ends_on >= today) && (!x.content.pages || x.content.pages.includes(page)));
  if (!c) return null;
  const promo = c.promo_code && c.promos && c.promos.active ? { code: c.promo_code, percent_off: c.promos.percent_off } : null;
  return { ref: c.ref, title: c.content.title, body: c.content.body, cta: c.content.cta, promo, ends_on: c.ends_on };
}

// ---------- texts (Twilio) ----------
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM (+1 number) or TWILIO_MESSAGING_SERVICE_SID.
function twilioConfigured() { return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID)); }
function e164(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return null;
}

async function twilioSend(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const form = new URLSearchParams({ To: to, Body: body });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", process.env.TWILIO_FROM);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST", body: form,
    headers: { Authorization: "Basic " + Buffer.from(sid + ":" + process.env.TWILIO_AUTH_TOKEN).toString("base64") }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Twilio ${r.status}`);
  return j.sid;
}

// Marketing texts go out 9 AM – 9 PM Toronto time only.
function quietHours() { const m = torontoNow().mins; return m < 9 * 60 || m >= 21 * 60; }

async function sendTest(ref, phone, origin) {
  if (!twilioConfigured()) throw new Error("Twilio 환경변수(TWILIO_FROM 또는 TWILIO_MESSAGING_SERVICE_SID)가 없습니다.");
  const c = await getCampaign(ref), to = e164(phone);
  if (!c || c.kind !== "sms") throw new Error("문자 캠페인을 찾지 못했습니다.");
  if (!to) throw new Error("전화번호를 확인하세요 (캐나다·미국 10자리).");
  const text = "[TEST] " + smsText(c, "Test", origin);
  return { sid: await twilioSend(to, text), text };
}

// Sends a draft text campaign to its audience. Numbers already texted for this campaign are skipped, so a send cut short can be run again.
async function sendCampaign(ref, origin) {
  if (!twilioConfigured()) throw new Error("Twilio 환경변수(TWILIO_FROM 또는 TWILIO_MESSAGING_SERVICE_SID)가 없습니다.");
  if (quietHours()) throw new Error("마케팅 문자는 토론토 시간 오전 9시 – 오후 9시에만 보낼 수 있습니다.");
  const c = await getCampaign(ref);
  if (!c || c.kind !== "sms" || !["draft", "sent"].includes(c.status)) throw new Error("보낼 수 있는 문자 캠페인이 아닙니다.");
  const done = new Set((await all(`sms_sends?select=phone&campaign_ref=eq.${ref}&ok=is.true&order=id`)).map((s) => s.phone));
  const seen = new Set(), queue = [];
  (await audienceList(c.audience)).forEach((x) => {
    const to = e164(x.phone_key);
    if (to && !done.has(to) && !seen.has(to)) { seen.add(to); queue.push({ c: x, to }); }
  });
  const MAX = 1000, batch = queue.slice(0, MAX), results = [];
  await setPromoActive(c, true);
  // A few at a time: Twilio queues them and sends at the number's rate.
  for (let i = 0; i < batch.length; i += 5) {
    await Promise.all(batch.slice(i, i + 5).map(async ({ c: x, to }) => {
      const first = String(x.name || "").trim().split(/\s+/)[0];
      try { results.push({ campaign_ref: ref, customer_id: x.id, phone: to, ok: true, sid: await twilioSend(to, smsText(c, first, origin)) }); }
      catch (err) { results.push({ campaign_ref: ref, customer_id: x.id, phone: to, ok: false, error: String(err.message).slice(0, 200) }); }
    }));
  }
  if (results.length) await db.rest("sms_sends", { method: "POST", prefer: "return=minimal", body: results });
  const prev = c.stats || {}, sent = (prev.sent || 0) + results.filter((r) => r.ok).length, failed = (prev.failed || 0) + results.filter((r) => !r.ok).length;
  await db.rest(`campaigns?ref=eq.${ref}`, { method: "PATCH", prefer: "return=minimal", body: { status: "sent", sent_at: c.sent_at || new Date().toISOString(), stats: { sent, failed } } });
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, left: queue.length - batch.length, errors: [...new Set(results.filter((r) => !r.ok).map((r) => r.error))].slice(0, 3) };
}

// STOP / START replies from Twilio's incoming-message webhook.
async function smsReply(from, body) {
  const word = String(body || "").trim().toUpperCase(), digits = String(from || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (!digits) return null;
  const now = new Date().toISOString();
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|ARRET|ARRÊT)$/.test(word)) {
    await db.rest(`customers?phone_key=eq.${digits}`, { method: "PATCH", prefer: "return=minimal", body: { sms_opt_in: false, sms_opt_out_at: now } });
    return "opt_out";
  }
  if (/^(START|UNSTOP|YES)$/.test(word)) {
    await db.rest(`customers?phone_key=eq.${digits}`, { method: "PATCH", prefer: "return=minimal", body: { sms_opt_in: true, sms_opt_in_at: now, sms_opt_out_at: null } });
    return "opt_in";
  }
  return null;
}

// Twilio signs each webhook: base64 HMAC-SHA1 of the URL plus the sorted POST fields, keyed with the auth token.
function twilioSignatureOk(req, url) {
  const token = process.env.TWILIO_AUTH_TOKEN, sig = String(req.headers["x-twilio-signature"] || "");
  if (!token || !sig) return false;
  const params = req.body && typeof req.body === "object" ? req.body : {};
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", token).update(data).digest("base64");
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- reports ----------
async function saveReport(title, body) {
  const row = { title: String(title || "Report").slice(0, 120), body: String(body || "").slice(0, 100000) };
  return (await db.rest("green_reports", { method: "POST", body: row }))[0];
}

// ---------- reading a public web page (competitor sites) ----------
// Only public http(s) addresses: names that resolve to private, loopback or link-local addresses are refused, redirects included.
const dns = require("dns").promises, net = require("net");
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return privateIp(x.slice(7));
  return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x);
}
async function readPage(address) {
  let url = String(address || "").trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error("Only public http(s) pages can be read.");
    const ips = await dns.lookup(u.hostname, { all: true });
    if (!ips.length || ips.some((i) => privateIp(i.address))) throw new Error("That address is not a public website.");
    const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(12000), headers: { "User-Agent": "Mozilla/5.0 (GuttaGolf research bot)", Accept: "text/html,text/plain" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location"), u).href; continue; }
    if (!r.ok) throw new Error(`The page answered ${r.status}.`);
    const html = (await r.text()).slice(0, 2e6);
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "";
    const text = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    return { url, title: title.trim().slice(0, 200), text: text.slice(0, 12000), truncated: text.length > 12000 };
  }
  throw new Error("Too many redirects.");
}

module.exports = {
  range, bookingStats, customerAnalysis, siteAnalytics, audiencePreview, createSmsDraft, createPopupDraft, campaignResults,
  getCampaign, updateDraft, deleteDraft, publishPopup, endCampaign, livePopup, segments, smsText, sendTest, sendCampaign,
  smsReply, twilioSignatureOk, twilioConfigured, twilioSend, e164, saveReport, readPage, quietHours, PAGES, BOOKING_GROUPS, CUSTOMER_DIMS, SITE_GROUPS, AUDIENCE_KEYS
};
