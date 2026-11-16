// Agent config + the obs-websocket config file that ships with OBS 28+.
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export const APP = "OBS Remote";
export const DIR = process.env.OBSR_HOME || join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), APP);
export const CONFIG_FILE = join(DIR, "config.json");
export const SETUP_PORT = Number(process.env.OBSR_PORT) || 47890;

// Baked in by build.mjs (--define). Overridable per install with --relay / relay.json next to the exe.
export const BAKED = {
  relay: typeof __RELAY__ !== "undefined" ? __RELAY__ : "",
  key: typeof __REGKEY__ !== "undefined" ? __REGKEY__ : "",
  // From source (tests) OBSR_VERSION / OBSR_UPDATE_REPO stand in for them.
  version: typeof __VERSION__ !== "undefined" ? __VERSION__ : process.env.OBSR_VERSION || "dev",
  /** GitHub "owner/repo" whose latest release is the update (UPDATE_REPO at build time); empty = no update button. */
  updates: typeof __UPDATES__ !== "undefined" ? __UPDATES__ : process.env.OBSR_UPDATE_REPO || "",
};

export function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

// ---- Backups: the room and every paired phone hang on config.json (and relay-state.json in local mode) ---------
const BACKUP_DIR = join(DIR, "backup");
const KEEP = 10;

/** Copy config.json and relay-state.json to DIR\backup before an install changes anything. Keeps the last 10. */
export function backupConfig(reason = "install") {
  if (!existsSync(CONFIG_FILE)) return "";
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(BACKUP_DIR, `${stamp}-${reason}`);
    mkdirSync(dir);
    for (const f of ["config.json", "relay-state.json"]) if (existsSync(join(DIR, f))) writeFileSync(join(dir, f), readFileSync(join(DIR, f)), { mode: 0o600 });
    const all = readdirSync(BACKUP_DIR).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) rmSync(join(BACKUP_DIR, old), { recursive: true, force: true });
    return dir;
  } catch { return ""; }
}

/** The newest backed-up identity for this relay ({ room, deviceToken }), so a reinstall finds its room again instead
 *  of registering a new one (which would sign out every paired phone). */
export function backedUpIdentity(mode, relay = "") {
  let all = [];
  try { all = readdirSync(BACKUP_DIR).sort().reverse(); } catch { return null; }
  for (const d of all) {
    let c;
    try { c = JSON.parse(readFileSync(join(BACKUP_DIR, d, "config.json"), "utf8")); } catch { continue; }
    for (const id of [c, c.saved?.[mode]]) {
      if (id?.room && id?.deviceToken && (id === c ? c.mode === mode : true) && (mode === "local" || id.relay === relay)) return { room: id.room, deviceToken: id.deviceToken };
    }
  }
  return null;
}

export function saveConfig(c) {
  mkdirSync(DIR, { recursive: true });
  const tmp = CONFIG_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  renameSync(tmp, CONFIG_FILE);
}

// ---- obs-websocket's own config ---------------------------------------------------------------

export const OBS_WS_CONFIG = join(process.env.APPDATA ?? join(homedir(), ".config"), "obs-studio", "plugin_config", "obs-websocket", "config.json");

/** What OBS has configured for its WebSocket server (null when OBS never ran / file unreadable). */
export function readObsWsConfig() {
  try {
    const j = JSON.parse(readFileSync(OBS_WS_CONFIG, "utf8"));
    return { enabled: !!j.server_enabled, port: j.server_port || 4455, auth: j.auth_required !== false, password: j.server_password || "", raw: j };
  } catch {
    return null;
  }
}

/** Turn the WebSocket server on (only call while OBS is closed: OBS rewrites the file on exit).
 *  Keeps an existing password; otherwise sets a random one. Returns what is now configured. */
export function enableObsWebSocket() {
  const cur = readObsWsConfig();
  const raw = cur?.raw ?? {};
  const password = raw.server_password || randomBytes(9).toString("base64url");
  const next = { ...raw, alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_port: raw.server_port || 4455, server_password: password };
  mkdirSync(join(OBS_WS_CONFIG, ".."), { recursive: true });
  if (existsSync(OBS_WS_CONFIG)) writeFileSync(OBS_WS_CONFIG + ".bak", readFileSync(OBS_WS_CONFIG));
  writeFileSync(OBS_WS_CONFIG, JSON.stringify(next, null, 4));
  return { enabled: true, port: next.server_port, auth: true, password };
}

// ---- OBS custom browser dock (shows the QR / status inside OBS itself) -------------------------

const OBS_DIR = join(process.env.APPDATA ?? join(homedir(), ".config"), "obs-studio");
export const DOCK_TITLE = "OBS Remote";

/** Where OBS keeps the ExtraBrowserDocks list: user.ini on OBS 31+, global.ini before. */
function dockIniPath() {
  for (const f of ["user.ini", "global.ini"]) {
    const p = join(OBS_DIR, f);
    try { if (/^ExtraBrowserDocks=/m.test(readFileSync(p, "utf8"))) return p; } catch { /* next */ }
  }
  const p = join(OBS_DIR, "user.ini");
  return existsSync(p) ? p : null;
}

/** Add (url) or remove (null) the OBS Remote dock. Only call while OBS is closed. Returns true if the file changed. */
export function setObsDock(url) {
  const file = dockIniPath();
  if (!file) return false;
  const text = readFileSync(file, "utf8");
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const m = text.match(/^ExtraBrowserDocks=(.*)$/m);
  let docks = [];
  try { docks = m ? JSON.parse(m[1]) : []; } catch { return false; } // unknown format: leave it alone
  if (!Array.isArray(docks)) return false;
  const rest = docks.filter((d) => d?.title !== DOCK_TITLE);
  const next = url ? [...rest, { title: DOCK_TITLE, url, uuid: randomUUID() }] : rest;
  const same = docks.length === next.length && (!url || docks.some((d) => d?.title === DOCK_TITLE && d.url === url));
  if (same) return false;
  const line = `ExtraBrowserDocks=${JSON.stringify(next)}`;
  let out;
  if (m) out = text.replace(/^ExtraBrowserDocks=.*$/m, () => line);
  else if (/^\[BasicWindow\]/m.test(text)) out = text.replace(/^\[BasicWindow\]\r?\n/m, (h) => h + line + nl);
  else return false;
  writeFileSync(file + ".obsremote.bak", text);
  writeFileSync(file, out);
  return true;
}
