// End-to-end check against a running relay: npm run dev  (then)  npm test [base-url]
import WebSocket from "ws";
import { createSim } from "../public/sim.js";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const wsBase = base.replace(/^http/, "ws");
let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };

// Browsers send the token as a subprotocol ("obsr.<token>"); mimic that unless the URL already carries ?token=.
const open = (url) => new Promise((resolve, reject) => {
  const m = url.match(/^(.*)[?&]token=([^&]*)$/);
  const ws = m ? new WebSocket(m[1].replace(/[?&]$/, ""), ["obsr." + m[2]]) : new WebSocket(url);
  ws.msgs = [];
  ws.waiters = [];
  ws.on("message", (raw, bin) => {
    const text = bin ? "" : raw.toString();
    if (process.env.TRACE) console.log("    <-", url.includes("/client") ? "client" : "obs   ", text.slice(0, 110));
    if (text === "pong") return ws.emit("pong-text");
    const m = bin ? { binary: raw.length } : JSON.parse(text);
    const i = ws.waiters.findIndex((w) => w.pred(m));
    if (i >= 0) ws.waiters.splice(i, 1)[0].resolve(m); else ws.msgs.push(m);
  });
  ws.on("open", () => resolve(ws));
  ws.on("unexpected-response", (_, res) => reject(new Error("HTTP " + res.statusCode)));
  ws.on("error", reject);
});
const next = (ws, pred, ms = 3000) => new Promise((resolve, reject) => {
  const i = ws.msgs.findIndex(pred);
  if (i >= 0) return resolve(ws.msgs.splice(i, 1)[0]);
  const w = { pred, resolve };
  ws.waiters.push(w);
  setTimeout(() => { ws.waiters = ws.waiters.filter((x) => x !== w); reject(new Error("timeout waiting for: " + pred + "\n  queued: " + ws.msgs.map((m) => (m.op ?? m.type) + (m.error ? `(${m.error})` : "")).join(", "))); }, ms);
});
const post = async (path, body, headers = {}) => {
  const r = await fetch(base + path, { method: "POST", body: JSON.stringify(body ?? {}), headers });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// ---- register + OBS side ----
// REG_KEY=... when the relay has REGISTRATION_KEY set: then room ids are signed and made-up rooms are refused.
const KEY = process.env.REG_KEY;
if (KEY) {
  const nokey = await post("/api/register");
  ok(nokey.status === 403, "register without the key is refused");
}
const reg = await post("/api/register", undefined, KEY ? { "x-registration-key": KEY } : {});
ok(reg.status === 200 && reg.json.room?.length === 10, "register creates a room");
if (KEY) {
  const fake = reg.json.room.slice(0, 6) + (reg.json.room.slice(6) === "aaaa" ? "bbbb" : "aaaa");
  const fp = await post("/api/pair", { room: fake, code: "AAAAAAAAAAAA" });
  ok(fp.status === 400 && fp.json.error === "bad_room", "pairing with a made-up room is refused before the room is touched");
  const fw = await open(`${wsBase}/ws/client?room=${fake}&token=x`).then(() => false, () => true);
  ok(fw, "socket to a made-up room is refused");
}

const bad = await open(`${wsBase}/ws/obs?room=${reg.json.room}&token=nope`).then(() => false, () => true);
ok(bad, "obs socket with wrong token is rejected");

const obs = await open(`${wsBase}/ws/obs?room=${reg.json.room}&token=${reg.json.deviceToken}`);
let curObs = obs; // the plugin side; swapped when the "OBS" reconnects below
const sim = createSim((m) => { if (!(m instanceof ArrayBuffer) && curObs.readyState === 1) curObs.send(JSON.stringify(m)); });
obs.on("message", (raw, bin) => { if (!bin) { const m = JSON.parse(raw.toString()); if (m.type === "req" || m.type === "sync.request") sim.handle(m); } });

// ---- pairing ----
obs.send(JSON.stringify({ type: "pair.request" }));
const code = await next(obs, (m) => m.type === "pair.code");
ok(/^[A-HJ-NP-Z2-9]{12}$/.test(code.code), "plugin receives a 12 character pairing code");

const wrong = await post("/api/pair", { room: reg.json.room, code: code.code === "000000" ? "111111" : "000000" });
ok(wrong.status === 400 && wrong.json.error === "bad_code", "wrong pairing code is refused");
const paired = await post("/api/pair", { room: reg.json.room, code: code.code.toLowerCase().match(/.{4}/g).join("-"), name: "test" });
ok(paired.status === 200 && paired.json.clientToken, "correct code yields a client token");
const reuse = await post("/api/pair", { room: reg.json.room, code: code.code });
ok(reuse.status === 400, "pairing code is single use");

// ---- client side ----
const anon = await open(`${wsBase}/ws/client?room=${reg.json.room}&token=bad`).then(() => false, () => true);
ok(anon, "client socket with wrong token is rejected");

const cl = await open(`${wsBase}/ws/client?room=${reg.json.room}&token=${paired.json.clientToken}`);
const hello = await next(cl, (m) => m.type === "hello");
ok(hello.obs === true, "client hello reports OBS online");
const snap = await next(cl, (m) => m.type === "state.sync");
ok(snap.data.scenes.length > 0, "client receives a full snapshot");

const rq = (op, data, extra = {}) => cl.send(JSON.stringify({ v: 1, type: "req", id: op + Math.random(), op, data, ...extra }));
rq("SetCurrentProgramScene", { sceneName: "Camera Full" });
const res1 = await next(cl, (m) => m.type === "res");
ok(res1.ok === true, "scene switch acknowledged");
const ev1 = await next(cl, (m) => m.type === "evt" && m.op === "ProgramSceneChanged");
ok(ev1.data.sceneName === "Camera Full", "scene change broadcast as event");

rq("SetInputVolume", { inputName: "Mic/Aux", inputVolumeDb: -3 }, { ctl: "vol:Mic/Aux", seq: 5 });
await next(cl, (m) => m.type === "evt" && m.op === "InputVolumeChanged");
cl.msgs.length = 0;
rq("SetInputVolume", { inputName: "Mic/Aux", inputVolumeDb: -40 }, { ctl: "vol:Mic/Aux", seq: 4, id: "stale" });
await next(cl, (m) => m.type === "res" && m.id === "stale");
ok(sim.state.inputs[0].volumeDb === -3, "stale seq is dropped by the plugin side");

rq("DeleteEverything", {}, { id: "evil" });
const denied = await next(cl, (m) => m.type === "res" && m.id === "evil");
ok(denied.ok === false && denied.error === "not_allowed", "unknown op is blocked by allowlist");

cl.send(JSON.stringify({ type: "req", id: "x", op: "bad op!", data: {} }));
cl.send(JSON.stringify({ type: "req", id: "y", op: "SetInputMute", data: { inputName: "Music", inputMuted: false } }));
const afterBad = await next(cl, (m) => m.type === "res" && m.id === "y");
ok(afterBad.ok === true, "malformed op name is dropped without breaking the socket");

cl.send("ping");
const pong = await new Promise((r) => { cl.once("pong-text", () => r("pong")); setTimeout(() => r(""), 2000); });
ok(pong === "pong", "keepalive ping answered");

// ---- switcher: studio mode, auto transition, T-bar ----
const waitEvt = (op, pred = () => true) => {
  if (process.env.TRACE) console.log("  waiting for", op, "queued:", cl.msgs.map((m) => m.op ?? m.type).join(","));
  return next(cl, (m) => m.type === "evt" && m.op === op && pred(m.data));
};
const rqOk = async (op, data, extra = {}) => {
  const id = op + Math.random();
  rq(op, data, { id, ...extra });
  return next(cl, (m) => m.type === "res" && m.id === id);
};
await waitEvt("TransitionEnded"); // the plain scene switch above ran with the default Fade
ok((await rqOk("SetCurrentPreviewScene", { sceneName: "Main" })).ok === false, "preview needs switcher mode on");
await rqOk("SetStudioModeEnabled", { studioModeEnabled: true });
await rqOk("SetCurrentSceneTransitionDuration", { transitionDuration: 200 });
await rqOk("SetCurrentSceneTransition", { transitionName: "Fade to Color" });
await rqOk("SetCurrentPreviewScene", { sceneName: "Gameplay" });
const before = sim.state.program;
const take = rqOk("StudioTake", {});
const started = await waitEvt("TransitionStarted");
ok(started.data.kind === "dip" && started.data.to === "Gameplay" && started.data.from === before, "AUTO take starts a dip transition from PGM to PVW");
ok(sim.state.preview === before, "buses swap after the take");
ok((await rqOk("SetTBarPosition", { position: 0.4, release: false })).ok === false, "T-bar refuses while an automatic transition runs");
await take;
await waitEvt("TransitionEnded");
ok(sim.state.tr === null, "transition ends by itself");
await rqOk("StudioTake", { transitionName: "Cut", duration: 0 });
ok(sim.state.program === before && sim.state.tr === null, "CUT swaps instantly with no transition");
await rqOk("SetTBarPosition", { position: 0.5, release: false });
ok(sim.state.tbar === 0.5, "T-bar holds mid-way");
ok((await rqOk("StudioTake", {})).ok === false, "take is refused while the T-bar is mid-way");
await rqOk("SetTBarPosition", { position: 1, release: true });
const done = await waitEvt("TBarChanged", (d) => d.completed);
ok(done.data.position === 0 && sim.state.tbar === 0, "T-bar release at the end completes and resets");
await rqOk("SetTBarPosition", { position: 0.3, release: false });
await rqOk("SetTBarPosition", { position: 0, release: true });
ok(sim.state.tbar === 0, "T-bar returned home cancels");
await rqOk("SetStudioModeEnabled", { studioModeEnabled: false });

// ---- preview demand + binary ----
cl.send(JSON.stringify({ type: "sub", preview: true }));
const demand = await next(obs, (m) => m.type === "demand" && m.preview === 1);
ok(!!demand, "plugin is told when a viewer wants preview");
obs.send(Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 5, 6, 7, 8]));
const frame = await next(cl, (m) => m.binary);
ok(frame.binary === 10, "binary preview frame reaches subscribed client");

