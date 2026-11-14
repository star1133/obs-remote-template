// Unit check of the OBS dock ini editing against a temp APPDATA (never touches the real OBS config).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "obsr-dock-"));
process.env.APPDATA = root;
mkdirSync(join(root, "obs-studio"));
const ini = join(root, "obs-studio", "user.ini");
const { setObsDock } = await import("../src/config.js");
let bad = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) bad++; };

writeFileSync(ini, "[General]\r\nA=1\r\n\r\n[BasicWindow]\r\nDockState=xyz\r\nExtraBrowserDocks=[]\r\nDocksLocked=false\r\n");
ok(setObsDock("http://127.0.0.1:47890/dock") === true, "adds the dock");
let t = readFileSync(ini, "utf8");
ok(/ExtraBrowserDocks=\[\{"title":"OBS Remote","url":"http:\/\/127.0.0.1:47890\/dock","uuid":"[0-9a-f-]+"\}\]/.test(t), "writes OBS's JSON format");
ok(t.includes("\r\nDocksLocked=false\r\n") && t.includes("DockState=xyz"), "leaves other settings and line endings alone");
ok(setObsDock("http://127.0.0.1:47890/dock") === false, "adding twice changes nothing");
writeFileSync(ini, t.replace("[]", "[]").replace(/ExtraBrowserDocks=\[/, 'ExtraBrowserDocks=[{"title":"Chat","url":"https://x","uuid":"u1"},'));
ok(setObsDock("http://127.0.0.1:47890/dock") === false, "keeps the user's other docks (and still has ours)");
ok(/"Chat"/.test(readFileSync(ini, "utf8")), "other dock survives");
ok(setObsDock(null) === true && !/OBS Remote/.test(readFileSync(ini, "utf8")) && /"Chat"/.test(readFileSync(ini, "utf8")), "removing only removes ours");
writeFileSync(ini, "[BasicWindow]\nDockState=q\n");
ok(setObsDock("http://x/dock") === true && /ExtraBrowserDocks=/.test(readFileSync(ini, "utf8")), "creates the key when missing");
writeFileSync(ini, "[BasicWindow]\nExtraBrowserDocks=not json\n");
ok(setObsDock("http://x/dock") === false, "unknown format is left untouched");
console.log(bad ? `${bad} FAILED` : "all passed");
process.exit(bad ? 1 : 0);
