// Dev probe: what does a real OBS emit around studio-mode transitions and the T-bar? Restores the original state.
import { ObsWs } from "../src/obsws.js";
import { readObsWsConfig } from "../src/config.js";
const f = readObsWsConfig();
const t0 = Date.now();
const log = (...a) => console.log(String(Date.now() - t0).padStart(5), ...a);
const c = new ObsWs({ host: "127.0.0.1", port: f.port, password: f.password, onEvent: (t, d) => { if (!/Meters|Volume/.test(t)) log("EVT", t, JSON.stringify(d)); }, onClose() {} });
await c.connect();
const sl = await c.request("GetSceneList");
const orig = { pgm: sl.currentProgramSceneName, studio: (await c.request("GetStudioModeEnabled")).studioModeEnabled };
const names = [...sl.scenes].sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
const other = names.find((n) => n !== orig.pgm);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  log("-- studio on"); await c.request("SetStudioModeEnabled", { studioModeEnabled: true }); await wait(500);
  log("-- preview ->", other); await c.request("SetCurrentPreviewScene", { sceneName: other }); await wait(300);
  log("-- trigger"); await c.request("TriggerStudioModeTransition"); await wait(900);
  log("-- preview back"); await c.request("SetCurrentPreviewScene", { sceneName: orig.pgm }); await wait(300);
  log("-- tbar 0.5 (no release)"); await c.request("SetTBarPosition", { position: 0.5, release: false }); await wait(400);
  log("-- tbar 1.0 release"); await c.request("SetTBarPosition", { position: 1, release: true }); await wait(900);
  log("state", JSON.stringify(await c.request("GetSceneList").then((r) => [r.currentProgramSceneName, r.currentPreviewSceneName])));
  log("-- tbar 0.4 then release at 0.0"); await c.request("SetTBarPosition", { position: 0.4, release: false }); await wait(300); await c.request("SetTBarPosition", { position: 0, release: true }); await wait(600);
  log("-- program direct (studio on)"); await c.request("SetCurrentProgramScene", { sceneName: other }).then(() => log("ok"), (e) => log("ERR", e.message)); await wait(900);
} finally {
  await c.request("SetCurrentPreviewScene", { sceneName: orig.pgm }).catch(() => {});
  await c.request("SetStudioModeEnabled", { studioModeEnabled: orig.studio }); await wait(400);
  await c.request("SetCurrentProgramScene", { sceneName: orig.pgm }).catch(() => {}); await wait(800);
  log("restored", JSON.stringify(await c.request("GetSceneList").then((r) => [r.currentProgramSceneName, r.currentPreviewSceneName])), (await c.request("GetStudioModeEnabled")).studioModeEnabled);
  c.close(); process.exit(0);
}
