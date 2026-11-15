// Read-only: screenshots every scene of the real OBS the way Present mode does and saves them, to see what
// off-air scenes look like. Usage: node test/probe-thumbs.mjs <out dir> [rounds]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ObsWs } from "../src/obsws.js";
import { readObsWsConfig } from "../src/config.js";

const out = process.argv[2] || "thumbs";
const rounds = Number(process.argv[3]) || 1;
mkdirSync(out, { recursive: true });
const f = readObsWsConfig();
const c = new ObsWs({ host: "127.0.0.1", port: f.port, password: f.auth === false ? "" : f.password, onEvent: () => {}, onClose: () => {} });
await c.connect();
const sl = await c.request("GetSceneList");
console.log("program", sl.currentProgramSceneName, "preview", sl.currentPreviewSceneName);
for (let r = 0; r < rounds; r++) {
  for (const s of sl.scenes) {
    const items = (await c.request("GetSceneItemList", { sceneName: s.sceneName })).sceneItems;
    const shot = await c.request("GetSourceScreenshot", { sourceName: s.sceneName, imageFormat: process.env.FMT || "png", imageWidth: 256, imageHeight: 144, imageCompressionQuality: 38 });
    const file = join(out, `${r}-${s.sceneIndex}.${process.env.FMT || "png"}`);
    writeFileSync(file, Buffer.from(shot.imageData.split(",")[1], "base64"));
    console.log(file, JSON.stringify(s.sceneName), items.filter((i) => i.sceneItemEnabled).map((i) => `${i.sourceName}:${i.inputKind ?? "scene"}`).join(", "));
  }
}
c.close();
process.exit(0);
