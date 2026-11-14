// OBS Remote agent. Double-click = install (or open the setup page when already installed).
//   obs-remote.exe [install|run|uninstall|status] [--relay URL] [--key KEY] [--open]
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isSea } from "node:sea";
import { basename, dirname, join } from "node:path";
import { APP, BAKED, CONFIG_FILE, DIR, SETUP_PORT, enableObsWebSocket, loadConfig, readObsWsConfig, saveConfig, setObsDock } from "./config.js";
import { chosenMode, ensureRegistered, runAgent } from "./agent.js";
import { alreadyRunning, openBrowser } from "./setup-server.js";

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--"));
const flag = (n) => args.includes("--" + n);
const opt = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };

const EXE_NAME = "obs-remote.exe";
const INSTALLED = join(DIR, EXE_NAME);
const LOG_FILE = join(DIR, "agent.log");
const UNINSTALL_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\OBSRemote`;
const MENU_DIR = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", APP);
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";
const STARTUP_VBS = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${APP}.vbs`);

function log(...a) {
  const line = `${new Date().toISOString().replace("T", " ").slice(0, 19)} ${a.join(" ")}`;
  try {
    mkdirSync(DIR, { recursive: true });
    try { if (statSync(LOG_FILE).size > 1_000_000) renameSync(LOG_FILE, LOG_FILE + ".old"); } catch { /* no log yet */ }
    appendFileSync(LOG_FILE, line + "\n");
  } catch { /* never let logging kill the agent */ }
  if (process.stdout.isTTY) console.log(line);
}

const say = (s = "") => console.log(s);

function obsRunning() {
  try {
    return /obs64\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq obs64.exe", "/NH"], { encoding: "utf8", windowsHide: true }));
  } catch { return false; }
}

function killAgents() {
  try { execFileSync("taskkill", ["/F", "/IM", EXE_NAME, "/FI", `PID ne ${process.pid}`], { stdio: "ignore", windowsHide: true }); } catch { /* none running */ }
}

function relayFromArgs() {
  let relay = opt("relay") || "";
  // A relay.json next to the installer overrides the baked-in address (lets one exe serve many relays).
  try { relay ||= JSON.parse(readFileSync(join(dirname(process.execPath), "relay.json"), "utf8")).relay || ""; } catch { /* optional */ }
  relay ||= BAKED.relay;
  relay = relay.trim().replace(/\/+$/, "");
  if (relay && !/^https:\/\/[^\s/]+$/i.test(relay) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(relay)) throw new Error(`"${relay}" is not a valid relay address (expected https://something.workers.dev).`);
  return relay;
}


/** Windows "Apps & features" entry + Start menu shortcuts, so the program can be opened, quit and removed like any other. */
function registerWithWindows() {
  const reg = (name, type, value) => execFileSync("reg", ["add", UNINSTALL_KEY, "/v", name, "/t", type, "/d", String(value), "/f"], { stdio: "ignore", windowsHide: true });
  try {
    reg("DisplayName", "REG_SZ", APP); reg("DisplayVersion", "REG_SZ", VERSION); reg("Publisher", "REG_SZ", APP);
    reg("DisplayIcon", "REG_SZ", `${INSTALLED},0`); reg("InstallLocation", "REG_SZ", DIR);
    reg("UninstallString", "REG_SZ", `"${INSTALLED}" uninstall`);
    reg("NoModify", "REG_DWORD", 1); reg("NoRepair", "REG_DWORD", 1);
    reg("EstimatedSize", "REG_DWORD", Math.round(statSync(INSTALLED).size / 1024));
  } catch { /* the program still works without the Apps list entry */ }
  try {
    mkdirSync(MENU_DIR, { recursive: true });
    const ps = [APP, "Quit " + APP, "Uninstall " + APP].map((name, i) => {
      const arg = ["open", "quit", "uninstall"][i];
      return `$l=$w.CreateShortcut('${join(MENU_DIR, name + ".lnk").replace(/'/g, "''")}');$l.TargetPath='${INSTALLED.replace(/'/g, "''")}';$l.Arguments='${arg}';$l.IconLocation='${INSTALLED.replace(/'/g, "''")},0';$l.Save()`;
    });
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$w=New-Object -ComObject WScript.Shell;" + ps.join(";")], { stdio: "ignore", windowsHide: true });
  } catch { /* shortcuts are a convenience */ }
}

