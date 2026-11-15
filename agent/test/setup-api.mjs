// What the native settings window (settings/settings.c) and the old OBS dock read from the agent's local page:
// plain-text status, the CSRF token, pairing as text with QR rows, and the one-button dock.   node test/setup-api.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PORT = 47994;
const home = mkdtempSync(join(tmpdir(), "obsr-sa-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ mode: "local", obsPort: 4999 }));
const agent = spawn(process.execPath, [join(ROOT, "agent/src/main.js"), "run"], { env: { ...process.env, OBSR_HOME: home, OBSR_PORT: String(PORT), OBSR_NO_TUNNEL: "1", OBSR_NO_BROWSER: "1", OBSR_NO_TRAY: "1", OBSR_NO_OBS: "1" }, stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { await wait(200); if (await fetch(`http://127.0.0.1:${PORT}/api/ping`).then((r) => r.ok, () => false)) break; }
let ok = true;
const check = (n, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); ok &&= !!c; };

const txt = await (await fetch(`http://127.0.0.1:${PORT}/api/status.txt`)).text();
const kv = Object.fromEntries(txt.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
check("plain-text status for the settings window", kv.v === "1" && kv.obs.startsWith("waiting\t") && "relay" in kv && "mode" in kv);
const token = await (await fetch(`http://127.0.0.1:${PORT}/api/token`)).text();
const pairTxt = await fetch(`http://127.0.0.1:${PORT}/api/pair?fmt=txt`, { method: "POST", headers: { "x-obsr-csrf": token, "content-type": "application/json" }, body: JSON.stringify({ role: "viewer" }) }).then((r) => r.text());
const n = Number(/^qr=(\d+)$/m.exec(pairTxt)?.[1]);
const rows = pairTxt.trim().split("\n").slice(-n);
check(`pairing code as text with a ${n}x${n} QR`, /^code=[A-Z0-9]{12}$/m.test(pairTxt) && /^role=viewer$/m.test(pairTxt) && n > 20 && rows.every((r) => r.length === n && /^[01]+$/.test(r)));
const noToken = await fetch(`http://127.0.0.1:${PORT}/api/pair?fmt=txt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("pairing needs the token", noToken.status === 403);
const dock = await (await fetch(`http://127.0.0.1:${PORT}/dock`)).text();
check("the OBS dock is a one-button page that does not poll", dock.includes("/dock.js") && !dock.includes("setup.js") && dock.length < 2000);
const fake = await fetch(`http://127.0.0.1:${PORT}/api/settings`, { method: "POST", headers: { "x-obsr-csrf": "nope" } });
check("opening the settings window needs the token too", fake.status === 403);
check("the YouTube page is gone", (await fetch(`http://127.0.0.1:${PORT}/yt`)).status === 404);

agent.kill();
console.log(ok ? "\nall passed" : "\nFAILED");
process.exit(ok ? 0 : 1);
