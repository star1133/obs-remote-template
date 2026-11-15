// The relay, running inside the agent (no Cloudflare account needed). Same protocol and rules as
// relay/src/room.ts, for exactly one room: the OBS machine this agent runs on. It listens on 127.0.0.1 only;
// tunnel.js makes it reachable from phones.
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocketServer } from "ws";

const MAX_TEXT = 64 * 1024;
const MAX_BINARY = 512 * 1024;
const WINDOW = 12, STALL_MS = 3000; // preview frame flow control, as in relay/src/room.ts
const PAIR_TTL_MS = 5 * 60 * 1000;
const PAIR_MAX_ACTIVE = 8;
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const OP_RE = /^[A-Za-z0-9]{1,64}$/;
const ROOM_RE = /^[a-z2-7]{10}$/;

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss: ws:; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml", webmanifest: "application/manifest+json", json: "application/json", png: "image/png", ico: "image/x-icon" };

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const randomHex = (n) => randomBytes(n).toString("hex");
// Pairing codes: 12 characters, no look-alikes (0/O, 1/I), about 60 bits. Shown as XXXX-XXXX-XXXX.
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () => Array.from(randomBytes(12), (b) => CODE_ABC[b % 32]).join("");
const normCode = (c) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** New room id (10 chars of base32) and device token for a fresh local install. */
export function newIdentity() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const room = Array.from(randomBytes(10), (b) => alphabet[b % 32]).join("");
  return { room, deviceToken: randomBytes(32).toString("base64url") };
}

/**
 * @param {{stateFile:string, room:string, deviceToken:string, assets:(path:string)=>({type:string,body:Buffer}|null), port?:number, log?:Function}} o
 */
