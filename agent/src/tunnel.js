// Public link without a Cloudflare account: a "quick tunnel" run by cloudflared. It gives a random
// https://xxxx.trycloudflare.com address that reaches the local relay. A new tunnel means a new address, and a
// phone holding the old one gets Cloudflare's error 1033, so this keeps one tunnel alive for as long as it can:
// - cloudflared is started through WMI, outside the OBS plugin's kill-on-close job, so it outlives OBS. The next
//   run finds it again (tunnel.json) and keeps its address, because the local relay listens on a fixed port.
// - when the internet drops, cloudflared reconnects by itself with the same address; we only wait.
// - only a cloudflared that died (reboot, crash) or a link that answers with something else gets a new address.
import { execFile, spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const EXE_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
const API_URL = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const HEALTH_MS = 15_000, APP_CHECK_MS = 10 * 60_000;

/** Download cloudflared once (about 60 MB) next to our config. Verified against GitHub's published SHA-256 when available. */
async function ensureBinary(dir, setStatus, log) {
  const exe = join(dir, "cloudflared.exe");
  if (existsSync(exe) && statSync(exe).size > 10e6) return exe;
  if (process.platform !== "win32") throw new Error("The built-in tunnel is Windows-only for now.");
  mkdirSync(dir, { recursive: true });
  setStatus("download", "Downloading cloudflared (one time, ~60 MB)…");
  let expected = "";
  try {
    const rel = await (await fetch(API_URL, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) })).json();
    expected = String(rel.assets?.find((a) => a.name === "cloudflared-windows-amd64.exe")?.digest ?? "").replace(/^sha256:/, "");
  } catch { /* checksum is best effort */ }
  const res = await fetch(EXE_URL, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
  const tmp = exe + ".part";
  const hash = createHash("sha256");
  const out = createWriteStream(tmp);
  for await (const chunk of res.body) { hash.update(chunk); if (!out.write(chunk)) await new Promise((r) => out.once("drain", r)); }
  await new Promise((r) => out.end(r));
  const got = hash.digest("hex");
  if (expected && got !== expected) { rmSync(tmp, { force: true }); throw new Error("Downloaded cloudflared failed its checksum, so it was discarded."); }
  if (!expected) log("cloudflared: no published checksum to compare against");
  if (statSync(tmp).size < 10e6) { rmSync(tmp, { force: true }); throw new Error("Download looks incomplete."); }
  renameSync(tmp, exe);
  return exe;
}

/** Does the address really serve our web app? true = yes, false = something else answers (error 1033 is a 530),
 *  null = can't tell from here (this computer's DNS may not know the new name yet; phones usually do). */
async function servesApp(url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url + "/app", { signal: AbortSignal.timeout(8000), headers: { "cache-control": "no-cache" } });
      const body = await res.text();
      if (res.ok && body.includes("OBS Remote")) return true;
      if (i >= 3) return false; // a fresh link can answer 404/530 for a few seconds
    } catch { /* not reachable from here yet */ }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isCloudflared(pid) {
  if (!pid) return false;
  try { return /cloudflared\.exe/i.test(execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true })); } catch { return false; }
}

function kill(pid) { if (isCloudflared(pid)) try { process.kill(pid); } catch { /* already gone */ } }

/** The tunnel a previous run left behind ({ pid, metrics, target }), if any. */
const stateFile = (dir) => join(dir, "tunnel.json");
function readState(dir) { try { return JSON.parse(readFileSync(stateFile(dir), "utf8")); } catch { return null; } }

/** Quit / uninstall / switching to the online server: the link is not wanted any more. */
export function closeLeftoverTunnel(dir) {
  const s = readState(dir);
  if (s?.pid) kill(s.pid);
  rmSync(stateFile(dir), { force: true });
}

function freePort(want) {
  const tryPort = (p) => new Promise((resolve) => {
    const srv = createServer().once("error", () => resolve(0)).listen(p, "127.0.0.1", () => { const got = srv.address().port; srv.close(() => resolve(got)); });
  });
  return tryPort(want).then((p) => p || tryPort(0));
}

