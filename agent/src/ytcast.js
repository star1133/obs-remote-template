// YouTube to OBS: introduces the browser extension (the tab with the video) to the OBS browser sources showing
// /yt, so they can open a WebRTC connection to each other. Only connection setup passes through here; the video
// goes directly from the browser to OBS. Both ends are on this computer.
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

/** Fixed by the "key" in extension/manifest.json, so only our extension may act as the sender. */
export const EXTENSION_ID = "hcljicifhbkdcgiclmecbikmkkckalon";
export const SOURCE_NAME = "YouTube (Chrome)";

/** The extension's files: inlined by build.mjs (__EXTENSION__, base64), read from agent/extension when run from source. */
const files = typeof __EXTENSION__ !== "undefined"
  ? __EXTENSION__
  : Object.fromEntries(readdirSync(new URL("../extension/", import.meta.url)).map((f) => [f, readFileSync(new URL("../extension/" + f, import.meta.url)).toString("base64")]));

/** Puts the extension where Chrome can load it ("Load unpacked"). Only rewrites files that changed. */
export function writeExtension(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [name, b64] of Object.entries(files)) {
    const want = Buffer.from(b64, "base64"), path = join(dir, name);
    let have = null;
    try { have = readFileSync(path); } catch { /* new file */ }
    if (!have || !have.equals(want)) writeFileSync(path, want);
  }
  return dir;
}

export function createYtHub({ log = () => {}, playerOrigins }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  let sender = null;
  const players = new Map(); // id -> ws
  let seq = 0;
  let now = { title: "", videoId: "", playing: false, ad: false };
  let senderSince = 0;

  const send = (ws, m) => { try { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); } catch { /* closing */ } };
  const resetPlayers = () => { for (const p of players.values()) send(p, { type: "reset" }); };

  function onSender(ws) {
    if (sender) { send(sender, { type: "replaced" }); sender.close(4000, "replaced"); }
    sender = ws;
    senderSince = Date.now();
    log("youtube: extension connected");
    resetPlayers();
    send(ws, { type: "players", ids: [...players.keys()] });
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "signal") send(players.get(m.to), { type: "signal", data: m.data });
      else if (m.type === "reset") resetPlayers();
      else if (m.type === "now") {
        const ad = m.ad === true;
        if (ad !== now.ad) for (const p of players.values()) send(p, { type: "ad", on: ad });
        now = { title: String(m.title || "").slice(0, 200), videoId: String(m.videoId || "").slice(0, 20), playing: m.playing === true, ad };
      }
    });
    ws.on("close", () => {
      if (sender !== ws) return;
      sender = null;
      now = { title: "", videoId: "", playing: false, ad: false };
      log("youtube: extension disconnected");
      resetPlayers();
    });
  }

  function onPlayer(ws) {
    const id = "p" + ++seq;
    players.set(id, ws);
    send(ws, { type: "hello", id });
    if (now.ad) send(ws, { type: "ad", on: true });
    send(sender, { type: "join", id });
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "signal") send(sender, { type: "signal", from: id, data: m.data });
      else if (m.type === "want") send(sender, { type: "join", id, n: Number(m.n) || 0 }); // still no picture: ask the tab to offer again
    });
    ws.on("close", () => { players.delete(id); send(sender, { type: "leave", id }); });
  }

  // Chrome stops an extension's worker after 30 s without events; a message now and then keeps the link up.
  const keepAlive = setInterval(() => send(sender, { type: "ping" }), 10000);

  return {
    /** For the setup server's "upgrade" event. Returns false when the request is not ours. */
    upgrade(req, socket, head) {
      const url = new URL(req.url, "http://x");
      if (url.pathname !== "/yt/ws") return false;
      const origin = req.headers.origin ?? "";
      const role = url.searchParams.get("role");
      const ok = role === "sender" ? origin === `chrome-extension://${EXTENSION_ID}` : role === "player" ? playerOrigins.has(origin) : false;
      if (!ok) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return true; }
      wss.handleUpgrade(req, socket, head, (ws) => (role === "sender" ? onSender(ws) : onPlayer(ws)));
      return true;
    },
    status: () => ({ extension: !!sender, since: senderSince, players: players.size, ...now }),
    stop() { clearInterval(keepAlive); for (const c of wss.clients) c.terminate(); wss.close(); },
  };
}

/** Adds the YouTube browser source to the scene being prepared (preview in Studio Mode, else program), sized to the
 *  canvas. Mutes its sound when OBS already records the computer's sound (Desktop Audio), so viewers don't hear it twice. */
export async function addYtSource(request, url) {
  const studio = (await request("GetStudioModeEnabled")).studioModeEnabled;
  const sceneName = studio ? (await request("GetCurrentPreviewScene")).currentPreviewSceneName : (await request("GetCurrentProgramScene")).currentProgramSceneName;
  const { baseWidth, baseHeight } = await request("GetVideoSettings");
  const inputs = (await request("GetInputList")).inputs;
  let sceneItemId, created = false;
  if (inputs.some((i) => i.inputName === SOURCE_NAME)) {
    const items = (await request("GetSceneItemList", { sceneName })).sceneItems;
    const found = items.find((i) => i.sourceName === SOURCE_NAME);
    if (found) return { scene: sceneName, already: true };
    ({ sceneItemId } = await request("CreateSceneItem", { sceneName, sourceName: SOURCE_NAME }));
  } else {
    ({ sceneItemId } = await request("CreateInput", {
      sceneName, inputName: SOURCE_NAME, inputKind: "browser_source",
      inputSettings: { url, width: baseWidth, height: baseHeight, reroute_audio: true, shutdown: false, restart_when_active: false, css: "" },
    }));
    created = true;
  }
  await request("SetSceneItemTransform", {
    sceneName, sceneItemId,
    sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, boundsType: "OBS_BOUNDS_SCALE_INNER", boundsAlignment: 0, boundsWidth: baseWidth, boundsHeight: baseHeight },
  });
  let muted = false;
  if (created) {
    const special = Object.entries(await request("GetSpecialInputs")).filter(([k, v]) => k.startsWith("desktop") && v).map(([, v]) => v);
    const captures = inputs.filter((i) => i.inputKind === "wasapi_output_capture").map((i) => i.inputName);
    for (const name of new Set([...special, ...captures])) {
      const m = await request("GetInputMute", { inputName: name }).catch(() => null);
      if (m && !m.inputMuted) { muted = true; break; }
    }
    if (muted) await request("SetInputMute", { inputName: SOURCE_NAME, inputMuted: true });
  }
  return { scene: sceneName, created, muted };
}
