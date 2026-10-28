/* Admin page: sign-in, dashboard, bookings, payments, customers, door and bay power, logs, site settings.
   Data comes from api/login, api/admin and api/devices (session cookie). Site settings still live in this browser (GG.save). */
(function () {
  var GG = window.GG, P = window.GGP;
  var $ = function (id) { return document.getElementById(id); };
  var TZ = P.TIME_ZONE;

  // ---------- helpers ----------
  function say(id, text, ok) { var m = $(id); m.textContent = text; m.className = "msg " + (ok ? "ok" : "err"); }
  function hoursLabel(slots) { var h = slots / P.PER_HOUR; return (h % 1 ? h.toFixed(1) : h) + "시간"; }
  function timeRange(b) { return P.slotLabel(b.start) + " – " + P.slotLabel(b.start + b.len); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function row(tbody, cells, cls) {
    var tr = tbody.insertRow(); if (cls) tr.className = cls;
    cells.forEach(function (c) {
      var td = tr.insertCell();
      if (c && c.nodeType) td.appendChild(c);
      else if (Array.isArray(c)) { td.textContent = c[0] == null || c[0] === "" ? "—" : c[0]; if (c[1]) td.className = c[1]; }
      else td.textContent = c == null || c === "" ? "—" : c;
    });
    return tr;
  }
  function empty(tbody, cols, text) { tbody.innerHTML = ""; var td = tbody.insertRow().insertCell(); td.colSpan = cols; td.className = "muted"; td.textContent = text; }
  function stamp(iso) {
    return iso ? new Date(iso).toLocaleString("ko-KR", { timeZone: TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";
  }
  function dayLabel(key) { var d = P.parseDay(key); return d ? d.toLocaleDateString("ko-KR", { month: "short", day: "numeric", weekday: "short" }) : key; }
  function pill(text, kind) { return el("span", text, "pill" + (kind ? " " + kind : "")); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }

  function download(name, text, type) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function csv(rows) {
    // BOM so Excel opens Korean text correctly
    return "﻿" + rows.map(function (r) {
      return r.map(function (v) { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(",");
    }).join("\r\n");
  }

  // Every API call. A 401 sends the admin back to the sign-in screen.
  function api(path, opts) {
    var o = opts || {};
    return fetch(path, {
      method: o.method || "GET", credentials: "same-origin",
      headers: o.body ? { "Content-Type": "application/json" } : {},
      body: o.body ? JSON.stringify(o.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && path.indexOf("api/login") !== 0) showLogin("로그인이 끝났습니다. 다시 로그인하세요.");
        if (!r.ok) { var e = new Error(j.error || "요청이 실패했습니다 (" + r.status + ")"); e.status = r.status; e.code = j.code; throw e; }
        return j;
      });
    }, function () { throw new Error("서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요."); });
  }
  function dbError(err) {
    var a = $("dbAlert");
    a.hidden = false;
    a.textContent = err.code === "not_configured" ? "데이터베이스(Supabase)가 연결되지 않아 예약·결제·로그를 불러올 수 없습니다." : err.message;
    a.scrollIntoView({ block: "nearest" });
  }

  // ---------- log labels ----------
  var CAT = { auth: "로그인", booking: "예약", payment: "결제", door: "도어", system: "시스템", error: "오류" };
  var ACT = {
    login: "로그인", login_fail: "로그인 실패", login_blocked: "로그인 차단", logout: "로그아웃",
    booking_add: "예약 추가 (전화·현장)", booking_cancel: "예약 취소",
    checkout_start: "결제 페이지 열림", paid: "온라인 결제 완료", paid_conflict: "결제됐지만 시간 겹침",
    door_open: "문 열기", power_on: "전원 켜기", power_off: "전원 끄기",
    admin_api: "관리자 API 오류", booking_save: "예약 저장 실패", checkout: "결제 페이지 오류"
  };
  function refLabel(r) { var m = /^bay(\d)$/.exec(r || ""); return m ? "Bay " + m[1] : r === "door" ? "정문" : r; }
  function detailText(d) {
    if (!d) return "";
    var parts = [];
    if (d.date) parts.push(d.date);
    if (d.bay) parts.push("Bay " + d.bay);
    if (d.time) parts.push(d.time);
    else if (d.start != null && d.len) parts.push(P.slotLabel(d.start) + " – " + P.slotLabel(d.start + d.len));
    if (d.name) parts.push(d.name);
    if (d.phone) parts.push(d.phone);
    if (d.email) parts.push(d.email);
    if (d.total != null) parts.push(GG.money(d.total));
    if (d.seconds) parts.push(d.seconds + "초");
    if (d.message) parts.push(d.message);
    if (!parts.length && d.agent) parts.push(d.agent);
    return parts.join(" · ");
  }
  function logRow(tbody, l, compact) {
    var res = pill(l.ok ? "성공" : "실패", l.ok ? "ok" : "bad");
    if (compact) return row(tbody, [[stamp(l.at), "mono"], ACT[l.action] || l.action, res, [refLabel(l.ref) || l.actor]]);
    return row(tbody, [[stamp(l.at), "mono"], CAT[l.category] || l.category, ACT[l.action] || l.action, res, l.actor, [refLabel(l.ref), "mono"], [l.ip, "mono"], [detailText(l.detail), "detail"]], l.ok ? "" : "bad");
  }

  // ---------- sign-in ----------
  function showLogin(text) {
    $("appView").hidden = true; $("loginView").hidden = false;
    if (text) say("loginMsg", text);
    if (!$("lId").value) $("lId").value = "guttagolf";
    $("lPw").value = ""; $("lPw").focus();
  }
  function showApp(me) {
    $("loginView").hidden = true; $("appView").hidden = false;
    $("whoName").textContent = me.user;
    if (me.db === false) dbError({ code: "not_configured" });
    route();
  }
  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    say("loginMsg", "확인 중…", true);
    api("api/login", { method: "POST", body: { id: $("lId").value, password: $("lPw").value } })
      .then(function (me) { $("loginMsg").textContent = ""; showApp(me); })
      .catch(function (err) { say("loginMsg", err.code === "not_configured" ? "서버에 ADMIN_PASSWORD가 설정되지 않았습니다." : err.message); $("lPw").select(); });
  });
  $("logoutBtn").addEventListener("click", function () {
    api("api/login", { method: "DELETE" }).catch(function () {}).then(function () { showLogin("로그아웃했습니다."); $("loginMsg").className = "msg ok"; });
  });

  // ---------- tabs ----------
  var loaders = {};
  function route() {
    var tab = (location.hash || "#dashboard").slice(1);
    if (!$(tab) || !$(tab).hasAttribute("data-tab")) tab = "dashboard";
    document.querySelectorAll("[data-tab]").forEach(function (s) { s.hidden = s.id !== tab; });
    document.querySelectorAll(".tabs a").forEach(function (a) {
      if (a.getAttribute("href") === "#" + tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (loaders[tab]) loaders[tab]();
  }
  window.addEventListener("hashchange", function () { if (!$("appView").hidden) { route(); window.scrollTo(0, 0); } });

  // ---------- dashboard ----------
  loaders.dashboard = function () {
    api("api/admin?view=summary").then(function (s) {
      var slots = 0, sales = 0;
      s.bookings.forEach(function (b) { slots += b.len; sales += b.total; });
      $("dCount").textContent = s.bookings.length;
      $("dHours").textContent = hoursLabel(slots);
      $("dSales").textContent = GG.money(sales);
      $("dMonth").textContent = GG.money(s.month.total);
      $("dMonthLabel").textContent = "이번 달 매출 (" + s.month.count + "건)";

      var next = s.bookings.filter(function (b) { return P.slotMins(b.start + b.len) > s.nowMins; }), tb = $("dNext");
      tb.innerHTML = "";
      next.forEach(function (b) { row(tb, [[timeRange(b), "mono"], "Bay " + b.bay, b.name, [b.phone, "mono"]]); });
      if (!next.length) empty(tb, 4, "남은 예약이 없습니다.");

      var ca = $("conflictAlert");
      ca.hidden = !s.conflicts.length;
      ca.textContent = s.conflicts.length ? "확인 필요: 결제는 됐지만 시간이 겹친 예약 " + s.conflicts.length + "건 — " +
        s.conflicts.map(function (b) { return b.date + " " + timeRange(b) + " Bay " + b.bay + " " + (b.name || "") + " " + (b.phone || ""); }).join(" / ") +
        ". 고객에게 연락해 다른 시간으로 옮기거나 Stripe에서 환불하세요." : "";

      var lt = $("dLogs"); lt.innerHTML = "";
      s.logs.forEach(function (l) { logRow(lt, l, true); });
      if (!s.logs.length) empty(lt, 4, "아직 기록이 없습니다.");
    }).catch(dbError);
  };

  // ---------- bookings ----------
  var sel = new Date(GG.today);
  loaders.bookings = function () {
    var key = P.dayKey(sel);
    $("day").value = key;
    updatePrice();
    var tbody = $("list");
    empty(tbody, 9, "불러오는 중…");
    api("api/admin?view=bookings&date=" + key).then(function (j) {
      if (P.dayKey(sel) !== key) return;
      var slots = 0, sales = 0, online = 0;
      tbody.innerHTML = "";
      j.bookings.forEach(function (b) {
        slots += b.len; sales += b.total; if (b.source === "online") online++;
        var x = el("button", "취소", "small-btn danger"); x.type = "button";
        x.addEventListener("click", function () {
          var warn = b.source === "online" ? "\n\n온라인 결제 예약입니다. 환불은 Stripe에서 따로 해야 합니다." : "";
          if (!confirm((b.name || "") + "님 " + P.slotLabel(b.start) + " Bay " + b.bay + " 예약을 취소할까요?" + warn)) return;
          x.disabled = true;
          api("api/admin?code=" + encodeURIComponent(b.code), { method: "DELETE", body: {} })
            .then(loaders.bookings).catch(function (err) { x.disabled = false; alert(err.message); });
        });
        var src = b.status === "conflict" ? pill("시간 겹침", "bad") : pill(b.source === "admin" ? "전화·현장" : "온라인", b.source === "online" ? "ok" : "");
        row(tbody, [[timeRange(b), "mono"], "Bay " + b.bay, b.name, [b.phone, "mono"], b.email, [GG.money(b.total), "num mono"], src, [b.code, "mono"], x],
          b.status === "conflict" ? "bad" : "");
      });
      if (!j.bookings.length) empty(tbody, 9, "이 날짜에는 예약이 없습니다.");
      $("stCount").textContent = j.bookings.length;
      $("stHours").textContent = hoursLabel(slots);
      $("stSales").textContent = GG.money(sales);
      $("stOnline").textContent = online;
    }).catch(function (err) { empty(tbody, 9, err.message); });
  };
  function moveDay(n) { sel = addDays(sel, n); loaders.bookings(); }
  $("prevDay").addEventListener("click", function () { moveDay(-1); });
  $("nextDay").addEventListener("click", function () { moveDay(1); });
  $("todayBtn").addEventListener("click", function () { sel = new Date(GG.today); loaders.bookings(); });
  $("day").addEventListener("change", function () { var d = P.parseDay(this.value); if (d) { sel = d; loaders.bookings(); } });

  for (var s = 0; s < P.SLOTS; s++) $("aStart").add(new Option(P.slotLabel(s), s));
  for (var b = 1; b <= P.BAYS; b++) $("aBay").add(new Option("Bay " + b + (GG.HAND[b] ? " (오른손)" : ""), b));
  function updatePrice() { $("aTotal").value = GG.money(P.cents(P.RATES, sel, +$("aStart").value, +$("aLen").value).total / 100); }
  $("aStart").addEventListener("change", updatePrice);
  $("aLen").addEventListener("change", updatePrice);

  $("addForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var start = +$("aStart").value, len = +$("aLen").value;
    if (sel < GG.today) return say("addMsg", "지난 날짜에는 예약을 추가할 수 없습니다.");
    if (start + len > P.SLOTS) return say("addMsg", "영업 종료 시간을 넘습니다. 시작 시간이나 이용 시간을 줄여 주세요.");
    var btn = e.submitter || this.querySelector("button"); btn.disabled = true;
    api("api/admin", { method: "POST", body: { date: P.dayKey(sel), bay: +$("aBay").value, start: start, len: len, name: $("aName").value.trim(), phone: $("aPhone").value.trim() } })
      .then(function (j) { $("aName").value = ""; $("aPhone").value = ""; say("addMsg", "예약을 추가했습니다 (" + j.code + ").", true); loaders.bookings(); })
      .catch(function (err) { say("addMsg", err.message); })
      .then(function () { btn.disabled = false; });
  });

  // ---------- payments ----------
  var payRows = [];
  $("pFrom").value = P.dayKey(new Date(GG.today.getFullYear(), GG.today.getMonth(), 1));
  $("pTo").value = P.dayKey(addDays(GG.today, P.DAYS_AHEAD));
  var STATUS = { confirmed: ["확정", "ok"], conflict: ["시간 겹침", "bad"], canceled: ["취소", ""] };
  function payFiltered() {
    var src = $("pSource").value, st = $("pStatus").value;
    return payRows.filter(function (p) { return (!src || p.source === src) && (!st || p.status === st); });
  }
  var stripeTest = true;
  function renderPayments() {
    var rows = payFiltered(), tb = $("pList"), sum = { total: 0, tax: 0, online: 0, admin: 0 };
    tb.innerHTML = "";
    rows.forEach(function (p) {
      if (p.status !== "canceled") { sum.total += p.total; sum.tax += p.tax; sum[p.source] += p.total; }
      var link = "—";
      if (p.paymentIntent) {
        link = el("a", "보기 ↗"); link.target = "_blank"; link.rel = "noopener";
        link.href = "https://dashboard.stripe.com/" + (stripeTest ? "test/" : "") + "payments/" + encodeURIComponent(p.paymentIntent);
      }
      row(tb, [dayLabel(p.date), [timeRange(p), "mono"], "Bay " + p.bay, (p.name || "—") + (p.phone ? " · " + p.phone : ""),
        [GG.money(p.subtotal), "num mono"], [GG.money(p.tax), "num mono"], [GG.money(p.total), "num mono"],
        p.source === "online" ? "온라인" : "전화·현장", pill(STATUS[p.status][0], STATUS[p.status][1]), [p.code, "mono"], link],
        p.status === "canceled" ? "off" : p.status === "conflict" ? "bad" : "");
    });
    if (!rows.length) empty(tb, 11, "이 기간에는 결제 내역이 없습니다.");
    $("pTotal").textContent = GG.money(sum.total); $("pTax").textContent = GG.money(sum.tax);
    $("pOnline").textContent = GG.money(sum.online); $("pAdmin").textContent = GG.money(sum.admin);
  }
  loaders.payments = function () {
    empty($("pList"), 11, "불러오는 중…");
    api("api/admin?view=payments&from=" + $("pFrom").value + "&to=" + $("pTo").value).then(function (j) {
      payRows = j.payments; stripeTest = j.stripeTest;
      $("pMode").textContent = stripeTest ? "Stripe 테스트 모드입니다 (실제 돈이 오가지 않음)." : "";
      renderPayments();
    }).catch(function (err) { empty($("pList"), 11, err.message); });
  };
  $("pLoad").addEventListener("click", loaders.payments);
  $("pSource").addEventListener("change", renderPayments);
  $("pStatus").addEventListener("change", renderPayments);
  $("pCsv").addEventListener("click", function () {
    var rows = [["예약일", "시작", "끝", "베이", "이름", "전화", "이메일", "금액", "HST", "합계", "경로", "상태", "코드", "Stripe 결제 ID", "예약 시각", "취소 시각"]];
    payFiltered().forEach(function (p) {
      rows.push([p.date, P.slotLabel(p.start), P.slotLabel(p.start + p.len), p.bay, p.name, p.phone, p.email, p.subtotal.toFixed(2), p.tax.toFixed(2), p.total.toFixed(2),
        p.source === "online" ? "온라인" : "전화·현장", STATUS[p.status][0], p.code, p.paymentIntent, stamp(p.created), p.canceled ? stamp(p.canceled) : ""]);
    });
    download("gutta-payments_" + $("pFrom").value + "_" + $("pTo").value + ".csv", csv(rows), "text/csv;charset=utf-8");
  });

  // ---------- customers ----------
  var custRows = [];
  loaders.customers = function () {
    empty($("cList"), 7, "불러오는 중…");
    api("api/admin?view=customers&q=" + encodeURIComponent($("cQ").value.trim())).then(function (j) {
      custRows = j.customers;
      var tb = $("cList"); tb.innerHTML = "";
      custRows.forEach(function (c) {
        row(tb, [c.name, [c.phone, "mono"], c.email, [c.count, "num mono"], [GG.money(c.spent), "num mono"], c.last ? dayLabel(c.last) : "—", stamp(c.created).slice(0, 6)]);
      });
      if (!custRows.length) empty(tb, 7, "고객이 없습니다.");
      $("cCount").textContent = custRows.length + "명" + (custRows.length >= 300 ? " (최근 300명까지 표시 — 검색으로 좁히세요)" : "");
    }).catch(function (err) { empty($("cList"), 7, err.message); });
  };
  $("cForm").addEventListener("submit", function (e) { e.preventDefault(); loaders.customers(); });
  $("cCsv").addEventListener("click", function () {
    var rows = [["이름", "전화", "이메일", "예약 수", "총 결제", "최근 예약일", "첫 방문"]];
    custRows.forEach(function (c) { rows.push([c.name, c.phone, c.email, c.count, c.spent.toFixed(2), c.last, c.created]); });
    download("gutta-customers.csv", csv(rows), "text/csv;charset=utf-8");
  });

  // ---------- door and bay power ----------
  var devReady = {}, busy = false;
  function devCall(device, action) {
    return api("api/devices", { method: "POST", body: { device: device, action: action } });
  }
  function devLogs() {
    var to = addDays(GG.today, 1), from = addDays(GG.today, -7), tb = $("devLogs");
    Promise.all(["door", "system"].map(function (c) {
      return api("api/admin?view=logs&limit=15&category=" + c + "&from=" + from.toISOString() + "&to=" + to.toISOString());
    })).then(function (r) {
      var all = r[0].logs.concat(r[1].logs).sort(function (a, b) { return a.at < b.at ? 1 : -1; }).slice(0, 15);
      tb.innerHTML = "";
      all.forEach(function (l) { logRow(tb, l, true); });
      if (!all.length) empty(tb, 4, "최근 7일 동안 기록이 없습니다.");
    }).catch(function (err) { empty(tb, 4, err.message); });
  }
  function setState(key, on) {
    var s = document.querySelector('[data-state="' + key + '"]');
    if (!s) return;
    s.textContent = on == null ? "상태 모름" : on ? "켜짐" : "꺼짐";
    s.className = "state" + (on ? " on" : "");
  }
  loaders.devices = function () {
    api("api/devices").then(function (j) {
      $("devSetup").hidden = j.configured;
      var box = $("bays"); box.innerHTML = "";
      j.devices.forEach(function (d) {
        devReady[d.key] = d.ready;
        if (d.kind !== "bay") return;
        var card = el("div", null, "bay"), r = el("div", null, "row");
        card.appendChild(el("b", "Bay " + d.key.slice(3)));
        var st = el("span", d.ready ? "상태 모름" : "연결 안 됨", "state"); st.setAttribute("data-state", d.key); card.appendChild(st);
        [["on", "켜기", ""], ["off", "끄기", " danger"]].forEach(function (a) {
          var btn = el("button", a[1], "small-btn" + a[2]); btn.type = "button"; btn.disabled = !d.ready;
          btn.addEventListener("click", function () {
            if (a[0] === "off" && !confirm("Bay " + d.key.slice(3) + " 시스템을 끌까요? 사용 중인 손님이 있으면 화면이 꺼집니다.")) return;
            btn.disabled = true; say("devMsg", "Bay " + d.key.slice(3) + " " + a[1] + "…", true);
            devCall(d.key, a[0]).then(function () { setState(d.key, a[0] === "on"); say("devMsg", "Bay " + d.key.slice(3) + " " + a[1] + " 완료.", true); devLogs(); })
              .catch(function (err) { say("devMsg", err.message); devLogs(); }).then(function () { btn.disabled = false; });
          });
          r.appendChild(btn);
        });
        card.appendChild(r); box.appendChild(card);
      });
      document.querySelectorAll("[data-door]").forEach(function (btn) { btn.disabled = !devReady.door; });
    }).catch(function (err) { say("devMsg", err.message); });
    devLogs();
  };

  document.querySelectorAll("[data-door]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!confirm("정문을 열까요?")) return;
      var label = btn.textContent;
      btn.disabled = true; btn.textContent = "여는 중…";
      devCall("door", "open").then(function () { btn.textContent = "열었습니다 ✓"; if (!$("devices").hidden) devLogs(); else loaders.dashboard(); })
        .catch(function (err) { btn.textContent = label; alert(err.message); })
        .then(function () { setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 2500); });
    });
  });

  // One bay at a time: Shelly Cloud takes about one request per second.
  function eachBay(fn, doneText) {
    if (busy) return;
    var keys = Object.keys(devReady).filter(function (k) { return k !== "door" && devReady[k]; });
    if (!keys.length) return say("devMsg", "연결된 베이가 없습니다.");
    busy = true;
    var fails = 0;
    keys.reduce(function (p, k, i) {
      return p.then(function () {
        say("devMsg", "Bay " + k.slice(3) + " 처리 중… (" + (i + 1) + "/" + keys.length + ")", true);
        return fn(k).catch(function () { fails++; setState(k, null); }).then(function () { return new Promise(function (r) { setTimeout(r, 1100); }); });
      });
    }, Promise.resolve()).then(function () {
      busy = false;
      say("devMsg", fails ? fails + "개 베이가 응답하지 않았습니다." : doneText, !fails);
      devLogs();
    });
  }
  $("allOn").addEventListener("click", function () {
    if (!confirm("모든 베이 시스템을 켤까요?")) return;
    eachBay(function (k) { return devCall(k, "on").then(function () { setState(k, true); }); }, "모든 베이를 켰습니다.");
  });
  $("allOff").addEventListener("click", function () {
    if (!confirm("모든 베이 시스템을 끌까요? 사용 중인 손님이 있으면 화면이 꺼집니다.")) return;
    eachBay(function (k) { return devCall(k, "off").then(function () { setState(k, false); }); }, "모든 베이를 껐습니다.");
  });
  $("allStatus").addEventListener("click", function () {
    eachBay(function (k) { return api("api/devices?status=" + k).then(function (j) { setState(k, j.on); }); }, "상태를 확인했습니다.");
  });

  // ---------- logs ----------
  var logRows = [];
  $("lFrom").value = P.dayKey(addDays(GG.today, -7));
  $("lTo").value = P.dayKey(GG.today);
  loaders.logs = function () {
    var from = P.parseDay($("lFrom").value), to = P.parseDay($("lTo").value);
    var q = "api/admin?view=logs&limit=2000" + ($("lCat").value ? "&category=" + $("lCat").value : "") +
      (from ? "&from=" + from.toISOString() : "") + (to ? "&to=" + addDays(to, 1).toISOString() : "") +
      ($("lQ").value.trim() ? "&q=" + encodeURIComponent($("lQ").value.trim()) : "");
    empty($("lList"), 8, "불러오는 중…");
    api(q).then(function (j) {
      logRows = j.logs;
      var tb = $("lList"); tb.innerHTML = "";
      logRows.forEach(function (l) { logRow(tb, l); });
      if (!logRows.length) empty(tb, 8, "조건에 맞는 기록이 없습니다.");
      var fails = logRows.filter(function (l) { return !l.ok; }).length;
      $("lCount").textContent = logRows.length + "건" + (fails ? " · 실패 " + fails + "건" : "") + (logRows.length >= 2000 ? " (최대 2000건까지 표시 — 기간을 좁히세요)" : "");
    }).catch(function (err) { empty($("lList"), 8, err.message); });
  };
  $("lForm").addEventListener("submit", function (e) { e.preventDefault(); loaders.logs(); });
  $("lCat").addEventListener("change", loaders.logs);
  function logFile(ext) { return "gutta-logs_" + ($("lCat").value || "all") + "_" + $("lFrom").value + "_" + $("lTo").value + "." + ext; }
  $("lCsv").addEventListener("click", function () {
    var rows = [["시간 (토론토)", "분류", "동작", "결과", "누가", "대상", "IP", "상세", "원본"]];
    logRows.forEach(function (l) {
      rows.push([stamp(l.at), CAT[l.category] || l.category, ACT[l.action] || l.action, l.ok ? "성공" : "실패", l.actor, refLabel(l.ref), l.ip, detailText(l.detail), l.detail ? JSON.stringify(l.detail) : ""]);
    });
    download(logFile("csv"), csv(rows), "text/csv;charset=utf-8");
  });
  $("lJson").addEventListener("click", function () { download(logFile("json"), JSON.stringify(logRows, null, 2), "application/json"); });

  // ---------- site settings (this browser) ----------
  function saveSettings() { return GG.save("gg.settings", { info: GG.info, rates: GG.rates, notice: GG.notice }); }
  var INFO = { iPhone: "phone", iEmail: "email", iInstagram: "instagram", iAddress1: "address1", iAddress2: "address2", iHours: "hours" };
  function fillForms() {
    ["winter", "summer"].forEach(function (s) {
      var S = s[0].toUpperCase() + s.slice(1);
      $("r" + S + "Day").value = GG.rates[s].day; $("r" + S + "Eve").value = GG.rates[s].eve; $("r" + S + "Weekend").value = GG.rates[s].weekend; $("r" + S + "Late").value = GG.rates[s].late;
    });
    $("rEveFrom").value = GG.rates.eveFrom;
    Object.keys(INFO).forEach(function (id) { $(id).value = GG.info[INFO[id]] || ""; });
    $("nText").value = GG.notice;
  }
  $("ratesForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var season = function (S) { return { day: +$("r" + S + "Day").value, eve: +$("r" + S + "Eve").value, weekend: +$("r" + S + "Weekend").value, late: +$("r" + S + "Late").value }; };
    GG.rates = { winter: season("Winter"), summer: season("Summer"), eveFrom: +$("rEveFrom").value };
    var ok = saveSettings();
    say("ratesMsg", ok ? "저장했습니다. 이 브라우저의 사이트 화면에만 반영됩니다." : "저장하지 못했습니다.", ok);
  });
  $("infoForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var info = {};
    Object.keys(INFO).forEach(function (id) { info[INFO[id]] = $(id).value.trim(); });
    GG.info = info;
    var ok = saveSettings();
    say("infoMsg", ok ? "저장했습니다." : "저장하지 못했습니다.", ok);
  });
  $("noticeForm").addEventListener("submit", function (e) {
    e.preventDefault();
    GG.notice = $("nText").value.trim();
    var ok = saveSettings();
    say("noticeMsg", ok ? (GG.notice ? "공지를 저장했습니다." : "공지를 지웠습니다.") : "저장하지 못했습니다.", ok);
  });
  $("resetSettings").addEventListener("click", function () {
    if (!confirm("요금·영업 정보·공지를 처음 값으로 되돌릴까요?")) return;
    GG.info = Object.assign({}, GG.defaults.info);
    GG.rates = JSON.parse(JSON.stringify(GG.defaults.rates));
    GG.notice = "";
    saveSettings(); fillForms();
    say("dataMsg", "기본값으로 되돌렸습니다.", true);
  });
  fillForms();

  // ---------- start ----------
  api("api/login").then(showApp).catch(function (err) {
    showLogin(err.status === 401 ? "" : err.code === "not_configured" ? "서버에 ADMIN_PASSWORD가 설정되지 않았습니다." : err.message);
  });
})();
