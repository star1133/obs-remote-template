// Ties config, relay link, OBS bridge and the local setup page together.
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadConfig, saveConfig, readObsWsConfig, BAKED, DIR, SETUP_PORT } from "./config.js";
import { startLocalRelay, newIdentity } from "./localrelay.js";
import { createTunnel } from "./tunnel.js";
import { loadAssets } from "./assets.js";
import { startTray } from "./tray.js";
import { createBridge, cleanLayout } from "./bridge.js";
import { readFileSync, writeFileSync } from "node:fs";
import { createRelayLink } from "./relay.js";
import { startSetupServer } from "./setup-server.js";
import { existsSync } from "node:fs";

/** Create the room on the relay once and remember the device token. */
export async function register(relay, key) {
  const res = await fetch(relay.replace(/\/+$/, "") + "/api/register", {
    method: "POST",
    headers: key ? { "x-registration-key": key } : {},
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 403) throw new Error("The relay refused this installer (registration key missing or wrong).");
  if (!res.ok) throw new Error(`The relay answered ${res.status}.`);
  const j = await res.json();
  if (!j.room || !j.deviceToken) throw new Error("Unexpected answer from the relay.");
  return j;
}

/** Which way this computer reaches phones: "cloud" (a relay you deploy on Cloudflare) or "local" (its own relay + free tunnel). */
export function chosenMode(cfg, want) {
  if (want === "cloud" || want === "local") return want;
  if (cfg.mode === "cloud" || cfg.mode === "local") return cfg.mode;
  return BAKED.relay || cfg.relay ? "cloud" : "local";
}

/** Make sure there is an identity for the wanted mode. Each mode keeps its own pairing, so switching back needs no new scan. */
export async function ensureRegistered(opts = {}) {
  let cfg = loadConfig();
  const relay = (opts.relay || BAKED.relay || cfg.saved?.cloud?.relay || cfg.relay || "").replace(/\/+$/, "");
  let mode = chosenMode(cfg, opts.mode);
  if (mode === "cloud" && !relay) mode = "local";

  if (cfg.mode && cfg.mode !== mode && cfg.room && cfg.deviceToken) { // park the identity of the mode we leave
    cfg.saved = { ...cfg.saved, [cfg.mode]: { relay: cfg.relay, room: cfg.room, deviceToken: cfg.deviceToken } };
  }
  const back = cfg.mode !== mode ? cfg.saved?.[mode] : null;
  if (back?.room && back?.deviceToken && (mode === "local" || back.relay === relay)) {
    cfg = { ...cfg, mode, relay: mode === "cloud" ? relay : "", room: back.room, deviceToken: back.deviceToken };
    saveConfig(cfg);
    return cfg;
  }

  if (mode === "local") {
    if (cfg.mode === "local" && cfg.room && cfg.deviceToken) return cfg;
    const id = newIdentity();
    const next = { ...cfg, mode, relay: "", room: id.room, deviceToken: id.deviceToken, created: Date.now() };
    saveConfig(next);
    return next;
  }
  if (cfg.mode === "cloud" && cfg.room && cfg.deviceToken && cfg.relay === relay) return cfg;
  const r = await register(relay, opts.key ?? BAKED.key);
  const next = { ...cfg, mode, relay, room: r.room, deviceToken: r.deviceToken, created: Date.now() };
  saveConfig(next);
  return next;
}

export async function runAgent({ log = console.log, open = false, notify = false, hosted = false, restartArgs = [], onQuit = () => {}, onUninstall = () => {} } = {}) {
  const cfg = await ensureRegistered();
  const started = Date.now(); // lets the setup page notice a restart (mode switch, OBS restart) and reload
  let devices = [];
  let local = null, tunnel = null, tray = null, linkRelay = cfg.relay;
  if (cfg.mode === "local") {
    local = await startLocalRelay({ stateFile: join(DIR, "relay-state.json"), room: cfg.room, deviceToken: cfg.deviceToken, assets: loadAssets(), log });
    linkRelay = local.url;
    if (process.env.OBSR_NO_TUNNEL !== "1") { tunnel = createTunnel({ dir: DIR, port: local.port, log }); tunnel.start(); }
  }
  /** The address phones use: the Cloudflare relay, or this computer's tunnel ("" until it is up). */
  const publicUrl = () => (cfg.mode === "local" ? tunnel?.url() || (process.env.OBSR_NO_TUNNEL === "1" ? local.url : "") : cfg.relay);
  const waiters = [];

  const getObsConf = () => {
    const f = readObsWsConfig();
    const c = loadConfig();
    return { host: "127.0.0.1", port: c.obsPort || f?.port || 4455, password: c.obsPassword ?? (f?.auth === false ? "" : f?.password ?? "") };
  };

  let link;
  // User-made buttons live on this computer (next to OBS), so every phone sees the same ones.
  const layoutFile = join(DIR, "layout.json");
  const layout = {
    load: () => { try { return cleanLayout(JSON.parse(readFileSync(layoutFile, "utf8"))); } catch { return { buttons: [] }; } },
    save: (l) => writeFileSync(layoutFile, JSON.stringify(l, null, 2)),
  };
  // What each scene last looked like on air, so Present mode has a picture for every screen, even after a restart.
  const picturesFile = join(DIR, "scene-pictures.json");
  let picturesTimer = null, picturesNext = null;
  const pictures = {
    load: () => { try { return JSON.parse(readFileSync(picturesFile, "utf8")); } catch { return {}; } },
    save: (p) => { // at most every 5 s: a live video changes its picture all the time
      picturesNext = p;
      picturesTimer ??= setTimeout(() => { picturesTimer = null; try { writeFileSync(picturesFile, JSON.stringify(picturesNext)); } catch { /* next change retries */ } }, 5000);
    },
  };
  const bridge = createBridge({ getObsConf, send: (m) => link.send(m), log, allowKeys: () => loadConfig().presentKeys === true, layout, pictures });
  link = createRelayLink({
    relay: linkRelay, room: cfg.room, token: cfg.deviceToken, log,
    onUp: () => { log("relay connected"); bridge.relayUp(); },
    onDown: () => { log("relay disconnected"); bridge.relayDown(); },
    onMessage: (m) => {
      if (m.type === "pair.code") { waiters.splice(0).forEach((w) => w(m)); return; }
      if (m.type === "devices") { devices = Array.isArray(m.data) ? m.data : []; return; }
      bridge.handleRelay(m);
    },
  });

  const api = {
    cfg,
    /** The native settings window (settings/settings.c), next to this program. */
    openSettings() {
      const exe = join(DIR, "obs-remote-settings.exe");
      if (!existsSync(exe)) throw new Error("The settings window is missing; run the installer again.");
      spawn(exe, [`--port=${SETUP_PORT}`], { detached: true, stdio: "ignore" }).unref();
    },
    publicUrl,
    /** Address for a browser on this same computer: no tunnel needed. */
    localUrl: () => (local ? local.url : cfg.relay),
    status() {
      const f = readObsWsConfig();
      return {
        obs: bridge.status(),
        relay: link.status(),
        relayUrl: publicUrl(),
        mode: cfg.mode === "local" ? "local" : "cloud",
        canSwitch: !!(BAKED.relay || loadConfig().saved?.cloud?.relay || cfg.relay),
        cloudHost: (BAKED.relay || cfg.relay || "").replace(/^https?:\/\//, ""),
        tunnel: tunnel ? tunnel.status() : null,
        room: cfg.room,
        hosted,
        started,
        devices,
        host: hostname(),
        obsWs: f ? { enabled: f.enabled, port: f.port, auth: f.auth } : null,
        customPassword: loadConfig().obsPassword != null,
        presentKeys: loadConfig().presentKeys === true,
      };
    },
    /** Ask the relay for a pairing code; the answer arrives as a `pair.code` message. */
    pairCode(role = "owner") {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("The relay did not answer. Is it reachable?")), 6000);
        waiters.push((m) => { clearTimeout(t); resolve(m); });
        if (!link.send({ type: "pair.request", role })) { clearTimeout(t); waiters.pop(); reject(new Error("Not connected to the relay yet.")); }
      });
    },
    revoke(cid) { return link.send({ type: "device.revoke", cid: String(cid) }); },
    setObsPassword(p) {
      const c = loadConfig();
      if (p == null || p === "") delete c.obsPassword; else c.obsPassword = String(p);
      saveConfig(c);
    },
    /** Switch between "cloud" and "local": save the choice, start a fresh copy that waits for this one to exit. */
    async switchMode(mode) {
      if (mode !== "cloud" && mode !== "local") throw new Error("bad mode");
      if (mode === cfg.mode) return;
      await ensureRegistered({ mode }); // registers (cloud) or makes an identity (local) before we stop
      log("switching to " + mode);
      setTimeout(() => {
        try { spawn(process.execPath, ["run", "--wait", ...restartArgs], { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch (e) { log("restart failed: " + e.message); }
        api.stop(); process.exit(0);
      }, 200);
    },
    setPresentKeys(on) { const c = loadConfig(); c.presentKeys = on === true; saveConfig(c); },
    /** Quit the whole system (menu "Quit" in the tray icon). */
    quit(opts = {}) {
      log("quit requested from the tray");
      try { onQuit(opts); } catch { /* best effort */ }
      setTimeout(() => { api.stop(); process.exit(0); }, 150);
    },
    /** Hand over to the uninstaller (it waits for us to leave, then removes everything). */
    uninstall() {
      log("uninstall requested");
      try { onUninstall(); } catch (e) { log("uninstall: " + e.message); }
      setTimeout(() => { api.stop(); process.exit(0); }, 200);
    },
    stop() { tray?.stop(); bridge.stop(); link.stop(); tunnel?.stop(); local?.stop(); server?.close(); },
  };

  bridge.start();
  link.start();
  const server = await startSetupServer(api, { log, open });
  // Started by the OBS plugin: OBS is the way in, so no tray icon.
  if (!hosted) tray = startTray({ notify, log });
  return api;
}
