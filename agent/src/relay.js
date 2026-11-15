// WebSocket link to the Cloudflare relay (/ws/obs). Reconnects forever with backoff.
// A ping every PING_MS; nothing back for DEAD_MS after one means the link is dead (sleep, network change, a router
// that dropped the session) even though no close arrived, so it is dropped and opened again at once.
const PING_MS = 5000, DEAD_MS = 11000, CONNECT_MS = 15000;

export function createRelayLink({ relay, room, token, onMessage, onUp, onDown, log = () => {} }) {
  const wsUrl = relay.replace(/^http/, "ws").replace(/\/+$/, "") + `/ws/obs?room=${room}`;
  let ws = null, stopped = false, tries = 0, timer = null, waitSince = 0, pinger = null;
  let state = { state: "connecting", detail: "", since: Date.now() };
  const set = (s, detail = "") => { state = { state: s, detail, since: Date.now() }; };

  function open() {
    if (stopped) return;
    set("connecting");
    let sock;
    try { sock = new WebSocket(wsUrl, ["obsr." + token]); } catch (e) { set("down", e.message); return retry(); }
    sock.binaryType = "arraybuffer";
    ws = sock;
    const opening = setTimeout(() => { if (sock.readyState === 0) drop(sock, "connect timeout"); }, CONNECT_MS);
    sock.onopen = () => {
      clearTimeout(opening);
      tries = 0;
      waitSince = 0;
      set("up");
      clearInterval(pinger);
      pinger = setInterval(() => {
        if (waitSince && Date.now() - waitSince > DEAD_MS) return drop(sock, "no answer from the relay");
        if (!waitSince) waitSince = Date.now();
        try { sock.send("ping"); } catch { /* */ }
      }, PING_MS);
      onUp();
    };
    sock.onmessage = (ev) => {
      waitSince = 0;
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m && typeof m === "object") onMessage(m);
    };
    sock.onclose = (ev) => { clearTimeout(opening); closed(sock, ev.code); };
    sock.onerror = () => { /* onclose follows */ };
  }

  function closed(sock, code) {
    if (ws !== sock) return;
    clearInterval(pinger);
    ws = null;
    onDown();
    if (stopped) return;
    if (code === 4000) { set("down", "another agent took over this room"); return retry(30000); }
    set("down", tries > 2 ? "relay unreachable or token rejected" : "reconnecting");
    retry();
  }

  /** Give up on a socket without waiting for its close handshake, which never finishes on a dead network. */
  function drop(sock, why) {
    log("relay link: " + why);
    sock.onclose = sock.onmessage = sock.onopen = null;
    try { sock.close(); } catch { /* */ }
    tries = 0; // the network was fine a moment ago: come back quickly
    closed(sock, 4999);
  }

  function retry(ms) {
    if (stopped) return;
    tries++;
    clearTimeout(timer);
    timer = setTimeout(open, ms ?? Math.min(500 * 2 ** Math.min(tries, 5), 15000) + Math.random() * 400);
  }

  return {
    start: open,
    stop() { stopped = true; clearTimeout(timer); clearInterval(pinger); try { ws?.close(); } catch { /* */ } },
    status: () => ({ ...state }),
    /** JSON object or a binary frame. Frames are dropped while the socket is backed up. */
    send(m) {
      if (!ws || ws.readyState !== 1) return false;
      try {
        if (m instanceof Uint8Array) { if (ws.bufferedAmount > 300_000) return false; ws.send(m); } else ws.send(JSON.stringify(m));
        return true;
      } catch { return false; }
    },
  };
}
