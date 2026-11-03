/* Green tab in admin.html: chat with Green (an ElevenLabs agent, by text or voice), the campaigns it drafts, and saved reports.
   Uses the helpers admin.js shares as window.GGA. Green only drafts; sending and publishing happen here, by the admin. */
(function () {
  var A = window.GGA, GG = window.GG;
  var $ = function (id) { return document.getElementById(id); };
  var el = A.el;

  // ---------- Markdown (Green's answers and reports). Everything is escaped first; only these tags are made. ----------
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }
  function cells(line) { return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); }); }
  function md(text) {
    var lines = String(text || "").replace(/\r/g, "").split("\n"), out = [], para = [], i = 0;
    function flush() { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } }
    while (i < lines.length) {
      var l = lines[i], m;
      if (/^```/.test(l)) {
        flush(); var code = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>"); i++; continue;
      }
      if (!l.trim()) { flush(); i++; continue; }
      if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { flush(); out.push("<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">"); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { flush(); out.push("<hr>"); i++; continue; }
      if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        var head = cells(l), rows = []; i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push('<div class="tw"><table><thead><tr>' + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr></thead><tbody>" +
          rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>");
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        flush();
        var ordered = /^\s*\d/.test(l), items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        out.push((ordered ? "<ol>" : "<ul>") + items.map(function (t) { return "<li>" + inline(t) + "</li>"; }).join("") + (ordered ? "</ol>" : "</ul>"));
        continue;
      }
      if (/^>\s?/.test(l)) {
        flush(); var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
        out.push("<blockquote>" + q.map(inline).join("<br>") + "</blockquote>"); continue;
      }
      para.push(l); i++;
    }
    flush();
    return out.join("");
  }

  // ---------- labels ----------
  var STATUS = { draft: ["초안", "warn"], active: ["게시 중", "ok"], sent: ["보냄", "ok"], ended: ["종료", ""] };
  var SEG = { new: "신규", one_time: "1회 방문", regular: "단골", vip: "VIP", lapsed: "휴면" };
  var AGE = { under18: "18 미만", "18-24": "18–24", "25-34": "25–34", "35-44": "35–44", "45-54": "45–54", "55-64": "55–64", "65plus": "65+" };
  var GEN = { female: "여성", male: "남성", other: "기타", na: "밝히지 않음" };
  var PAGE = { home: "홈", book: "예약", how: "이용 방법", rates: "요금", lessons: "레슨", faq: "FAQ", about: "소개" };
  var STARTERS = [
    "이번 달 마케팅 리포트 만들어줘",
    "Tracer Golf 웹사이트를 읽고 요금·서비스를 우리와 비교해줘",
    "지역·나이·성별로 고객을 분석해줘",
    "한가한 시간대를 채울 프로모션을 제안해줘",
    "60일 넘게 안 온 고객에게 보낼 문자 만들어줘",
    "이번 주 웹사이트 팝업 홍보창 만들어줘",
    "지난 캠페인 성과를 분석해줘"
  ];

  function audienceText(a) {
    if (!a || !Object.keys(a).length) return "수신 동의한 모든 고객";
    var p = [];
    if (a.segments) p.push(a.segments.map(function (s) { return SEG[s] || s; }).join("·"));
    if (a.regions) p.push("지역 " + a.regions.join(", "));
    if (a.age_bands) p.push(a.age_bands.map(function (s) { return AGE[s] || s; }).join("·") + "세");
    if (a.genders) p.push(a.genders.map(function (s) { return GEN[s] || s; }).join("·"));
    if (a.min_bookings) p.push("예약 " + a.min_bookings + "회 이상");
    if (a.last_visit_within_days) p.push("최근 " + a.last_visit_within_days + "일 안에 방문");
    if (a.last_visit_more_than_days) p.push(a.last_visit_more_than_days + "일 넘게 안 옴");
    return p.join(", ") + " (수신 동의자만)";
  }

  // ---------- status and setup ----------
  var ready = false;
  function loadStatus() {
    return A.api("api/green?do=status").then(function (s) {
      ready = s.eleven;
      var setup = [];
      if (!s.eleven) setup.push("<li><code>ELEVENLABS_API_KEY</code> — 일레븐랩스 → Developers → API Keys에서 만든 키. 이게 있어야 그린이 대답합니다.</li>");
      if (!s.twilio) setup.push("<li><code>TWILIO_FROM</code> (예: <code>+14375550123</code>) 또는 <code>TWILIO_MESSAGING_SERVICE_SID</code> — 문자를 보낼 Twilio 번호. 없으면 문자 초안까지만 됩니다.</li>");
      $("gSetup").hidden = !setup.length;
      if (setup.length) $("gSetup").innerHTML = "<b>Vercel 환경변수를 추가하면 모든 기능이 켜집니다.</b><ul style=\"margin: 8px 0 0; padding-left: 20px\">" + setup.join("") + "</ul>";
      $("gStatus").textContent = (!s.eleven ? "일레븐랩스 연결 안 됨" : s.agent ? "일레븐랩스 에이전트 · " + s.llm : "일레븐랩스 연결됨 · 첫 대화 때 그린을 만듭니다") +
        " · " + (s.twilio ? "문자 발송 가능" + (s.quiet ? " (지금은 발송 금지 시간)" : "") : "문자 발송 설정 안 됨");
      var b = $("gSetupBtn");
      b.hidden = !s.eleven;
      b.textContent = !s.agent ? "그린 만들기" : s.outdated ? "그린 업데이트 필요" : "그린 다시 설정";
      b.className = "small-btn" + (s.outdated ? " danger" : "");
    }).catch(function (err) { noTables(err); $("gStatus").textContent = err.message; });
  }
  $("gSetupBtn").addEventListener("click", function () {
    var b = this;
    if (!confirm("일레븐랩스에 그린 에이전트와 도구를 만들거나 최신 내용으로 바꿉니다. 진행할까요?")) return;
    b.disabled = true; b.textContent = "설정 중…";
    A.api("api/green?do=setup", { method: "POST", body: {} }).then(function (j) { alert("그린을 설정했습니다 (" + j.llm + ")."); })
      .catch(function (err) { noTables(err); alert(err.message); })
      .then(function () { b.disabled = false; endSession(); loadStatus(); });
  });
  function noTables(err) {
    if (err.code !== "no_tables") return;
    $("gSetup").hidden = false;
    $("gSetup").innerHTML = "<b>마케팅 테이블이 아직 없습니다.</b> Supabase → SQL Editor에서 <code>supabase/schema.sql</code> 전체를 다시 실행하세요 (기존 데이터는 그대로 남습니다).";
  }

  // ---------- conversation (ElevenLabs browser SDK, loaded on first use) ----------
  // Typing starts a text-only session; the mic button starts a voice session. Either one is a new ElevenLabs conversation.
  var SDK_URL = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.28.0/dist/lib.iife.js";
  var sdk = null, conv = null, mode = null, starting = null, wait = null, waitTimer = null, refreshTimer = null;
  var viewing = false, viewId = null;
  function loadSdk() {
    if (sdk) return sdk;
    sdk = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = SDK_URL; s.crossOrigin = "anonymous";
      s.onload = function () { if (window.ElevenLabsClient) resolve(window.ElevenLabsClient); else reject(new Error("일레븐랩스 프로그램을 불러오지 못했습니다.")); };
      s.onerror = function () { sdk = null; reject(new Error("일레븐랩스 프로그램을 불러오지 못했습니다. 인터넷 연결을 확인하세요.")); };
      document.head.appendChild(s);
    });
    return sdk;
  }

  function scrollDown() { var log = $("gLog"); log.scrollTop = log.scrollHeight; }
  function clearWelcome() { var w = document.querySelector("#gLog .g-welcome"); if (w) w.remove(); }
  function bubbleMe(text) { clearWelcome(); $("gLog").appendChild(el("div", text, "g-msg me")); scrollDown(); }
  function bubbleGreen(text) {
    clearWelcome();
    var box = el("div", null, "g-msg green"), body = el("div", null, "g-md");
    body.innerHTML = md(text);
    box.appendChild(body); $("gLog").appendChild(box); scrollDown();
  }
  function note(text, cls) { $("gLog").appendChild(el("div", text, "g-msg " + (cls || "wait"))); scrollDown(); }

  var WAIT = ["생각하고 있어요", "데이터를 보고 있어요", "자료를 정리하고 있어요", "거의 다 됐어요"];
  function showWait() {
    hideWait();
    var t0 = Date.now();
    wait = el("div", "", "g-msg green wait"); $("gLog").appendChild(wait); scrollDown();
    function tick() {
      var s = Math.round((Date.now() - t0) / 1000);
      if (s > 120) { hideWait(); note("그린이 대답하지 않아요. 다시 보내 보세요.", "err"); return; }
      wait.textContent = "그린이 " + WAIT[Math.min(Math.floor(s / 15), WAIT.length - 1)] + "… " + s + "초";
    }
    tick(); waitTimer = setInterval(tick, 1000);
  }
  function hideWait() { clearInterval(waitTimer); if (wait) wait.remove(); wait = null; }

  // The SDK's message: { message, source: "user" | "ai" } (some builds use role). Typed messages are shown when sent, so only spoken ones are added here.
  function onMessage(m) {
    var text = m && (m.message || m.text), from = m && (m.source || m.role);
    if (!text) return;
    if (from === "user") { if (mode === "voice") bubbleMe(text); return; }
    hideWait(); bubbleGreen(text);
    // Green may have just made a draft or a report.
    clearTimeout(refreshTimer); refreshTimer = setTimeout(function () { loadCampaigns(); loadReports(); }, 1200);
  }

  function ui() {
    var v = $("gVoice");
    v.textContent = mode === "voice" ? "■ 음성 끝내기" : "🎙 음성으로 대화";
    v.classList.toggle("on", mode === "voice");
    $("gVoiceState").textContent = mode === "voice" ? "듣는 중…" : "";
  }

  function start(m) {
    if (starting) return starting;
    starting = Promise.all([loadSdk(), A.api("api/green?do=session")]).then(function (r) {
      var opts = {
        signedUrl: r[1].signed_url, connectionType: "websocket",
        onMessage: onMessage,
        onError: function (e) { hideWait(); note("그린 연결 오류: " + (e && e.message ? e.message : e), "err"); },
        onDisconnect: function () {
          var was = mode; conv = null; mode = null; ui(); hideWait();
          if (was) note("대화가 끝났어요. 다시 보내면 새 대화를 시작합니다.");
          setTimeout(loadChats, 3000);
        },
        onModeChange: function (x) { if (mode === "voice") $("gVoiceState").textContent = x && x.mode === "speaking" ? "그린이 말하는 중…" : "듣는 중…"; }
      };
      if (m === "text") { opts.textOnly = true; opts.overrides = { conversation: { textOnly: true } }; }
      return r[0].Conversation.startSession(opts);
    }).then(function (c) { conv = c; mode = m; ui(); starting = null; return c; }, function (err) { starting = null; throw err; });
    return starting;
  }
  function endSession() {
    var c = conv; conv = null; mode = null; ui();
    if (c) { try { c.endSession(); } catch (e) {} }
  }

  function send(text) {
    text = String(text || "").trim();
    if (!text) return;
    if (!ready) { loadStatus(); alert("ELEVENLABS_API_KEY가 설정되지 않아 그린이 대답할 수 없습니다. 위 안내를 확인하세요."); return; }
    if (viewing) { $("gLog").innerHTML = ""; viewing = false; markChat(); }
    $("gMsg").value = ""; $("gMsg").style.height = "";
    bubbleMe(text); showWait();
    (conv ? Promise.resolve(conv) : start("text")).then(function (c) { c.sendUserMessage(text); })
      .catch(function (err) { hideWait(); noTables(err); note(err.message, "err"); $("gMsg").value = text; });
  }
  $("gForm").addEventListener("submit", function (e) { e.preventDefault(); send($("gMsg").value); });
  $("gMsg").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($("gMsg").value); } });
  $("gMsg").addEventListener("input", function () { this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 200) + "px"; });

  $("gVoice").addEventListener("click", function () {
    if (mode === "voice") { endSession(); return; }
    if (!ready) { loadStatus(); alert("ELEVENLABS_API_KEY가 설정되지 않아 그린이 대답할 수 없습니다."); return; }
    endSession();
    if (viewing) { $("gLog").innerHTML = ""; viewing = false; markChat(); }
    var b = this; b.disabled = true;
    note("마이크를 켜는 중… 브라우저가 물어보면 허용을 눌러 주세요.");
    start("voice").catch(function (err) { note(err && err.name === "NotAllowedError" ? "마이크 사용이 막혀 있어요. 주소창의 자물쇠 → 마이크 허용을 눌러 주세요." : err.message, "err"); })
      .then(function () { b.disabled = false; });
  });

  // ---------- past conversations (kept by ElevenLabs, read only) ----------
  function markChat() { document.querySelectorAll("#gChats li").forEach(function (li) { li.classList.toggle("on", viewing && li.getAttribute("data-id") === viewId); }); }
  function loadChats() {
    return A.api("api/green?do=chats").then(function (j) {
      var ul = $("gChats"); ul.innerHTML = "";
      j.chats.forEach(function (c) {
        var li = el("li"); li.setAttribute("data-id", c.id);
        var b = el("button", c.title, "open"); b.type = "button"; b.title = (c.at ? A.stamp(c.at) : "") + (c.messages ? " · 메시지 " + c.messages + "개" : "");
        b.addEventListener("click", function () { openChat(c.id); });
        li.appendChild(b); ul.appendChild(li);
      });
      if (!j.chats.length) ul.appendChild(el("li", "아직 대화가 없습니다.", "hint"));
      markChat();
    }).catch(function (err) { $("gChats").innerHTML = ""; $("gChats").appendChild(el("li", err.message, "hint")); });
  }
  function openChat(id) {
    endSession(); hideWait();
    viewing = true; viewId = id; markChat();
    $("gLog").innerHTML = ""; note("불러오는 중…");
    A.api("api/green?do=chat&id=" + encodeURIComponent(id)).then(function (j) {
      $("gLog").innerHTML = "";
      note("지난 대화예요. 여기서 보내면 새 대화로 시작합니다.");
      j.transcript.forEach(function (m) { if (m.role === "me") bubbleMe(m.text); else bubbleGreen(m.text); });
    }).catch(function (err) { $("gLog").innerHTML = ""; note(err.message, "err"); });
  }
  function welcome() {
    var log = $("gLog"); log.innerHTML = "";
    var w = el("div", null, "g-welcome");
    w.appendChild(el("p", "안녕하세요, 그린이에요. 예약·고객·웹사이트 데이터와 경쟁 업체 웹사이트를 보고 마케팅을 같이 고민할게요. 글로 물어보시거나 🎙 버튼으로 말로 물어보세요. 문자와 팝업은 초안까지 만들어 두면 아래 캠페인에서 확인하고 직접 보내시면 돼요."));
    var chips = el("div", null, "g-chips");
    STARTERS.forEach(function (t) { var b = el("button", t); b.type = "button"; b.addEventListener("click", function () { send(t); }); chips.appendChild(b); });
    w.appendChild(chips); log.appendChild(w);
  }
  $("gNew").addEventListener("click", function () { endSession(); hideWait(); viewing = false; markChat(); welcome(); $("gMsg").focus(); });

  // ---------- campaigns ----------
  function num(label, value) { var d = el("div"); d.append(el("b", value == null ? "—" : String(value)), el("span", label)); return d; }
  function field(label, input) { var l = el("label", label); l.appendChild(input); return l; }
  function input(value, max) { var i = el("input"); i.value = value || ""; if (max) i.maxLength = max; return i; }
  function btn(text, cls, fn) { var b = el("button", text, "small-btn" + (cls ? " " + cls : "")); b.type = "button"; b.addEventListener("click", fn); return b; }

  function act(c, msg, path, body, okText) {
    msg.className = "msg"; msg.textContent = "처리 중…";
    return A.api("api/green?do=" + path + "&ref=" + c.ref, { method: path === "campaign" ? "PATCH" : "POST", body: body || {} }).then(function (j) {
      msg.className = "msg ok"; msg.textContent = typeof okText === "function" ? okText(j) : okText;
      return j;
    }).catch(function (err) { msg.className = "msg err"; msg.textContent = err.message; throw err; });
  }

  function campCard(c) {
    var card = el("div", null, "g-camp" + (c.status === "draft" ? " draft" : "")), msg = el("p", "", "msg");
    card.setAttribute("data-ref", c.ref);
    var head = el("div", null, "g-camp-head"), st = STATUS[c.status] || [c.status, ""];
    head.append(el("b", c.name), A.pill(c.kind === "sms" ? "문자" : "팝업"), A.pill(st[0], st[1]));
    if (c.promo_code) head.appendChild(A.pill(c.promo_code + " · " + c.percent_off + "%" + (c.promo_active ? "" : " (꺼짐)"), c.promo_active ? "ok" : ""));
    card.appendChild(head);
    var dates = (c.starts_on || c.ends_on) ? (c.starts_on || "") + " – " + (c.ends_on || "") : "";

    if (c.kind === "sms") {
      card.appendChild(el("p", "대상: " + audienceText(c.audience) + (c.reachable != null ? " · 지금 " + c.reachable + "명" : ""), "hint"));
      var text;
      if (c.status === "draft") {
        text = el("textarea"); text.value = c.content.text; text.maxLength = 600;
        card.appendChild(field("문자 내용 ({name} = 이름, {link} = 예약 링크)", text));
      }
      var pv = el("div", c.preview, "preview");
      card.appendChild(field("보낼 문자 (예: 이름이 Alex일 때)", pv));
      card.appendChild(el("p", c.chars + "자 · " + c.encoding + " · 1명당 " + c.segments + "건" + (c.encoding === "UCS-2" ? " (한글·이모지는 70자마다 1건)" : ""), "hint"));
      if (c.status !== "draft") {
        var s = c.stats || {}, nums = el("div", null, "nums");
        nums.append(num("보냄" + (s.failed ? " (실패 " + s.failed + ")" : ""), s.sent || 0), num("링크 방문 (" + (c.visit_rate_pct || 0) + "%)", c.visits), num("예약 · $" + c.revenue, c.bookings));
        card.appendChild(nums);
      }
      var row = el("div", null, "row");
      if (c.status === "draft") {
        row.appendChild(btn("저장", "", function () {
          act(c, msg, "campaign", { text: text.value }, function (j) { pv.textContent = j.preview; return "저장했습니다. " + j.chars + "자, 1명당 " + j.segments + "건."; });
        }));
        row.appendChild(btn("테스트 문자", "", function () {
          var phone = prompt("테스트 문자를 받을 번호 (예: 437-655-4161)", localStorage.getItem("gg.testPhone") || "");
          if (!phone) return;
          try { localStorage.setItem("gg.testPhone", phone); } catch (e) {}
          act(c, msg, "test", { phone: phone }, "테스트 문자를 보냈습니다. 휴대폰에서 확인하세요.").catch(function () {});
        }));
        row.appendChild(btn("보내기", "", function () {
          if (!c.reachable) { msg.className = "msg err"; msg.textContent = "받을 사람이 없습니다 (문자 수신에 동의한 고객만 받습니다)."; return; }
          if (text.value.trim() !== c.content.text.trim()) { msg.className = "msg err"; msg.textContent = "고친 내용을 먼저 저장하세요."; return; }
          if (!confirm(c.reachable + "명에게 이 문자를 보냅니다. 보낸 문자는 되돌릴 수 없습니다.\n\n" + c.preview)) return;
          act(c, msg, "send", {}, function (j) { return j.sent + "명에게 보냈습니다" + (j.failed ? ", 실패 " + j.failed + "건 (" + j.errors.join(" / ") + ")" : "") + (j.left ? ". 남은 " + j.left + "명은 보내기를 한 번 더 누르세요." : "."); })
            .then(function () { setTimeout(loadCampaigns, 1500); }).catch(function () {});
        }));
        row.appendChild(btn("삭제", "danger", function () {
          if (!confirm("이 초안을 지울까요?")) return;
          A.api("api/green?do=campaign&ref=" + c.ref, { method: "DELETE" }).then(loadCampaigns).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
        }));
      } else if (c.status === "sent" && c.promo_active) {
        row.appendChild(btn("할인 코드 끄기", "", function () { if (confirm(c.promo_code + " 코드를 더 이상 못 쓰게 할까요?")) act(c, msg, "end", {}, "할인 코드를 껐습니다.").then(loadCampaigns).catch(function () {}); }));
      }
      card.appendChild(row);
    } else {
      var t = input(c.content.title, 80), b = el("textarea"), cta = input(c.content.cta, 30), from = input(c.starts_on), to = input(c.ends_on);
      b.value = c.content.body; b.maxLength = 300; from.type = to.type = "date";
      var draft = c.status === "draft";
      [t, b, cta, from, to].forEach(function (x) { x.disabled = !draft; });
      card.append(field("제목", t), field("본문", b), field("버튼", cta));
      var dr = el("div", null, "grid2"); dr.append(field("시작일", from), field("종료일", to)); card.appendChild(dr);
      card.appendChild(el("p", "보이는 페이지: " + (c.content.pages || []).map(function (p) { return PAGE[p] || p; }).join(", "), "hint"));
      if (c.status !== "draft") {
        var nums2 = el("div", null, "nums");
        nums2.append(num("노출", c.popup_views), num("클릭 (" + (c.click_rate_pct || 0) + "%)", c.popup_clicks), num("예약 · $" + c.revenue, c.bookings));
        card.appendChild(nums2);
      }
      var row2 = el("div", null, "row");
      function data() { return { ref: c.ref, title: t.value, body: b.value, cta: cta.value, ends_on: to.value || null, promo: c.promo_code ? { code: c.promo_code, percent_off: c.percent_off } : null }; }
      row2.appendChild(btn("미리보기", "", function () { GG.popup(data(), { preview: true }); }));
      if (draft) {
        row2.appendChild(btn("저장", "", function () {
          act(c, msg, "campaign", { content: { title: t.value, body: b.value, cta: cta.value }, starts_on: from.value, ends_on: to.value }, "저장했습니다.").catch(function () {});
        }));
      }
      if (draft || c.status === "ended") {
        row2.appendChild(btn("사이트에 게시", "", function () {
          var go = function () { act(c, msg, "publish", {}, "게시했습니다. 방문자에게 한 번씩 보입니다.").then(loadCampaigns).catch(function () {}); };
          if (!draft) return confirm("이 팝업을 다시 게시할까요?") && go();
          // Save what is on screen first, so the published popup is what the admin sees.
          A.api("api/green?do=campaign&ref=" + c.ref, { method: "PATCH", body: { content: { title: t.value, body: b.value, cta: cta.value }, starts_on: from.value, ends_on: to.value } })
            .then(function () { if (confirm("이 팝업을 웹사이트에 게시할까요?" + (c.promo_code ? "\n할인 코드 " + c.promo_code + "도 함께 켜집니다." : ""))) go(); })
            .catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
        }));
      }
      if (c.status === "active") row2.appendChild(btn("내리기", "danger", function () { if (confirm("팝업을 내릴까요? 할인 코드도 꺼집니다.")) act(c, msg, "end", {}, "내렸습니다.").then(loadCampaigns).catch(function () {}); }));
      if (draft) row2.appendChild(btn("삭제", "danger", function () {
        if (!confirm("이 초안을 지울까요?")) return;
        A.api("api/green?do=campaign&ref=" + c.ref, { method: "DELETE" }).then(loadCampaigns).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
      }));
      card.appendChild(row2);
    }
    if (dates && c.kind === "sms") card.appendChild(el("p", "할인 기간: " + dates, "hint"));
    card.appendChild(el("p", "만든 날 " + A.stamp(c.created).slice(0, 6) + (c.sent_at ? " · " + (c.kind === "sms" ? "보낸" : "게시한") + " 날 " + A.stamp(c.sent_at).slice(0, 6) : "") + " · " + c.ref, "hint"));
    card.appendChild(msg);
    return card;
  }

  function loadCampaigns() {
    var box = $("gCamps");
    return A.api("api/green?do=campaigns").then(function (j) {
      box.innerHTML = "";
      j.campaigns.forEach(function (c) { box.appendChild(campCard(c)); });
      if (!j.campaigns.length) box.appendChild(el("p", "아직 캠페인이 없습니다. 그린에게 \"휴면 고객 문자 만들어줘\"처럼 부탁해 보세요.", "hint"));
    }).catch(function (err) { noTables(err); box.innerHTML = ""; box.appendChild(el("p", err.message, "hint")); });
  }
  $("gCampReload").addEventListener("click", loadCampaigns);

  // ---------- reports ----------
  var report = null;
  function loadReports() {
    return A.api("api/green?do=reports").then(function (j) {
      var ul = $("gReports"); ul.innerHTML = "";
      j.reports.forEach(function (r) {
        var li = el("li"), b = el("button", r.title, "open"); b.type = "button"; b.title = A.stamp(r.created_at);
        b.addEventListener("click", function () { openReport(r.id); });
        li.appendChild(b); ul.appendChild(li);
      });
      if (!j.reports.length) ul.appendChild(el("li", "그린에게 리포트를 부탁하면 여기 저장됩니다.", "hint"));
    }).catch(function () {});
  }
  function openReport(id) {
    A.api("api/green?do=report&id=" + id).then(function (r) {
      report = r;
      $("gReportTitle").textContent = r.title;
      $("gReportBody").innerHTML = md(r.body);
      $("gReport").showModal();
    }).catch(function (err) { alert(err.message); });
  }
  function fileName(r, ext) { return "gutta-" + r.created_at.slice(0, 10) + "-" + r.title.replace(/[^\w가-힣]+/g, "-").slice(0, 40) + ext; }
  $("gReportClose").addEventListener("click", function () { $("gReport").close(); });
  $("gReportMd").addEventListener("click", function () { A.download(fileName(report, ".md"), "# " + report.title + "\n\n" + report.body, "text/markdown;charset=utf-8"); });
  $("gReportPrint").addEventListener("click", function () {
    var w = window.open("", "_blank");
    if (!w) { alert("팝업 차단을 풀어 주세요."); return; }
    w.document.write('<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>' + esc(report.title) + "</title><style>" +
      "body{font:15px/1.6 system-ui,-apple-system,'Malgun Gothic',sans-serif;color:#14211B;max-width:780px;margin:32px auto;padding:0 20px}" +
      "h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:22px 0 8px}h3,h4{font-size:15px;margin:16px 0 6px}" +
      "table{border-collapse:collapse;margin:0 0 14px;font-size:13px}th,td{border:1px solid #ccd;padding:5px 9px;text-align:left;vertical-align:top}th{background:#f2f4f2}" +
      "blockquote{margin:0 0 10px;padding-left:12px;border-left:3px solid #D9AE2E;color:#555}.meta{color:#666;font-size:13px;margin-bottom:20px}a{color:#1F5A43}" +
      "</style></head><body><h1>" + esc(report.title) + '</h1><p class="meta">Gutta Golf · 그린 리포트 · ' + esc(A.stamp(report.created_at)) + "</p>" + md(report.body) + "</body></html>");
    w.document.close(); w.focus(); setTimeout(function () { w.print(); }, 300);
  });
  $("gReportDel").addEventListener("click", function () {
    if (!confirm("이 리포트를 지울까요?")) return;
    A.api("api/green?do=report&id=" + report.id, { method: "DELETE" }).then(function () { $("gReport").close(); loadReports(); }).catch(function (e) { alert(e.message); });
  });

  // ---------- tab and floating button ----------
  var started = false;
  A.loaders.green = function () {
    loadStatus(); loadChats(); loadCampaigns(); loadReports();
    if (!started) { started = true; welcome(); }
  };
  function fab() {
    var here = (location.hash || "#dashboard") === "#green";
    $("gFab").hidden = here;
    if (!here && mode === "voice") endSession();     // don't keep the mic open on other tabs
  }
  window.addEventListener("hashchange", fab);
  fab();
})();
