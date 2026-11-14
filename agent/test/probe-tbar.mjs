// Dev probe: how does the real T-bar complete? Restores the original state.
import { ObsWs } from "../src/obsws.js";
import { readObsWsConfig } from "../src/config.js";
const f = readObsWsConfig();
const t0 = Date.now();
const log = (...a) => console.log(String(Date.now() - t0).padStart(5), ...a);
const c = new ObsWs({ host: "127.0.0.1", port: f.port, password: f.password, onEvent: (t, d) => { if (!/Meters|Volume|VideoEnded/.test(t)) log("  EVT", t, d.sceneName ?? ""); }, onClose() {} });
await c.connect();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pp = async () => { const r = await c.request("GetSceneList"); return `pgm=${r.currentProgramSceneName} pvw=${r.currentPreviewSceneName}`; };
const sl = await c.request("GetSceneList");
const orig = { pgm: sl.currentProgramSceneName, studio: (await c.request("GetStudioModeEnabled")).studioModeEnabled };
const names = [...sl.scenes].sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
const other = names.find((n) => n !== orig.pgm);
try {
  await c.request("SetStudioModeEnabled", { studioModeEnabled: true }); await wait(400);
  await c.request("SetCurrentPreviewScene", { sceneName: other }); await wait(300);
  log("start:", await pp());
  const set = (position, release) => c.request("SetTBarPosition", { position, release });
  const pv = () => pp();
  const V = async (label, fn) => { const before = await pv(); await fn(); await wait(1200); log(label, "|", before, "=>", await pv()); };
  const pvwName = async () => (await c.request("GetSceneList")).currentPreviewSceneName;
  await V("V6 hold@1.0 then SetCurrentProgramScene(pvw)", async () => { await set(0.5, false); await wait(100); await set(1, false); await wait(200); const t = await pvwName(); log("  pvw name", t); await c.request("SetCurrentProgramScene", { sceneName: t }).catch((e) => log("  ERR", e.message)); });
  await V("V7 noop settle", async () => {});
  await V("V8 hold@1.0 release@1.0 then SetCurrentProgramScene(pvw)", async () => { await set(0.5, false); await wait(100); await set(1, false); await wait(150); const t = await pvwName(); await set(1, true); await wait(150); await c.request("SetCurrentProgramScene", { sceneName: t }).catch((e) => log("  ERR", e.message)); });
  await V("V9 cancel (0,release) then trigger", async () => { await set(0.5, false); await wait(100); await set(0, true); await wait(300); await c.request("TriggerStudioModeTransition"); });
} finally {
  await c.request("SetStudioModeEnabled", { studioModeEnabled: orig.studio }); await wait(400);
  await c.request("SetCurrentProgramScene", { sceneName: orig.pgm }).catch(() => {}); await wait(800);
  log("restored:", await pp(), (await c.request("GetStudioModeEnabled")).studioModeEnabled);
  c.close(); process.exit(0);
}
