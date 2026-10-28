/* Booking page: timetable with 15-minute rows and one column per bay.
   Tap a start time, then tap the finish (or drag the handle). Bookings come from the database through GG.loadDay in site.js (window.GG). */
(function () {
  var GG = window.GG, DAYS_AHEAD = 7;
  var state = { day: 0, bay: null, start: null, end: null };   // end is exclusive
  var cells = [], taken = {};
  var $ = function (id) { return document.getElementById(id); };
  var fmtLong = { weekday: "long", month: "long", day: "numeric" };

  function hasSel() { return state.bay !== null; }
  function clearSel() { state.bay = state.start = state.end = null; }

  // Furthest end (exclusive) a booking starting at s in this bay can reach.
  function maxEnd(b, s) {
    var t = taken[b], e = s;
    while (e < GG.SLOTS && !t[e] && GG.slotOpen(state.day, e) && e - s < GG.MAX_LEN) e++;
    return e;
  }

  // Day picker: ‹ date › plus a menu of the bookable days
  function renderDayNav() {
    var d = GG.dateFor(state.day);
    $("dayLabel").textContent = state.day === 0 ? "Today, " + d.toLocaleDateString("en-CA", { month: "short", day: "numeric" }) : d.toLocaleDateString("en-CA", GG.fmtDay);
    $("dayLong").textContent = d.toLocaleDateString("en-CA", fmtLong);
    $("prevDay").disabled = state.day === 0;
    $("nextDay").disabled = state.day === DAYS_AHEAD - 1;
    $("rateNote").textContent = rateNote(d);

    var menu = $("dayMenu"); menu.innerHTML = "";
    for (var i = 0; i < DAYS_AHEAD; i++) (function (i) {
      var di = GG.dateFor(i), b = document.createElement("button");
      b.type = "button"; b.className = "chip";
      b.setAttribute("aria-pressed", i === state.day ? "true" : "false");
      b.textContent = i === 0 ? "Today" : di.toLocaleDateString("en-CA", { weekday: "short" });
      var sm = document.createElement("small"); sm.textContent = di.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
      b.appendChild(sm);
      b.addEventListener("click", function () { toggleMenu(false); setDay(i); $("dayBtn").focus(); });
      menu.appendChild(b);
    })(i);
  }

  // e.g. "Winter weekday: $35 an hour to 12 AM, $40 late night. Prices are per hour before tax."
  function rateNote(d) {
    var season = GG.season(d), r = GG.rates[season], kind, text;
    if (GG.weekendRate(d)) {
      kind = GG.isHoliday(d) && !GG.isWeekend(d) ? "holiday (weekend rate)" : "weekend";
      text = "$" + r.weekend + " to 12 AM";
    } else {
      kind = "weekday";
      text = r.day === r.eve ? "$" + r.day + " to 12 AM" : "$" + r.day + " before " + GG.hourLabel(GG.rates.eveFrom) + ", $" + r.eve + " after";
    }
    return GG.SEASONS[season] + " " + kind + ": " + text + ", $" + r.late + " late night. Prices are per hour before tax.";
  }

  function toggleMenu(open) {
    $("dayMenu").hidden = !open;
    $("dayBtn").setAttribute("aria-expanded", open ? "true" : "false");
  }
  $("dayBtn").addEventListener("click", function () { toggleMenu($("dayMenu").hidden); });
  document.addEventListener("click", function (e) { if (!e.target.closest(".day-pick")) toggleMenu(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") toggleMenu(false); });
  $("prevDay").addEventListener("click", function () { setDay(state.day - 1); });
  $("nextDay").addEventListener("click", function () { setDay(state.day + 1); });

  function setDay(i) {
    if (i < 0 || i >= DAYS_AHEAD) return;
    state.day = i; clearSel();
    build(); $("ttWrap").scrollTop = 0;
    refresh();
  }

  // Reload the day's bookings from the database and redraw; drops a selection that is no longer free.
  function refresh() {
    var i = state.day;
    return GG.loadDay(i).then(function (ok) {
      if (!ok || state.day !== i) return;
      if (hasSel() && !GG.bayFree(i, state.bay, state.start, state.end - state.start)) clearSel();
      build();
    });
  }

  // The grid: a header row of bays, then one row per 15 minutes from now (or opening) to close.
  function build() {
    renderDayNav();
    var tt = $("tt"); tt.innerHTML = ""; cells = [];
    tt.style.gridTemplateColumns = "4.75rem repeat(" + GG.BAYS + ", minmax(6.5rem, 1fr))";
    for (var b = 1; b <= GG.BAYS; b++) taken[b] = GG.taken(state.day, b);

    var corner = div("tt-corner"); tt.appendChild(corner);
    for (b = 1; b <= GG.BAYS; b++) {
      var h = div("tt-bay" + (b === GG.BAYS ? " end" : "")); h.setAttribute("role", "columnheader");
      var n = document.createElement("b"); n.textContent = "Bay " + b;
      var hand = document.createElement("small"); hand.textContent = GG.hand(b);
      h.append(n, hand); tt.appendChild(h);
    }

    var any = false, crossed = false;
    for (var s = 0; s < GG.SLOTS; s++) {
      if (GG.pastSlot(state.day, s)) continue;
      var mins = GG.slotMins(s);
      if (mins >= 1440 && !crossed) {
        crossed = true;
        var next = GG.dateFor(state.day + 1), dv = div("tt-divider");
        dv.textContent = next.toLocaleDateString("en-CA", fmtLong) + ", after midnight · Late night $" + GG.rates[GG.season(GG.dateFor(state.day))].late + "/hr" +
          (GG.lateClosed(state.day) ? " · Closed to new bookings after " + GG.hourLabel(GG.LATE_BY) : " · Book by " + GG.hourLabel(GG.LATE_BY) + " the same day");
        tt.appendChild(dv);
      }
      if (mins >= 1440) crossed = true;
      any = true;
      var onHour = mins % 60 === 0, lab = div("tt-time" + (onHour ? " hour" : ""));
      lab.textContent = GG.slotLabel(s); tt.appendChild(lab);
      cells[s] = [];
      for (b = 1; b <= GG.BAYS; b++) tt.appendChild(cells[s][b] = cell(s, b, onHour));
    }
    if (!any) {
      var e = div("tt-empty"); e.textContent = "No more start times today. Try the next day.";
      tt.appendChild(e);
    }
    paint();
  }

  // "4:00–5:30 PM" fits in a cell; "11:30 AM–1:00 PM" keeps both halves of the day.
  function shortRange(a, b) {
    var x = GG.slotLabel(a), y = GG.slotLabel(b);
    return x.slice(-2) === y.slice(-2) ? x.slice(0, -3) + "–" + y : x.replace(" ", "") + "–" + y.replace(" ", "");
  }

  function div(cls) { var d = document.createElement("div"); d.className = cls; return d; }

  function cell(s, b, onHour) {
    var btn = document.createElement("button"), t = taken[b], when = "Bay " + b + ", " + GG.slotLabel(s);
    btn.type = "button"; btn.className = "tt-cell" + (onHour ? " hour" : "") + (b === GG.BAYS ? " end" : "");
    btn.dataset.s = s; btn.dataset.b = b;
    if (!GG.slotOpen(state.day, s)) {
      btn.disabled = true; btn.classList.add("closed");
      btn.setAttribute("aria-label", when + ", closed to new bookings");
    } else if (t[s]) {
      btn.disabled = true; btn.classList.add("booked");
      btn.setAttribute("aria-label", when + ", booked");
      if (s === 0 || !t[s - 1] || GG.pastSlot(state.day, s - 1)) btn.textContent = "Booked";
    } else {
      btn.setAttribute("aria-label", when + ", free");
      btn.addEventListener("click", function () { tap(s, b); });
    }
    return btn;
  }

  // Tap rules: first tap picks the start (30 minutes); a later tap in the same bay sets the finish;
  // tapping the start again clears it; anything else starts over there.
  function tap(s, b) {
    if (hasSel() && b === state.bay) {
      if (s === state.start) { clearSel(); paint(); return; }
      if (s > state.start && s < maxEnd(b, state.start)) { setEnd(s + 1); return; }
    }
    if (maxEnd(b, s) - s < GG.MIN_LEN) { flash(s, b); return; }
    state.bay = b; state.start = s; state.end = s + GG.MIN_LEN;
    paint();
  }

  function setEnd(e) {
    var lo = state.start + GG.MIN_LEN, hi = maxEnd(state.bay, state.start);
    e = Math.max(lo, Math.min(e, hi));
    if (e !== state.end) { state.end = e; paint(); }
  }

  // A start time with less than 30 free minutes after it
  function flash(s, b) {
    var c = cells[s][b];
    c.classList.remove("nope"); void c.offsetWidth; c.classList.add("nope");
    c.title = "Bookings are at least 30 minutes. This bay is booked right after.";
  }

  function paint() {
    var old = $("tt").querySelectorAll(".sel, .sel-first, .sel-last");
    for (var i = 0; i < old.length; i++) {
      old[i].classList.remove("sel", "sel-first", "sel-last");
      old[i].setAttribute("aria-pressed", "false");
      if (!old[i].classList.contains("booked")) old[i].textContent = "";
    }
    if (hasSel()) {
      for (var s = state.start; s < state.end; s++) {
        var c = cells[s] && cells[s][state.bay];
        if (!c) continue;
        c.classList.add("sel"); c.setAttribute("aria-pressed", "true");
      }
      var first = cells[state.start][state.bay], last = cells[state.end - 1][state.bay];
      first.classList.add("sel-first");
      first.textContent = shortRange(state.start, state.end);
      last.classList.add("sel-last");
      // The handle sits on the grid (not inside the cell button) at the bottom edge of the selection.
      handle.style.left = last.offsetLeft + "px";
      handle.style.width = last.offsetWidth + "px";
      handle.style.top = (last.offsetTop + last.offsetHeight) + "px";
      handle.setAttribute("aria-valuetext", "Finish " + GG.slotLabel(state.end));
      if (handle.parentNode !== $("tt")) $("tt").appendChild(handle);
    } else if (handle.parentNode) {
      handle.parentNode.removeChild(handle);
    }
    summary();
  }

  // Drag handle at the bottom of the selection: drag (or arrow keys) to move the finish time.
  var handle = document.createElement("span");
  handle.className = "tt-handle"; handle.tabIndex = 0;
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", "Finish time");
  handle.innerHTML = "<i></i>";
  var dragging = false, scrollTimer = null, lastY = 0;
  handle.addEventListener("pointerdown", function (e) {
    e.preventDefault(); e.stopPropagation();
    dragging = true; lastY = e.clientY;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("tt-dragging");
    scrollTimer = setInterval(autoScroll, 30);
  });
  handle.addEventListener("pointermove", function (e) { if (dragging) { lastY = e.clientY; endFromY(lastY); } });
  function stopDrag() {
    if (!dragging) return;
    dragging = false; clearInterval(scrollTimer);
    document.body.classList.remove("tt-dragging");
  }
  handle.addEventListener("pointerup", stopDrag);
  handle.addEventListener("pointercancel", stopDrag);
  handle.addEventListener("keydown", function (e) {
    var d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault(); setEnd(state.end + d); handle.focus();
  });

  // Which row the pointer is over, measured down the selected bay's column
  function endFromY(y) {
    var hi = maxEnd(state.bay, state.start), s = state.start;
    while (s < hi - 1 && cells[s][state.bay].getBoundingClientRect().bottom < y) s++;
    setEnd(s + 1);
  }
  function autoScroll() {
    var w = $("ttWrap"), r = w.getBoundingClientRect(), edge = 40;
    var dy = lastY > r.bottom - edge ? 12 : lastY < r.top + 70 ? -12 : 0;   // header row takes the top 50px
    if (dy) { w.scrollTop += dy; endFromY(lastY); }
  }

  function summary() {
    var d = GG.dateFor(state.day);
    $("sDay").textContent = d.toLocaleDateString("en-CA", GG.fmtDay);
    var on = hasSel(), len = on ? state.end - state.start : 0;
    if (on) {
      // Same rounding as the payment API, so the total here is what the card is charged.
      var c = GG.cents(state.day, state.start, len), when = GG.slotLabel(state.start) + " – " + GG.slotLabel(state.end);
      $("sTime").textContent = when; $("sLen").textContent = GG.lenLabel(len); $("sBay").textContent = "Bay " + state.bay;
      $("sSub").textContent = GG.money(c.subtotal / 100); $("sTax").textContent = GG.money(c.tax / 100); $("sTotal").textContent = GG.money(c.total / 100);
      $("barWhat").textContent = "Bay " + state.bay + " · " + GG.lenLabel(len);
      $("barWhen").textContent = when; $("barTotal").textContent = GG.money(c.total / 100);
      $("go").textContent = "Pay " + GG.money(c.total / 100) + " and book";
    } else {
      ["sTime", "sLen", "sBay", "sSub", "sTax"].forEach(function (id) { $(id).textContent = "—"; });
      $("sTotal").textContent = "$0.00";
      $("go").textContent = "Pay and book";
    }
    $("ttBar").hidden = !on;
    updateGo();
  }

  var paying = false;
  function updateGo() {
    $("go").disabled = paying || !(hasSel() && $("cName").value.trim() && $("cPhone").value.trim());
  }
  $("cName").addEventListener("input", updateGo);
  $("cPhone").addEventListener("input", updateGo);

  $("waitCall").href = "tel:" + GG.info.phone.replace(/[^\d+]/g, "");

  function payMsg(text) { var m = $("payMsg"); m.textContent = text || ""; m.hidden = !text; }

  // Pay: the server prices the booking and sends back a Stripe Checkout page to go to.
  $("go").addEventListener("click", function () {
    paying = true; updateGo(); payMsg("");
    $("go").textContent = "Opening secure payment…";
    fetch("api/checkout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: GG.dayKey(GG.dateFor(state.day)), bay: state.bay, start: state.start, len: state.end - state.start,
        name: $("cName").value.trim(), phone: $("cPhone").value.trim()
      })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok && j.url) { location.href = j.url; return; }
        if (j.code === "taken") refresh();
        throw new Error(j.error || "We could not open the payment page. Please try again, or call or text us.");
      });
    }).catch(function (err) {
      paying = false; summary();
      payMsg(err.message && !/fetch|network/i.test(err.message) ? err.message : "We could not reach the payment service. Check your connection and try again.");
    });
  });

  // Back from Stripe: ?paid=<session id> shows the confirmation, ?canceled=1 says nothing was charged.
  function showConfirm(b) {
    var box = $("confirm");
    box.className = "confirm"; box.hidden = false; box.innerHTML = "";
    var h = document.createElement("h3"); h.textContent = "You're booked";
    var c = document.createElement("p"); c.className = "code"; c.textContent = b.code;
    var d = GG.parseDay ? GG.parseDay(b.date) : null;
    var p = document.createElement("p");
    p.textContent = (d ? d.toLocaleDateString("en-CA", GG.fmtDay) : b.date) + ", " + GG.slotLabel(b.start) + " – " + GG.slotLabel(b.start + b.len) +
      ", Bay " + b.bay + ". Paid " + GG.money(b.total) + (b.email ? ". Your receipt is on its way to " + b.email + "." : ".");
    box.append(h, c, p);
    box.scrollIntoView({ block: "center" });
  }
  var q = new URLSearchParams(location.search);
  if (q.get("paid")) {
    fetch("api/session?id=" + encodeURIComponent(q.get("paid"))).then(function (r) { return r.json(); }).then(function (b) {
      if (!b.paid) { payMsg("We could not confirm that payment. If your card was charged, call or text us with the time you booked."); return; }
      if (b.status === "conflict") { payMsg("Your payment went through, but someone booked that time a moment before you. We will call or text " + b.phone + " to move your booking or refund you. Your reference is " + b.code + "."); refresh(); return; }
      showConfirm(b);
      if (b.status === "unsaved") payMsg("Your payment went through, but we could not save the booking just now. Please call or text us with reference " + b.code + ".");
      refresh();
    }).catch(function () { payMsg("We could not check your payment just now. Refresh this page in a moment."); });
  } else if (q.get("canceled")) {
    payMsg("Payment canceled. Nothing was charged and the time is not booked.");
  }
  if (q.get("paid") || q.get("canceled")) history.replaceState(null, "", location.pathname);

  build();
  refresh();
})();
