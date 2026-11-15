// Updates from the latest GitHub release (BAKED.updates = "owner/repo"). The settings window shows "Update to vX";
// one click downloads OBS-Remote-Setup.exe, checks its SHA-256 against GitHub's and runs it quietly with this
// computer's mode and relay, so the room and every paired phone stay as they are. The installer stops this agent
// and starts the new one inside the running OBS.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { BAKED, DIR, loadConfig } from "./config.js";

const ASSET = "OBS-Remote-Setup.exe";
const EVERY_MS = 6 * 3600_000;

/** 1.4.10 > 1.4.9; anything that isn't x.y.z counts as 0. */
export function newer(a, b) {
  const p = (v) => String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

const launch = (file, args) => spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();

// api, launch and config are swapped out by test/update.mjs.
export function createUpdater({ log = () => {}, repo = BAKED.updates, version = BAKED.version, dir = join(DIR, "update"), api = "https://api.github.com", run = launch, config = loadConfig } = {}) {
  // state: off | idle | checking | none | available | downloading | installing | error
  let st = { state: repo && version !== "dev" ? "idle" : "off", latest: "", detail: "" };
  let rel = null, timer = null, busy = false;
  const set = (state, detail = "") => { st = { state, latest: rel?.version ?? "", detail }; };

  async function check() {
    if (st.state === "off" || busy || st.state === "installing") return st;
    busy = true;
    const before = st.state;
    if (before !== "available") set("checking");
    try {
      const res = await fetch(`${api}/repos/${repo}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "obs-remote" }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const j = await res.json();
      const a = (j.assets ?? []).find((x) => x.name === ASSET);
      if (!a) throw new Error("the latest release has no installer");
      rel = { version: String(j.tag_name ?? "").replace(/^v/, ""), url: a.browser_download_url, size: a.size, sha256: String(a.digest ?? "").replace(/^sha256:/, "") };
      if (newer(rel.version, version)) { set("available"); if (before !== "available") log(`update available: ${rel.version}`); }
      else set("none");
      try { for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true }); } catch { /* nothing left over */ }
    } catch (e) {
      set(before === "available" ? "available" : "error", before === "available" ? "" : `Could not check for updates (${e.message}).`);
    } finally { busy = false; }
    return st;
  }

  async function download() {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `OBS-Remote-Setup-${rel.version}.exe`), tmp = file + ".part";
    const res = await fetch(rel.url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const hash = createHash("sha256"), out = createWriteStream(tmp);
    let got = 0, shown = -1;
    for await (const chunk of res.body) {
      hash.update(chunk); got += chunk.length;
      const pct = rel.size ? Math.floor((got / rel.size) * 100) : 0;
      if (pct !== shown) { shown = pct; set("downloading", rel.size ? `${pct}%` : `${Math.round(got / 1e6)} MB`); }
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise((r) => out.end(r));
    const sum = hash.digest("hex");
    if (rel.size && statSync(tmp).size !== rel.size) { rmSync(tmp, { force: true }); throw new Error("the download is incomplete"); }
    if (rel.sha256 && sum !== rel.sha256) { rmSync(tmp, { force: true }); throw new Error("the download failed its checksum, so it was thrown away"); }
    if (!rel.sha256) log("update: GitHub published no checksum for this installer");
    renameSync(tmp, file);
    return file;
  }

  /** Download and hand over to the installer. Resolves once the installer runs; it then stops this process. */
  async function apply({ reopenSettings = false } = {}) {
    if (busy || !["available", "error"].includes(st.state)) throw new Error(st.state === "off" ? "Updates are not set up in this build." : "No update to install.");
    if (!rel) await check();
    if (!rel || !newer(rel.version, version)) throw new Error("No update to install.");
    busy = true;
    try {
      const file = await download();
      const c = config();
      const mode = c.mode === "local" || !c.relay ? ["--local"] : ["--cloud", "--relay", c.relay, ...(BAKED.key ? ["--key", BAKED.key] : [])];
      set("installing", "OBS Remote restarts by itself in a few seconds.");
      log(`update: installing ${rel.version}`);
      run(file, ["install", "--update", ...mode, ...(reopenSettings ? ["--reopen-settings"] : [])]);
    } catch (e) {
      set("error", `Update failed: ${e.message}`);
      log("update failed: " + e.message);
      throw e;
    } finally { busy = false; }
  }

  return {
    start() { if (st.state === "off") return; timer = setTimeout(function tick() { check(); timer = setTimeout(tick, EVERY_MS); }, 20_000); },
    stop() { clearTimeout(timer); },
    status: () => ({ ...st, current: version }),
    check,
    apply,
  };
}