/** Start a program as a child of WMI instead of us, so the OBS plugin's job does not end it with OBS. */
function startOutsideJob(exe, args) {
  const q = (s) => `"${s}"`;
  const cmd = [q(exe), ...args.map((a) => (/[\s"]/.test(a) ? q(a) : a))].join(" ").replace(/'/g, "''");
  const ps = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd}'; ProcessStartupInformation = $si }
if ($r.ReturnValue -ne 0) { exit 1 }; [Console]::Out.Write($r.ProcessId)`;
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { windowsHide: true, timeout: 20000 }, (err, out) => {
      const pid = Number(String(out).trim());
      if (err || !pid) reject(new Error("WMI could not start cloudflared")); else resolve(pid);
    });
  });
}

export function createTunnel({ dir, port, metricsPort = 0, log = () => {} }) {
  let st = { state: "starting", detail: "", url: "" }; // state: starting | download | up | down | blocked | error
  let stopped = false, timer = null, health = null, tries = 0;
  let pid = 0, metrics = 0, url = "", logFile = join(dir, "cloudflared.log"), downSince = 0, appCheckAt = 0;
  const setStatus = (state, detail = "", u = "") => { st = { state, detail, url: u }; };
  const ask = async (path) => fetch(`http://127.0.0.1:${metrics}${path}`, { signal: AbortSignal.timeout(2500) });
  const hostname = async () => { try { const h = (await (await ask("/quicktunnel")).json()).hostname; return h ? `https://${h}` : ""; } catch { return ""; } };
  const ready = async () => { try { return (await ask("/ready")).status === 200; } catch { return false; } };

  /** A cloudflared from the last run that points at our relay port: keep it, and with it the address phones know. */
  async function adopt() {
    const s = readState(dir);
    if (!s?.pid) return false;
    if (s.target !== port || !isCloudflared(s.pid)) { kill(s.pid); rmSync(stateFile(dir), { force: true }); return false; }
    pid = s.pid; metrics = s.metrics;
    url = await hostname();
    if (url) return true;
    kill(pid); pid = 0;
    return false;
  }

  async function launch(exe) {
    metrics = await freePort(metricsPort);
    // Our own config file: without --config cloudflared reads %USERPROFILE%\.cloudflared\config.yml, and the ingress
    // rules of a tunnel the user set up for something else win over --url, so the link answers 404 to everyone.
    const conf = join(dir, "cloudflared-quick.yml");
    try { writeFileSync(conf, "no-autoupdate: true\n"); } catch { /* keep the old one */ }
    rmSync(logFile, { force: true });
    const args = ["tunnel", "--config", conf, "--no-autoupdate", "--metrics", `127.0.0.1:${metrics}`, "--logfile", logFile, "--url", `http://127.0.0.1:${port}`];
    try { pid = await startOutsideJob(exe, args); }
    catch (e) { // still works, it just ends with OBS
      log("tunnel: " + e.message + "; starting it as our child");
      const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      pid = child.pid;
    }
    writeFileSync(stateFile(dir), JSON.stringify({ pid, metrics, target: port, started: Date.now() }));
    for (let i = 0; i < 60 && !stopped; i++) {
      url = await hostname();
      if (url) return;
      if (blockedByTls()) throw Object.assign(new Error("Something on this computer (usually antivirus \"HTTPS scanning\", e.g. Avast Web Shield) is intercepting the tunnel's encrypted connection. Turn that scanning off for cloudflared.exe, or use a Cloudflare relay instead."), { state: "blocked" });
      if (!isCloudflared(pid)) throw new Error("cloudflared stopped right after starting.");
      await sleep(1000);
    }
    throw new Error("Cloudflare did not hand out a link.");
  }

  function blockedByTls() { try { return /x509: certificate signed by unknown authority/.test(readFileSync(logFile, "utf8")); } catch { return false; } }

  async function run() {
    if (stopped) return;
    let exe;
    try { exe = await ensureBinary(dir, setStatus, log); }
    catch (e) { setStatus("error", e.message); log("tunnel: " + e.message); return retry(60000); }
    if (stopped) return;
    const kept = await adopt();
    if (!kept) {
      setStatus("starting", "Opening the public link…");
      try { await launch(exe); }
      catch (e) { kill(pid); pid = 0; setStatus(e.state || "error", e.message); log("tunnel: " + e.message); return retry(e.state === "blocked" ? 60000 : undefined); }
    }
    if (stopped) return;
    setStatus("starting", "Waiting for the link to start working…");
    for (let i = 0; i < 60 && !stopped && !(await ready()); i++) await sleep(1000);
    setStatus("starting", "Checking that the link opens OBS Remote…");
    const ok = await servesApp(url);
    if (stopped) return;
    if (ok === false) {
      log("public link " + url + " does not serve the app; opening a new one");
      setStatus("error", "The public link opens, but not to OBS Remote. Opening a new link…");
      return renew(Math.max(2000, 2000 * 2 ** Math.min(tries++, 4)));
    }
    tries = 0; downSince = 0; appCheckAt = Date.now() + APP_CHECK_MS;
    setStatus("up", "", url);
    log("public link " + url + (kept ? " (kept from the last run: paired phones keep working)" : "") + (ok ? "" : " (not reachable from this computer yet, so unchecked)"));
    clearInterval(health);
    health = setInterval(watch, HEALTH_MS);
  }

  /** Every 15 s: is cloudflared alive and connected? Every 10 min: does the link still open our page? */
  async function watch() {
    if (stopped) return;
    if (!isCloudflared(pid)) {
      log("cloudflared stopped; opening a new link");
      setStatus("down", "The public link stopped. Opening a new one: phones need to scan the new QR code.");
      return renew(2000);
    }
    if (await ready()) {
      if (st.state !== "up") { log("public link back: " + url); setStatus("up", "", url); }
      downSince = 0;
      if (Date.now() > appCheckAt) {
        appCheckAt = Date.now() + APP_CHECK_MS;
        if ((await servesApp(url, 4)) === false && !stopped) { log("public link " + url + " stopped serving the app; opening a new one"); return renew(2000); }
      }
      return;
    }
    downSince ||= Date.now();
    if (Date.now() - downSince > 25_000) setStatus("down", "Reconnecting to Cloudflare (is the internet down?). The link stays the same, so phones reconnect by themselves.", url);
  }

  /** Throw the tunnel away and open a new one (new address). */
  function renew(ms) {
    clearInterval(health);
    kill(pid); pid = 0; url = "";
    rmSync(stateFile(dir), { force: true });
    retry(ms);
  }

  function retry(ms) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(run, ms ?? Math.min(2000 * 2 ** Math.min(tries++, 4), 30000));
  }

  return {
    start() { stopped = false; run(); },
    /** The agent is going away (OBS closes, an update, a restart): cloudflared stays, so the next run keeps the link. */
    stop() { stopped = true; clearTimeout(timer); clearInterval(health); },
    /** The link is not wanted any more (quit, uninstall, switching to the online server). */
    close() { this.stop(); kill(pid); rmSync(stateFile(dir), { force: true }); },
    status: () => st,
    url: () => (st.state === "up" || st.state === "down" ? url : ""),
  };
}