// ---- flow control: a client that acknowledges frames gets at most 12 unacknowledged ones ----
const countFrames = async (ms) => { await new Promise((r) => setTimeout(r, ms)); const n = cl.msgs.filter((m) => m.binary).length; cl.msgs = cl.msgs.filter((m) => !m.binary); return n; };
const burst = (n) => { for (let i = 0; i < n; i++) obs.send(Buffer.from([0, 0xff, 0xd8, 1, 2, 3, 4, 5, 6, 7])); };
burst(30);
ok((await countFrames(600)) === 30, "a client without acks (older page) gets every frame");
cl.send(JSON.stringify({ type: "sub", preview: true, acks: true }));
await next(obs, (m) => m.type === "demand");
burst(30);
const got12 = await countFrames(600);
ok(got12 === 12, `a client that has not acknowledged gets at most 12 frames (${got12})`);
cl.send("a12");
await new Promise((r) => setTimeout(r, 150));
burst(5);
ok((await countFrames(600)) === 5, "acknowledged frames free the window");
obs.send(Buffer.from([2, 1, 65, 0xff, 0xd8, 1, 2, 3]));
ok((await countFrames(400)) === 0, "scene pictures go only to Present-mode clients");
cl.send("a99");
cl.send(JSON.stringify({ type: "sub", preview: true }));
await next(obs, (m) => m.type === "demand");

