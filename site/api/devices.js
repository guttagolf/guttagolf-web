// Door and bay power through Shelly Cloud. Every request needs the admin session cookie from /api/login.
//   GET  /api/devices                                   →  { configured, devices: [{ key, label, kind, ready, plugs }] }
//   GET  /api/devices?status=bay3                       →  { key, on, plugs: [{ id, online, on, error }] } live state, switches nothing
//                                                          on is true/false when every plug agrees, otherwise null
//   POST /api/devices  { device: "door", action: "open" }            →  relay on, then off after the pulse
//   POST /api/devices  { device: "bay3", action: "on" | "off" }      →  every plug of the bay, one after another
// Env (Shelly app → User settings → Authorization cloud key):
//   SHELLY_SERVER    e.g. https://shelly-103-eu.shelly.cloud
//   SHELLY_AUTH_KEY  the cloud key
//   SHELLY_DEVICES   JSON: {"door": {"id": "a1b2c3d4e5f6", "channel": 0, "pulse": 3}, "bay1": ["b1c2d3e4f5a6", "c1d2e3f4a5b6"], …}
//                    a plain string is a device id on channel 0, a list is several plugs that switch together;
//                    "pulse" is seconds the door relay stays on (default 3)
// Shelly Cloud allows about one request per second, so plugs are called one at a time with a pause between them.
const db = require("./_db.js");
const auth = require("./_auth.js");

const LABELS = { door: "정문" };
for (let i = 1; i <= 8; i++) LABELS["bay" + i] = "Bay " + i + " 시스템";

const GAP = 1100;   // ms between two Shelly calls

function plug(v) {
  const p = typeof v === "string" ? { id: v } : v || {};
  return p.id ? { id: String(p.id).trim(), channel: +p.channel || 0, pulse: Math.min(Math.max(+p.pulse || 3, 1), 8) } : null;
}
// { key: [plug, …] } for every key with at least one plug.
function devices() {
  let raw = {};
  try { raw = JSON.parse(process.env.SHELLY_DEVICES || "{}"); } catch (e) { console.error("SHELLY_DEVICES is not valid JSON."); }
  const out = {};
  Object.keys(raw).forEach((k) => {
    if (!LABELS[k]) return;
    const plugs = (Array.isArray(raw[k]) ? raw[k] : [raw[k]]).map(plug).filter(Boolean);
    if (plugs.length) out[k] = plugs;
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

// One plug's state from /device/status, for Gen1 (relays[]) and Gen2+ ("switch:N") devices. Never throws.
async function plugStatus(d) {
  try {
    const data = await shelly("/device/status", { id: d.id }), s = data.device_status || {};
    let on = null;
    if (s["switch:" + d.channel]) on = !!s["switch:" + d.channel].output;
    else if (s.relays && s.relays[d.channel]) on = !!s.relays[d.channel].ison;
    return { id: d.id, online: data.online == null ? null : !!data.online, on };
  } catch (err) {
    return { id: d.id, error: err.message };
  }
}
// Runs fn on each plug in turn, pausing between calls.
async function eachPlug(plugs, fn) {
  const out = [];
  for (let i = 0; i < plugs.length; i++) {
    if (i) await wait(GAP);
    out.push(await fn(plugs[i]));
  }
  return out;
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
        devices: Object.keys(LABELS).map((k) => ({ key: k, label: LABELS[k], kind: k === "door" ? "door" : "bay", ready: !!list[k], plugs: list[k] ? list[k].length : 0 }))
      });
    }
    if (!configured() || !list[key]) return res.status(404).json({ error: "등록되지 않은 장비입니다." });
    const plugs = await eachPlug(list[key], plugStatus);
    const states = plugs.map((p) => p.on);
    const on = states.every((v) => v === true) ? true : states.every((v) => v === false) ? false : null;
    return res.status(200).json({ key, on, plugs });
  }

  if (req.method === "POST") {
    const b = req.body || {}, key = String(b.device || ""), action = String(b.action || "");
    const plugs = list[key];
    const valid = key === "door" ? action === "open" : /^bay[1-8]$/.test(key) && (action === "on" || action === "off");
    if (!valid) return res.status(400).json({ error: "장비나 동작을 확인하세요." });
    if (!configured() || !plugs) return res.status(503).json({ error: "이 장비는 아직 연결되지 않았습니다. 환경변수 SHELLY_DEVICES를 확인하세요.", code: "not_configured" });

    const category = key === "door" ? "door" : "system", logAction = key === "door" ? "door_open" : "power_" + action;
    try {
      if (key === "door") {
        const d = plugs[0];
        await relay(d, "on");
        await wait(d.pulse * 1000);                 // the door stays unlocked for the pulse, then locks again
        await relay(d, "off");
        await db.log(category, { action: logAction, actor, ref: key, req, detail: { seconds: d.pulse } });
        return res.status(200).json({ ok: true });
      }
      // A bay: try every plug even when one fails, so one dead plug does not leave the others behind.
      const failed = (await eachPlug(plugs, (d) => relay(d, action).then(() => null, (err) => d.id + " (" + err.message + ")"))).filter(Boolean);
      if (failed.length === plugs.length) throw new Error(failed.join(", "));
      await db.log(category, { action: logAction, ok: !failed.length, actor, ref: key, req, detail: { plugs: plugs.length, failed: failed.length ? failed : undefined } });
      if (failed.length) return res.status(502).json({ error: "일부 플러그가 응답하지 않습니다: " + failed.join(", ") });
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