export function startLocalRelay({ stateFile, room, deviceToken, assets, port = 0, log = () => {} }) {
  // ---- persistent state: who may connect (hashes only) ----------------------------------------
  let state = { room, dev: sha256(deviceToken), clients: {} };
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    if (s.room === room && s.dev === state.dev) state = s; // otherwise the identity changed: start clean
  } catch { /* first run */ }
  const save = () => {
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = stateFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, stateFile);
  };
  save();

  let pairs = {};   // code -> { exp, role }
  let fails = { n: 0, at: Date.now() };
  const obsSockets = new Set();
  const clientSockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BINARY, handleProtocols: (set) => [...set].find((p) => p.startsWith("obsr.")) ?? false });

  // ---- helpers ---------------------------------------------------------------------------------
  const obs = () => [...obsSockets].find((w) => w.readyState === 1);
  const sendTo = (ws, data, opts) => { try { ws.send(data, opts); } catch { /* closing */ } };
  const toObs = (m) => { const o = obs(); if (!o) return false; sendTo(o, JSON.stringify(m)); return true; };
  const broadcast = (text) => clientSockets.forEach((c) => sendTo(c, text));

  function allow(ws, role) {
    const rate = role === "obs" ? 400 : 100;
    const now = Date.now();
    const b = ws.bucket ?? (ws.bucket = { tokens: rate * 2, at: now });
    b.tokens = Math.min(rate * 2, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function newPairCode(role) {
    const now = Date.now();
    for (const c of Object.keys(pairs)) if (pairs[c].exp < now) delete pairs[c];
    const live = Object.keys(pairs).sort((a, b) => pairs[a].exp - pairs[b].exp);
    while (live.length >= PAIR_MAX_ACTIVE) delete pairs[live.shift()];
    let code = randomCode();
    while (pairs[code]) code = randomCode();
    const exp = now + PAIR_TTL_MS;
    pairs[code] = { exp, role };
    return { code, exp };
  }

  function deviceList(closing) {
    const online = new Set([...clientSockets].filter((c) => c !== closing).map((c) => c.att.cid));
    return Object.entries(state.clients).map(([cid, r]) => ({ cid, name: r.name, role: r.role ?? "owner", created: r.created, online: online.has(cid) }));
  }

  function announceDevices(closing) {
    const text = JSON.stringify({ type: "devices", data: deviceList(closing) });
    const o = obs();
    if (o) sendTo(o, text);
    for (const c of clientSockets) if (c !== closing && c.att.perm === "owner") sendTo(c, text);
  }

  function notifyDemand(closing) {
    let clients = 0, preview = 0, thumbs = 0, live = 0, max = 0;
    for (const c of clientSockets) {
      if (c === closing) continue;
      clients++;
      if (c.att.preview) preview++;
      if (c.att.preview && c.att.thumbs) thumbs++;
      if (c.att.preview && c.att.live) live++;
      if (c.att.preview && c.att.max) max++;
    }
    toObs({ type: "demand", clients, preview, thumbs, live, max });
  }

  function revoke(cid) {
    if (!state.clients[cid]) return;
    delete state.clients[cid];
    save();
    for (const c of clientSockets) if (c.att.cid === cid) c.close(4001, "revoked");
    announceDevices();
  }

  // ---- messages --------------------------------------------------------------------------------
  function fromClient(ws, m) {
    const att = ws.att;
    switch (m.type) {
      case "req": {
        const id = typeof m.id === "string" ? m.id.slice(0, 64) : "";
        if (typeof m.op !== "string" || !OP_RE.test(m.op)) return;
        if (att.perm === "viewer") return sendTo(ws, JSON.stringify({ type: "res", id, ok: false, error: "view_only" }));
        if (!toObs({ ...m, cid: att.cid })) sendTo(ws, JSON.stringify({ type: "res", id, ok: false, error: "obs_offline" }));
        return;
      }
      case "sub":
        att.preview = m.preview === true;
        att.thumbs = att.preview && m.thumbs === true;
        att.live = att.preview && m.rate !== "eco";
        att.max = att.preview && m.rate === "max";
        att.acks = m.acks === true;
        ws.inflight = null;
        return notifyDemand();
      case "sync":
        toObs({ type: "sync.request", cid: att.cid });
        return;
      case "invite": {
        if (att.perm !== "owner") return sendTo(ws, JSON.stringify({ type: "invite.error", error: "owner_only" }));
        const role = m.role === "viewer" ? "viewer" : "operator";
        const { code, exp } = newPairCode(role);
        return sendTo(ws, JSON.stringify({ type: "invite.code", room, code, exp, role }));
      }
      case "devices":
        if (att.perm === "owner") sendTo(ws, JSON.stringify({ type: "devices", data: deviceList() }));
        return;
      case "revoke":
        if (att.perm === "owner" && typeof m.cid === "string" && m.cid !== att.cid) revoke(m.cid);
        return;
    }
  }

  function fromObs(m) {
    switch (m.type) {
      case "pair.request": {
        const role = m.role === "viewer" ? "viewer" : m.role === "operator" ? "operator" : "owner";
        const { code, exp } = newPairCode(role);
        toObs({ type: "pair.code", room, code, exp, role });
        return;
      }
      case "device.revoke":
        return revoke(String(m.cid ?? ""));
      case "res": case "evt": case "state.sync": {
        const cid = typeof m.cid === "string" ? m.cid : "";
        const text = JSON.stringify(m);
        if (!cid) return broadcast(text);
        for (const c of clientSockets) if (c.att.cid === cid) sendTo(c, text);
        return;
      }
    }
  }

  function onMessage(ws, data, isBinary) {
    const role = ws.att.role;
    if (!isBinary && data.length === 4 && data.toString() === "ping") return sendTo(ws, "pong");
    if (!allow(ws, role)) return;
    if (isBinary) {
      if (role !== "obs" || data.length > MAX_BINARY) return;
      const thumb = data[0] === 2 || data[0] === 3; // channels 2 and 3 = scene pictures, only for Present-mode clients
      const now = Date.now();
      for (const c of clientSockets) {
        if (!c.att.preview || (thumb && !c.att.thumbs)) continue;
        if (c.att.acks) {
          const f = c.inflight ?? (c.inflight = { n: 0, at: now });
          if (f.n >= WINDOW && !thumb) {
            if (now - f.at < STALL_MS) continue;
            f.n = 0;
          }
          if (f.n === 0) f.at = now;
          f.n++;
        }
        sendTo(c, data, { binary: true });
      }
      return;
    }
    const text = data.toString();
    if (role === "client" && text.length <= 6 && text[0] === "a") { // "a<n>": n frames arrived
      if (ws.inflight) { ws.inflight.n = Math.max(0, ws.inflight.n - (Number(text.slice(1)) || 0)); ws.inflight.at = Date.now(); }
      return;
    }
    if (text.length > MAX_TEXT) return ws.close(1009, "too large");
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (typeof m !== "object" || m === null) return;
    if (role === "client") fromClient(ws, m); else fromObs(m);
  }

  function onGone(ws) {
    if (ws.att.role === "obs") {
      obsSockets.delete(ws);
      if (!obs()) broadcast(JSON.stringify({ type: "presence", obs: false }));
      notifyDemand();
    } else {
      clientSockets.delete(ws);
      notifyDemand();
      announceDevices();
    }
  }

  // ---- HTTP ------------------------------------------------------------------------------------
  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 4096) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });

  async function pair(req, res) {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "bad_request" }); }
    if (String(body.room ?? "").toLowerCase() !== room) return json(res, 400, { error: "bad_room" });
    const now = Date.now();
    if (now - fails.at > FAIL_WINDOW_MS) fails = { n: 0, at: now };
    if (fails.n >= FAIL_LIMIT) return json(res, 429, { error: "locked" });
    for (const c of Object.keys(pairs)) if (pairs[c].exp < now) delete pairs[c];
    const match = Object.keys(pairs).find((c) => safeEqual(c, normCode(body.code)));
    if (!match) { fails.n++; return json(res, 400, { error: Object.keys(pairs).length ? "bad_code" : "no_code" }); }
    const role = pairs[match].role;
    delete pairs[match]; // single use
    fails = { n: 0, at: now };
    const token = randomHex(32), cid = randomHex(6);
    state.clients[cid] = { hash: sha256(token), name: String(body.name ?? "").slice(0, 40) || "device", created: now, role };
    save();
    announceDevices();
    json(res, 200, { clientToken: token, cid, role });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "POST" && url.pathname === "/api/pair") return await pair(req, res);
      if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not_found" });
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
      const a = assets(url.pathname === "/" || url.pathname === "/app" ? "/index.html" : url.pathname);
      if (!a) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": a.type, "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : a.body);
    } catch (e) {
      log("relay http error: " + e.message);
      if (!res.headersSent) json(res, 500, { error: "server" });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    const isObs = url.pathname === "/ws/obs";
    if ((!isObs && url.pathname !== "/ws/client") || (url.searchParams.get("room") ?? "").toLowerCase() !== room || !ROOM_RE.test(room)) { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); return socket.destroy(); }
    const proto = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim()).find((p) => p.startsWith("obsr."));
    const token = proto ? proto.slice(5) : "";
    const hash = sha256(token);
    let cid = null;
    if (isObs) { if (!safeEqual(state.dev, hash)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); } }
    else {
      cid = Object.keys(state.clients).find((id) => safeEqual(state.clients[id].hash, hash));
      if (!cid) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (d, bin) => onMessage(ws, d, bin));
      ws.on("close", () => onGone(ws));
      ws.on("error", () => onGone(ws));
      if (isObs) {
        for (const old of obsSockets) old.close(4000, "replaced");
        ws.att = { role: "obs" };
        obsSockets.add(ws);
        sendTo(ws, JSON.stringify({ type: "hello", role: "obs", clients: clientSockets.size }));
        broadcast(JSON.stringify({ type: "presence", obs: true }));
        sendTo(ws, JSON.stringify({ type: "devices", data: deviceList() }));
        notifyDemand();
      } else {
        const perm = state.clients[cid].role ?? "owner";
        ws.att = { role: "client", cid, preview: false, thumbs: false, perm };
        clientSockets.add(ws);
        const online = !!obs();
        sendTo(ws, JSON.stringify({ type: "hello", role: "client", cid, perm, obs: online }));
        if (online) toObs({ type: "sync.request", cid });
        notifyDemand();
        announceDevices();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      log(`local relay on 127.0.0.1:${p}`);
      resolve({
        port: p,
        url: `http://127.0.0.1:${p}`,
        stop() { for (const w of [...obsSockets, ...clientSockets]) try { w.terminate(); } catch { /* */ } server.close(); },
      });
    });
  });
}

export const contentType = (path) => TYPES[path.split(".").pop()] ?? "application/octet-stream";
