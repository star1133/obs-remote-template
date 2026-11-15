// The page inside the OBS browser source: receives the video from the YouTube tab (see agent/extension/content.js).
// ?debug shows the connection state in the corner (never on air otherwise).
const v = document.getElementById("v");
const msg = document.getElementById("msg");
const debug = new URLSearchParams(location.search).has("debug");
let ws = null, pc = null, id = "";
window.__ytpc = () => pc; // tests
let waitingSince = Date.now(); // no picture since then; after a while, ask for a fresh connection
let wants = 0; // numbered, so the tab can ignore an old request that arrives late
const stats = { frames: 0, connects: 0, state: "starting", log: [] };
const t0 = Date.now();
const note = (t) => { stats.log.push(`${((Date.now() - t0) / 1000).toFixed(1)} ${t}`); if (stats.log.length > 40) stats.log.shift(); };
window.__yt = stats;

const show = (t) => { stats.state = t; note(t); if (debug) { msg.hidden = false; msg.textContent = t; } };
const send = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };

function drop() {
  waitingSince = Date.now();
  if (pc) { try { pc.close(); } catch { /* closed */ } pc = null; }
  v.srcObject = null; // transparent again: no frozen picture on air
}

async function onOffer(sdp) {
  drop();
  pc = new RTCPeerConnection({ iceServers: [] });
  const ms = new MediaStream();
  pc.ontrack = (e) => {
    ms.addTrack(e.track);
    e.receiver.jitterBufferTarget = 0; // as little delay as the network allows; it never leaves this computer
    if (v.srcObject !== ms) v.srcObject = ms;
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); // plain browsers block sound until a click; OBS does not
  };
  pc.onicecandidate = (e) => send({ type: "signal", data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
  pc.onconnectionstatechange = () => {
    show(pc?.connectionState ?? "closed");
    if (pc?.connectionState === "connected") stats.connects++;
    else waitingSince = Date.now();
  };
  await pc.setRemoteDescription(sdp);
  await pc.setLocalDescription(await pc.createAnswer());
  send({ type: "signal", data: { sdp: pc.localDescription.toJSON() } });
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/yt/ws?role=player`);
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    note(m.type + (m.data?.sdp ? " " + m.data.sdp.type : m.data && "candidate" in m.data ? " candidate" : ""));
    if (m.type === "hello") { id = m.id; show("waiting for a YouTube tab"); }
    else if (m.type === "reset") { drop(); show("waiting for a YouTube tab"); }
    else if (m.type === "ad") { stats.ad = m.on; v.classList.toggle("ad", m.on); v.muted = m.on; show(m.on ? "advert hidden" : "connected"); }
    else if (m.type === "signal" && m.data?.sdp?.type === "offer") onOffer(m.data.sdp).catch((err) => show("error: " + err.message));
    else if (m.type === "signal" && m.data && "candidate" in m.data && pc) pc.addIceCandidate(m.data.candidate ?? null).catch(() => {});
  };
  ws.onclose = () => { drop(); show("OBS Remote is not running"); setTimeout(connect, 1000); };
}

// A lost setup message or a dropped connection: ask again every 6 s until the picture is back.
setInterval(() => {
  const fine = pc && ["connected", "connecting"].includes(pc.connectionState);
  if (!fine && Date.now() - waitingSince > 6000) { waitingSince = Date.now(); send({ type: "want", n: ++wants }); }
}, 1000);

const count = () => { stats.frames++; v.requestVideoFrameCallback(count); };
v.requestVideoFrameCallback(count);
connect();
