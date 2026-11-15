// Local setup page on 127.0.0.1: status, pairing QR, device list. Not reachable from other machines.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import qrcode from "qrcode-generator";
import { SETUP_PORT } from "./config.js";
import { ui } from "./ui/index.js";

const { page, script, style } = ui;

const HOSTS = new Set([`127.0.0.1:${SETUP_PORT}`, `localhost:${SETUP_PORT}`, `[::1]:${SETUP_PORT}`]);

function qrRows(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  return { n, rows: Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => (q.isDark(y, x) ? "1" : "0")).join("")) };
}

/** One field per line, tab-separated parts: easy to read for the native settings window (settings/settings.c). */
const clean = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
/** What the OBS dock shows now: one button that opens the settings window. */
const DOCK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="csrf" content="__CSRF__"><title>OBS Remote</title>
<style>body{margin:0;padding:14px;background:#17171a;color:#ebeae6;font:13px/1.5 "Segoe UI",system-ui,sans-serif}
button{width:100%;min-height:36px;border:0;border-radius:6px;background:#e8e6e0;color:#141416;font:600 14px "Segoe UI",sans-serif;cursor:pointer}
p{color:#8f8e8a;margin:10px 0 0}</style></head><body><button id="b">Open OBS Remote</button>
<p>Settings and the phone QR code are in their own window now. You can close this dock (also under Tools → OBS Remote).</p>
<script src="/dock.js"></script></body></html>`;
const DOCK_JS = `document.getElementById("b").addEventListener("click", () => fetch("/api/settings", { method: "POST", headers: { "x-obsr-csrf": document.querySelector("meta[name=csrf]").content } }));`;

export function statusText(s) {
  const b = (v) => (v ? 1 : 0);
  const lines = [
    "v=1", `host=${clean(s.host)}`, `obs=${clean(s.obs.state)}\t${clean(s.obs.detail)}`, `obsws=${b(s.obsWs?.enabled)}`,
    `relay=${clean(s.relay.state)}\t${clean(s.relay.detail)}`, `url=${clean(s.relayUrl)}`, `mode=${clean(s.mode)}`, `canSwitch=${b(s.canSwitch)}`,
    `cloudHost=${clean(s.cloudHost)}`, `hosted=${b(s.hosted)}`, `presentKeys=${b(s.presentKeys)}`, `started=${s.started}`, `room=${clean(s.room)}`,
    `version=${clean(s.version)}`, `update=${clean(s.update.state)}	${clean(s.update.latest)}	${clean(s.update.detail)}`,
  ];
  if (s.tunnel) lines.push(`tunnel=${clean(s.tunnel.state)}\t${clean(s.tunnel.url)}\t${clean(s.tunnel.detail)}`);
  for (const d of s.devices) lines.push(`dev=${clean(d.cid)}\t${b(d.online)}\t${clean(d.role || "owner")}\t${d.created ?? 0}\t${clean(d.name)}`);
  return lines.join("\n") + "\n";
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
        if (url.pathname === "/") return send(res, 200, page.replace("__CSRF__", csrf), "text/html");
        // The OBS dock used to show the whole page; settings now live in their own window, so the dock only opens it
        // (a still page: no polling, nothing for OBS's browser to do).
        if (url.pathname === "/dock") return send(res, 200, DOCK_PAGE.replace("__CSRF__", csrf), "text/html", "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
        if (url.pathname === "/dock.js") return send(res, 200, DOCK_JS, "text/javascript");
        if (url.pathname === "/setup.js") return send(res, 200, script, "text/javascript");
        if (url.pathname === "/setup.css") return send(res, 200, style, "text/css");
        if (url.pathname === "/api/ping") return send(res, 200, { app: "obs-remote" });
        if (url.pathname === "/api/status") return send(res, 200, api.status());
        if (url.pathname === "/api/status.txt") return send(res, 200, statusText(api.status()), "text/plain");
        // The native settings window's token. Pages on other sites cannot read this answer (no CORS, Host checked).
        if (url.pathname === "/api/token") return send(res, 200, csrf, "text/plain");
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
        const qr = qrRows(link);
        if (url.searchParams.get("fmt") === "txt") return send(res, 200, [`code=${m.code}`, `room=${m.room}`, `exp=${m.exp}`, `role=${m.role}`, `url=${link}`, `qr=${qr.n}`, ...qr.rows].join("\n") + "\n", "text/plain");
        return send(res, 200, { code: m.code, room: m.room, exp: m.exp, role: m.role, url: link, qr });
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
      if (url.pathname === "/api/update") { api.update({ reopenSettings: body.reopen === true }); return send(res, 200, { ok: true }); }
      if (url.pathname === "/api/update-check") { await api.checkUpdate(); return send(res, 200, { ok: true }); }
      if (url.pathname === "/api/present-keys") { api.setPresentKeys(body.on === true); return send(res, 200, { ok: true }); }
      if (url.pathname === "/api/settings") { api.openSettings(); return send(res, 200, { ok: true }); }
      if (url.pathname === "/api/obs-password") { api.setObsPassword(typeof body.password === "string" ? body.password : ""); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  // No WebSockets on this page.
  server.on("upgrade", (req, socket) => socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SETUP_PORT, "127.0.0.1", () => {
      log(`setup page: http://127.0.0.1:${SETUP_PORT}/`);
      if (open) openBrowser(`http://127.0.0.1:${SETUP_PORT}/`);
      resolve(server);
    });
  });
}
