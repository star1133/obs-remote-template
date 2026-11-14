// End to end: fake OBS (obs-websocket v5) <-> agent process <-> relay (wrangler dev) <-> fake phone.
// Needs the relay running: cd ../relay && npx wrangler dev   (default http://127.0.0.1:8787)
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import WebSocket from "ws";
import { startFakeObs } from "./fake-obs.mjs";

const RELAY = process.argv[2] ?? "http://127.0.0.1:8787";
const WS = RELAY.replace(/^http/, "ws");
const OBS_PORT = 4466, SETUP = 47999;
let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(url, protocols) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, protocols);
    ws.msgs = []; ws.frames = [];
    ws.on("message", (raw, bin) => { if (bin) ws.frames.push(raw); else { try { ws.msgs.push(JSON.parse(raw.toString())); } catch { /* pong */ } } });
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
async function next(ws, pred, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const i = ws.msgs.findIndex(pred); if (i >= 0) return ws.msgs.splice(i, 1)[0]; await sleep(25); }
  throw new Error("timeout waiting for message; queued: " + JSON.stringify(ws.msgs.slice(0, 4)).slice(0, 400));
}
let rid = 0;
async function rpc(ws, op, data, extra = {}) {
  const id = "r" + ++rid;
  ws.send(JSON.stringify({ v: 1, type: "req", id, op, data, ...extra }));
  return next(ws, (m) => m.type === "res" && m.id === id);
}
async function waitFor(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; }