function unregisterFromWindows() {
  try { execFileSync("reg", ["delete", UNINSTALL_KEY, "/f"], { stdio: "ignore", windowsHide: true }); } catch { /* not there */ }
  try { rmSync(MENU_DIR, { recursive: true, force: true }); } catch { /* not there */ }
}

/** First install asks how phones should reach this computer; an update keeps the earlier answer. */
async function pickMode() {
  if (flag("local")) return "local";
  if (flag("cloud")) return "cloud";
  const prev = loadConfig().mode;
  if (!BAKED.relay && !opt("relay")) return "local";
  if (prev && !flag("choose")) return prev;
  if (!process.stdin.isTTY) return "cloud";
  const host = (opt("relay") || BAKED.relay).replace(/^https?:\/\//, "");
  say(`How should your phone reach OBS on this computer?\n`);
  say(`  1  Through ${host}  (recommended: permanent link, works anywhere)`);
  say(`  2  100% on this computer  (free temporary Cloudflare link, nothing goes through our server)\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question("Type 1 or 2 and press Enter [1]: ", r));
  rl.close();
  say();
  return a.trim() === "2" ? "local" : "cloud";
}

function startHidden(notify = false) {
  spawn(INSTALLED, notify ? ["run", "--notify"] : ["run"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

async function install() {
  say(`Installing ${APP}\n`);
  if (!isSea()) throw new Error("install only works from the built .exe (npm run build in agent/).");

  const relay = relayFromArgs();
  const mode = await pickMode();
  say(mode === "local" ? "Mode: 100% on this computer (its own relay, free Cloudflare link, no account).\n" : `Mode: connect through ${(relay || BAKED.relay).replace(/^https?:\/\//, "")}\n`);

  say("1/5  Stopping any running copy");
  killAgents();
  await new Promise((r) => setTimeout(r, 400));

  say("2/5  Copying program files");
  mkdirSync(DIR, { recursive: true });
  if (process.execPath.toLowerCase() !== INSTALLED.toLowerCase()) copyFileSync(process.execPath, INSTALLED);

  say(mode === "cloud" ? "3/5  Registering with the relay" : "3/5  Preparing this computer as the relay");
  const prev = loadConfig();
  const cfg = await ensureRegistered({ relay, key: opt("key"), mode });
  if (prev.room !== cfg.room) say(`     new room ${cfg.room}`);

  say("4/5  Setting up OBS");
  const ws = readObsWsConfig();
  if (ws?.enabled) say("     OBS WebSocket server is already on — leaving your settings alone.");
  else if (obsRunning()) say("     OBS is running, so its settings can't be changed now.\n     Easiest: close OBS and run this installer again.\n     Or in OBS: Tools → WebSocket Server Settings → enable the server.");
  else { enableObsWebSocket(); say("     Enabled the WebSocket server (port 4455) with a random password."); }
  if (obsRunning()) say("     The OBS Remote dock could not be added while OBS is open (see below).");
  else if (setObsDock(`http://127.0.0.1:${SETUP_PORT}/dock`)) say('     Added the "OBS Remote" dock to OBS (Docks menu).');
  else say("     The OBS Remote dock is already in OBS.");

  say("5/5  Starting automatically with Windows");
  if (process.env.OBSR_NO_STARTUP === "1") say("     (skipped: OBSR_NO_STARTUP)");
  else {
    mkdirSync(dirname(STARTUP_VBS), { recursive: true });
    writeFileSync(STARTUP_VBS, `' ${APP}: starts the background agent without a window.\r\nCreateObject("WScript.Shell").Run """${INSTALLED}"" run", 0, False\r\n`);
  }

  say("     Added to Windows Apps list and the Start menu.");
  registerWithWindows();

  startHidden(true);
  const up = await waitFor(alreadyRunning, 8000);
  say();
  if (up) {
    say("Done. Nothing was opened in your browser.");
    say("In OBS: Docks → OBS Remote (QR code and the control-page button). Right-click the tray icon near the clock to open or quit.");
  } else say(`The agent did not start. See ${LOG_FILE}`);
  if (obsRunning()) say(`\nOBS is open right now. Close it and run this installer once more to add the dock,\nor in OBS use Docks → Custom Browser Docks → name "OBS Remote", URL http://127.0.0.1:${SETUP_PORT}/dock`);
}

function uninstall() {
  say(`Removing ${APP}\n`);
  killAgents();
  try { rmSync(STARTUP_VBS, { force: true }); say("- removed startup entry"); } catch { /* */ }
  unregisterFromWindows(); say("- removed Start menu shortcuts and the Apps list entry");
  if (obsRunning()) say("- OBS is open: remove the OBS Remote dock yourself (Docks → Custom Browser Docks)");
  else if (setObsDock(null)) say("- removed the OBS dock");
  if (flag("keep-data")) say(`- kept ${DIR}`);
  else {
    // The running exe can't delete itself; hand the folder to a helper that waits for us to exit.
    spawn("cmd", ["/d", "/s", "/c", `"ping -n 4 127.0.0.1 >nul & rmdir /s /q "${DIR}""`], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
    say("- removing program files and saved pairing");
  }
  say("\nOBS's own WebSocket setting was left as it is. Paired phones stop working.");
}

async function status() {
  const c = loadConfig();
  say(`config:   ${CONFIG_FILE}`);
  say(`relay:    ${c.relay || "(none)"}   room: ${c.room || "(none)"}`);
  say(`obs ws:   ${JSON.stringify((({ raw, password, ...r }) => r)(readObsWsConfig() ?? { enabled: false }))}`);
  say(`obs open: ${obsRunning()}`);
  try {
    const s = await (await fetch(`http://127.0.0.1:${SETUP_PORT}/api/status`, { signal: AbortSignal.timeout(1500) })).json();
    say(`agent:    running — obs ${s.obs.state} (${s.obs.detail}), relay ${s.relay.state}, ${s.devices.length} device(s)`);
  } catch { say("agent:    not running"); }
}

async function run() {
  if (flag("wait")) await waitFor(async () => !(await alreadyRunning()), 10000); // a restart: let the old copy leave first
  if (await alreadyRunning()) {
    if (flag("open")) openBrowser(`http://127.0.0.1:${SETUP_PORT}/`);
    return log("agent already running");
  }
  log(`starting (pid ${process.pid})`);
  const agent = await runAgent({ log, open: flag("open"), notify: flag("notify"), onQuit: (o) => { if (o.noStartup) rmSync(STARTUP_VBS, { force: true }); },
    onUninstall: () => spawn(INSTALLED, ["uninstall", "--quiet"], { detached: true, stdio: "ignore", windowsHide: true }).unref() });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { agent.stop(); process.exit(0); });
}

async function pause() {
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question("\nPress Enter to close this window…", r));
  rl.close();
}

process.on("uncaughtException", (e) => log("uncaught:", e.stack || e));
process.on("unhandledRejection", (e) => log("unhandled:", e?.stack || e));

async function main() {
try {
  if (cmd === "run") await run();
  else if (cmd === "install") { await install(); await pause(); process.exit(0); }
  else if (cmd === "uninstall") { uninstall(); if (!flag("quiet")) await pause(); process.exit(0); }
  else if (cmd === "quit") { killAgents(); say("OBS Remote stopped."); process.exit(0); }
  else if (cmd === "open") { // Start menu entry: make sure it runs, then show the settings page
    if (!(await alreadyRunning())) { startHidden(); await waitFor(alreadyRunning, 8000); }
    openBrowser(`http://127.0.0.1:${SETUP_PORT}/`);
    process.exit(0);
  }
  else if (cmd === "status") { await status(); process.exit(0); }
  else if (!cmd) {
    // Double-click: installed copy opens the setup page, anything else installs.
    if (existsSync(INSTALLED) && basename(process.execPath).toLowerCase() === EXE_NAME) {
      if (!(await alreadyRunning())) { startHidden(true); await waitFor(alreadyRunning, 8000); }
      process.exit(0); // the tray icon (near the clock) is the way in; no browser pops up
    }
    await install();
    await pause();
    process.exit(0);
  } else { say("usage: obs-remote [install | run | open | quit | uninstall | status] [--cloud | --local] [--relay URL] [--key KEY]"); process.exit(1); }
} catch (e) {
  say(`\nSomething went wrong: ${e.message}`);
  log("fatal:", e.stack || e);
  await pause();
  process.exit(1);
}
}

main();
