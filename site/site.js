/* Gutta Golf — shared script for every page.
   0. Browser storage helpers.
   1. Business facts (defaults here; admin.html saves changes and the notice on the server, api/site?do=settings).
   2. Header and footer, drawn into #gg-header and #gg-footer.
   3. Bay availability from the database (sample bookings only in a local preview). */
(function () {
  var GG = window.GG = {};

  // 0. Browser storage
  GG.load = function (key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  };
  GG.save = function (key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; }
  };

  // 1. Business facts
  GG.defaults = {
    info: {
      phone: "437-655-4161",
      email: "info@guttagolf.ca",
      instagram: "https://www.instagram.com/guttagolf.ca/",
      address1: "244 Lesmill Rd",
      address2: "North York, ON M3B 2M3",
      hours: "Every day, 9 AM – 12 AM"
    },
    rates: JSON.parse(JSON.stringify(window.GGP.RATES)),   // seasonal rates, see pricing.js
    notice: ""                      // one-line banner under the header, e.g. a holiday closing
  };
  // Rates always come from pricing.js, the same numbers the payment API charges.
  GG.rates = JSON.parse(JSON.stringify(window.GGP.RATES));
  GG.notice = "";
  GG.setInfo = function (info) {
    GG.info = Object.assign({}, GG.defaults.info, info);
    GG.info.maps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(GG.info.address1 + " " + GG.info.address2);
    GG.info.mailto = "mailto:" + GG.info.email;
  };
  GG.setInfo({});
  // The real domain shows no preview banner; any other address (vercel.app, localhost) does.
  GG.live = /(^|\.)guttagolf\.ca$/.test(location.hostname);
  try { localStorage.removeItem("gg.settings"); } catch (e) {}   // settings from the old browser-only admin

  // 2. Header and footer
  var NAV = [
    ["book", "book.html", "Book"],
    ["how", "how-it-works.html", "How it works"],
    ["rates", "rates.html", "Rates"],
    ["lessons", "lessons.html", "Lessons"],
    ["faq", "faq.html", "FAQ"],
    ["about", "about.html", "About & contact"]
  ];
  var page = document.body.getAttribute("data-page");

  var header = document.getElementById("gg-header");
  if (header) {
    header.outerHTML =
      (GG.live ? "" : '<div class="testbar">Preview of the new Gutta Golf website.</div>') +
      '<header class="site"><div class="wrap">' +
        '<a class="logo" href="./"><span class="dot" aria-hidden="true"></span>Gutta Golf</a>' +
        '<button class="menu-btn" type="button" aria-expanded="false" aria-controls="mainnav">Menu</button>' +
        '<nav class="main" id="mainnav" aria-label="Main">' +
          NAV.map(function (n) {
            return '<a href="' + n[1] + '"' + (n[0] === page ? ' aria-current="page"' : "") + ">" + n[2] + "</a>";
          }).join("") +
        "</nav>" +
        '<a class="btn" href="book.html">Book a bay</a>' +
      "</div></header>";
    var btn = document.querySelector(".menu-btn"), nav = document.getElementById("mainnav");
    btn.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.textContent = open ? "Close" : "Menu";
    });
  }

  var footer = document.getElementById("gg-footer");
  if (footer) {
    footer.outerHTML =
      '<footer class="site"><div class="wrap">' +
        '<div class="cols">' +
          "<div>" +
            '<a class="logo" href="./"><span class="dot" aria-hidden="true"></span>Gutta Golf</a>' +
            '<p><span data-gg="address1"></span><br><span data-gg="address2"></span></p>' +
            '<p data-gg="hours"></p>' +
          "</div>" +
          "<div><h3>Golf</h3>" +
            '<a href="book.html">Book a bay</a><a href="rates.html">Rates</a><a href="lessons.html">Lessons</a><a href="how-it-works.html">How it works</a>' +
          "</div>" +
          "<div><h3>Help</h3>" +
            '<a href="faq.html">FAQ</a><a href="about.html">About us</a><a href="about.html#contact">Contact</a><a href="privacy.html">Privacy &amp; booking terms</a>' +
          "</div>" +
          "<div><h3>Contact</h3>" +
            '<span class="mono" data-gg="phone"></span>' +
            '<span data-gg="email"></span>' +
            '<a data-gg-href="instagram" target="_blank" rel="noopener">Instagram @guttagolf.ca</a>' +
          "</div>" +
        "</div>" +
        '<div class="base"><span>© ' + new Date().getFullYear() + " Gutta Golf</span>" + (GG.live ? "" : "<span>Preview</span>") + "</div>" +
      "</div></footer>";
  }

  // Facts into the page: <span data-gg="phone">, <a data-gg-href="maps">, <button data-gg-copy="phone">. Run again when the server's settings arrive.
  GG.fillInfo = function () {
    var i = GG.info;
    document.querySelectorAll("[data-gg]").forEach(function (el) {
      var v = i[el.getAttribute("data-gg")];
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll("[data-gg-href]").forEach(function (a) { a.href = i[a.getAttribute("data-gg-href")]; });
    document.querySelectorAll("[data-gg-copy]").forEach(function (b) { b.setAttribute("data-copy", i[b.getAttribute("data-gg-copy")]); });
  };
  // The one-line notice above the header (e.g. a holiday closing). Empty removes it.
  GG.showNotice = function (text) {
    GG.notice = text || "";
    var note = document.querySelector(".notice"), head = document.querySelector("header.site");
    if (!GG.notice) { if (note) note.remove(); return; }
    if (!note && head) { note = document.createElement("div"); note.className = "notice"; head.before(note); }
    if (note) note.textContent = GG.notice;
  };
  GG.fillInfo();
  // What the admin saved: { info, notice }. The page shows the defaults above until it arrives.
  GG.settingsReady = fetch("api/site?do=settings").then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j) return;
    GG.setInfo(j.info || {}); GG.fillInfo(); GG.showNotice(j.notice);
  }).catch(function () {});

  // Copy buttons: <button class="copy" data-copy="text" data-target="id">
  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var text = b.getAttribute("data-copy"), label = b.textContent;
      function selectIt() {
        var el = document.getElementById(b.getAttribute("data-target"));
        if (!el) return;
        var r = document.createRange(); r.selectNodeContents(el);
        var s = getSelection(); s.removeAllRanges(); s.addRange(r);
      }
      try {
        navigator.clipboard.writeText(text).then(function () {
          b.textContent = "Copied"; setTimeout(function () { b.textContent = label; }, 1600);
        }, selectIt);
      } catch (err) { selectIt(); }
    });
  });

  // 3. Availability: bookings from the database, or random sample bookings when it is not reachable
  // Hours, slots and price math live in pricing.js (window.GGP), shared with the payment API.
  var P = window.GGP;
  ["OPEN", "CLOSE", "LATE_BY", "STEP", "PER_HOUR", "SLOTS", "MIN_LEN", "MAX_LEN", "DAYS_AHEAD", "BAYS", "TAX"].forEach(function (k) { GG[k] = P[k]; });
  ["dayKey", "parseDay", "isWeekend", "season", "isHoliday", "weekendRate", "slotMins", "isLate", "slotLabel"].forEach(function (k) { GG[k] = P[k]; });
  GG.HAND = { 1: "Right-handed", 7: "Right-handed", 8: "Right-handed" };   // every other bay is right & left
  GG.hand = function (bay) { return GG.HAND[bay] || "Right & left"; };

  var today = new Date(); today.setHours(0, 0, 0, 0);
  GG.today = today;
  GG.dateFor = function (n) { var d = new Date(today); d.setDate(d.getDate() + n); return d; };
  GG.lenLabel = function (len) {
    var mins = len * GG.STEP, h = Math.floor(mins / 60), m = mins % 60;
    return (h ? h + (h === 1 ? " hr" : " hrs") : "") + (h && m ? " " : "") + (m ? m + " min" : "");
  };
  GG.money = function (n) { return "$" + n.toFixed(2); };
  GG.fmtDay = { weekday: "short", month: "short", day: "numeric" };

  // Real bookings from the Supabase database (api/availability), per day: { "YYYY-MM-DD": [{ bay, start, len }] }.
  // Until a day loads it shows as free; a local preview with no API shows sample bookings instead.
  var preview = location.protocol === "file:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var remote = {};
  GG.loadDay = function (dayIdx) {
    var day = GG.dayKey(GG.dateFor(dayIdx));
    return fetch("api/availability?date=" + day).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.taken) remote[day] = j.taken; return !!(j && j.taken); })
      .catch(function () { return false; });
  };

  // Deterministic per day and bay so the page looks the same on reload.
  function rng(seed) { return function () { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }; }
  var cache = {};
  function sample(d, bay) {
    var r = rng(d.getDate() * 31 + d.getMonth() * 7 + bay * 101);
    var arr = new Array(GG.SLOTS).fill(false), busy = GG.isWeekend(d) ? 0.55 : 0.35, half = GG.PER_HOUR / 2;
    // Sample bookings start on the half hour and last 1–2 hours.
    for (var s = 0; s < GG.SLOTS; s += half) {
      var mins = GG.slotMins(s), evening = mins >= 15 * 60 ? 0.15 : 0;
      if (mins >= 1440) { busy = 0.06; evening = 0; }   // late night is quiet
      if (r() < busy + evening) { var len = (2 + Math.floor(r() * 3)) * half; arr.fill(true, s, Math.min(s + len, GG.SLOTS)); s += len - half; }
    }
    return arr;
  }
  GG.taken = function (dayIdx, bay) {
    var d = GG.dateFor(dayIdx), key = d.toDateString() + bay, day = GG.dayKey(d);
    var arr = new Array(GG.SLOTS).fill(false);
    if (!remote[day]) return preview ? (cache[key] || (cache[key] = sample(d, bay))).slice() : arr;
    remote[day].forEach(function (b) { if (b.bay === bay) arr.fill(true, b.start, b.start + b.len); });
    return arr;
  };
  GG.pastSlot = function (dayIdx, s) {
    if (dayIdx !== 0) return false;
    var now = new Date();
    return GG.slotMins(s) <= now.getHours() * 60 + now.getMinutes();
  };
  // Tonight's late night closes to new bookings at 9 PM.
  GG.lateClosed = function (dayIdx) { return dayIdx === 0 && new Date().getHours() >= GG.LATE_BY; };
  GG.slotOpen = function (dayIdx, s) { return !GG.pastSlot(dayIdx, s) && !(GG.isLate(s) && GG.lateClosed(dayIdx)); };
  GG.bayFree = function (dayIdx, bay, s, len) {
    if (s + len > GG.SLOTS) return false;
    var t = GG.taken(dayIdx, bay);
    for (var k = 0; k < len; k++) if (t[s + k] || !GG.slotOpen(dayIdx, s + k)) return false;
    return true;
  };
  GG.rateAt = function (dayIdx, s) { return P.rateAt(GG.rates, GG.dateFor(dayIdx), s); };
  GG.price = function (dayIdx, s, len) { return P.price(GG.rates, GG.dateFor(dayIdx), s, len); };
  // { subtotal, tax, total } in cents, rounded the way Stripe charges
  GG.cents = function (dayIdx, s, len) { return P.cents(GG.rates, GG.dateFor(dayIdx), s, len); };

  // "Today's bays" board on the home page
  GG.renderBoard = function () {
    var ol = document.getElementById("board");
    if (!ol) return;
    ol.innerHTML = "";
    document.getElementById("boardDate").textContent = today.toLocaleDateString("en-CA", GG.fmtDay);
    for (var b = 1; b <= GG.BAYS; b++) {
      var next = null;
      for (var s = 0; s < GG.SLOTS; s++) if (GG.bayFree(0, b, s, GG.PER_HOUR)) { next = s; break; }
      var first = next !== null && (next === 0 || GG.pastSlot(0, next - 1));
      var li = document.createElement("li");
      if (first) li.className = "now";
      var bb = document.createElement("b"); bb.textContent = "Bay " + b;
      var sp = document.createElement("span"); sp.textContent = next === null ? "Full today" : first ? "Open now" : "Open " + GG.slotLabel(next);
      li.append(bb, sp); ol.appendChild(li);
    }
  };
  if (preview) GG.renderBoard();
  if (document.getElementById("board")) GG.loadDay(0).then(function (ok) { if (ok) GG.renderBoard(); });

  // 4. Rate tables drawn from GG.rates: <ul data-gg-rates="now"> (home) and <tbody data-gg-rates="winter|summer"> (rates page)
  GG.SEASONS = { winter: "Winter", summer: "Summer" };
  GG.SEASON_DATES = { winter: "Nov 1 – Apr 30", summer: "May 1 – Oct 31" };
  GG.hourLabel = function (h) { h = h % 24; return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? " AM" : " PM"); };
  // Rows of [time, weekday, weekend & holidays, note]
  GG.rateRows = function (season) {
    var r = GG.rates[season], open = GG.hourLabel(GG.OPEN), eve = GG.hourLabel(GG.rates.eveFrom), late = GG.hourLabel(GG.LATE_BY);
    var rows = r.day === r.eve
      ? [[open + " – 12 AM", r.day, r.weekend]]
      : [[open + " – " + eve, r.day, r.weekend], [eve + " – 12 AM", r.eve, r.weekend]];
    rows.push(["12 AM – " + GG.hourLabel(GG.CLOSE), r.late, r.late, "Late night. Book by " + late + " the same day."]);
    rows.push([GG.hourLabel(GG.CLOSE) + " – " + open, null, null]);
    return rows;
  };
  GG.renderRates = function () {
    var now = GG.season(today), r = GG.rates[now];
    document.querySelectorAll('[data-gg="seasonNow"]').forEach(function (el) { el.textContent = GG.SEASONS[now] + " · " + GG.SEASON_DATES[now]; });
    document.querySelectorAll('[data-gg-rates="now"]').forEach(function (ul) {
      var items = r.day === r.eve
        ? [["Weekdays, " + GG.hourLabel(GG.OPEN) + " – 12 AM", r.day]]
        : [["Weekdays, " + GG.hourLabel(GG.OPEN) + " – " + GG.hourLabel(GG.rates.eveFrom), r.day], ["Weekday evenings, to 12 AM", r.eve]];
      items.push(["Weekends & holidays", r.weekend], ["Late night, 12 – " + GG.hourLabel(GG.CLOSE), r.late]);
      ul.innerHTML = "";
      items.forEach(function (it) {
        var li = document.createElement("li"), sp = document.createElement("span"), b = document.createElement("b");
        sp.textContent = it[0]; b.textContent = "$" + it[1];
        var sm = document.createElement("small"); sm.textContent = "/hr"; b.appendChild(sm);
        li.append(sp, b); ul.appendChild(li);
      });
    });
    document.querySelectorAll("[data-gg-rates]").forEach(function (tb) {
      var season = tb.getAttribute("data-gg-rates");
      if (!GG.SEASONS[season]) return;
      tb.innerHTML = "";
      GG.rateRows(season).forEach(function (row) {
        var tr = tb.insertRow(), t = tr.insertCell();
        t.textContent = row[0];
        if (row[3]) { var sm = document.createElement("small"); sm.textContent = row[3]; t.appendChild(sm); }
        if (row[1] === null) { var c = tr.insertCell(); c.colSpan = 2; c.textContent = "Closed"; c.className = "muted"; return; }
        [row[1], row[2]].forEach(function (v) { tr.insertCell().textContent = "$" + v; });
      });
    });
  };
  GG.renderRates();

  // 5. Marketing: visit tracking and the website popup (api/site). Sends no names, contact details or IP addresses.
  //    ?src= (campaign ref) and ?promo= from a text or popup link are kept for this tab, so the booking is credited to them.
  function store(local, k, v) {
    try { var s = local ? localStorage : sessionStorage; if (v === undefined) return s.getItem(k); s.setItem(k, v); } catch (e) { return null; }
  }
  function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  var qs = new URLSearchParams(location.search);
  var qSrc = (qs.get("src") || qs.get("utm_source") || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  var qPromo = (qs.get("promo") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  if (qSrc) store(false, "gg.src", qSrc);
  if (qPromo) store(false, "gg.promo", qPromo);
  GG.campaign = function () { return { src: store(false, "gg.src") || "", promo: store(false, "gg.promo") || "" }; };
  GG.setPromo = function (code) { store(false, "gg.promo", code || ""); };

  var sid = store(false, "gg.sid") || rid(), vid = store(true, "gg.vid") || rid();
  store(false, "gg.sid", sid); store(true, "gg.vid", vid);
  var refHost = "";
  try { var rh = document.referrer ? new URL(document.referrer).hostname : ""; if (rh && rh !== location.hostname) refHost = rh.replace(/^www\./, ""); } catch (e) {}
  var device = /Mobi|Android/i.test(navigator.userAgent) || matchMedia("(max-width: 760px)").matches ? "mobile" : "desktop";
  var tracking = !preview && page !== "admin";

  // type: view | popup_view | popup_click | popup_close | book_start | booked
  GG.track = function (type, extra) {
    if (!tracking) return;
    var body = JSON.stringify(Object.assign({ type: type, page: page, sid: sid, vid: vid, src: GG.campaign().src, referrer: refHost, device: device }, extra));
    try { if (navigator.sendBeacon && navigator.sendBeacon("api/site?do=track", new Blob([body], { type: "application/json" }))) return; } catch (e) {}
    fetch("api/site?do=track", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {});
  };
  GG.track("view");

  // The popup: { ref, title, body, cta, promo: { code, percent_off } | null, ends_on }.
  // opts.preview (admin): nothing is tracked or remembered and the button goes nowhere.
  GG.popup = function (p, opts) {
    var o = opts || {}, prev = document.querySelector(".gg-pop");
    if (prev) prev.remove();
    var wrap = document.createElement("div");
    wrap.className = "gg-pop";
    wrap.innerHTML = '<div class="gg-pop-card" role="dialog" aria-modal="true" aria-labelledby="ggPopTitle">' +
      '<button class="gg-pop-x" type="button" aria-label="Close">×</button>' +
      '<p class="eyebrow">Gutta Golf</p><h2 id="ggPopTitle"></h2><p class="gg-pop-body"></p>' +
      '<p class="gg-pop-code" hidden></p><a class="btn"></a><p class="gg-pop-end" hidden></p></div>';
    wrap.querySelector("h2").textContent = p.title;
    wrap.querySelector(".gg-pop-body").textContent = p.body;
    var link = wrap.querySelector("a.btn");
    link.textContent = p.cta || "Book a bay";
    link.href = "book.html?src=" + encodeURIComponent(p.ref) + (p.promo ? "&promo=" + encodeURIComponent(p.promo.code) : "");
    if (p.promo) {
      var code = wrap.querySelector(".gg-pop-code");
      code.hidden = false; code.textContent = "Code ";
      var b = document.createElement("b"); b.textContent = p.promo.code; code.appendChild(b);
      code.appendChild(document.createTextNode(" · " + p.promo.percent_off + "% off, applied when you book"));
    }
    if (p.ends_on) {
      var d = GG.parseDay(p.ends_on), end = wrap.querySelector(".gg-pop-end");
      end.hidden = false; end.textContent = "Ends " + (d ? d.toLocaleDateString("en-CA", { month: "short", day: "numeric" }) : p.ends_on);
    }
    function close(how) {
      wrap.remove(); document.removeEventListener("keydown", onKey);
      if (o.preview) return;
      store(true, "gg.popup." + p.ref, "1");
      GG.track(how === "click" ? "popup_click" : "popup_close", { src: p.ref });
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    wrap.querySelector(".gg-pop-x").addEventListener("click", function () { close(); });
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    link.addEventListener("click", function (e) { if (o.preview) { e.preventDefault(); close(); return; } close("click"); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(wrap);
    link.focus({ preventScroll: true });
    if (!o.preview) GG.track("popup_view", { src: p.ref });
  };

  // Each popup shows once per visitor, and not to someone already holding its code.
  if (tracking) {
    fetch("api/site?do=popup&page=" + encodeURIComponent(page)).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      var p = j && j.popup;
      if (!p || store(true, "gg.popup." + p.ref) || (p.promo && GG.campaign().promo === p.promo.code)) return;
      setTimeout(function () { GG.popup(p); }, page === "book" ? 800 : 2500);
    }).catch(function () {});
  }
})();
