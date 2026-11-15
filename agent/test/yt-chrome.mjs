// YouTube to OBS, end to end with real YouTube (needs Chrome and internet): the agent from source + Chrome with the
// extension playing a video + a second Chrome showing /yt in place of the OBS browser source. Checks the picture
// arrives, follows a clip change, hides adverts, recovers a dropped connection and keeps going in a background tab.
//   node test/yt-chrome.mjs [screenshot dir]      REALOBS=1 also shows it in a throwaway scene of the OBS on this PC
//   HEADED=1 shows the browsers.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const out = process.argv[2] ?? join(tmpdir(), "yt-out");
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 47995;
const home = mkdtempSync(join(tmpdir(), "obsr-yt-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ mode: "local", obsPort: 4999 }));
const agent = spawn(process.execPath, [join(ROOT, "agent/src/main.js"), "run"], { env: { ...process.env, OBSR_HOME: home, OBSR_PORT: String(PORT), OBSR_NO_TUNNEL: "1", OBSR_NO_BROWSER: "1", OBSR_NO_TRAY: "1", OBSR_NO_OBS: "1" }, stdio: ["ignore", "inherit", "inherit"] });
const status = () => fetch(`http://127.0.0.1:${PORT}/api/status`).then((r) => r.json(), () => null);
let st;
for (let i = 0; i < 60 && !st?.yt; i++) { await wait(300); st = await status(); }
console.log("agent up, extension folder:", st.yt.folder);
let ok = true;
const check = (n, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); ok &&= !!c; };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const HEADLESS = process.env.HEADED ? [] : ["--headless=new"];

// --- CDP over a pipe (needed for Extensions.loadUnpacked)
function pipeChrome(extra) {
  const p = spawn(CHROME, [...HEADLESS, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${mkdtempSync(join(tmpdir(), "obsr-ytc-"))}`, "--no-first-run", "--autoplay-policy=no-user-gesture-required", `--user-agent=${UA}`, "--window-size=1280,800", ...extra, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const w = p.stdio[3], r = p.stdio[4];
  let buf = "", seq = 0;
  const pending = new Map(), listeners = [];
  r.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else listeners.forEach((f) => f(m));
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result))); w.write(JSON.stringify({ id, method, params, sessionId }) + "\0"); });
  return { p, send, on: (f) => listeners.push(f) };
}

const A = pipeChrome([]);
const { id: extId } = await A.send("Extensions.loadUnpacked", { path: st.yt.folder });
check(`extension loads with the fixed id (${extId})`, extId === "hcljicifhbkdcgiclmecbikmkkckalon");
// point the extension at the test agent's port, through its popup (the same path a user's click takes)
const { targetId: popT } = await A.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
const { sessionId: popS } = await A.send("Target.attachToTarget", { targetId: popT, flatten: true });
await wait(800);
const popjs = async (e) => (await A.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, popS)).result.value;
console.log("port set:", await popjs(`chrome.runtime.sendMessage({ type: "set", port: ${PORT}, on: true }).then(() => chrome.runtime.sendMessage({ type: "status" })).then((s) => s.port)`));
const swState = () => popjs(`chrome.runtime.sendMessage({ type: "status" })`);

const { targetId: ytT } = await A.send("Target.createTarget", { url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" });
const { sessionId: yS } = await A.send("Target.attachToTarget", { targetId: ytT, flatten: true });
const yjs = async (e) => (await A.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, yS)).result.value;
await A.send("Page.enable", {}, yS);
await A.send("Runtime.enable", {}, yS);

// consent page / paused autoplay: nudge it to play
for (let i = 0; i < 40; i++) {
  const v = await yjs(`(() => { const v = document.querySelector("video"); if (v && v.paused) { v.muted = false; v.play().catch(() => {}); } return v ? { t: v.currentTime, paused: v.paused, w: v.videoWidth, url: location.href } : { url: location.href }; })()`);
  if (v?.t > 1 && !v.paused) { console.log("youtube playing", v); break; }
  if (i === 39) console.log("youtube state", v);
  await wait(500);
}
for (let i = 0; i < 20; i++) { st = await status(); if (st.yt.extension && st.yt.playing) break; await wait(300); }
{ const x = await swState(); console.log("extension trace:", x.trace.join(" | ")); }
if (process.env.STOP) { A.p.kill(); agent.kill(); process.exit(1); }
check(`agent sees the extension and the playing video ("${st.yt.title}")`, st.yt.extension && st.yt.playing && st.yt.videoId === "aqz-KE-bpKQ");

// --- the "OBS" side: a separate Chrome showing /yt
const B = pipeChrome([]);
const { targetId: pT } = await B.send("Target.createTarget", { url: `http://127.0.0.1:${PORT}/yt?debug` });
const { sessionId: pS } = await B.send("Target.attachToTarget", { targetId: pT, flatten: true });
const pjs = async (e) => (await B.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, pS)).result.value;
const player = () => pjs(`({ ...window.__yt, w: document.getElementById("v").videoWidth, h: document.getElementById("v").videoHeight, audio: document.getElementById("v").srcObject?.getAudioTracks().length ?? 0 })`);
let p;
for (let i = 0; i < 40; i++) { p = await player(); if (p?.state === "connected" && p.frames > 10) break; await wait(250); }
console.log("player", p);
console.log("worker started", (Date.now() - (await swState()).boot) / 1000, "s ago");
{ const x = await swState(); console.log("extension trace:", x.trace.join(" | ")); }
check("OBS page connects and receives frames", p?.state === "connected" && p.frames > 10);
check(`picture size ${p?.w}x${p?.h}, with sound track`, p?.w >= 640 && p?.audio === 1);
await wait(4000);
const p2 = await player();
const fps = (p2.frames - p.frames) / 4;
const pv = await pjs(`(async () => { const v = document.getElementById("v"); const s = [...(await (window.__pc?.getStats?.() ?? new Map())).values()]; return { w: v.videoWidth, h: v.videoHeight }; })()`);
console.log(`fps ~${fps.toFixed(1)}, size ${pv.w}x${pv.h}`);
check(`smooth enough (~${fps.toFixed(0)} fps)`, fps > 15);
const shot = async (n) => { const r = await B.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, pS); writeFileSync(join(out, n + ".jpg"), Buffer.from(r.data, "base64")); };
await shot("1-first-clip");

// clip change the way a person does it: click another video on the page (YouTube swaps it in without a reload)
const before = await yjs("performance.timeOrigin");
const picked = await yjs(`(() => { const a = [...document.querySelectorAll('#secondary a[href*="/watch?v="], #related a[href*="/watch?v="], a[href*="/watch?v="]')].find((x) => !x.href.includes("aqz-KE-bpKQ") && x.offsetParent); if (!a) return ""; a.click(); return new URL(a.href).searchParams.get("v"); })()`);
const tClick = Date.now();
console.log("clicked related video:", picked || "(none found)");
let firstNew = 0;
for (let i = 0; i < 60; i++) {
  await yjs(`(() => { const v = document.querySelector("video"); if (v && v.paused) v.play().catch(() => {}); })()`);
  st = await status(); if (picked && st.yt.videoId === picked && st.yt.playing) break; await wait(250);
}
const sameDoc = (await yjs("performance.timeOrigin")) === before;
// a real advert before the clip: check OBS hides it, then skip/wait it out like a viewer would
let sawAd = false, clear = 0;
for (let i = 0; i < 180 && clear < 6; i++) { // adverts come in pairs: wait for 3 s without one
  const ad = await yjs(`(() => { const ad = !!document.querySelector(".html5-video-player.ad-showing"); document.querySelector(".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern")?.click(); return ad; })()`);
  clear = ad ? 0 : clear + 1;
  if (!ad) { await wait(500); continue; }
  if (!sawAd) { sawAd = true; await wait(1500); const h = await pjs(`getComputedStyle(document.getElementById("v")).visibility`); check(`a real YouTube advert is hidden in OBS (${h})`, h === "hidden"); }
  await wait(500);
}
if (sawAd) await wait(1500);
check(`clip changed without reloading the page (${st.yt.videoId})`, picked && st.yt.videoId === picked && sameDoc);
console.log("after clip change:", st.yt.videoId, st.yt.title, "url", await yjs("location.href"));
const q0 = await player();
await wait(3000);
const q1 = await player();
console.log(`  picture flowing ${((Date.now() - tClick) / 1000).toFixed(1)} s after the click; player log tail:`, q1.log.slice(-4));
check(`OBS keeps getting frames after the clip change (${q1.frames - q0.frames} in 3 s, state ${q1.state})`, q1.frames - q0.frames > 20 && /connected|advert/.test(q1.state));
await shot("2-second-clip");

// the OBS side loses its connection without anyone saying so: it asks again and the picture comes back
await pjs(`window.__ytpc()?.close()`);
const lostAt = Date.now();
let back = null;
for (let i = 0; i < 60; i++) { await wait(250); const x = await player(); if (x.state === "connected" && x.connects > (q1.connects ?? 1)) { back = x; break; } }
const r = back ? await player() : null; await wait(1000); const r2 = back ? await player() : null;
check(`a dropped OBS connection recovers by itself (${back ? ((Date.now() - lostAt) / 1000).toFixed(1) + " s" : "no"})`, back && r2.frames > r.frames);

// YouTube tab in the background (another tab in front)
const { targetId: other } = await A.send("Target.createTarget", { url: "about:blank" });
await A.send("Target.activateTarget", { targetId: other });
await wait(12000); // Chrome stops decoding hidden videos after ~10 s if nobody watches
const r0 = await player(); await wait(3000); const r1 = await player();
if (r1.ad) console.log("SKIP  background tab check: a YouTube advert is playing (hidden in OBS, so no frames to count)");
else check(`frames keep coming with the YouTube tab in the background (${r1.frames - r0.frames} in 3 s)`, r1.frames - r0.frames > 30);

// the OBS Remote panel while a video is going to OBS (screenshots for a look)
await A.send("Target.activateTarget", { targetId: ytT });
await wait(1500);
for (const [name, path, w, h] of [["4-setup-page", "/", 900, 1100], ["5-obs-dock", "/dock", 330, 760]]) {
  const { targetId } = await B.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await B.send("Target.attachToTarget", { targetId, flatten: true });
  await B.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
  await B.send("Page.navigate", { url: `http://127.0.0.1:${PORT}${path}` }, sessionId);
  await wait(2500);
  const r = await B.send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(out, name + ".png"), Buffer.from(r.data, "base64"));
}

if (process.env.REALOBS) {
  // The real OBS on this computer: a throwaway scene with the browser source, removed again at the end.
  const base = pathToFileURL(join(ROOT, "agent/src/")).href;
  const { ObsWs } = await import(base + "obsws.js");
  const { readObsWsConfig } = await import(base + "config.js");
  const f = readObsWsConfig();
  const c = new ObsWs({ host: "127.0.0.1", port: f.port, password: f.auth === false ? "" : f.password, onEvent: () => {}, onClose: () => {} });
  await c.connect();
  const scene = "zz OBS Remote YouTube test", input = "zz YouTube test";
  await A.send("Target.activateTarget", { targetId: ytT });
  try {
    await c.request("CreateScene", { sceneName: scene });
    await c.request("CreateInput", { sceneName: scene, inputName: input, inputKind: "browser_source", inputSettings: { url: `http://127.0.0.1:${PORT}/yt`, width: 1280, height: 720, reroute_audio: true, shutdown: false } });
    await c.request("SetInputMute", { inputName: input, inputMuted: true });
    let best = 0;
    for (let i = 0; i < 20; i++) {
      await wait(1000);
      st = await status();
      const img = await c.request("GetSourceScreenshot", { sourceName: input, imageFormat: "jpg", imageWidth: 640, imageCompressionQuality: 70 });
      const buf = Buffer.from(img.imageData.split(",")[1], "base64");
      if (buf.length > best) { best = buf.length; writeFileSync(join(out, "3-real-obs.jpg"), buf); }
      if (best > 15000 && i > 5) break;
    }
    check(`real OBS browser source shows the video (jpeg ${best} bytes, players ${st.yt.players})`, best > 15000 && st.yt.players >= 2);
  } finally {
    await c.request("RemoveScene", { sceneName: scene }).catch((e) => console.log("remove scene:", e.message));
    await c.request("RemoveInput", { inputName: input }).catch(() => {});
    const left = (await c.request("GetSceneList")).scenes.some((x) => x.sceneName === scene);
    check("test scene removed from OBS", !left);
    c.close();
  }
}

A.p.kill(); B.p.kill(); agent.kill();
console.log(ok ? "\nall passed" : "\nFAILED");
process.exit(ok ? 0 : 1);
