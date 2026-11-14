const $ = (s) => document.querySelector(s);
const csrf = document.querySelector('meta[name=csrf]').content;
const NS = "http://www.w3.org/2000/svg";

async function post(path, body = {}) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-obsr-csrf": csrf }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `error ${r.status}`);
  return j;
}

const dock = location.pathname === "/dock"; // the same page, compact, inside an OBS dock
if (dock) document.body.classList.add("dock");

let expiresAt = 0;
let baseline = null; // paired-device count when the QR was shown: a new one means the scan worked
let autoShown = false;

function paint(s) {
  $("#host").textContent = s.host;
  const o = s.obs;
  const od = $("#obsDot"), ot = $("#obsTxt");
  od.dataset.s = o.state === "connected" ? "ok" : o.state === "auth" || o.state === "refused" ? "bad" : "wait";
  ot.textContent = o.state === "connected" ? `connected · ${o.detail}` : o.state === "auth" ? "wrong WebSocket password" : "waiting for OBS";
  const help = $("#help");
  let hint = "";
  if (o.state === "waiting") {
    hint = s.obsWs && !s.obsWs.enabled
      ? "OBS's WebSocket server is switched off. In OBS: Tools → WebSocket Server Settings → tick “Enable WebSocket server”."
      : "Start OBS Studio. This page updates by itself.";
  }
  help.hidden = !hint;
  help.textContent = hint;
  $("#pwForm").hidden = o.state !== "auth";
  if (document.activeElement !== $("#presentKeys")) $("#presentKeys").checked = !!s.presentKeys;

  $("#modeCard").hidden = !s.canSwitch;
  $("#modeCloudName").textContent = s.cloudHost || "Online server";
  for (const b of document.querySelectorAll("#modeCard [data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === s.mode));

  const r = $("#relDot");
  r.dataset.s = s.relay.state === "up" ? "ok" : s.relay.state === "down" ? "bad" : "wait";
  $("#relTxt").textContent = s.relay.state === "up" ? "connected" : s.relay.detail || "connecting…";

  const tr = $("#tunRow");
  tr.hidden = !s.tunnel;
  if (s.tunnel) {
    const t = s.tunnel;
    $("#tunDot").dataset.s = t.state === "up" ? "ok" : t.state === "blocked" || t.state === "error" ? "bad" : "wait";
    $("#tunTxt").textContent = t.state === "up" ? t.url.replace("https://", "") : t.detail || "starting…";
  }

  const online = s.devices.filter((d) => d.online).length;
  $("#devDot").dataset.s = online ? "ok" : "";
  $("#devTxt").textContent = `${online} online · ${s.devices.length} paired`;

  const ul = $("#devs");
  ul.replaceChildren(...s.devices.map((d) => {
    const li = document.createElement("li");
    const dot = Object.assign(document.createElement("span"), { className: "dot" });
    dot.dataset.s = d.online ? "ok" : "";
    const name = Object.assign(document.createElement("span"), { className: "name", textContent: d.name });
    const tag = Object.assign(document.createElement("span"), { className: "tag", textContent: d.role === "viewer" ? "view only" : d.role === "operator" ? "control" : "full" });
    const b = Object.assign(document.createElement("button"), { className: "btn danger", textContent: "Remove" });
    b.addEventListener("click", async () => { if (confirm(`Remove “${d.name}”? It will be signed out.`)) { await post("/api/revoke", { cid: d.cid }); poll(); } });
    li.append(dot, name, tag, b);
    return li;
  }));
  $("#noDevs").hidden = s.devices.length > 0;
  $("#relayUrl").textContent = s.relayUrl;
  $("#room").textContent = s.room;

  // The scan worked: hide the QR so it is not left lying around on a stream preview.
  if (baseline !== null && (s.devices.length > baseline.n || online > baseline.online)) {
    const who = s.devices.find((d) => d.online && d.created >= baseline.at - 1000) ?? s.devices[s.devices.length - 1];
    hideQr(`Connected${who ? ": " + who.name : ""}. The code is hidden.`);
  }
  // First run inside OBS: nobody has paired yet, so show the QR straight away.
  if (dock && !autoShown && s.devices.length === 0 && s.relay.state === "up") { autoShown = true; $("#btnCode").click(); }
  $("#btnCode").textContent = $("#pairBox").hidden ? (s.devices.length ? "Add another device" : "Show code") : "New code";
}

function hideQr(msg) {
  baseline = null;
  expiresAt = 0;
  $("#pairBox").hidden = true;
  $("#link").value = "";
  $("#code").textContent = "";
  $("#pairedMsg").textContent = msg;
  $("#pairedMsg").hidden = !msg;
}

async function poll() {
  try {
    const s = await (await fetch("/api/status")).json();
    paint(s);
  } catch {
    $("#obsTxt").textContent = "the agent stopped";
  }
  if (expiresAt) {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    $("#expiry").textContent = left ? `Code valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Code expired — show a new one.";
    if (!left) hideQr("Code expired. Press the button for a new one.");
  }
}

function drawQr({ n, rows }) {
  const svg = $("#qr");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  const p = document.createElementNS(NS, "path");
  let d = "";
  rows.forEach((row, y) => { for (let x = 0; x < n; x++) if (row[x] === "1") d += `M${x} ${y}h1v1h-1z`; });
  p.setAttribute("d", d);
  p.setAttribute("fill", "#000");
  svg.replaceChildren(p);
}

$("#btnCode").addEventListener("click", async () => {
  $("#pairErr").textContent = "";
  try {
    const cur = await (await fetch("/api/status")).json();
    const r = await post("/api/pair", { role: $("#role").value });
    baseline = { n: cur.devices.length, online: cur.devices.filter((d) => d.online).length, at: Date.now() };
    $("#pairedMsg").hidden = true;
    drawQr(r.qr);
    $("#code").textContent = `${r.room.toUpperCase()}-${r.code.match(/.{1,4}/g).join("-")}`;
    $("#link").value = r.url;
    expiresAt = r.exp;
    $("#pairBox").hidden = false;
    poll();
  } catch (e) {
    $("#pairErr").textContent = e.message;
  }
});

$("#btnCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#link").value); $("#btnCopy").textContent = "Copied"; } catch { $("#link").select(); }
  setTimeout(() => { $("#btnCopy").textContent = "Copy link"; }, 1500);
});

$("#pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await post("/api/obs-password", { password: $("#pw").value });
  $("#pw").value = "";
  poll();
});

$("#btnOpen").addEventListener("click", async () => {
  try { await post("/api/open", {}); } catch (e) { $("#pairErr").textContent = e.message; }
});
$("#presentKeys").addEventListener("change", async (e) => { await post("/api/present-keys", { on: e.target.checked }); poll(); });

for (const b of document.querySelectorAll("#modeCard [data-mode]")) {
  b.addEventListener("click", async () => {
    if (b.getAttribute("aria-checked") === "true") return;
    $("#modeMsg").textContent = "Switching… this page reconnects in a few seconds. Phones paired in the other mode will need no new scan when you come back.";
    try { await post("/api/mode", { mode: b.dataset.mode }); } catch (e) { $("#modeMsg").textContent = e.message; }
  });
}
$("#btnQuit").addEventListener("click", async () => {
  try { await post("/api/quit", {}); } catch { /* the page dies with the program */ }
  document.body.textContent = "OBS Remote has stopped.";
});
let sure = 0;
$("#btnUninstall").addEventListener("click", async (e) => {
  if (!sure) { sure = 1; e.target.textContent = "Click again to remove everything"; setTimeout(() => { sure = 0; e.target.textContent = "Uninstall…"; }, 5000); return; }
  try { await post("/api/uninstall", {}); } catch { /* the program is leaving */ }
  document.body.textContent = "Uninstalling… you can close this window.";
});

poll();
setInterval(poll, 1500);
