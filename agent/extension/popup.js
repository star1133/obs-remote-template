const $ = (s) => document.querySelector(s);
const ask = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));

async function paint() {
  const s = await ask({ type: "status" });
  if (!s) return;
  $("#on").checked = s.on;
  $("#link").textContent = !s.on ? "Switched off" : s.connected ? "Connected to OBS Remote" : "OBS Remote is not running on this computer";
  $("#link").className = "row" + (s.on && s.connected ? " ok" : "");
  $("#now").textContent = s.title ? (s.ad ? "Advert playing, hidden in OBS: " : s.playing ? "Sending: " : "Paused: ") + s.title : s.tabs ? "Play a video to send it" : "Open a YouTube video";
  $("#now").className = "row" + (s.title && s.playing ? " live" : "");
  $("#obs").textContent = s.players ? `Showing in OBS (${s.players})` : "No OBS source yet";
}

$("#on").addEventListener("change", async (e) => { await ask({ type: "set", on: e.target.checked }); paint(); });
paint();
setInterval(paint, 1000);