const home = mkdtempSync(join(tmpdir(), "obsr-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ relay: RELAY, obsPort: OBS_PORT, obsPassword: "pw" }));

let obs = startFakeObs({ port: OBS_PORT, password: "pw" });
const agent = spawn(process.execPath, [fileURLToPath(new URL("../src/main.js", import.meta.url)), "run"], {
  env: { ...process.env, OBSR_HOME: home, OBSR_PORT: String(SETUP) }, stdio: "ignore",
});
const done = async () => { agent.kill(); await obs.close().catch(() => {}); rmSync(home, { recursive: true, force: true }); console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0); };

try {
  const base = `http://127.0.0.1:${SETUP}`;
  ok(await waitFor(async () => (await fetch(base + "/api/ping").then((r) => r.json(), () => null))?.app === "obs-remote", 8000), "agent starts and serves the setup page");
  ok(await waitFor(async () => (await (await fetch(base + "/api/status")).json()).obs.state === "connected", 6000), "agent connects to OBS with the password");
  ok(await waitFor(async () => (await (await fetch(base + "/api/status")).json()).relay.state === "up", 6000), "agent connects to the relay");

  // setup page security
  const html = await (await fetch(base + "/")).text();
  const csrf = html.match(/name="csrf" content="([0-9a-f]+)"/)?.[1];
  ok(!!csrf, "setup page carries a CSRF token");
  ok((await fetch(base + "/api/pair", { method: "POST", body: "{}" })).status === 403, "pairing without the CSRF token is refused");
  const evil = await new Promise((r) => http.get({ host: "127.0.0.1", port: SETUP, path: "/api/status", headers: { host: "evil.example" } }, (res) => { res.resume(); r(res.statusCode); }).on("error", () => r(0)));
  ok(evil === 403, "foreign Host header is refused (DNS rebinding)");
  const post = (p, b) => fetch(base + p, { method: "POST", headers: { "x-obsr-csrf": csrf, "content-type": "application/json" }, body: JSON.stringify(b) });

  // pair a phone through the setup page
  const pr = await (await post("/api/pair", { role: "owner" })).json(); if (process.env.TRACE) console.log("pair:", JSON.stringify(pr).slice(0, 200));
  ok(/^[A-Z2-9]{12}$/.test(pr.code) && pr.url.includes("#pair=") && pr.qr.n > 20, "setup page makes a pairing code, link and QR");
  const pj = await (await fetch(RELAY + "/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: pr.room, code: pr.code, name: "e2e phone" }) })).json();
  ok(!!pj.clientToken, "phone pairs with that code");
  const ph = await open(`${WS}/ws/client?room=${pr.room}`, ["obsr." + pj.clientToken]);
  const hello = await next(ph, (m) => m.type === "hello");
  ok(hello.obs === true && hello.perm === "owner", "phone connects, OBS reported online");

  // snapshot
  const sync = (await next(ph, (m) => m.type === "state.sync")).data;
  ok(sync.scenes.join() === "Starting Soon,Main,Gameplay", "snapshot has scenes in dock order");
  ok(sync.program === "Main" && sync.studioMode === false, "snapshot has program and studio state");
  ok(sync.inputs.map((i) => i.name).join() === "Mic/Aux,Desktop Audio" || sync.inputs.map((i) => i.name).join() === "Desktop Audio,Mic/Aux", "mixer lists audio inputs only (no image source)");
  ok(sync.inputs.every((i) => i.pinned), "global audio devices are pinned");
  ok(sync.items.Main.length === 2 && sync.items.Main[0].locked === true && sync.items.Main[0].name === "Logo", "snapshot has sources with lock state");
  ok(sync.transitionKinds.Cut === "cut" && sync.transitionKinds.Fade === "mix" && sync.transitionKinds.Slide === "slide", "snapshot tells the UI what each transition does");
  ok(sync.transitions.includes("Fade") && sync.transition === "Fade" && sync.duration === 300, "snapshot has transition + duration");

  // controls
  ok((await rpc(ph, "SetCurrentProgramScene", { sceneName: "Gameplay" })).ok, "scene switch acknowledged");
  ok(await waitFor(() => obs.state.program === "Gameplay", 2000), "OBS actually switched");
  ok((await next(ph, (m) => m.type === "evt" && m.op === "ProgramSceneChanged")).data.sceneName === "Gameplay", "program change event reaches the phone");
  ok((await rpc(ph, "SetInputVolume", { inputName: "Mic/Aux", inputVolumeDb: -20.5 }, { ctl: "vol:Mic/Aux", seq: 1 })).ok && obs.state.inputs[0].db === -20.5, "volume change reaches OBS");
  await rpc(ph, "SetInputVolume", { inputName: "Mic/Aux", inputVolumeDb: -5 }, { ctl: "vol:Mic/Aux", seq: 1 });
  ok(obs.state.inputs[0].db === -20.5, "stale seq is dropped");
  ok((await rpc(ph, "SetInputMute", { inputName: "Desktop Audio", inputMuted: true })).ok && obs.state.inputs[1].muted, "mute reaches OBS");
  ok((await rpc(ph, "Shutdown", {})).error === "not_allowed", "ops outside the allowlist are blocked");
  ok((await rpc(ph, "SetInputVolume", { inputName: 5, inputVolumeDb: "x" })).ok === false, "bad field types are rejected before OBS");
  ok((await rpc(ph, "SetInputVolume", { inputName: "Nope", inputVolumeDb: -3 })).ok === false, "OBS errors come back as failed responses");

  // switcher
  ok((await rpc(ph, "StudioTake", {})).ok === false, "take refused while studio mode is off");
  await rpc(ph, "SetStudioModeEnabled", { studioModeEnabled: true });
  ok((await next(ph, (m) => m.op === "StudioModeChanged")).data.studioMode === true, "studio mode event");
  await rpc(ph, "SetCurrentPreviewScene", { sceneName: "Main" });
  ph.msgs.length = 0;
  ok((await rpc(ph, "StudioTake", {})).ok, "plain take");
  const ts = await next(ph, (m) => m.op === "TransitionStarted");
  ok(ts.data.from === "Gameplay" && ts.data.to === "Main" && ts.data.duration === 300, "TransitionStarted has from/to/duration");
  await next(ph, (m) => m.op === "TransitionEnded");
  ok(true, "TransitionEnded follows");
  ph.msgs.length = 0; obs.log.length = 0;
  ok((await rpc(ph, "StudioTake", { transitionName: "Slide", duration: 1200 })).ok, "take with a one-off effect");
  const ts2 = await next(ph, (m) => m.op === "TransitionStarted");
  ok(ts2.data.transition === "Slide" && ts2.data.duration === 1200 && ts2.data.kind === "slide", "one-off effect is reported");
  await next(ph, (m) => m.op === "TransitionEnded");
  await waitFor(() => obs.state.transition === "Fade" && obs.state.duration === 300, 3000);
  ok(obs.state.transition === "Fade" && obs.state.duration === 300, "the user's own transition is restored afterwards");
  ok(!ph.msgs.some((m) => m.op === "CurrentSceneTransitionChanged" && m.data.transitionName === "Slide"), "the temporary switch is hidden from the UI");
  await sleep(300);
  ok((await rpc(ph, "SetTBarPosition", { position: 0.4, release: false })).ok && obs.state.tbar === 0.4, "T-bar position reaches OBS");
  ok((await next(ph, (m) => m.op === "TBarChanged")).data.position === 0.4, "T-bar echo event");
  ok(!ph.msgs.some((m) => m.op === "TransitionStarted"), "a manual T-bar move is not reported as an automatic transition");
  const before = { pgm: obs.state.program, pvw: obs.state.preview };
  await rpc(ph, "SetTBarPosition", { position: 1, release: true });
  ok((await next(ph, (m) => m.op === "TBarChanged" && m.data.completed)) !== null, "T-bar release at the end reports completion");
  await waitFor(() => obs.state.program === before.pvw, 3000);
  ok(obs.state.program === before.pvw && obs.state.preview === before.pgm, "released T-bar really swaps program and preview");

  // live data
  ok((await rpc(ph, "StartStream", {})).ok, "stream start acknowledged");
  ok((await next(ph, (m) => m.op === "StreamStateChanged")).data.active === true, "stream state event");
  ok(!!(await next(ph, (m) => m.op === "Stats", 4000)).data.stats.fps, "stats arrive");
  const lv = await next(ph, (m) => m.op === "Levels");
  ok(lv.data.levels["Mic/Aux"][0] > 0, "audio levels arrive");
  ok(!ph.frames.length, "no preview frames before anyone asks");
  ph.send(JSON.stringify({ type: "sub", preview: true }));
  ok(await waitFor(() => ph.frames.length > 0, 3000), "preview frames arrive once subscribed");
  ok(ph.frames[0][0] === 0 && ph.frames[0][1] === 0xff && ph.frames[0][2] === 0xd8, "frame = channel byte + JPEG");
  ph.send(JSON.stringify({ type: "sub", preview: false }));
  await rpc(ph, "StopStream", {});

  // OBS goes away and comes back
  await obs.close();
  ok((await next(ph, (m) => m.op === "ObsOnline" && m.data.online === false, 5000)) !== null, "phone is told OBS closed");
  ok((await rpc(ph, "SetCurrentProgramScene", { sceneName: "Main" })).error === "obs_offline", "requests fail fast while OBS is closed");
  obs = startFakeObs({ port: OBS_PORT, password: "pw" });
  ok((await next(ph, (m) => m.op === "ObsOnline" && m.data.online === true, 10000)) !== null, "agent reconnects to OBS by itself");
  ok(!!(await next(ph, (m) => m.type === "state.sync", 5000)).data.scenes.length, "phone gets a fresh snapshot");

  // wrong password is reported, not looped on silently
  const cfgPath = join(home, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), obsPassword: "wrong" }));
  await obs.close();
  obs = startFakeObs({ port: OBS_PORT, password: "pw" });
  ok(await waitFor(async () => (await (await fetch(base + "/api/status")).json()).obs.state === "auth", 12000), "wrong WebSocket password shows up as an auth problem");
  await post("/api/obs-password", { password: "pw" });
  ok(await waitFor(async () => (await (await fetch(base + "/api/status")).json()).obs.state === "connected", 12000), "fixing the password on the setup page reconnects");
} catch (e) {
  console.log("FAIL  " + e.message);
  failed++;
}
await done();
