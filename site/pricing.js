/* Gutta Golf — hours, rates and price math.
   Shared by the pages (window.GGP, loaded before site.js) and the payment API (require("../pricing.js")),
   so the price on screen and the amount Stripe charges come from the same code. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GGP = factory();
})(this, function () {
  var P = {};

  // A booking day runs 9 AM – 6 AM the next morning; 6 – 9 AM is closed.
  P.OPEN = 9; P.CLOSE = 30;                    // hours after midnight of the booking day
  P.LATE_BY = 21;                              // late night (12 – 6 AM) must be booked by 9 PM the same day
  P.STEP = 15;                                 // minutes per slot
  P.PER_HOUR = 60 / P.STEP;
  P.SLOTS = (P.CLOSE - P.OPEN) * P.PER_HOUR;
  P.MIN_LEN = 2;                               // shortest booking: 30 minutes
  P.MAX_LEN = 20 * P.PER_HOUR;                 // longest booking: 20 hours
  P.DAYS_AHEAD = 7;                            // today plus the next 6 days
  P.BAYS = 8; P.TAX = 0.13;
  P.TIME_ZONE = "America/Toronto";

  // Per bay, per hour, before tax. Winter is Nov 1 – Apr 30, summer May 1 – Oct 31.
  // day: weekday before eveFrom; eve: weekday from eveFrom to 12 AM; weekend: weekends and holidays, 9 AM – 12 AM;
  // late: 12 AM – 6 AM, every day, booked by 9 PM the same day.
  P.RATES = {
    summer: { day: 20, eve: 23, weekend: 25, late: 25 },
    winter: { day: 35, eve: 35, weekend: 38, late: 40 },
    eveFrom: 17                                // 5 PM
  };

  P.dayKey = function (d) {
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  };
  P.parseDay = function (key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
    return m ? new Date(+m[1], m[2] - 1, +m[3]) : null;
  };
  P.isWeekend = function (d) { var w = d.getDay(); return w === 0 || w === 6; };
  P.season = function (d) { var m = d.getMonth() + 1; return m >= 11 || m <= 4 ? "winter" : "summer"; };

  // Ontario holidays (charged at the weekend rate): New Year's, Family Day, Good Friday, Victoria Day, Canada Day,
  // Civic Holiday, Labour Day, Thanksgiving, Christmas, Boxing Day.
  var holidayCache = {};
  function nthMonday(y, m, n) { var d = new Date(y, m, 1); d.setDate(1 + (8 - d.getDay()) % 7 + (n - 1) * 7); return d; }
  function holidays(y) {
    if (holidayCache[y]) return holidayCache[y];
    // Easter Sunday (anonymous Gregorian algorithm)
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    var g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    var month = Math.floor((h + l - 7 * m + 114) / 31) - 1, day = (h + l - 7 * m + 114) % 31 + 1;
    var victoria = new Date(y, 4, 24); victoria.setDate(24 - (victoria.getDay() + 6) % 7);
    var list = [new Date(y, 0, 1), nthMonday(y, 1, 3), new Date(y, month, day - 2), victoria, new Date(y, 6, 1),
      nthMonday(y, 7, 1), nthMonday(y, 8, 1), nthMonday(y, 9, 2), new Date(y, 11, 25), new Date(y, 11, 26)];
    return (holidayCache[y] = list.map(P.dayKey));
  }
  P.isHoliday = function (d) { return holidays(d.getFullYear()).indexOf(P.dayKey(d)) >= 0; };
  P.weekendRate = function (d) { return P.isWeekend(d) || P.isHoliday(d); };

  P.slotMins = function (s) { return P.OPEN * 60 + s * P.STEP; };   // minutes after midnight of the booking day
  P.isLate = function (s) { return P.slotMins(s) >= 1440; };
  P.slotLabel = function (s) {
    var mins = P.slotMins(s), h = Math.floor(mins / 60) % 24, m = mins % 60;
    var ap = h < 12 ? "AM" : "PM", hh = h % 12 === 0 ? 12 : h % 12;
    return hh + ":" + ("0" + m).slice(-2) + " " + ap;
  };

  // By the booking day's season: late night one rate, weekends and holidays one rate, weekdays day / evening.
  P.rateAt = function (rates, d, s) {
    var r = rates[P.season(d)];
    if (P.isLate(s)) return r.late;
    if (P.weekendRate(d)) return r.weekend;
    return P.slotMins(s) >= rates.eveFrom * 60 ? r.eve : r.day;
  };
  // Subtotal in dollars for len slots from slot s on day d
  P.price = function (rates, d, s, len) {
    var sum = 0;
    for (var k = 0; k < len; k++) sum += P.rateAt(rates, d, s + k) / P.PER_HOUR;
    return sum;
  };
  // Amounts in cents, the way Stripe charges them
  P.cents = function (rates, d, s, len) {
    var sub = Math.round(P.price(rates, d, s, len) * 100), tax = Math.round(sub * P.TAX);
    return { subtotal: sub, tax: tax, total: sub + tax };
  };

  return P;
});
