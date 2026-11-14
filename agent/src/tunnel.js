// Public link without a Cloudflare account: a "quick tunnel" run by cloudflared. It gives a random
// https://xxxx.trycloudflare.com address that reaches the local relay. The address changes every time the
// tunnel restarts, so phones scan the QR code again (the setup page shows a fresh one).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXE_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
const API_URL = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

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

export function createTunnel({ dir, port, log = () => {} }) {
  let st = { state: "starting", detail: "", url: "" }; // state: starting | download | up | down | error
  let child = null, stopped = false, timer = null, tries = 0;
  const setStatus = (state, detail = "", url = "") => { st = { state, detail, url }; };

  async function run() {
    if (stopped) return;
    let exe;
    try { exe = await ensureBinary(dir, setStatus, log); }
    catch (e) { setStatus("error", e.message); log("tunnel: " + e.message); return retry(60000); }
    if (stopped) return;
    setStatus("starting", "Opening the public link…");
    child = spawn(exe, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let pending = "", blocked = false;
    const onData = (d) => {
      const text = String(d);
      const m = URL_RE.exec(text);
      if (m) { pending = m[0]; setStatus("starting", "Waiting for the link to start working…"); }
      // cloudflared says this once it is really connected; before that the address answers with an error page.
      if (pending && /Registered tunnel connection/.test(text)) { tries = 0; blocked = false; setStatus("up", "", pending); log("public link " + pending); }
      if (!blocked && /x509: certificate signed by unknown authority/.test(text) && st.state !== "up") {
        blocked = true;
        setStatus("blocked", "Something on this computer (usually antivirus \"HTTPS scanning\", e.g. Avast Web Shield) is intercepting the tunnel's encrypted connection. Turn that scanning off for cloudflared.exe, or use a Cloudflare relay instead.");
        log("tunnel blocked: TLS interception");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => { setStatus("error", e.message); });
    child.on("exit", (code) => {
      child = null;
      if (stopped) return;
      setStatus("down", `cloudflared stopped (${code}); retrying…`);
      retry();
    });
  }

  function retry(ms) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(run, ms ?? Math.min(2000 * 2 ** Math.min(tries++, 4), 30000));
  }

  return {
    start() { stopped = false; run(); },
    stop() { stopped = true; clearTimeout(timer); try { child?.kill(); } catch { /* */ } },
    status: () => st,
    url: () => (st.state === "up" ? st.url : ""),
  };
}