// ---- sharing: owners invite operators/viewers; viewers can only watch ----
cl.send(JSON.stringify({ type: "invite", role: "viewer" }));
const inv = await next(cl, (m) => m.type === "invite.code");
ok(/^[A-HJ-NP-Z2-9]{12}$/.test(inv.code) && inv.role === "viewer", "owner can create a viewer invite");
const vp = await post("/api/pair", { room: reg.json.room, code: inv.code, name: "guest" });
ok(vp.status === 200 && vp.json.role === "viewer", "invite code pairs a viewer");
const vw = await open(`${wsBase}/ws/client?room=${reg.json.room}&token=${vp.json.clientToken}`);
const vhello = await next(vw, (m) => m.type === "hello");
ok(vhello.perm === "viewer", "viewer is told its permission");
await next(vw, (m) => m.type === "state.sync");
vw.send(JSON.stringify({ v: 1, type: "req", id: "v1", op: "SetInputMute", data: { inputName: "Music", inputMuted: true } }));
const vres = await next(vw, (m) => m.type === "res" && m.id === "v1");
ok(vres.ok === false && vres.error === "view_only", "viewer cannot control OBS");
vw.send(JSON.stringify({ type: "invite", role: "operator" }));
vw.send(JSON.stringify({ type: "devices" }));
await new Promise((r) => setTimeout(r, 300));
ok(!vw.msgs.some((m) => m.type === "invite.code" || (m.type === "devices" && m.data.length > 1 && m.fromRequest)), "viewer cannot invite");
cl.send(JSON.stringify({ type: "invite", role: "operator" }));
const inv2 = await next(cl, (m) => m.type === "invite.code");
const op = await post("/api/pair", { room: reg.json.room, code: inv2.code, name: "helper" });
const opw = await open(`${wsBase}/ws/client?room=${reg.json.room}&token=${op.json.clientToken}`);
await next(opw, (m) => m.type === "state.sync");
opw.send(JSON.stringify({ v: 1, type: "req", id: "o1", op: "SetInputMute", data: { inputName: "Music", inputMuted: false } }));
ok((await next(opw, (m) => m.type === "res" && m.id === "o1")).ok === true, "operator can control OBS");
opw.send(JSON.stringify({ type: "revoke", cid: paired.json.cid }));
await new Promise((r) => setTimeout(r, 300));
const stillThere = await open(`${wsBase}/ws/client?room=${reg.json.room}&token=${paired.json.clientToken}`).then((w) => { w.close(); return true; }, () => false);
ok(stillThere, "operator cannot revoke the owner");
const vClosed = new Promise((r) => vw.on("close", (c) => r(c)));
cl.send(JSON.stringify({ type: "revoke", cid: vp.json.cid }));
ok((await vClosed) === 4001, "owner can revoke a shared device");
opw.close();
// 11 wrong codes lock the room's pairing for a while
let locked = 0;
for (let i = 0; i < 12; i++) if ((await post("/api/pair", { room: reg.json.room, code: "999999" })).status === 429) locked++;
ok(locked >= 1, "repeated wrong codes get locked out");
cl.msgs.length = 0;

// ---- obs goes away: clients must be told, and told again when it returns ----
const presenceOff = next(cl, (m) => m.type === "presence" && m.obs === false);
obs.close();
ok(!!(await presenceOff), "clients are told when OBS disconnects");
const rqOff = await rqOk("SetInputMute", { inputName: "Music", inputMuted: true });
ok(rqOff.ok === false && rqOff.error === "obs_offline", "requests fail fast while OBS is offline");
const obs2 = await open(`${wsBase}/ws/obs?room=${reg.json.room}&token=${reg.json.deviceToken}`);
const presenceOn = await next(cl, (m) => m.type === "presence" && m.obs === true);
ok(!!presenceOn, "clients are told when OBS comes back");
obs2.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "req" || m.type === "sync.request") sim.handle(m); });
curObs = obs2;

// ---- revoke ----
const closed = new Promise((r) => cl.on("close", (c) => r(c)));
obs2.send(JSON.stringify({ type: "device.revoke", cid: paired.json.cid }));
ok((await closed) === 4001, "revoking a device closes its socket with 4001");
const again = await open(`${wsBase}/ws/client?room=${reg.json.room}&token=${paired.json.clientToken}`).then(() => false, () => true);
ok(again, "revoked token can no longer connect");

obs2.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
