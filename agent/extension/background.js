// Links the YouTube tabs to OBS Remote on this computer (ws://127.0.0.1:<port>/yt/ws).
// The tab that most recently started playing is the one OBS shows; the others wait. The video itself goes straight
// from that tab to the OBS browser source over WebRTC; this worker only passes the connection setup messages along.

const DEFAULT_PORT = 47890;
const tabs = new Map(); // tabId -> { port, playing, title, videoId, at }
let active = null; // tabId sending to OBS
let ws = null, wsOpen = false, retry = 0, players = [];
let settings = { port: DEFAULT_PORT, on: true };
const boot = Date.now();
// A restarted worker must not connect before it knows the saved port and switch.
const loaded = chrome.storage.local.get("settings").then((s) => { settings = { ...settings, ...s.settings }; }, () => {});

// The last connection events, for the popup's status answer (helps when OBS shows nothing).
const trace = [];
const note = (t) => { trace.push(`${((Date.now() - boot) / 1000).toFixed(1)} ${t}`); if (trace.length > 30) trace.shift(); };
const toAgent = (m) => { if (m.type !== "ping") note("> agent " + m.type); if (wsOpen) ws.send(JSON.stringify(m)); };
const toTab = (id, m) => { note(`> tab ${m.type}${m.players ? " " + m.players.length : ""}`); try { tabs.get(id)?.port.postMessage(m); } catch { /* tab went away */ } };

async function connect() {
  await loaded;
  if (ws || !settings.on) return;
  const sock = ws = new WebSocket(`ws://127.0.0.1:${settings.port}/yt/ws?role=sender`);
  sock.onopen = () => { wsOpen = true; retry = 0; note("ws open"); report(); };
  sock.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type !== "ping") note(`< agent ${m.type} (active ${active != null})`);
    if (m.type === "players") { players = m.ids; if (active != null) toTab(active, { type: "start", players }); }
    else if (m.type === "join") { players = [...players, m.id]; if (active != null) toTab(active, m); }
    else if (m.type === "leave") { players = players.filter((p) => p !== m.id); if (active != null) toTab(active, m); }
    else if (m.type === "signal" && active != null) toTab(active, m);
    // "ping" from OBS Remote: nothing to do, receiving it is what keeps this worker running
  };
  sock.onclose = () => {
    if (ws !== sock) return; // replaced on purpose (port changed, switched off)
    ws = null; wsOpen = false; players = [];
    if (active != null) toTab(active, { type: "stop" });
    if (settings.on && tabs.size) setTimeout(connect, Math.min(10000, 1000 * 2 ** retry++));
  };
}

/** Picks the tab to send: the one that started playing last, else the last one that played at all. */
function choose() {
  let best = null;
  for (const [id, t] of tabs) if (t.at && (best == null || t.at > tabs.get(best).at)) best = id;
  if (!settings.on) best = null;
  if (best === active) return;
  if (active != null) toTab(active, { type: "stop" });
  active = best;
  toAgent({ type: "reset" }); // players drop the old tab's picture before the new tab offers its own
  if (active != null && wsOpen) toTab(active, { type: "start", players });
  report();
}

function report() {
  const t = active != null ? tabs.get(active) : null;
  toAgent(t ? { type: "now", title: t.title, videoId: t.videoId, playing: t.playing, ad: !!t.ad } : { type: "now", title: "", videoId: "", playing: false, ad: false });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "yt" || !port.sender?.tab) return;
  const id = port.sender.tab.id;
  // A page that reloads connects again before its old port reports closed; the old one must not remove the new.
  const rec = { port, playing: false, title: "", videoId: "", at: 0 };
  tabs.set(id, rec);
  connect();
  port.onMessage.addListener((m) => {
    const t = rec;
    if (tabs.get(id) !== rec) return;
    if (m.type !== "ping" && m.type !== "signal") note(`< tab ${m.type}${m.type === "state" ? (m.playing ? " playing" : " stopped") : ""}`);
    if (m.type === "state") {
      if (m.playing && !t.playing) t.at = Date.now(); // started playing: this tab takes over
      Object.assign(t, { playing: !!m.playing, ad: !!m.ad, title: String(m.title || "").slice(0, 200), videoId: String(m.videoId || "").slice(0, 20) });
      if (id === active) report();
      choose();
    } else if (m.type === "signal" && id === active) {
      toAgent({ type: "signal", to: m.to, data: m.data });
    }
  });
  port.onDisconnect.addListener(() => {
    if (tabs.get(id) !== rec) return;
    tabs.delete(id);
    if (id === active) { active = null; toAgent({ type: "reset" }); }
    choose();
  });
});

// Popup: status and the on/off switch.
chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.type === "status") {
    const t = active != null ? tabs.get(active) : null;
    reply({ boot, trace, on: settings.on, port: settings.port, connected: wsOpen, players: players.length, tabs: tabs.size, title: t?.title || "", playing: !!t?.playing, ad: !!t?.ad });
  } else if (m?.type === "set") {
    settings = { ...settings, ...(typeof m.on === "boolean" ? { on: m.on } : {}), ...(Number(m.port) > 0 ? { port: Number(m.port) } : {}) };
    chrome.storage.local.set({ settings });
    const old = ws;
    ws = null; wsOpen = false; players = [];
    try { old?.close(); } catch { /* replaced below */ }
    if (settings.on && tabs.size) connect();
    choose();
    reply({ ok: true });
  }
});

// Keeps the worker awake while a tab is linked (a quiet worker is stopped after 30 s and the link would drop).
setInterval(() => { if (wsOpen) toAgent({ type: "ping" }); }, 10000);

loaded.then(() => { if (tabs.size) connect(); });
