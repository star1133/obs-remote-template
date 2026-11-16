// Pairing backups: an install copies config.json first, and a lost config finds its room again instead of registering
// a new one (which would sign out every paired phone).   node test/backup.mjs
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OBSR_HOME = mkdtempSync(join(tmpdir(), "obsr-bak-"));
const { backupConfig, backedUpIdentity, saveConfig, loadConfig, DIR } = await import("../src/config.js");
const { ensureRegistered } = await import("../src/agent.js");

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : "  — " + extra}`); if (!ok) failed++; };

check("no config, nothing to back up", backupConfig() === "");

const RELAY = "https://relay.example";
saveConfig({ mode: "cloud", relay: RELAY, room: "abcdefghij", deviceToken: "t".repeat(64), saved: { local: { relay: "", room: "localroomxx", deviceToken: "l".repeat(64) } } });
writeFileSync(join(DIR, "relay-state.json"), "{}");
const dir = backupConfig("test");
check("install backs up config.json and relay-state.json", dir && readdirSync(dir).sort().join(",") === "config.json,relay-state.json", dir);

check("finds the cloud room for the same relay", backedUpIdentity("cloud", RELAY)?.room === "abcdefghij");
check("not for another relay", backedUpIdentity("cloud", "https://other.example") === null);
check("finds the parked local room", backedUpIdentity("local")?.room === "localroomxx");

// The config is lost (an old installer, a crash): the next start must come back to the same room without registering.
rmSync(join(DIR, "config.json"));
const cfg = await ensureRegistered({ relay: RELAY, mode: "cloud" }).catch((e) => ({ error: e.message }));
check("a lost config gets its room back, no new registration", cfg.room === "abcdefghij" && cfg.deviceToken === "t".repeat(64), JSON.stringify(cfg));
check("and saves it", loadConfig().room === "abcdefghij");

for (let i = 0; i < 14; i++) backupConfig("n" + String(i).padStart(2, "0"));
check("keeps only the last 10 backups", readdirSync(join(DIR, "backup")).length === 10);

rmSync(DIR, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
