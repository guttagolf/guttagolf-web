// Green (그린): the admin's marketing assistant, run as an ElevenLabs agent (text chat and voice).
// The agent calls our data through webhook tools (POST /api/green?do=tool&name=…, api/_marketing.js), authenticated with a key
// kept as an ElevenLabs workspace secret. Green only writes drafts and reports; texts are sent and popups published by the admin.
// Env: ELEVENLABS_API_KEY (required), GREEN_LLM (default claude-sonnet-5-5, any ElevenLabs agent LLM id), GREEN_VOICE_ID (optional),
//      SITE_URL (the public https address ElevenLabs calls back; defaults to the address the admin set Green up from).
// The agent, tool and secret ids are kept in the app_settings table under "green".
// Files starting with "_" are helpers, not API routes.
const crypto = require("crypto");
const P = require("../pricing.js");
const db = require("./_db.js");
const M = require("./_marketing.js");
const { torontoNow } = require("./_booking.js");

const API = "https://api.elevenlabs.io";
const VERSION = 2;             // bump when the prompt or tools change, so the admin page offers to update the agent

function configured() { return !!process.env.ELEVENLABS_API_KEY; }
function llm() { return /^[\w.-]{2,60}$/.test(process.env.GREEN_LLM || "") ? process.env.GREEN_LLM : "claude-sonnet-5-5"; }

