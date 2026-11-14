import { ObsWs } from "../src/obsws.js";
import { readObsWsConfig } from "../src/config.js";
const f = readObsWsConfig();
let got = null;
const c = new ObsWs({ host: "127.0.0.1", port: f.port, password: f.password, onEvent: (t, d) => { if (t === "InputVolumeMeters" && !got) got = d; }, onClose() {} });
await c.connect();
const il = await c.request("GetInputList");
await new Promise((r) => setTimeout(r, 600));
console.log("inputs:", il.inputs.length, "meters:", got?.inputs.map((i) => i.inputName + " ch" + i.inputLevelsMul.length).join(" | "));
for (const i of il.inputs) { const v = await c.tryRequest("GetInputVolume", { inputName: i.inputName }); console.log(i.inputKind.padEnd(28), v ? "vol ok" : "no vol", got?.inputs.some((m) => m.inputName === i.inputName) ? "METER" : "-"); }
c.close(); process.exit(0);
