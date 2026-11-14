import { Room } from "./room";

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  REGISTRATION_KEY?: string;
  /** Optional: where /download/OBS-Remote-Setup.exe sends people (e.g. your latest GitHub release asset). */
  INSTALLER_URL?: string;
  /** Per-IP brakes (wrangler.jsonc "ratelimits"); absent in tests, then no limit. */
  REG_LIMIT?: RateLimit;
  PAIR_LIMIT?: RateLimit;
}

const ROOM_RE = /^[a-z2-7]{10}$/;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'self' wss: ws:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function randomRoomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % 32]).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function roomStub(env: Env, room: string) {
  return env.ROOM.get(env.ROOM.idFromName(room));
}

async function limited(rl: RateLimit | undefined, request: Request): Promise<boolean> {
  if (!rl) return false;
  const key = request.headers.get("cf-connecting-ip") ?? "local";
  return !(await rl.limit({ key })).success;
}


const PAGES: Record<string, string> = { "/": "/index.html", "/app": "/index.html", "/app/": "/index.html" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // OBS plugin creates a room (once) and keeps the returned device token.
    if (path === "/api/register" && request.method === "POST") {
      if (await limited(env.REG_LIMIT, request)) return json({ error: "slow_down" }, 429);
      if (env.REGISTRATION_KEY && request.headers.get("x-registration-key") !== env.REGISTRATION_KEY) {
        return json({ error: "forbidden" }, 403);
      }
      const room = randomRoomId();
      const deviceToken = randomToken();
      const res = await roomStub(env, room).fetch("https://room/init", {
        method: "POST",
        body: JSON.stringify({ room, token: deviceToken }),
      });
      if (!res.ok) return json({ error: "init_failed" }, 500);
      return json({ room, deviceToken });
    }

    // Browser exchanges the pairing code shown in the OBS dock for a client token.
    if (path === "/api/pair" && request.method === "POST") {
      if (await limited(env.PAIR_LIMIT, request)) return json({ error: "slow_down" }, 429);
      let body: { room?: string; code?: string; name?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_request" }, 400);
      }
      const room = String(body.room ?? "").toLowerCase();
      if (!ROOM_RE.test(room)) return json({ error: "bad_room" }, 400);
      const res = await roomStub(env, room).fetch("https://room/pair", {
        method: "POST",
        body: JSON.stringify({ code: String(body.code ?? ""), name: String(body.name ?? "").slice(0, 40) }),
      });
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }

    if (path === "/ws/obs" || path === "/ws/client") {
      if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const room = (url.searchParams.get("room") ?? "").toLowerCase();
      if (!ROOM_RE.test(room)) return new Response("bad room", { status: 400 });
      return roomStub(env, room).fetch(request);
    }

    if (path.startsWith("/api/")) return json({ error: "not_found" }, 404);
    if (path === "/download/OBS-Remote-Setup.exe" && request.method === "GET") return env.INSTALLER_URL ? Response.redirect(env.INSTALLER_URL, 302) : new Response("installer not published", { status: 404 });

    // The control app is served at "/" and "/app" (the agent's own relay serves it at "/" too).
    const page = PAGES[path];
    const res = await env.ASSETS.fetch(page ? new Request(new URL(page, request.url), request) : request);
    const out = new Response(res.body, res);
    out.headers.set("content-security-policy", CSP);
    out.headers.set("x-content-type-options", "nosniff");
    out.headers.set("referrer-policy", "no-referrer");
    return out;
  },
} satisfies ExportedHandler<Env>;
