// The Update button's logic against a fake GitHub: version compare, "available", download + SHA-256 check, and the
// installer command line that keeps this computer's mode and relay.   node test/update.mjs
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdater, newer } from "../src/update.js";

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : "  — " + extra}`); if (!ok) failed++; };

check("1.4.10 is newer than 1.4.9", newer("1.4.10", "1.4.9"));
check("v1.5.0 is newer than 1.4.1", newer("v1.5.0", "1.4.1"));
check("1.4.1 is not newer than 1.4.1", !newer("1.4.1", "1.4.1"));
check("1.4.0 is not newer than 1.4.1", !newer("1.4.0", "1.4.1"));

const exe = Buffer.from("MZ fake installer ".repeat(5000));
const sha = createHash("sha256").update(exe).digest("hex");
let release = { tag_name: "v1.5.0", assets: [{ name: "OBS-Remote-Setup.exe", size: exe.length, digest: "sha256:" + sha }] };
const server = createServer((req, res) => {
  if (req.url === "/repos/me/obs/releases/latest") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(release)); }
  if (req.url === "/dl/OBS-Remote-Setup.exe") { res.writeHead(200, { "content-length": exe.length }); return res.end(exe); }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
release.assets[0].browser_download_url = `${base}/dl/OBS-Remote-Setup.exe`;

const dir = mkdtempSync(join(tmpdir(), "obsr-upd-"));
const runs = [];
const make = (o = {}) => createUpdater({ repo: "me/obs", version: "1.4.1", dir, api: base, run: (file, args) => runs.push({ file, args }), config: () => ({ mode: "cloud", relay: "https://relay.example" }), ...o });

check("no repo means no update button", createUpdater({ repo: "", version: "1.4.1" }).status().state === "off");
check("a build from source has no update button", createUpdater({ repo: "me/obs", version: "dev" }).status().state === "off");

const u = make();
let s = await u.check();
check("newer release is offered", s.state === "available" && s.latest === "1.5.0", JSON.stringify(s));
await u.apply({ reopenSettings: true });
const r = runs[0];
check("installer is downloaded next to the agent", r && existsSync(r.file) && r.file.startsWith(dir));
check("installer keeps the cloud relay", r && r.args.join(" ") === "install --update --cloud --relay https://relay.example --reopen-settings", r && r.args.join(" "));
check("status says installing", u.status().state === "installing");

runs.length = 0;
const loc = make({ config: () => ({ mode: "local" }) });
await loc.check(); await loc.apply();
check("local mode stays local", runs[0]?.args.join(" ") === "install --update --local", runs[0]?.args.join(" "));

runs.length = 0;
release.assets[0].digest = "sha256:" + "0".repeat(64);
const bad = make();
await bad.check();
let threw = false;
try { await bad.apply(); } catch { threw = true; }
check("a download with the wrong checksum is refused", threw && runs.length === 0 && bad.status().state === "error");
check("and thrown away", !readdirSync(dir).some((f) => f.endsWith(".part")));

release = { ...release, tag_name: "v1.4.1" };
check("same version: up to date", (await make().check()).state === "none");
release = { tag_name: "v1.6.0", assets: [] };
check("a release without the installer is an error, not an offer", (await make().check()).state === "error");

server.close();
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
