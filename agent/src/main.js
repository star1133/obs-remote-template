// OBS Remote agent. Double-click = install. The OBS plugin it installs starts `run --hosted` with OBS and stops it with OBS.
//   obs-remote.exe [install|run|uninstall|status] [--relay URL] [--key KEY] [--open]
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
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
const VERSION = BAKED.version;
// Earlier versions started with Windows and had Start menu shortcuts; installing or removing cleans those up.
const STARTUP_VBS = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${APP}.vbs`);
// OBS 28+ also loads plugins from ProgramData, which ordinary users may write to (no admin prompt).
const PLUGIN_DIR = join(process.env.ProgramData || String.raw`C:\ProgramData`, "obs-studio", "plugins", "obs-remote");
const PLUGIN_DLL = join(PLUGIN_DIR, "bin", "64bit", "obs-remote.dll");
const PLUGIN = typeof __PLUGIN__ !== "undefined" ? __PLUGIN__ : "";
// The native settings window (settings/settings.c, about 100 KB): inlined by build.mjs, written next to the agent.
const SETTINGS = typeof __SETTINGS__ !== "undefined" ? __SETTINGS__ : "";
const SETTINGS_EXE = join(DIR, "obs-remote-settings.exe");

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
  return obsPid() > 0;
}

/** Process id of the running OBS, 0 when it is closed. */
function obsPid() {
  try {
    const m = /"obs64\.exe","(\d+)"/i.exec(execFileSync("tasklist", ["/FI", "IMAGENAME eq obs64.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true }));
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

function killAgents() {
  try { execFileSync("taskkill", ["/F", "/IM", EXE_NAME, "/FI", `PID ne ${process.pid}`], { stdio: "ignore", windowsHide: true }); } catch { /* none running */ }
  try { execFileSync("taskkill", ["/F", "/IM", "obs-remote-settings.exe"], { stdio: "ignore", windowsHide: true }); } catch { /* not open */ }
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


/** Windows "Apps & features" entry, so OBS Remote can be removed like any other program. */
function registerWithWindows() {
  const reg = (name, type, value) => execFileSync("reg", ["add", UNINSTALL_KEY, "/v", name, "/t", type, "/d", String(value), "/f"], { stdio: "ignore", windowsHide: true });
  try {
    reg("DisplayName", "REG_SZ", APP); reg("DisplayVersion", "REG_SZ", VERSION); reg("Publisher", "REG_SZ", APP);
    reg("DisplayIcon", "REG_SZ", `${INSTALLED},0`); reg("InstallLocation", "REG_SZ", DIR);
    reg("UninstallString", "REG_SZ", `"${INSTALLED}" uninstall`);
    reg("NoModify", "REG_DWORD", 1); reg("NoRepair", "REG_DWORD", 1);
    reg("EstimatedSize", "REG_DWORD", Math.round(statSync(INSTALLED).size / 1024));
  } catch { /* the program still works without the Apps list entry */ }
}

/** Shortcuts earlier versions put on the desktop and in the Start menu. Everything is in OBS now (Tools → OBS Remote), so
 *  installing removes them. */
const LINKS = [["OBS Remote.lnk", "", ""], ["YouTube to OBS.lnk", "", ""]];
const psQuote = (x) => `'${String(x).replace(/'/g, "''")}'`;
function shortcuts(add) {
  const one = ([name, args, desc]) => add
    ? `$l = $s.CreateShortcut((Join-Path $d ${psQuote(name)})); $l.TargetPath = ${psQuote(SETTINGS_EXE)}; $l.Arguments = ${psQuote(args)}; $l.IconLocation = ${psQuote(INSTALLED + ",0")}; $l.Description = ${psQuote(desc)}; $l.Save()`
    : `Remove-Item -LiteralPath (Join-Path $d ${psQuote(name)}) -Force -ErrorAction SilentlyContinue`;
  const ps = `$s = New-Object -ComObject WScript.Shell; foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { ${LINKS.map(one).join("; ")} }`;
  try { execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", windowsHide: true }); return true; } catch { return false; }
}

function installSettings() {
  if (!SETTINGS) return false;
  writeFileSync(SETTINGS_EXE, Buffer.from(SETTINGS, "base64"));
  return true;
}

function unregisterFromWindows() {
  try { execFileSync("reg", ["delete", UNINSTALL_KEY, "/f"], { stdio: "ignore", windowsHide: true }); } catch { /* not there */ }
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

function obsExe() {
  let dir = String.raw`C:\Program Files\obs-studio`;
  try { dir = /REG_SZ\s+(.+)/.exec(execFileSync("reg", ["query", String.raw`HKLM\SOFTWARE\OBS Studio`, "/ve"], { encoding: "utf8", windowsHide: true }))[1].trim(); } catch { /* default path */ }
  const exe = join(dir, "bin", "64bit", "obs64.exe");
  return existsSync(exe) ? exe : null;
}

function startObs() {
  const exe = obsExe();
  if (!exe) return false;
  spawn(exe, [], { cwd: dirname(exe), detached: true, stdio: "ignore" }).unref(); // OBS needs its own folder as cwd
  return true;
}

/** OBS keeps its settings in memory and writes them on exit, so the dock and WebSocket settings need it closed. */
async function waitForObsToClose() {
  if (!obsRunning() || !process.stdin.isTTY) return false;
  say("     OBS is open. Close OBS to continue; this window waits for it.");
  const end = Date.now() + 15 * 60_000;
  while (obsRunning() && Date.now() < end) await new Promise((r) => setTimeout(r, 1000));
  await new Promise((r) => setTimeout(r, 1500)); // let OBS finish writing its settings
  return !obsRunning();
}

/** A plugin file OBS has loaded can't be overwritten or deleted, only renamed; the renamed copies go next time. */
function retirePlugin() {
  const bin = dirname(PLUGIN_DLL);
  try { for (const f of readdirSync(bin)) if (f.endsWith(".old")) try { rmSync(join(bin, f)); } catch { /* still loaded */ } } catch { /* no folder yet */ }
  try { renameSync(PLUGIN_DLL, `${PLUGIN_DLL}.${Date.now()}.old`); } catch { /* not there */ }
}

function installPlugin() {
  if (!PLUGIN) throw new Error("this build has no OBS plugin inside (build it with npm run build in agent/).");
  mkdirSync(dirname(PLUGIN_DLL), { recursive: true });
  retirePlugin();
  writeFileSync(PLUGIN_DLL, Buffer.from(PLUGIN, "base64"));
}

/** True when the folder is gone; false when OBS is open and has the plugin loaded (it is then renamed so OBS skips it). */
function removePlugin() {
  retirePlugin();
  try { rmSync(PLUGIN_DIR, { recursive: true, force: true }); return true; } catch { return false; }
}

function removeOldVersionBits() {
  try { rmSync(STARTUP_VBS, { force: true }); } catch { /* not there */ }
  try { rmSync(MENU_DIR, { recursive: true, force: true }); } catch { /* not there */ }
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
  removeOldVersionBits();
  await new Promise((r) => setTimeout(r, 400));

  say("2/5  Copying program files");
  mkdirSync(DIR, { recursive: true });
  if (process.execPath.toLowerCase() !== INSTALLED.toLowerCase()) copyFileSync(process.execPath, INSTALLED);

  say(mode === "cloud" ? "3/5  Registering with the relay" : "3/5  Preparing this computer as the relay");
  const prev = loadConfig();
  const cfg = await ensureRegistered({ relay, key: opt("key"), mode });
  if (prev.room !== cfg.room) say(`     new room ${cfg.room}`);

  say("4/5  Adding OBS Remote to OBS");
  const closedObs = await waitForObsToClose();
  installPlugin();
  say("     Installed the plugin: OBS Remote now starts and stops with OBS.");
  if (installSettings()) say("     Installed the settings window: OBS → Tools → OBS Remote.");
  // YouTube to OBS (1.3) is gone: its Chrome profile and extension folder go too.
  for (const old of ["youtube-browser", "chrome-extension"]) try { rmSync(join(DIR, old), { recursive: true, force: true }); } catch { /* still open */ }
  const ws = readObsWsConfig();
  if (ws?.enabled) say("     OBS WebSocket server is already on, leaving your settings alone.");
  else if (obsRunning()) say("     OBS is running, so its WebSocket setting can't be changed now.\n     In OBS: Tools → WebSocket Server Settings → enable the server.");
  else { enableObsWebSocket(); say("     Enabled the WebSocket server (port 4455) with a random password."); }
  // Earlier versions put the whole settings page in an OBS browser dock; the native window replaces it.
  if (!obsRunning() && setObsDock(null)) say("     Removed the old OBS Remote browser dock (settings have their own window now).");

  say("5/5  Adding OBS Remote to the Windows Apps list");
  registerWithWindows();
  shortcuts(false); // nothing to open besides OBS: settings are under Tools → OBS Remote

  say();
  if (flag("update")) { // from the Update button: OBS stays as it is, the new agent takes over inside it
    const pid = obsPid();
    if (pid) spawn(INSTALLED, ["run", "--hosted", "--parent", String(pid)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    if (flag("reopen-settings") && existsSync(SETTINGS_EXE)) spawn(SETTINGS_EXE, [`--port=${SETUP_PORT}`], { detached: true, stdio: "ignore" }).unref();
    log(`updated to ${VERSION}${pid ? "" : " (OBS is closed, so it starts with OBS)"}`);
    say(`Updated to ${VERSION}.`);
  } else if (obsRunning()) {
    say("Done. Restart OBS to load OBS Remote.");
  } else if (process.env.OBSR_NO_OBS !== "1" && startObs()) {
    say(`Done. ${closedObs ? "Opening OBS again" : "Opening OBS"}: the QR code is under Tools → OBS Remote.`);
  } else say("Done. Open OBS: the QR code is under Tools → OBS Remote.");
}

function uninstall() {
  say(`Removing ${APP}\n`);
  killAgents();
  removeOldVersionBits();
  if (removePlugin()) say("- removed the OBS plugin");
  else say("- OBS is open: the plugin is switched off and its folder goes after the next uninstall or reinstall");
  unregisterFromWindows(); say("- removed the Apps list entry");
  shortcuts(false); say("- removed the desktop and Start menu shortcuts");
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
  const hosted = flag("hosted");
  const parent = Number(opt("parent")) || 0;
  log(`starting (pid ${process.pid}${hosted ? ", inside OBS" : ""})`);
  const agent = await runAgent({ log, open: flag("open"), notify: flag("notify"), hosted,
    restartArgs: hosted ? ["--hosted", ...(parent ? ["--parent", String(parent)] : [])] : [], onQuit: (o) => { if (o.noStartup) rmSync(STARTUP_VBS, { force: true }); },
    onUninstall: () => spawn(INSTALLED, ["uninstall", "--quiet"], { detached: true, stdio: "ignore", windowsHide: true }).unref() });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { agent.stop(); process.exit(0); });
  // The plugin's job object already ends us with OBS; this covers the case where Windows refused the job.
  if (parent) setInterval(() => { try { process.kill(parent, 0); } catch { log("OBS closed"); agent.stop(); process.exit(0); } }, 2000).unref();
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
      if (existsSync(SETTINGS_EXE)) spawn(SETTINGS_EXE, [], { detached: true, stdio: "ignore" }).unref();
      else if (await alreadyRunning()) openBrowser(`http://127.0.0.1:${SETUP_PORT}/`);
      else { say("OBS Remote runs inside OBS. Open OBS, then Docks → OBS Remote (or Tools → OBS Remote)."); await pause(); }
      process.exit(0);
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
