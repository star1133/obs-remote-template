// WebSocket link to the Cloudflare relay (/ws/obs). Reconnects forever with backoff.
export function createRelayLink({ relay, room, token, onMessage, onUp, onDown, log = () => {} }) {
  const wsUrl = relay.replace(/^http/, "ws").replace(/\/+$/, "") + `/ws/obs?room=${room}`;
  let ws = null, stopped = false, tries = 0, timer = null, lastRx = 0, pinger = null;
  let state = { state: "connecting", detail: "", since: Date.now() };
  const set = (s, detail = "") => { state = { state: s, detail, since: Date.now() }; };

  function open() {
    if (stopped) return;
    set("connecting");
    let sock;
    try { sock = new WebSocket(wsUrl, ["obsr." + token]); } catch (e) { set("down", e.message); return retry(); }
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      tries = 0;
      lastRx = Date.now();
      set("up");
      clearInterval(pinger);
      pinger = setInterval(() => {
        if (Date.now() - lastRx > 50000) return sock.close();
        try { sock.send("ping"); } catch { /* */ }
      }, 20000);
      onUp();
    };
    sock.onmessage = (ev) => {
      lastRx = Date.now();
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m && typeof m === "object") onMessage(m);
    };
    sock.onclose = (ev) => {
      clearInterval(pinger);
      if (ws === sock) ws = null;
      onDown();
      if (stopped) return;
      if (ev.code === 4000) { set("down", "another agent took over this room"); return retry(30000); }
      set("down", tries > 2 ? "relay unreachable or token rejected" : "reconnecting");
      retry();
    };
    sock.onerror = () => { /* onclose follows */ };
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
