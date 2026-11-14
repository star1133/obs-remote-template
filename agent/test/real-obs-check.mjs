// Dev check: the real agent against the real OBS on this machine (read-only). Needs OBS running and `wrangler dev`.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
const RELAY = "http://127.0.0.1:8787", SETUP = 47997;
const home = mkdtempSync(join(tmpdir(), "obsr-real-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ relay: RELAY }));
const agent = spawn(process.execPath, [fileURLToPath(new URL("../src/main.js", import.meta.url)), "run"], { env: { ...process.env, OBSR_HOME: home, OBSR_PORT: String(SETUP) }, stdio: "inherit" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const base = `http://127.0.0.1:${SETUP}`;
  let s; for (let i = 0; i < 40; i++) { s = await fetch(base + "/api/status").then((r) => r.json(), () => null); if (s?.obs.state === "connected" && s.relay.state === "up") break; await sleep(250); }
  console.log("status", JSON.stringify({ obs: s?.obs, relay: s?.relay.state }));
  const csrf = (await (await fetch(base + "/")).text()).match(/name="csrf" content="([0-9a-f]+)"/)[1];
  const pr = await (await fetch(base + "/api/pair", { method: "POST", headers: { "x-obsr-csrf": csrf, "content-type": "application/json" }, body: "{}" })).json();
  const pj = await (await fetch(RELAY + "/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: pr.room, code: pr.code, name: "check" }) })).json();
  const ws = new WebSocket(`ws://127.0.0.1:8787/ws/client?room=${pr.room}`, ["obsr." + pj.clientToken]);
  const msgs = [], frames = [];
  ws.on("message", (raw, bin) => { if (bin) frames.push(raw); else { try { msgs.push(JSON.parse(raw.toString())); } catch {} } });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "sub", preview: true }));
  await sleep(2500);
  const snap = msgs.find((m) => m.type === "state.sync")?.data;
  console.log("scenes", snap?.scenes.join(" | "));
  console.log("program", snap?.program, "studio", snap?.studioMode, "transition", snap?.transition, snap?.duration, JSON.stringify(snap?.transitionKinds));
  console.log("mixer", snap?.inputs.map((i) => `${i.name}${i.pinned ? "*" : ""} ${i.volumeDb.toFixed(1)}dB${i.muted ? " M" : ""}`).join(" | "));
  console.log("items in program", JSON.stringify(snap?.items[snap.program]));
  console.log("stats", JSON.stringify(msgs.find((m) => m.op === "Stats")?.data.stats));
  console.log("levels", JSON.stringify(msgs.find((m) => m.op === "Levels")?.data.levels));
  console.log("frames", frames.length, frames[0]?.length, frames[0]?.[0], frames[0]?.[1]?.toString(16), frames[0]?.[2]?.toString(16));
  ws.close();
} finally { agent.kill(); await sleep(200); rmSync(home, { recursive: true, force: true }); process.exit(0); }
