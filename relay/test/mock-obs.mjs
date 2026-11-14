// Fake OBS plugin for manual testing: node test/mock-obs.mjs [http://127.0.0.1:8787]
// Registers a room, prints the pairing string, then behaves like OBS via public/sim.js.
import WebSocket from "ws";
import { createSim } from "../public/sim.js";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const wsBase = base.replace(/^http/, "ws");

const reg = await (await fetch(base + "/api/register", { method: "POST" })).json();
console.log("room:", reg.room);

const ws = new WebSocket(`${wsBase}/ws/obs?room=${reg.room}&token=${reg.deviceToken}`);
const sim = createSim((m) => {
  if (m instanceof ArrayBuffer) { if (demand.preview > 0 && ws.readyState === 1) ws.send(Buffer.from(m)); return; }
  if (ws.readyState === 1) ws.send(JSON.stringify(m));
});
const demand = { clients: 0, preview: 0 };

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "pair.request" }));
  sim.start();
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "pair.code") console.log(`\nPair string:  ${m.room.toUpperCase()}-${m.code}\nOpen:         ${base}/#pair=${m.room}-${m.code}\n(valid 5 minutes)`);
  else if (m.type === "demand") Object.assign(demand, m);
  else if (m.type === "devices") console.log("devices:", m.data.map((d) => `${d.name}${d.online ? "*" : ""}`).join(", ") || "none");
  else sim.handle(m);
});
ws.on("close", (c) => { console.log("closed", c); process.exit(0); });

// Re-issue a pairing code on Enter, handy when the first one expired.
process.stdin.on("data", () => ws.send(JSON.stringify({ type: "pair.request" })));
