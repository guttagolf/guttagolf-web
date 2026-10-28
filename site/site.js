/* Gutta Golf — shared script for every page.
   0. Saved settings. admin.html edits them; in the test version they live in this browser only (bookings are in Supabase).
   1. Business facts (defaults here; admin.html can override them).
   2. Header and footer, drawn into #gg-header and #gg-footer.
   3. Sample bay availability for the test version (used by the home board and the booking page). */
(function () {
  var GG = window.GG = {};

  // 0. Saved settings
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
  var saved = GG.load("gg.settings", {});
  GG.info = Object.assign({}, GG.defaults.info, saved.info);
  // Settings saved before the current rate shape (seasons with their own late-night rate) are dropped.
  GG.rates = Object.assign({}, GG.defaults.rates, saved.rates && saved.rates.summer && saved.rates.summer.late != null ? saved.rates : {});
  GG.notice = saved.notice || "";
  GG.info.maps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(GG.info.address1 + " " + GG.info.address2);

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
  var i = GG.info;

  var header = document.getElementById("gg-header");
  if (header) {
    header.outerHTML =
      '<div class="testbar">Test version. This is not the live site, and bookings here are not real.</div>' +
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
    if (GG.notice) {
      var note = document.createElement("div");
      note.className = "notice"; note.textContent = GG.notice;
      document.querySelector("header.site").before(note);
    }
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
            "<p>" + i.address1 + "<br>" + i.address2 + "</p>" +
            "<p>" + i.hours + "</p>" +
          "</div>" +
          "<div><h3>Golf</h3>" +
            '<a href="book.html">Book a bay</a><a href="rates.html">Rates</a><a href="lessons.html">Lessons</a><a href="how-it-works.html">How it works</a>' +
          "</div>" +
          "<div><h3>Help</h3>" +
            '<a href="faq.html">FAQ</a><a href="about.html">About us</a><a href="about.html#contact">Contact</a>' +
          "</div>" +
          "<div><h3>Contact</h3>" +
            '<span class="mono">' + i.phone + "</span>" +
            "<span>" + i.email + "</span>" +
            '<a href="' + i.instagram + '" target="_blank" rel="noopener">Instagram @guttagolf.ca</a>' +
          "</div>" +
        "</div>" +
        '<div class="base"><span>© ' + new Date().getFullYear() + " Gutta Golf</span><span>Test version</span></div>" +
      "</div></footer>";
  }

  // Saved facts into the page: <span data-gg="phone">, <a data-gg-href="maps">, <button data-gg-copy="phone">
  document.querySelectorAll("[data-gg]").forEach(function (el) {
    var k = el.getAttribute("data-gg");
    var v = i[k];
    if (v != null) el.textContent = v;
  });
  document.querySelectorAll("[data-gg-href]").forEach(function (a) { a.href = i[a.getAttribute("data-gg-href")]; });
  document.querySelectorAll("[data-gg-copy]").forEach(function (b) { b.setAttribute("data-copy", i[b.getAttribute("data-gg-copy")]); });

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
  // Until a day loads, or when the API is not reachable (local preview), that day shows sample bookings instead.
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
    if (!remote[day]) return (cache[key] || (cache[key] = sample(d, bay))).slice();
    var arr = new Array(GG.SLOTS).fill(false);
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
  GG.renderBoard();
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
})();
