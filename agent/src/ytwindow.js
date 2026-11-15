// "YouTube to OBS": a Chrome window (Edge when there is no Chrome; not tested) with its own profile and the YouTube
// extension already in it, so nobody has to switch on Developer mode. Chrome only lets programs add an extension that
// is not from the Web Store over its DevTools pipe, and only for that session, so this process starts the browser,
// loads the extension, opens YouTube and then stays (hidden) until the window is closed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const HOME_URL = "https://www.youtube.com/";

export function findBrowser() {
  const pf = process.env.ProgramFiles || String.raw`C:\Program Files`;
  const pf86 = process.env["ProgramFiles(x86)"] || String.raw`C:\Program Files (x86)`;
  const local = process.env.LOCALAPPDATA || "";
  return [
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].find((p) => p && existsSync(p)) ?? null;
}

/** Resolves when the window is closed. A second call while it is open just opens YouTube in that window. */
export function openYoutubeWindow({ extensionDir, profileDir, log = () => {}, url = HOME_URL }) {
  const exe = findBrowser();
  if (!exe) throw new Error("Google Chrome is needed for YouTube to OBS.");
  mkdirSync(profileDir, { recursive: true });
  const base = [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check"];
  const p = spawn(exe, ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging", ...base], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: false });
  let buf = "", seq = 0;
  const pending = new Map();
  p.stdio[4].on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      let m;
      try { m = JSON.parse(buf.slice(0, i)); } catch { m = {}; }
      buf = buf.slice(i + 1);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  p.stdio[3].on("error", () => {});
  p.stdio[4].on("error", () => {});
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(method + " timed out")); }, 15000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    try { p.stdio[3].write(JSON.stringify({ id, method, params }) + "\0"); } catch (e) { clearTimeout(t); reject(e); }
  });

  const closed = new Promise((resolve) => p.on("exit", resolve));
  return (async () => {
    // The window is already open: this browser process hands over to it and quits at once.
    const ready = send("Browser.getVersion").then(() => true, () => false);
    const first = await Promise.race([ready, closed.then(() => false)]);
    if (!first) {
      log("youtube window: already open, showing YouTube there");
      spawn(exe, [...base, url], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    const { id } = await send("Extensions.loadUnpacked", { path: extensionDir });
    log(`youtube window: extension ${id} loaded (${exe.split(/[\\/]/).pop()})`);
    const { targetInfos } = await send("Target.getTargets");
    await send("Target.createTarget", { url });
    // the start page was open before the extension: close it so every YouTube tab has the extension
    for (const t of targetInfos) if (t.type === "page") await send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    await closed;
    log("youtube window: closed");
  })();
}
