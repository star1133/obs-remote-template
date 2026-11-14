// A small stand-in for OBS's obs-websocket v5 server, enough to exercise the agent.
import { WebSocketServer } from "ws";
import { createHash } from "node:crypto";

const b64 = (s) => createHash("sha256").update(s).digest("base64");

export function startFakeObs({ port = 4466, password = "pw" } = {}) {
  const s = {
    scenes: ["Starting Soon", "Main", "Gameplay"], program: "Main", preview: "Gameplay", studio: false,
    inputs: [
      { name: "Mic/Aux", kind: "wasapi_input_capture", db: -6, muted: false },
      { name: "Desktop Audio", kind: "wasapi_output_capture", db: -12, muted: false },
      { name: "Logo", kind: "image_source" },
    ],
    items: { Main: [{ id: 1, name: "Camera", on: true, locked: false }, { id: 2, name: "Logo", on: true, locked: true }], Gameplay: [{ id: 3, name: "Game", on: true, locked: false }], "Starting Soon": [] },
    transitions: ["Cut", "Fade", "Slide"], transition: "Fade", duration: 300,
    stream: false, record: false, tbar: -1,
  };
  const log = []; // requests received, for assertions
  const wss = new WebSocketServer({ port, host: "127.0.0.1", handleProtocols: (p) => (p.has("obswebsocket.json") ? "obswebsocket.json" : false) });
  const clients = new Set();
  const emit = (eventType, eventData = {}) => clients.forEach((c) => c.ident && c.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 1, eventData } })));

  /** Real OBS reports program/preview changes when the transition ENDS. */
  function transition(target) {
    if (s.pending) throw new Error("transition in progress");
    const dur = s.transition === "Cut" ? 0 : s.duration;
    s.pending = target;
    emit("SceneTransitionStarted", { transitionName: s.transition });
    setTimeout(() => {
      const old = s.program;
      s.program = target; s.pending = null;
      if (s.studio) { s.preview = old; emit("CurrentPreviewSceneChanged", { sceneName: s.preview }); }
      emit("CurrentProgramSceneChanged", { sceneName: s.program });
      emit("SceneTransitionEnded", { transitionName: s.transition });
    }, dur + 10);
  }

  function handle(type, d = {}) {
    const input = () => { const i = s.inputs.find((x) => x.name === d.inputName); if (!i || !i.kind.includes("capture")) throw new Error("no such input"); return i; };
    switch (type) {
      case "GetVersion": return { obsVersion: "31.0.0", obsWebSocketVersion: "5.5.0" };
      case "GetSceneList": return { currentProgramSceneName: s.pending ?? s.program, currentPreviewSceneName: s.studio ? s.preview : null, scenes: s.scenes.map((n, i) => ({ sceneName: n, sceneIndex: s.scenes.length - 1 - i })).reverse() };
      case "GetCurrentProgramScene": return { currentProgramSceneName: s.pending ?? s.program, sceneName: s.pending ?? s.program };
      case "GetStudioModeEnabled": return { studioModeEnabled: s.studio };
      case "GetInputList": return { inputs: s.inputs.map((i) => ({ inputName: i.name, inputKind: i.kind })) };
      case "GetSpecialInputs": return { desktop1: "Desktop Audio", mic1: "Mic/Aux", mic2: null };
      case "GetInputVolume": return { inputVolumeDb: input().db, inputVolumeMul: 10 ** (input().db / 20) };
      case "GetInputMute": return { inputMuted: input().muted };
      case "GetSceneItemList": return { sceneItems: (s.items[d.sceneName] ?? []).map((x, i) => ({ sceneItemId: x.id, sourceName: x.name, sceneItemEnabled: x.on, sceneItemLocked: x.locked, sceneItemIndex: i, sourceType: "OBS_SOURCE_TYPE_INPUT", inputKind: "x" })) };
      case "GetSceneTransitionList": return { transitions: s.transitions.map((n) => ({ transitionName: n, transitionKind: { Cut: "cut_transition", Fade: "fade_transition", Slide: "slide_transition" }[n] })) };
      case "GetCurrentSceneTransition": return { transitionName: s.transition, transitionDuration: s.duration };
      case "GetStreamStatus": return { outputActive: s.stream, outputDuration: 1000, outputBytes: 1000, outputSkippedFrames: 0, outputTotalFrames: 100 };
      case "GetRecordStatus": return { outputActive: s.record, outputPaused: false, outputDuration: 0, outputBytes: 0 };
      case "GetReplayBufferStatus": return { outputActive: false };
      case "GetStats": return { cpuUsage: 7.5, memoryUsage: 512, activeFps: 60, averageFrameRenderTime: 2.2, availableDiskSpace: 102400 };
      case "SetCurrentProgramScene": {
        if (!s.scenes.includes(d.sceneName)) throw new Error("no such scene");
        if (d.sceneName === s.program && !s.pending) return {};
        transition(d.sceneName);
        return {};
      }
      case "SetCurrentPreviewScene": { if (!s.studio) throw new Error("studio mode is off"); s.preview = d.sceneName; emit("CurrentPreviewSceneChanged", { sceneName: d.sceneName }); return {}; }
      case "SetStudioModeEnabled": s.studio = d.studioModeEnabled; emit("StudioModeStateChanged", { studioModeEnabled: s.studio }); return {};
      case "SetInputVolume": input().db = d.inputVolumeDb; emit("InputVolumeChanged", { inputName: d.inputName, inputVolumeDb: d.inputVolumeDb, inputVolumeMul: 1 }); return {};
      case "SetInputMute": input().muted = d.inputMuted; emit("InputMuteStateChanged", { inputName: d.inputName, inputMuted: d.inputMuted }); return {};
      case "SetSceneItemEnabled": { const it = s.items[d.sceneName].find((x) => x.id === d.sceneItemId); it.on = d.sceneItemEnabled; emit("SceneItemEnableStateChanged", d); return {}; }
      case "SetCurrentSceneTransition": s.transition = d.transitionName; emit("CurrentSceneTransitionChanged", { transitionName: d.transitionName }); return {};
      case "SetCurrentSceneTransitionDuration": s.duration = d.transitionDuration; emit("CurrentSceneTransitionDurationChanged", { transitionDuration: d.transitionDuration }); return {};
      case "TriggerStudioModeTransition": {
        if (!s.studio) throw new Error("studio mode is off");
        transition(s.preview);
        return {};
      }
      case "SetTBarPosition": {
        // Like real OBS over WebSocket: the first move starts a transition, releasing ends it WITHOUT swapping buses.
        if (!s.studio) throw new Error("studio mode is off");
        if (!s.tbarOn) { s.tbarOn = true; s.pending = s.preview; emit("SceneTransitionStarted", { transitionName: s.transition }); }
        s.tbar = d.position;
        if (d.release) { s.tbarOn = false; s.pending = null; emit("SceneTransitionEnded", { transitionName: s.transition }); }
        return {};
      }
      case "StartStream": s.stream = true; emit("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" }); return {};
      case "StopStream": s.stream = false; emit("StreamStateChanged", { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" }); return {};
      case "GetSourceScreenshot": return { imageData: "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xff, 0xd9]).toString("base64") + "" };
      default: throw Object.assign(new Error("unknown request"), { code: 204 });
    }
  }

  wss.on("connection", (ws) => {
    clients.add(ws);
    const salt = "salt" + Math.random().toString(36).slice(2), challenge = "chal" + Math.random().toString(36).slice(2);
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1, authentication: password ? { challenge, salt } : undefined } }));
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.op === 1) {
        if (password && m.d.authentication !== b64(b64(password + salt) + challenge)) return ws.close(4009, "Authentication failed.");
        ws.ident = true;
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      } else if (m.op === 6 && ws.ident) {
        const { requestType, requestId, requestData } = m.d;
        log.push({ type: requestType, data: requestData });
        try {
          const responseData = handle(requestType, requestData);
          ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } }));
        } catch (e) {
          ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: false, code: e.code ?? 600, comment: e.message } } }));
        }
      }
    });
  });

  const meters = setInterval(() => emit("InputVolumeMeters", { inputs: s.inputs.filter((i) => i.kind.includes("capture")).map((i) => ({ inputName: i.name, inputLevelsMul: [[0.3, 0.5, 0.5], [0.2, 0.4, 0.4]] })) }), 50);

  return { state: s, log, emit, close: () => new Promise((r) => { clearInterval(meters); clients.forEach((c) => c.terminate()); wss.close(() => r()); }) };
}
