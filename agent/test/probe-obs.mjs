import { ObsWs } from "../src/obsws.js";
import { readObsWsConfig } from "../src/config.js";
const f = readObsWsConfig();
const c = new ObsWs({ host: "127.0.0.1", port: f.port, password: f.password, onEvent: (t) => { if (t !== "InputVolumeMeters") console.log("EVT", t); }, onClose: (w) => console.log("closed", w) });
console.log("identified", JSON.stringify(await c.connect()));
const sl = await c.request("GetSceneList");
console.log("scenes", JSON.stringify(sl.scenes), "pgm", sl.currentProgramSceneName, "pvw", sl.currentPreviewSceneName);
const il = await c.request("GetInputList");
console.log("inputs", il.inputs.map(i=>i.inputName+":"+i.inputKind).join(" | "));
console.log("special", JSON.stringify(await c.request("GetSpecialInputs")));
for (const s of sl.scenes) { const r = await c.request("GetSceneItemList", { sceneName: s.sceneName }); console.log("items", s.sceneName, JSON.stringify(r.sceneItems.map(x=>[x.sceneItemIndex,x.sourceName,x.sceneItemEnabled,x.sceneItemLocked,x.inputKind]))); }
console.log("trans", JSON.stringify(await c.request("GetSceneTransitionList")));
console.log("cur", JSON.stringify(await c.request("GetCurrentSceneTransition")));
console.log("stats", JSON.stringify(await c.request("GetStats")));
console.log("stream", JSON.stringify(await c.tryRequest("GetStreamStatus")));
console.log("replay", JSON.stringify(await c.tryRequest("GetReplayBufferStatus")));
const shot = await c.request("GetSourceScreenshot", { sourceName: sl.currentProgramSceneName, imageFormat: "jpg", imageWidth: 480, imageHeight: 270, imageCompressionQuality: 45 });
console.log("shot", shot.imageData.slice(0, 40), shot.imageData.length);
c.close(); process.exit(0);
