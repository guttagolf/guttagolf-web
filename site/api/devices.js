// Door and bay power through Shelly Cloud. Every request needs the admin session cookie from /api/login.
//   GET  /api/devices                                   →  { configured, devices: [{ key, label, kind }] }
//   GET  /api/devices?status=door                       →  { key, on } live relay state
//   POST /api/devices  { device: "door", action: "open" }            →  relay on, then off after the pulse
//   POST /api/devices  { device: "bay3", action: "on" | "off" }      →  bay power
// Env (Shelly app → User settings → Authorization cloud key):
//   SHELLY_SERVER    e.g. https://shelly-103-eu.shelly.cloud
//   SHELLY_AUTH_KEY  the cloud key
//   SHELLY_DEVICES   JSON: {"door": {"id": "a1b2c3d4e5f6", "channel": 0, "pulse": 3}, "bay1": "b1c2d3e4f5a6", …}
//                    a plain string is a device id on channel 0; "pulse" is seconds the door relay stays on (default 3)
// Shelly Cloud allows about one request per second, so "all bays" is done one bay at a time by the page.
const db = require("./_db.js");
const auth = require("./_auth.js");

const LABELS = { door: "정문" };
for (let i = 1; i <= 8; i++) LABELS["bay" + i] = "Bay " + i + " 시스템";

function devices() {
  let raw = {};
  try { raw = JSON.parse(process.env.SHELLY_DEVICES || "{}"); } catch (e) { console.error("SHELLY_DEVICES is not valid JSON."); }
  const out = {};
  Object.keys(raw).forEach((k) => {
    if (!LABELS[k]) return;
    const v = typeof raw[k] === "string" ? { id: raw[k] } : raw[k] || {};
    if (v.id) out[k] = { id: String(v.id), channel: +v.channel || 0, pulse: Math.min(Math.max(+v.pulse || 3, 1), 8) };
  });
  return out;
}
function configured() { return !!(process.env.SHELLY_SERVER && process.env.SHELLY_AUTH_KEY && Object.keys(devices()).length); }

async function shelly(path, params) {
  const body = new URLSearchParams({ ...params, auth_key: process.env.SHELLY_AUTH_KEY });
  const r = await fetch(process.env.SHELLY_SERVER.replace(/\/+$/, "") + path, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.isok) throw new Error((j && j.errors && JSON.stringify(j.errors)) || `Shelly ${r.status}`);
  return j.data;
}
const relay = (d, turn) => shelly("/device/relay/control", { id: d.id, channel: String(d.channel), turn });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Relay state from /device/status, for Gen1 (relays[]) and Gen2+ ("switch:N") devices.
async function isOn(d) {
  const s = (await shelly("/device/status", { id: d.id })).device_status || {};
  if (s["switch:" + d.channel]) return !!s["switch:" + d.channel].output;
  if (s.relays && s.relays[d.channel]) return !!s.relays[d.channel].ison;
  return null;
}

module.exports = async (req, res) => {
  const actor = auth.requireAdmin(req, res);
  if (!actor) return;
  const list = devices();

  if (req.method === "GET") {
    const key = String((req.query && req.query.status) || "");
    if (!key) {
      return res.status(200).json({
        configured: configured(),
        devices: Object.keys(LABELS).map((k) => ({ key: k, label: LABELS[k], kind: k === "door" ? "door" : "bay", ready: !!list[k] }))
      });
    }
    if (!configured() || !list[key]) return res.status(404).json({ error: "등록되지 않은 장비입니다." });
    try { return res.status(200).json({ key, on: await isOn(list[key]) }); }
    catch (err) { return res.status(502).json({ error: "상태를 읽지 못했습니다: " + err.message }); }
  }

  if (req.method === "POST") {
    const b = req.body || {}, key = String(b.device || ""), action = String(b.action || "");
    const d = list[key];
    const valid = key === "door" ? action === "open" : /^bay[1-8]$/.test(key) && (action === "on" || action === "off");
    if (!valid) return res.status(400).json({ error: "장비나 동작을 확인하세요." });
    if (!configured() || !d) return res.status(503).json({ error: "이 장비는 아직 연결되지 않았습니다. 환경변수 SHELLY_DEVICES를 확인하세요.", code: "not_configured" });

    const category = key === "door" ? "door" : "system", logAction = key === "door" ? "door_open" : "power_" + action;
    try {
      if (key === "door") {
        await relay(d, "on");
        await wait(d.pulse * 1000);                 // the door stays unlocked for the pulse, then locks again
        await relay(d, "off");
      } else {
        await relay(d, action);
      }
      await db.log(category, { action: logAction, actor, ref: key, req, detail: key === "door" ? { seconds: d.pulse } : null });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Shelly call failed:", key, action, err.message);
      await db.log(category, { action: logAction, ok: false, actor, ref: key, req, detail: { message: err.message } });
      return res.status(502).json({ error: "장비가 응답하지 않습니다: " + err.message });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed." });
};
