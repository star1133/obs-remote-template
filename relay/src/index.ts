import { Room, refuseSocket } from "./room";

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  REGISTRATION_KEY?: string;
  /** Per-IP brakes (wrangler.jsonc "ratelimits"); absent in tests, then no limit. */
  REG_LIMIT?: RateLimit;
  PAIR_LIMIT?: RateLimit;
  ROOM_LIMIT?: RateLimit;
  /** Rooms made before room ids were signed, comma separated; they keep working. */
  LEGACY_ROOMS?: string;
  /** Optional: where /download/OBS-Remote-Setup.exe sends people (e.g. your latest GitHub release asset). */
  INSTALLER_URL?: string;
  /** Where new rooms are made ("apac", "weur", "enam", ...): near the people who use this relay, so every command
   *  takes the shortest trip. Only affects rooms created after it is set. */
  LOCATION_HINT?: string;
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

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** With REGISTRATION_KEY set, a room id is 6 random characters plus a 4 character tag signed with that key, so the
 *  Worker can turn away made-up rooms before they wake (and bill) a Durable Object. */
async function roomTag(key: string, head: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("room:" + head)));
  return Array.from(mac.slice(0, 4), (b) => B32[b % 32]).join("");
}

async function randomRoomId(env: Env): Promise<string> {
  const head = Array.from(crypto.getRandomValues(new Uint8Array(env.REGISTRATION_KEY ? 6 : 10)), (b) => B32[b % 32]).join("");
  return env.REGISTRATION_KEY ? head + (await roomTag(env.REGISTRATION_KEY, head)) : head;
}

async function knownRoom(env: Env, room: string): Promise<boolean> {
  if (!ROOM_RE.test(room)) return false;
  if (!env.REGISTRATION_KEY) return true; // open relay: any well-formed room
  if ((env.LEGACY_ROOMS ?? "").split(",").map((r) => r.trim()).includes(room)) return true;
  return room.slice(6) === (await roomTag(env.REGISTRATION_KEY, room.slice(0, 6)));
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function roomStub(env: Env, room: string) {
  const hint = env.LOCATION_HINT as DurableObjectLocationHint | undefined;
  return env.ROOM.get(env.ROOM.idFromName(room), hint ? { locationHint: hint } : undefined);
}

async function limited(rl: RateLimit | undefined, request: Request): Promise<boolean> {
  if (!rl) return false;
  const key = request.headers.get("cf-connecting-ip") ?? "local";
  return !(await rl.limit({ key })).success;
}


const PAGES: Record<string, string> = { "/": "/index.html", "/app": "/index.html" };

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
      const room = await randomRoomId(env);
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
      if (!(await knownRoom(env, room))) return json({ error: "bad_room" }, 400);
      const res = await roomStub(env, room).fetch("https://room/pair", {
        method: "POST",
        body: JSON.stringify({ code: String(body.code ?? ""), name: String(body.name ?? "").slice(0, 40) }),
      });
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }

    if (path === "/ws/obs" || path === "/ws/client") {
      if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      if (await limited(env.ROOM_LIMIT, request)) return new Response("slow down", { status: 429 });
      const room = (url.searchParams.get("room") ?? "").toLowerCase();
      if (!(await knownRoom(env, room))) return path === "/ws/client" ? refuseSocket(request, 4004, "unknown room") : new Response("bad room", { status: 400 });
      return roomStub(env, room).fetch(request);
    }

    if (path.startsWith("/api/")) return json({ error: "not_found" }, 404);
    if (path === "/download/OBS-Remote-Setup.exe" && request.method === "GET") return env.INSTALLER_URL ? Response.redirect(env.INSTALLER_URL, 302) : new Response("installer not published", { status: 404 });

    // The control app is served at "/" and "/app" (the agent's own relay serves it at "/" too).
    // "/app/" would load the app with its files looked up under /app/, so it goes to "/app" (keeping ?demo and #pair=).
    if (path === "/app/") return Response.redirect(new URL("/app" + url.search, request.url).toString(), 301);
    const page = PAGES[path];
    const res = await env.ASSETS.fetch(page ? new Request(new URL(page, request.url), request) : request);
    const out = new Response(res.body, res);
    out.headers.set("content-security-policy", CSP);
    out.headers.set("x-content-type-options", "nosniff");
    out.headers.set("referrer-policy", "no-referrer");
    return out;
  },
} satisfies ExportedHandler<Env>;
