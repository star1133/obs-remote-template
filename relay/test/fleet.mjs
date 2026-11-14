// Dev helper: several simulated OBS computers on one relay, plus a tiny HTTP endpoint that hands out pairing codes.
//   npm run dev   (then)   node test/fleet.mjs [base-url] [count]     GET http://127.0.0.1:8890/code?i=0  ->  room-code
import http from "node:http";
import WebSocket from "ws";
import { createSim } from "../public/sim.js";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const count = Number(process.argv[3] ?? 2);
const wsBase = base.replace(/^http/, "ws");
const names = ["STUDIO-PC", "STAGE-PC", "BACKUP-PC", "LOBBY-PC"];

const fleet = [];
for (let i = 0; i < count; i++) {
  const reg = await (await fetch(base + "/api/register", { method: "POST" })).json();
  const ws = new WebSocket(`${wsBase}/ws/obs?room=${reg.room}&token=${reg.deviceToken}`);
  await new Promise((r) => ws.on("open", r));
  const sim = createSim((m) => { if (!(m instanceof ArrayBuffer) && ws.readyState === 1) ws.send(JSON.stringify(m)); });
  sim.state.name = names[i % names.length];
  if (i > 0) { sim.state.scenes = sim.state.scenes.slice(0, 5 - i + 1); sim.state.program = sim.state.scenes[0]; sim.state.preview = sim.state.scenes[1]; }
  ws.on("message", (raw, bin) => {
    if (bin) return;
    const m = JSON.parse(raw.toString());
    if (m.type === "req" || m.type === "sync.request") sim.handle(m);
    if (m.type === "pair.code") fleet[i].waiter?.(m);
  });
  sim.start();
  fleet.push({ room: reg.room, ws, sim });
}

http.createServer(async (req, res) => {
  const i = Number(new URL(req.url, "http://x").searchParams.get("i") ?? 0);
  const f = fleet[i];
  if (!f) { res.statusCode = 404; return res.end("no such computer"); }
  const m = await new Promise((resolve) => { f.waiter = resolve; f.ws.send(JSON.stringify({ type: "pair.request" })); });
  res.end(`${m.room}-${m.code}`);
}).listen(8890, "127.0.0.1", () => console.log(`fleet of ${count} up; codes at http://127.0.0.1:8890/code?i=0..${count - 1}`));
