// Green tab in admin.html: Green itself (an ElevenLabs agent), the campaigns it drafts and the reports it saves.
// Every request needs the admin session cookie, except do=tool, which ElevenLabs calls with the x-green-key secret.
//   GET    /api/green?do=status                 →  { eleven, agent, outdated, llm, twilio, quiet }
//   POST   /api/green?do=setup                  →  creates or updates the ElevenLabs agent and its tools
//   GET    /api/green?do=session                →  { signed_url } to start a text or voice conversation from the browser
//   GET    /api/green?do=chats                  →  { chats } past conversations (kept by ElevenLabs)
//   GET    /api/green?do=chat&id=…              →  { transcript }
//   POST   /api/green?do=tool&name=…  { … }     ←  ElevenLabs, when Green uses a tool (api/_green.js)
//   GET    /api/green?do=campaigns              →  { campaigns } with results
//   PATCH  /api/green?do=campaign&ref=…  { name?, text?, content?, starts_on?, ends_on? }   (drafts only)
//   DELETE /api/green?do=campaign&ref=…         (drafts only)
//   POST   /api/green?do=test&ref=…  { phone }  →  sends one test text
//   POST   /api/green?do=send&ref=…             →  texts the campaign's audience
//   POST   /api/green?do=publish&ref=…  /  ?do=end&ref=…   →  puts a popup on the site / takes a campaign down
//   GET    /api/green?do=reports  /  ?do=report&id=…        DELETE /api/green?do=report&id=…
const auth = require("./_auth.js");
const db = require("./_db.js");
const M = require("./_marketing.js");
const G = require("./_green.js");

const ID = /^[0-9a-f-]{36}$/;

function origin(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${req.headers["x-forwarded-proto"] || (String(host).startsWith("localhost") ? "http" : "https")}://${host}`;
}

// ElevenLabs calling one of Green's tools. Errors go back to the agent as text so it can explain or try again.
async function tool(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!G.toolKeyOk(req)) return res.status(401).json({ error: "Bad key." });
  const name = String((req.query || {}).name || "");
  try {
    const out = await G.runTool(name, req.body);
    if (/^(create_|save_)/.test(name)) await db.log("marketing", { action: "green_draft", actor: "green", ref: out.ref || out.id, detail: { message: name + " " + (out.ref || out.title || "") } });
    return res.status(200).json(out);
  } catch (err) {
    console.error("Green tool failed:", name, err.message);
    return res.status(200).json({ error: String(err.message || err) });
  }
}

module.exports = async (req, res) => {
  if ((req.query || {}).do === "tool") return tool(req, res);
  const actor = auth.requireAdmin(req, res);
  if (!actor) return;
  if (!db.configured()) return res.status(503).json({ error: "Supabase 환경변수가 설정되지 않았습니다.", code: "not_configured" });

  const q = req.query || {}, ref = String(q.ref || ""), id = String(q.id || ""), m = req.method;
  const send = (status, data) => res.status(status).json(data);
  try {
    switch (`${m} ${q.do}`) {
      case "GET status":
        return send(200, { eleven: G.configured(), ...(await G.status()), twilio: M.twilioConfigured(), quiet: M.quietHours() });
      case "POST setup": {
        if (!G.configured()) return send(503, { error: "ELEVENLABS_API_KEY 환경변수가 없습니다.", code: "not_configured" });
        const s = await G.setup(origin(req));
        await db.log("marketing", { action: "green_setup", actor, ref: s.agent_id, req, detail: { message: s.llm } });
        return send(200, { ok: true, agent: s.agent_id, llm: s.llm });
      }
      case "GET session":
        if (!G.configured()) return send(503, { error: "ELEVENLABS_API_KEY 환경변수가 없어 그린을 쓸 수 없습니다.", code: "not_configured" });
        return send(200, { signed_url: await G.signedUrl(origin(req)) });
      case "GET chats":
        return send(200, { chats: G.configured() ? await G.conversations() : [] });
      case "GET chat":
        return send(200, { transcript: await G.transcript(id) });

      case "GET campaigns": {
        // Texts also get the final wording, and drafts how many people they would reach right now.
        const list = await M.campaignResults();
        await Promise.all(list.filter((c) => c.kind === "sms").map(async (c) => {
          c.preview = M.smsText(c, "Alex", origin(req));
          Object.assign(c, M.segments(c.preview));
          if (c.status === "draft") c.reachable = (await M.audiencePreview(c.audience)).reachable;
        }));
        return send(200, { campaigns: list });
      }
      case "PATCH campaign": {
        const c = await M.updateDraft(ref, req.body || {});
        return send(200, { campaign: c, preview: c.kind === "sms" ? M.smsText(c, "Alex", origin(req)) : null, ...(c.kind === "sms" ? M.segments(M.smsText(c, "Alex", origin(req))) : {}) });
      }
      case "DELETE campaign":
        await M.deleteDraft(ref);
        await db.log("marketing", { action: "campaign_delete", actor, ref, req });
        return send(200, { ok: true });
      case "POST test": {
        const r = await M.sendTest(ref, (req.body || {}).phone, origin(req));
        await db.log("marketing", { action: "sms_test", actor, ref, req, detail: { phone: (req.body || {}).phone } });
        return send(200, r);
      }
      case "POST send": {
        const r = await M.sendCampaign(ref, origin(req));
        await db.log("marketing", { action: "sms_send", ok: !r.failed, actor, ref, req, detail: { message: `보냄 ${r.sent}, 실패 ${r.failed}` + (r.left ? `, 남음 ${r.left}` : "") } });
        return send(200, r);
      }
      case "POST publish":
        await M.publishPopup(ref);
        await db.log("marketing", { action: "popup_publish", actor, ref, req });
        return send(200, { ok: true });
      case "POST end":
        await M.endCampaign(ref);
        await db.log("marketing", { action: "campaign_end", actor, ref, req });
        return send(200, { ok: true });

      case "GET reports":
        return send(200, { reports: await db.rest("green_reports?select=id,title,created_at&order=created_at.desc&limit=100") });
      case "GET report": {
        if (!ID.test(id)) return send(400, { error: "리포트를 찾지 못했습니다." });
        const row = (await db.rest(`green_reports?select=*&id=eq.${id}`))[0];
        return row ? send(200, row) : send(404, { error: "리포트를 찾지 못했습니다." });
      }
      case "DELETE report":
        if (!ID.test(id)) return send(400, { error: "리포트를 찾지 못했습니다." });
        await db.rest(`green_reports?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" });
        return send(200, { ok: true });
    }
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return send(400, { error: "알 수 없는 요청입니다." });
  } catch (err) {
    if (err.eleven) {
      console.error("ElevenLabs call failed:", err.message);
      return send(502, { error: err.status === 401 ? "ELEVENLABS_API_KEY가 맞지 않거나 권한이 부족합니다. " + err.message : "일레븐랩스 요청이 실패했습니다: " + err.message });
    }
    if (err.code === "PGRST205" || err.code === "PGRST204" || err.code === "42703" || /Could not find the (table|.*column)/.test(err.message)) {
      return send(503, { error: "마케팅 테이블이 아직 없습니다. Supabase → SQL Editor에서 supabase/schema.sql을 다시 실행하세요.", code: "no_tables" });
    }
    if (!err.status) return send(400, { error: err.message });   // our own checks (draft only, quiet hours, …)
    console.error("Green API failed:", err.message);
    await db.log("error", { action: "green_api", ok: false, actor, req, detail: { do: q.do, message: err.message } });
    return send(502, { error: "요청이 실패했습니다: " + err.message });
  }
};
