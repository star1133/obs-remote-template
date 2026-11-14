import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const MAX_TEXT = 64 * 1024;
const MAX_BINARY = 512 * 1024;
const PAIR_TTL_MS = 5 * 60 * 1000;
const PAIR_MAX_ACTIVE = 8;
const FAIL_LIMIT = 10;              // wrong pairing codes allowed ...
const FAIL_WINDOW_MS = 10 * 60 * 1000; // ... per room per window
const OP_RE = /^[A-Za-z0-9]{1,64}$/;

/** owner: paired from the OBS machine, can invite and revoke. operator: can control. viewer: watch only. */
type Role = "owner" | "operator" | "viewer";

interface ClientRec {
  hash: string;
  name: string;
  created: number;
  role?: Role; // missing on records written before roles existed: treated as owner
}

interface PairRec {
  exp: number;
  role: Role;
}

type Attachment = { role: "obs" } | { role: "client"; cid: string; preview: boolean; thumbs?: boolean; live?: boolean; max?: boolean; perm: Role };

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomId(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

function jres(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** One Room per OBS machine: authenticates both sides and forwards messages between them. */
export class Room extends DurableObject<Env> {
  // Token buckets live in memory only; losing them on hibernation just resets the budget.
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/init":
        return this.init(request);
      case "/pair":
        return this.pair(request);
      case "/ws/obs":
        return this.connectObs(request, url);
      case "/ws/client":
        return this.connectClient(request, url);
    }
    return new Response("not found", { status: 404 });
  }

  /** Token comes in the Sec-WebSocket-Protocol header ("obsr.<token>") so it never lands in URLs or logs;
   *  `?token=` is still accepted for simple tools. Returns the token and the protocol to echo back. */
  private tokenOf(request: Request, url: URL): { token: string; proto: string | null } {
    for (const p of (request.headers.get("sec-websocket-protocol") ?? "").split(",")) {
      const v = p.trim();
      if (v.startsWith("obsr.")) return { token: v.slice(5), proto: v };
    }
    return { token: url.searchParams.get("token") ?? "", proto: null };
  }

  private upgraded(ws: WebSocket, proto: string | null): Response {
    return new Response(null, { status: 101, webSocket: ws, headers: proto ? { "Sec-WebSocket-Protocol": proto } : undefined });
  }

  // ---- storage helpers -----------------------------------------------------

  private async clients(): Promise<Record<string, ClientRec>> {
    return (await this.ctx.storage.get<Record<string, ClientRec>>("clients")) ?? {};
  }

  /** Create a fresh pairing code with a role and return it. Old and expired codes are dropped. */
  private async newPairCode(role: Role): Promise<{ code: string; exp: number }> {
    const now = Date.now();
    const pairs = (await this.ctx.storage.get<Record<string, PairRec>>("pairs")) ?? {};
    for (const c of Object.keys(pairs)) if (pairs[c].exp < now) delete pairs[c];
    const live = Object.keys(pairs).sort((a, b) => pairs[a].exp - pairs[b].exp);
    while (live.length >= PAIR_MAX_ACTIVE) delete pairs[live.shift()!];
    let code = randomCode();
    while (pairs[code]) code = randomCode();
    const exp = now + PAIR_TTL_MS;
    pairs[code] = { exp, role };
    await this.ctx.storage.put("pairs", pairs);
    return { code, exp };
  }

  // ---- HTTP side ---------------------------------------------------------

  private async init(request: Request): Promise<Response> {
    if (await this.ctx.storage.get("dev")) return jres({ error: "exists" }, 409);
    const { room, token } = (await request.json()) as { room: string; token: string };
    await this.ctx.storage.put({ dev: await sha256Hex(token), room, clients: {} });
    return jres({ ok: true });
  }

  private async pair(request: Request): Promise<Response> {
    const { code, name } = (await request.json()) as { code: string; name: string };
    const now = Date.now();

    let fails = (await this.ctx.storage.get<{ n: number; at: number }>("fails")) ?? { n: 0, at: now };
    if (now - fails.at > FAIL_WINDOW_MS) fails = { n: 0, at: now };
    if (fails.n >= FAIL_LIMIT) return jres({ error: "locked" }, 429);

    const pairs = (await this.ctx.storage.get<Record<string, PairRec>>("pairs")) ?? {};
    for (const c of Object.keys(pairs)) if (pairs[c].exp < now) delete pairs[c];
    const match = Object.keys(pairs).find((c) => safeEqual(c, String(code)));
    if (!match) {
      fails.n++;
      await this.ctx.storage.put({ fails, pairs });
      return jres({ error: Object.keys(pairs).length ? "bad_code" : "no_code" }, 400);
    }
    const role = pairs[match].role;
    delete pairs[match]; // single use
    await this.ctx.storage.put({ pairs, fails: { n: 0, at: now } });

    const token = randomId(32);
    const cid = randomId(6);
    const clients = await this.clients();
    clients[cid] = { hash: await sha256Hex(token), name: name || "device", created: now, role };
    await this.ctx.storage.put("clients", clients);
    await this.announceDevices(clients);
    return jres({ clientToken: token, cid, role });
  }

  // ---- WebSocket upgrade -------------------------------------------------

  private async connectObs(request: Request, url: URL): Promise<Response> {
    const dev = await this.ctx.storage.get<string>("dev");
    const { token, proto } = this.tokenOf(request, url);
    if (!dev || !safeEqual(dev, await sha256Hex(token))) return new Response("unauthorized", { status: 401 });

    for (const old of this.ctx.getWebSockets("obs")) old.close(4000, "replaced");

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["obs"]);
    pair[1].serializeAttachment({ role: "obs" } satisfies Attachment);
    pair[1].send(JSON.stringify({ type: "hello", role: "obs", clients: this.clientSockets().length }));
    this.broadcast({ type: "presence", obs: true });
    pair[1].send(JSON.stringify({ type: "devices", data: this.deviceList(await this.clients()) }));
    this.notifyDemand();
    return this.upgraded(pair[0], proto);
  }

  private async connectClient(request: Request, url: URL): Promise<Response> {
    const { token, proto } = this.tokenOf(request, url);
    const hash = await sha256Hex(token);
    const clients = await this.clients();
    const cid = Object.keys(clients).find((id) => safeEqual(clients[id].hash, hash));
    if (!cid) return new Response("unauthorized", { status: 401 });
    const perm: Role = clients[cid].role ?? "owner";

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["client"]);
    pair[1].serializeAttachment({ role: "client", cid, preview: false, perm } satisfies Attachment);
    const obsOnline = this.obsSocket() !== undefined;
    pair[1].send(JSON.stringify({ type: "hello", role: "client", cid, perm, obs: obsOnline }));
    if (obsOnline) this.toObs({ type: "sync.request", cid });
    this.notifyDemand();
    void this.announceDevices(clients);
    return this.upgraded(pair[0], proto);
  }

  // ---- WebSocket handlers ------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;

    if (!this.allow(ws, att.role)) return;

    if (typeof message !== "string") {
      // Preview frames from OBS go only to clients that asked for them.
      if (att.role !== "obs" || message.byteLength > MAX_BINARY) return;
      const thumb = new Uint8Array(message)[0] === 2;
      for (const c of this.clientSockets()) {
        const a = c.deserializeAttachment() as Attachment;
        // Channel 2 = scene thumbnails, only for clients in Present mode.
        if (a.role === "client" && a.preview && (!thumb || a.thumbs)) c.send(message);
      }
      return;
    }
    if (message.length > MAX_TEXT) {
      ws.close(1009, "too large");
      return;
    }

    let m: Record<string, unknown>;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof m !== "object" || m === null) return;

    if (att.role === "client") await this.fromClient(ws, att, m);
    else await this.fromObs(m);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.onGone(ws);
    // 1005/1006/1015 are reserved and must not be sent in a close frame.
    try { ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason.slice(0, 120)); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  private onGone(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    // The closing socket is still listed by getWebSockets, so always exclude it explicitly.
    if (att?.role === "obs" && !this.ctx.getWebSockets("obs").some((w) => w !== ws)) this.broadcast({ type: "presence", obs: false });
    this.notifyDemand(ws);
    if (att?.role === "client") void this.clients().then((c) => this.announceDevices(c, ws));
  }

  private async fromClient(ws: WebSocket, att: Extract<Attachment, { role: "client" }>, m: Record<string, unknown>) {
    switch (m.type) {
      case "req": {
        const id = typeof m.id === "string" ? m.id.slice(0, 64) : "";
        if (typeof m.op !== "string" || !OP_RE.test(m.op)) return;
        if (att.perm === "viewer") {
          ws.send(JSON.stringify({ type: "res", id, ok: false, error: "view_only" }));
          return;
        }
        if (!this.toObs({ ...m, cid: att.cid })) {
          ws.send(JSON.stringify({ type: "res", id, ok: false, error: "obs_offline" }));
        }
        return;
      }
      case "sub":
        att.preview = m.preview === true;
        att.thumbs = att.preview && m.thumbs === true;
        att.live = att.preview && m.rate !== "eco"; // "eco" = low-rate preview to save CPU
        att.max = att.preview && m.rate === "max";  // "max" = as fast as OBS can render, at any CPU/GPU cost
        ws.serializeAttachment(att);
        this.notifyDemand();
        return;
      case "sync":
        this.toObs({ type: "sync.request", cid: att.cid });
        return;
      case "invite": {
        // Only owners can hand out access, and only operator/viewer roles (never owner).
        if (att.perm !== "owner") return void ws.send(JSON.stringify({ type: "invite.error", error: "owner_only" }));
        const role: Role = m.role === "viewer" ? "viewer" : "operator";
        const { code, exp } = await this.newPairCode(role);
        ws.send(JSON.stringify({ type: "invite.code", room: await this.ctx.storage.get<string>("room"), code, exp, role }));
        return;
      }
      case "devices":
        if (att.perm === "owner") ws.send(JSON.stringify({ type: "devices", data: this.deviceList(await this.clients()) }));
        return;
      case "revoke":
        if (att.perm === "owner" && typeof m.cid === "string" && m.cid !== att.cid) await this.revoke(m.cid);
        return;
    }
  }

  private async fromObs(m: Record<string, unknown>) {
    switch (m.type) {
      case "pair.request": {
        const role: Role = m.role === "viewer" ? "viewer" : m.role === "operator" ? "operator" : "owner";
        const { code, exp } = await this.newPairCode(role);
        const room = await this.ctx.storage.get<string>("room");
        this.toObs({ type: "pair.code", room, code, exp, role });
        return;
      }
      case "device.revoke":
        await this.revoke(String(m.cid ?? ""));
        return;
      case "res":
      case "evt":
      case "state.sync": {
        const cid = typeof m.cid === "string" ? m.cid : "";
        const text = JSON.stringify(m);
        if (!cid) return this.broadcastRaw(text);
        for (const c of this.clientSockets()) {
          const a = c.deserializeAttachment() as Attachment;
          if (a.role === "client" && a.cid === cid) {
            try { c.send(text); } catch { /* closing */ }
          }
        }
        return;
      }
    }
  }

  /** Remove a device and drop its sockets. */
  private async revoke(cid: string): Promise<void> {
    const clients = await this.clients();
    if (!clients[cid]) return;
    delete clients[cid];
    await this.ctx.storage.put("clients", clients);
    for (const c of this.clientSockets()) {
      const a = c.deserializeAttachment() as Attachment;
      if (a.role === "client" && a.cid === cid) c.close(4001, "revoked");
    }
    await this.announceDevices(clients);
  }

  // ---- helpers -----------------------------------------------------------

  private allow(ws: WebSocket, role: "obs" | "client"): boolean {
    const rate = role === "obs" ? 400 : 100; // messages per second
    const now = Date.now();
    const b = this.buckets.get(ws) ?? { tokens: rate * 2, at: now };
    b.tokens = Math.min(rate * 2, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    this.buckets.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private obsSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets("obs").find((w) => w.readyState === WebSocket.OPEN);
  }

  private clientSockets(): WebSocket[] {
    return this.ctx.getWebSockets("client");
  }

  private toObs(m: unknown): boolean {
    const obs = this.obsSocket();
    if (!obs) return false;
    try {
      obs.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }

  private broadcast(m: unknown): void {
    this.broadcastRaw(JSON.stringify(m));
  }

  private broadcastRaw(text: string): void {
    for (const c of this.clientSockets()) {
      try { c.send(text); } catch { /* socket closing */ }
    }
  }

  /** Tell the plugin how many viewers want preview frames so it can stop encoding when nobody does. */
  private notifyDemand(closing?: WebSocket): void {
    let clients = 0;
    let preview = 0;
    let thumbs = 0;
    let live = 0;
    let max = 0;
    for (const c of this.clientSockets()) {
      if (c === closing) continue;
      clients++;
      const a = c.deserializeAttachment() as Attachment;
      if (a.role === "client" && a.preview) preview++;
      if (a.role === "client" && a.preview && a.thumbs) thumbs++;
      if (a.role === "client" && a.preview && a.live) live++;
      if (a.role === "client" && a.preview && a.max) max++;
    }
    this.toObs({ type: "demand", clients, preview, thumbs, live, max });
  }

  /** The device list goes to the OBS side and to owners, whenever it changes. */
  private async announceDevices(clients: Record<string, ClientRec>, closing?: WebSocket): Promise<void> {
    const text = JSON.stringify({ type: "devices", data: this.deviceList(clients, closing) });
    this.obsSocket()?.send(text);
    for (const c of this.clientSockets()) {
      const a = c.deserializeAttachment() as Attachment;
      if (c !== closing && a.role === "client" && a.perm === "owner") {
        try { c.send(text); } catch { /* closing */ }
      }
    }
  }

  private deviceList(clients: Record<string, ClientRec>, closing?: WebSocket) {
    const online = new Set<string>();
    for (const c of this.clientSockets()) {
      if (c === closing) continue;
      const a = c.deserializeAttachment() as Attachment;
      if (a.role === "client") online.add(a.cid);
    }
    return Object.entries(clients).map(([cid, r]) => ({ cid, name: r.name, role: r.role ?? "owner", created: r.created, online: online.has(cid) }));
  }
}
