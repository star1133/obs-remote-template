// YouTube to OBS without a browser: who may use the link on the setup port (only our extension and our own /yt
// page), and what "Add to OBS" does in OBS (scripted OBS).   node test/ytcast.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { addYtSource, SOURCE_NAME } from "../src/ytcast.js";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WebSocket = createRequire(join(ROOT, "agent/package.json"))("ws");
const PORT = 47994;
const home = mkdtempSync(join(tmpdir(), "obsr-or-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ mode: "local", obsPort: 4999 }));
const agent = spawn(process.execPath, [join(ROOT, "agent/src/main.js"), "run"], { env: { ...process.env, OBSR_HOME: home, OBSR_PORT: String(PORT), OBSR_NO_TUNNEL: "1", OBSR_NO_BROWSER: "1", OBSR_NO_TRAY: "1", OBSR_NO_OBS: "1" }, stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { await wait(200); if (await fetch(`http://127.0.0.1:${PORT}/api/ping`).then((r) => r.ok, () => false)) break; }
let ok = true;
const check = (n, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); ok &&= !!c; };
const tryWs = (role, origin, host) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/yt/ws?role=${role}`, { headers: { origin, ...(host ? { host } : {}) } });
  ws.on("open", () => { ws.close(); res("open"); });
  ws.on("unexpected-response", (_, r) => res(String(r.statusCode)));
  ws.on("error", (e) => res("error " + e.message));
});
const EXT = "chrome-extension://hcljicifhbkdcgiclmecbikmkkckalon";
check("our extension can send", (await tryWs("sender", EXT)) === "open");
check("our /yt page can watch", (await tryWs("player", `http://127.0.0.1:${PORT}`)) === "open");
check("a web page cannot pose as the sender", (await tryWs("sender", "https://evil.example")) === "403");
check("another extension cannot send", (await tryWs("sender", "chrome-extension://abcdefghijklmnopabcdefghijklmnop")) === "403");
check("a web page cannot watch the video", (await tryWs("player", "https://www.youtube.com")) === "403");
check("no origin at all is refused", (await tryWs("sender", "")) === "403");
check("DNS-rebinding host is refused", (await tryWs("player", `http://127.0.0.1:${PORT}`, `evil.example:${PORT}`)) === "404");
check("unknown role refused", (await tryWs("owner", EXT)) === "403");
const page = await fetch(`http://127.0.0.1:${PORT}/yt`);
check("/yt page: scripts only from itself (OBS custom CSS allowed)", page.ok && /default-src 'self'/.test(page.headers.get("content-security-policy")) && !/script-src/.test(page.headers.get("content-security-policy")) && (await page.text()).includes("yt.js"));
const post = await fetch(`http://127.0.0.1:${PORT}/api/yt-source`, { method: "POST" });
check("Add to OBS needs the setup page's token", post.status === 403);
function fakeObs({ studio, desktopMuted }) {
  const inputs = [{ inputName: "Desktop Audio", inputKind: "wasapi_output_capture" }, { inputName: "Mic", inputKind: "wasapi_input_capture" }];
  const scenes = { Main: [], Prep: [] };
  const calls = [];
  const mutes = { "Desktop Audio": desktopMuted, Mic: false };
  const request = async (t, d = {}) => {
    calls.push([t, d]);
    switch (t) {
      case "GetStudioModeEnabled": return { studioModeEnabled: studio };
      case "GetCurrentPreviewScene": return { currentPreviewSceneName: "Prep" };
      case "GetCurrentProgramScene": return { currentProgramSceneName: "Main" };
      case "GetVideoSettings": return { baseWidth: 1920, baseHeight: 1080 };
      case "GetInputList": return { inputs: [...inputs] };
      case "GetSceneItemList": return { sceneItems: scenes[d.sceneName].map((n, i) => ({ sourceName: n, sceneItemId: i + 1 })) };
      case "CreateInput": inputs.push({ inputName: d.inputName, inputKind: d.inputKind }); scenes[d.sceneName].push(d.inputName); mutes[d.inputName] = false; return { sceneItemId: scenes[d.sceneName].length };
      case "CreateSceneItem": scenes[d.sceneName].push(d.sourceName); return { sceneItemId: scenes[d.sceneName].length };
      case "SetSceneItemTransform": return {};
      case "GetSpecialInputs": return { desktop1: "Desktop Audio", desktop2: null, mic1: "Mic" };
      case "GetInputMute": return { inputMuted: mutes[d.inputName] };
      case "SetInputMute": mutes[d.inputName] = d.inputMuted; return {};
      default: throw new Error("unexpected " + t);
    }
  };
  return { request, calls, scenes, mutes, inputs };
}
const url = "http://127.0.0.1:47890/yt";
let o = fakeObs({ studio: true, desktopMuted: false });
let r = await addYtSource(o.request, url);
const ci = o.calls.find(([t]) => t === "CreateInput")[1];
check("Studio Mode: goes into the preview scene, not on air", r.scene === "Prep" && o.scenes.Prep.includes(SOURCE_NAME) && !o.scenes.Main.length);
check("browser source points at /yt, canvas sized, sound in the mixer", ci.inputKind === "browser_source" && ci.inputSettings.url === url && ci.inputSettings.width === 1920 && ci.inputSettings.reroute_audio === true);
const tf = o.calls.find(([t]) => t === "SetSceneItemTransform")[1].sceneItemTransform;
check("fitted to the canvas", tf.boundsType === "OBS_BOUNDS_SCALE_INNER" && tf.boundsWidth === 1920 && tf.boundsHeight === 1080);
check("muted because Desktop Audio already carries the sound", r.muted && o.mutes[SOURCE_NAME] === true);
r = await addYtSource(o.request, url);
check("second press in the same scene changes nothing", r.already && o.scenes.Prep.filter((n) => n === SOURCE_NAME).length === 1);

o = fakeObs({ studio: false, desktopMuted: true });
r = await addYtSource(o.request, url);
check("no Studio Mode: program scene; Desktop Audio muted, so the source keeps its sound", r.scene === "Main" && !r.muted && o.mutes[SOURCE_NAME] === false);
// existing input, other scene: reuses it instead of making a second browser
o.scenes.Prep = [];
const before = o.inputs.length;
o.request("GetStudioModeEnabled").then(() => {});
const o2 = { ...o, request: async (t, d) => (t === "GetStudioModeEnabled" ? { studioModeEnabled: true } : o.request(t, d)) };
r = await addYtSource(o2.request, url);
check("another scene reuses the same source", r.scene === "Prep" && o.inputs.length === before && o.scenes.Prep.includes(SOURCE_NAME));
agent.kill();
console.log(ok ? "\nall passed" : "\nFAILED");
process.exit(ok ? 0 : 1);
