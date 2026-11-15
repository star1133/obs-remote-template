// Local setup page on 127.0.0.1: status, pairing QR, device list. Not reachable from other machines.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import qrcode from "qrcode-generator";
import { SETUP_PORT } from "./config.js";
import { ui } from "./ui/index.js";

const { page, script, style, ytPage, ytScript, ytStyle } = ui;

const HOSTS = new Set([`127.0.0.1:${SETUP_PORT}`, `localhost:${SETUP_PORT}`, `[::1]:${SETUP_PORT}`]);

function qrRows(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  return { n, rows: Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => (q.isDark(y, x) ? "1" : "0")).join("")) };
}

export function openBrowser(url) {
  if (process.env.OBSR_NO_BROWSER === "1") return; // tests
  try { spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch { /* user can open it by hand */ }
}

/** True when another agent already serves the setup page (single instance check). */
export async function alreadyRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${SETUP_PORT}/api/ping`, { signal: AbortSignal.timeout(800) });
    return r.ok && (await r.json()).app === "obs-remote";
  } catch { return false; }
}

/** Origins of pages this server serves (the OBS browser source with /yt). */
export const OWN_ORIGINS = new Set([...HOSTS].map((h) => "http://" + h));

export function startSetupServer(api, { log, open }) {
  const csrf = randomBytes(16).toString("hex");
  const send = (res, code, body, type = "application/json", csp = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'") => {
    res.writeHead(code, { "content-type": type + "; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": csp });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const readJson = (req) => new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 4096) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error("bad json")); } });
  });

  const server = createServer(async (req, res) => {
    // DNS-rebinding guard: only answer to our own loopback names.
    if (!HOSTS.has(req.headers.host ?? "")) return send(res, 403, { error: "host" });
    const url = new URL(req.url, "http://x");
    try {
      if (req.method === "GET") {
        if (url.pathname === "/" || url.pathname === "/dock") return send(res, 200, page.replace("__CSRF__", csrf), "text/html");
        if (url.pathname === "/setup.js") return send(res, 200, script, "text/javascript");
        if (url.pathname === "/setup.css") return send(res, 200, style, "text/css");
        // YouTube to OBS: the page the OBS browser source shows (see ytcast.js)
        // inline styles allowed: OBS puts the source's Custom CSS in as a style tag (scripts stay locked down)
        if (url.pathname === "/yt") return send(res, 200, ytPage, "text/html", "default-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob: mediastream:; frame-ancestors 'none'");
        if (url.pathname === "/yt.js") return send(res, 200, ytScript, "text/javascript");
        if (url.pathname === "/yt.css") return send(res, 200, ytStyle, "text/css");
        if (url.pathname === "/api/ping") return send(res, 200, { app: "obs-remote" });
        if (url.pathname === "/api/status") return send(res, 200, api.status());
        return send(res, 404, { error: "not found" });
      }
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      // Cross-site protection: a custom header only our page (which got the token) can set, plus same-origin.
      const origin = req.headers.origin;
      if (req.headers["x-obsr-csrf"] !== csrf || (origin && !HOSTS.has(origin.replace(/^https?:\/\//, "")))) return send(res, 403, { error: "csrf" });
      const body = await readJson(req);
      if (url.pathname === "/api/pair") {
        const role = body.role === "viewer" ? "viewer" : body.role === "operator" ? "operator" : "owner";
        const m = await api.pairCode(role);
        const base = api.publicUrl().replace(/\/+$/, "");
        if (!base) throw new Error("The public link is not ready yet. Wait a few seconds and try again.");
        const link = `${base}${api.cfg.mode === "local" ? "/" : "/app"}#pair=${m.room}-${m.code}`;
        return send(res, 200, { code: m.code, room: m.room, exp: m.exp, role: m.role, url: link, qr: qrRows(link) });
      }
      if (url.pathname === "/api/open") { // "Open control page": pair this computer's browser and show the web UI
        const m = await api.pairCode("owner");
        openBrowser(`${api.localUrl().replace(/\/+$/, "")}/#pair=${m.room}-${m.code}`);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/api/quit") { send(res, 200, { ok: true }); api.quit({ noStartup: body.noStartup === true }); return; }
      if (url.pathname === "/api/revoke") return send(res, 200, { ok: api.revoke(body.cid) });
      if (url.pathname === "/api/mode") { await api.switchMode(body.mode); return send(res, 200, { ok: true }); }
      if (url.pathname === "/api/uninstall") { send(res, 200, { ok: true }); api.uninstall(); return; }
      if (url.pathname === "/api/present-keys") { api.setPresentKeys(body.on === true); return send(res, 200, { ok: true }); }
      if (url.pathname === "/api/yt-source") return send(res, 200, await api.addYtSource());
      if (url.pathname === "/api/yt-open") { api.openYoutube(); return send(res, 200, { ok: true }); }
      if (url.pathname === "/api/yt-extension") { api.openExtensionSetup(); return send(res, 200, { ok: true }); }
      if (url.pathname === "/api/obs-password") { api.setObsPassword(typeof body.password === "string" ? body.password : ""); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  // WebSockets: only the YouTube link (ytcast.js) uses one, and only from our own loopback names.
  server.on("upgrade", (req, socket, head) => {
    if (!HOSTS.has(req.headers.host ?? "") || !api.yt?.upgrade(req, socket, head)) socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SETUP_PORT, "127.0.0.1", () => {
      log(`setup page: http://127.0.0.1:${SETUP_PORT}/`);
      if (open) openBrowser(`http://127.0.0.1:${SETUP_PORT}/`);
      resolve(server);
    });
  });
}