// One ElevenLabs REST call. Throws an Error with the status and ElevenLabs' message.
async function xi(path, opts) {
  const o = opts || {};
  const r = await fetch(API + path, {
    method: o.method || "GET",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, ...(o.body ? { "Content-Type": "application/json" } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { detail: text.slice(0, 300) }; }
  if (!r.ok) {
    const d = data && data.detail, msg = typeof d === "string" ? d : d && d.message ? d.message : JSON.stringify(d || data).slice(0, 400);
    const err = new Error(`ElevenLabs ${r.status}: ${msg}`); err.status = r.status; err.eleven = true;
    throw err;
  }
  return data;
}

// ---------- settings ----------
async function settings() {
  const rows = await db.rest("app_settings?select=value&key=eq.green");
  return rows.length ? rows[0].value : {};
}
async function saveSettings(value) {
  await db.rest("app_settings?on_conflict=key", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: { key: "green", value, updated_at: new Date().toISOString() } });
}

// The key ElevenLabs sends in x-green-key when it calls our tools. Derived from server secrets, so it is never stored here.
function toolKey() {
  return crypto.createHmac("sha256", "gg-green-tools|" + (process.env.SUPABASE_SERVICE_ROLE_KEY || "") + "|" + (process.env.ADMIN_PASSWORD || "")).update("v1").digest("hex");
}
function keyHash() { return crypto.createHash("sha256").update(toolKey()).digest("hex").slice(0, 16); }
function toolKeyOk(req) {
  const got = String(req.headers["x-green-key"] || "");
  const a = crypto.createHash("sha256").update(got).digest(), b = crypto.createHash("sha256").update(toolKey()).digest();
  return !!got && crypto.timingSafeEqual(a, b);
}

// ---------- prompt ----------
const r = P.RATES;
const PROMPT = `너는 "그린"이야. 토론토 노스요크의 실내 골프 시뮬레이터 업체 Gutta Golf의 마케팅 비서이고, 관리자 사이트 안에서 사장님(Jason)과 대화해.
사장님은 혼자 사업과 웹사이트를 운영해. 사장님이 한국어로 말하면 한국어로, 영어로 말하면 영어로 답해. 손님에게 나갈 문구(문자, 웹사이트 팝업)는 따로 요청이 없으면 영어로 써.

# 업체 정보
- 주소: 244 Lesmill Rd, North York, ON M3B (Don Mills 지역, 401·DVP 근처). 전화 437-655-4161, 인스타 @guttagolf.ca
- 개인 베이 8개 (SG Golf 시뮬레이터), 베이당 최대 4명. 베이 1·7·8은 오른손잡이 전용, 2–6은 양손.
- 영업: 오전 9시 – 자정, 심야 자정 – 오전 6시(당일 오후 9시까지 예약해야 함). 오전 6–9시 휴무. 온라인 예약은 7일 앞까지, 15분 단위, 최소 30분.
- 요금 (베이 1개 1시간, HST 13% 별도):
  - 겨울 11/1–4/30: 평일 $${r.winter.day}, 평일 저녁(오후 ${r.eveFrom % 12}시–) $${r.winter.eve}, 주말·공휴일 $${r.winter.weekend}, 심야 $${r.winter.late}
  - 여름 5/1–10/31: 평일 낮 $${r.summer.day}, 평일 저녁 $${r.summer.eve}, 주말·공휴일 $${r.summer.weekend}, 심야 $${r.summer.late}
- 사장님이 직접 레슨함. 결제는 온라인(Stripe) 또는 현장(카드·현금).
- 가장 가까운 경쟁 업체: Tracer Golf Toronto North (150 Lesmill Rd, 약 400m).

# 데이터와 도구
- 우리 데이터: booking_stats(예약·매출·가동률), customer_analysis(지역·나이·성별·고객 등급), site_analytics(웹사이트 방문·팝업), campaign_results(캠페인 성과), audience_preview(문자 대상 수).
- 모든 도구 결과의 today가 오늘 날짜(토론토)야. 날짜를 계산할 때 이걸 기준으로 해.
- 너에게는 웹 검색이 없어. 경쟁 업체는 read_webpage로 그 업체 웹사이트(요금·영업시간 페이지)를 직접 읽어서 조사해. 주소를 모르면 추측하지 말고 사장님께 웹사이트 주소를 물어봐. 읽은 페이지 주소와 날짜를 출처로 적어.
- 이 예약 시스템은 2026년 10월 말에 시작해서 데이터가 적을 수 있어. 숫자는 반드시 도구 결과에서만 가져오고, 데이터가 부족하면 그렇다고 말해. 추정은 추정이라고 밝혀.
- 지역·나이·성별은 고객이 예약할 때 선택해서 적는 항목이라 비어 있는 고객이 많을 수 있어. data_coverage_pct를 보고 분석의 한계를 말해줘.
- 지역은 캐나다 우편번호 앞 3자리(FSA)야. 확실하지 않은 동네 이름은 쓰지 말고 코드만 적어.
- 도구 결과에는 전화번호가 없어. 개인 연락처를 묻거나 추측하지 마.

# 프로모션·문자·팝업
- 제안은 가동률이 낮은 시간대(rate_band, hour, weekday)와 고객 등급(new, one_time, regular, vip, lapsed)을 근거로 해. 할인은 최대 50%이고 보통 10–25%가 적당해. 할인은 HST 전 금액에 적용돼.
- 할인을 넣으려면 promo로 코드(영문 대문자·숫자 3–16자), 할인율, 종료일을 함께 만들어. 코드는 캠페인을 보내거나 게시할 때 켜져.
- 문자 초안(create_sms_draft): 짧게, 가능하면 160자(1건) 안에. {name}은 손님 이름, {link}는 예약 링크로 바뀌어. 앞의 "Gutta Golf:"와 끝의 "Reply STOP to opt out."은 없으면 자동으로 붙어(캐나다 CASL). 한글 문자는 70자마다 1건이라 비용이 늘어난다고 알려줘.
  문자는 수신 동의한 고객에게만 가고, 오전 9시–오후 9시에만 보낼 수 있어. 초안을 만들기 전에 audience_preview로 대상 수를 확인해.
- 팝업 초안(create_popup_draft): 제목은 짧고 분명하게, 본문 1–2문장, 버튼 문구 하나.
- 너는 초안만 만들어. 실제 발송·게시는 사장님이 그린 화면의 캠페인 목록에서 확인하고 직접 해. 보냈다고 말하지 마.

# 분석 자료
- 사장님이 리포트·분석 자료를 원하면: 한 줄 요약 → 핵심 숫자 표 → 발견한 점 → 실행할 일(우선순위, 예상 효과) → 다음에 확인할 지표 순서로 Markdown으로 쓰고 save_report로 저장해. 저장하면 그린 화면의 리포트 목록에서 보고 인쇄·내려받기 할 수 있어.

# 말투
- 글로 대화할 때는 Markdown 표와 목록을 써도 돼. 군더더기 없이 핵심 위주로.
- 음성으로 대화할 때는 표나 기호를 읽지 말고 2–4문장으로 짧게 말해. 자세한 숫자는 리포트로 저장해 두겠다고 제안해.`;

// ---------- tools ----------
// Webhook body schemas: every property gets a description so the LLM fills it in. Allowed values are listed in the text.
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const arr = (description, item) => ({ type: "array", description, items: str(item) });
const obj = (description, properties, required) => ({ type: "object", description, properties, required: required || [] });
const DATE = (what) => str(`${what} date, YYYY-MM-DD in Toronto. Leave empty for the default (last 30 days).`);
const PROMO = obj("Optional discount code for this campaign. Leave out for no discount.", {
  code: str("3–16 capital letters or digits, e.g. AM20"),
  percent_off: num("Whole number from 1 to 50"),
  starts_on: str("Optional first day, YYYY-MM-DD"),
  ends_on: str("Last day the code works, YYYY-MM-DD")
}, ["code", "percent_off"]);
const AUDIENCE = obj("Who gets the text. Empty object means every customer who agreed to marketing texts. Filters combine with AND.", {
  segments: arr("Customer segments to include", "One of: new, one_time, regular, vip, lapsed"),
  regions: arr("Postal code prefixes to include", "e.g. M3B or M3"),
  age_bands: arr("Age bands to include", "One of: under18, 18-24, 25-34, 35-44, 45-54, 55-64, 65plus"),
  genders: arr("Genders to include", "One of: female, male, other, na"),
  min_bookings: num("Only customers with at least this many bookings"),
  last_visit_within_days: num("Only customers whose last visit was within this many days"),
  last_visit_more_than_days: num("Only customers whose last visit was more than this many days ago")
});

const TOOLS = [
  ["booking_stats", "Confirmed bookings in a date range, grouped one way: bookings, booked hours, revenue (CAD before HST, after discounts), unique customers and utilization % (booked bay-hours / open bay-hours). Use hour or rate_band to find quiet times, campaign or promo to see what promotions brought in.", {
    from: DATE("First"), to: DATE("Last"),
    group_by: str("One of: " + M.BOOKING_GROUPS.join(", "))
  }, ["group_by"]],
  ["customer_analysis", "Customers grouped by region (postal FSA), area (first 2 postal characters), age_band, gender, segment (new / one_time / regular / vip / lapsed / no_booking), sms_opt_in or first_month; optionally crossed with a second dimension. Bookings and revenue count the date range. Also returns how many customers have each field filled in. top adds the best customers by spend (first name and initial only).", {
    dimension: str("One of: " + M.CUSTOMER_DIMS.join(", ")),
    by: str("Optional second dimension, same choices as dimension. Leave empty for none."),
    from: DATE("First"), to: DATE("Last"),
    top: num("Optional: how many top customers to list, 1–25. Leave out for none.")
  }, ["dimension"]],
  ["site_analytics", "Website traffic from our own tracking: page views, unique visitors, sessions, booking page sessions, bookings finished on the site, popup views / clicks / closes.", {
    from: DATE("First"), to: DATE("Last"),
    group_by: str("One of: " + M.SITE_GROUPS.join(", "))
  }, ["group_by"]],
  ["campaign_results", "Every text campaign and website popup (newest first) with status, content, promo code and results: texts sent, visits from its link, popup views and clicks, bookings, revenue and discount credited to it.", {
    ref: str("Optional campaign ref (sms-… or pop-…) for just one campaign. Leave empty for all.")
  }, []],
  ["audience_preview", "How many customers a text audience reaches (only customers who agreed to marketing texts), split by segment, age band and gender. Check this before drafting a text.", {
    audience: AUDIENCE
  }, ["audience"]],
  ["create_sms_draft", "Saves a marketing text as a DRAFT for the owner to review, test and send from the Green screen. Does not send anything. Use {name} and {link} in the text. Returns the final preview, character and segment count and audience size.", {
    name: str("Short internal name, Korean is fine"),
    text: str("The text message. Customer-facing, English unless the owner asked otherwise."),
    audience: AUDIENCE, promo: PROMO
  }, ["name", "text", "audience"]],
  ["create_popup_draft", "Saves a website popup as a DRAFT for the owner to publish from the Green screen. Customer-facing English. The button opens the booking page with the promo code filled in.", {
    name: str("Short internal name, Korean is fine"),
    title: str("Headline, up to about 60 characters"),
    body: str("1–2 sentences, up to about 200 characters"),
    cta: str("Button text, e.g. Book a bay"),
    pages: arr("Pages to show it on. Empty for all pages.", "One of: " + M.PAGES.join(", ")),
    starts_on: str("Optional first day, YYYY-MM-DD"),
    ends_on: str("Optional last day, YYYY-MM-DD"),
    promo: PROMO
  }, ["name", "title", "body", "cta"]],
  ["save_report", "Saves an analysis report (Markdown) to the report list on the Green screen, where the owner can read, print and download it.", {
    title: str("Report title in Korean"),
    markdown: str("The whole report in Markdown")
  }, ["title", "markdown"]],
  ["read_webpage", "Reads a public web page and returns its text, e.g. a competitor's rates or hours page. There is no web search: use a website address you know or the owner gave you.", {
    url: str("Full address, e.g. https://example.com/rates")
  }, ["url"]]
];

// Numbers from the LLM can arrive as 3.0 or "3"; the marketing code wants whole numbers.
function ints(x, keys) { keys.forEach((k) => { if (x && x[k] != null && x[k] !== "") x[k] = Math.round(+x[k]); else if (x) delete x[k]; }); return x; }

// Runs one tool for the agent. Returns the JSON to send back.
async function runTool(name, input) {
  const x = input && typeof input === "object" ? input : {};
  if (x.audience) ints(x.audience, ["min_bookings", "last_visit_within_days", "last_visit_more_than_days"]);
  if (x.promo) { ints(x.promo, ["percent_off"]); if (!x.promo.code) delete x.promo; }
  const today = torontoNow().key;
  let out;
  switch (name) {
    case "booking_stats": out = await M.bookingStats(x); break;
    case "customer_analysis": out = await M.customerAnalysis(ints(x, ["top"])); break;
    case "site_analytics": out = await M.siteAnalytics(x); break;
    case "campaign_results": out = { campaigns: await M.campaignResults(x.ref) }; break;
    case "audience_preview": out = await M.audiencePreview(x.audience); break;
    case "create_sms_draft": out = await M.createSmsDraft(x, "green"); break;
    case "create_popup_draft": out = await M.createPopupDraft(x, "green"); break;
    case "save_report": { const rep = await M.saveReport(x.title, x.markdown); out = { saved: true, id: rep.id, title: rep.title }; break; }
    case "read_webpage": out = await M.readPage(x.url); break;
    default: throw new Error("Unknown tool " + name);
  }
  return { today, ...out };
}

// ---------- setting the agent up ----------
// Creates (or updates) the secret, the webhook tools and the agent. Tools are made fresh each time and the old ones removed.
async function setup(origin) {
  const base = String(process.env.SITE_URL || origin || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) {
    const err = new Error("그린 설정은 배포된 https 사이트(Vercel)에서 해야 합니다. 일레븐랩스가 인터넷으로 우리 서버를 불러야 하기 때문입니다."); err.status = 400; throw err;
  }
  const s = await settings();

  let secretId = s.secret_id;
  if (!secretId || s.key_hash !== keyHash()) {
    secretId = (await xi("/v1/convai/secrets", { method: "POST", body: { type: "new", name: "gutta-green-tools-" + Date.now(), value: toolKey() } })).secret_id;
  }

  const toolIds = [];
  for (const t of TOOLS) toolIds.push((await xi("/v1/convai/tools", { method: "POST", body: { tool_config: toolConfig(t, base, { secret_id: secretId }) } })).id);

  let agentId = s.agent_id;
  try {
    if (agentId) await xi(`/v1/convai/agents/${agentId}`, { method: "PATCH", body: agentBody(toolIds) });
  } catch (err) { if (err.status !== 404) throw err; agentId = null; }
  if (!agentId) agentId = (await xi("/v1/convai/agents/create", { method: "POST", body: agentBody(toolIds) })).agent_id;

  for (const old of s.tool_ids || []) { try { await xi(`/v1/convai/tools/${old}?force=true`, { method: "DELETE" }); } catch (e) { /* an old tool left behind does no harm */ } }
  const value = { agent_id: agentId, tool_ids: toolIds, secret_id: secretId, key_hash: keyHash(), base, llm: llm(), version: VERSION, at: new Date().toISOString() };
  await saveSettings(value);
  return value;
}

// One webhook tool: ElevenLabs POSTs the inputs as JSON to /api/green?do=tool&name=…, with our key in x-green-key.
function toolConfig([name, description, properties, required], base, key) {
  return {
    type: "webhook", name, description, response_timeout_secs: 30,
    api_schema: {
      url: `${base}/api/green?do=tool&name=${name}`, method: "POST", content_type: "application/json",
      request_headers: { "x-green-key": key },
      request_body_schema: { type: "object", description: "Tool input", properties, required }
    }
  };
}

function agentBody(toolIds) {
  return {
    name: "Gutta Golf 그린 (관리자 마케팅 비서)",
    tags: ["gutta-green"],
    conversation_config: {
      agent: {
        first_message: "안녕하세요, 그린이에요. 무엇을 분석해 드릴까요?",
        language: "ko",
        // language_detection lets Green switch to English mid-conversation when the owner speaks it.
        prompt: {
          prompt: PROMPT, llm: llm(), tool_ids: toolIds,
          built_in_tools: { language_detection: { type: "system", name: "language_detection", description: "", params: { system_tool_type: "language_detection" } } }
        }
      },
      // Korean is the default; English is the one other language Green understands and speaks.
      language_presets: { en: { overrides: { agent: { language: "en", first_message: "Hi, I'm Green. What would you like me to look into?" } } } },
      tts: { model_id: "eleven_flash_v2_5", ...(process.env.GREEN_VOICE_ID ? { voice_id: process.env.GREEN_VOICE_ID } : {}) },
      conversation: { max_duration_seconds: 1800 }
    },
    // Only our admin page can start a conversation (signed URL), and it may start one as text only.
    platform_settings: { auth: { enable_auth: true }, overrides: { conversation_config_override: { conversation: { text_only: true } } } }
  };
}

// A one-time address the admin page connects to. Sets the agent up first if it has never been set up.
async function signedUrl(origin) {
  let s = await settings();
  if (!s.agent_id) s = await setup(origin);
  return (await xi(`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(s.agent_id)}`)).signed_url;
}

async function status() {
  const s = await settings().catch(() => ({}));
  return { agent: !!s.agent_id, outdated: !!s.agent_id && (s.version !== VERSION || s.llm !== llm() || s.key_hash !== keyHash()), llm: s.llm || llm(), at: s.at || null };
}

// Past conversations with Green, newest first, and one conversation's messages.
async function conversations() {
  const s = await settings();
  if (!s.agent_id) return [];
  const j = await xi(`/v1/convai/conversations?agent_id=${encodeURIComponent(s.agent_id)}&page_size=40`);
  return (j.conversations || []).map((c) => ({
    id: c.conversation_id, at: c.start_time_unix_secs ? new Date(c.start_time_unix_secs * 1000).toISOString() : null,
    title: c.call_summary_title || (c.transcript_summary || "").slice(0, 60) || "대화", messages: c.message_count, seconds: c.call_duration_secs
  }));
}
async function transcript(id) {
  if (!/^[\w-]{6,80}$/.test(String(id || ""))) { const err = new Error("대화를 찾지 못했습니다."); err.status = 400; throw err; }
  const j = await xi(`/v1/convai/conversations/${id}`);
  return (j.transcript || []).filter((t) => t.message).map((t) => ({ role: t.role === "user" ? "me" : "green", text: t.message }));
}

module.exports = { configured, llm, setup, signedUrl, status, conversations, transcript, runTool, toolKeyOk, VERSION, TOOLS, toolConfig, agentBody, xi };
