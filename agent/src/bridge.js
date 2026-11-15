// Translates between the relay protocol (same shapes as relay/public/sim.js) and obs-websocket v5.
import os from "node:os";
import { ObsWs } from "./obsws.js";
import { SLIDE_KEYS, sendSlideKey } from "./keys.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Inputs that never carry audio even though GetInputVolume answers for them.
const NO_AUDIO = new Set(["image_source", "color_source_v3", "color_source_v2", "color_source", "text_gdiplus_v3", "text_gdiplus_v2", "text_ft2_source_v2", "slideshow", "slideshow_v2", "monitor_capture", "window_capture", "game_capture", "display_capture", "xshm_input", "screen_capture", "scene", "group"]);

const MEDIA_ACTIONS = new Set(["PLAY", "PAUSE", "STOP", "RESTART", "NEXT", "PREVIOUS"].map((a) => `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${a}`));

/** Request allowlist: relay op -> obs-websocket request, with the fields that may pass (s=string n=number b=boolean). */
const OPS = {
  SetCurrentProgramScene: { f: { sceneName: "s" } },
  SetCurrentPreviewScene: { f: { sceneName: "s" } },
  TriggerStudioModeTransition: { f: {} },
  SetStudioModeEnabled: { f: { studioModeEnabled: "b" } },
  SetInputVolume: { f: { inputName: "s", inputVolumeDb: "n" } },
  SetInputMute: { f: { inputName: "s", inputMuted: "b" } },
  SetSceneItemEnabled: { f: { sceneName: "s", sceneItemId: "n", sceneItemEnabled: "b" } },
  SetSceneItemLocked: { f: { sceneName: "s", sceneItemId: "n", sceneItemLocked: "b" } },
  SetCurrentSceneTransition: { f: { transitionName: "s" } },
  SetCurrentSceneTransitionDuration: { f: { transitionDuration: "n" } },
  StartStream: { f: {} }, StopStream: { f: {} },
  StartRecord: { f: {} }, StopRecord: { f: {} }, ToggleRecordPause: { f: {} },
  TriggerMediaInputAction: { f: { inputName: "s", mediaAction: "s" }, enum: { mediaAction: MEDIA_ACTIONS } },
  StartReplayBuffer: { f: {} }, StopReplayBuffer: { f: {} }, SaveReplayBuffer: { f: {} },
};
// Ops for user-made buttons: names are resolved here so a button keeps working when scene item ids change.
const TOGGLE = new Set(["on", "off", "toggle"]);
const BUTTON_OPS = new Set(["SetSourceVisible", "SetFilterState", "SetMuteState", "SetText", "TriggerHotkeyByName", "ListFilters", "ListHotkeys", "SetLayout"]);
export const ALLOWED_OPS = new Set([...Object.keys(OPS), "StudioTake", "SetTBarPosition", "PresentKey", ...BUTTON_OPS]);

// What a saved button may contain. Anything else is dropped, so a hostile client cannot park arbitrary data on the computer.
const STEP_FIELDS = {
  scene: ["sceneName", "mode"], source: ["sceneName", "sourceName", "state"], filter: ["sourceName", "filterName", "state"],
  mute: ["inputName", "state"], volume: ["inputName", "db"], media: ["inputName", "action"], text: ["inputName", "text"],
  hotkey: ["hotkeyName"], stream: ["state"], record: ["state"], slides: ["key"], studio: ["action"], wait: ["ms"],
};
export function cleanLayout(raw) {
  const out = { buttons: [] };
  for (const b of Array.isArray(raw?.buttons) ? raw.buttons.slice(0, 60) : []) {
    if (typeof b?.id !== "string" || typeof b.label !== "string") continue;
    const steps = [];
    for (const st of Array.isArray(b.steps) ? b.steps.slice(0, 20) : []) {
      const fields = STEP_FIELDS[st?.type];
      if (!fields) continue;
      const step = { type: st.type };
      for (const f of fields) {
        const v = st[f];
        if (typeof v === "string") step[f] = v.slice(0, f === "text" ? 2000 : 256);
        else if (typeof v === "number" && Number.isFinite(v)) step[f] = v;
        else if (typeof v === "boolean") step[f] = v;
      }
      steps.push(step);
    }
    out.buttons.push({ id: b.id.slice(0, 40), label: b.label.slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(b.color ?? "") ? b.color : "", icon: typeof b.icon === "string" ? b.icon.slice(0, 20) : "", group: typeof b.group === "string" ? b.group.slice(0, 30) : "", steps });
  }
  return out;
}

function pick(spec, d) {
  const out = {};
  for (const [k, t] of Object.entries(spec)) {
    const v = d?.[k];
    if (t === "s") { if (typeof v !== "string" || !v || v.length > 256) throw new Error(`bad ${k}`); out[k] = v; }
    else if (t === "n") { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`bad ${k}`); out[k] = v; }
    else if (t === "b") { if (typeof v !== "boolean") throw new Error(`bad ${k}`); out[k] = v; }
  }
  return out;
}

/** obs transition kind -> the switcher's effect family (see relay/public/kinds.js). */
export function kindOfTransition(k = "") {
  if (k === "cut_transition") return "cut";
  if (k === "fade_to_color_transition") return "dip";
  if (k === "slide_transition") return "slide";
  if (k === "swipe_transition" || k === "luma_wipe_transition") return "wipe";
  return "mix"; // fade, stinger, plugins: treat as a mix
}

export const FRAME_PGM = 0;
export const FRAME_PVW = 1;
export const FRAME_THUMB = 2; // [2][name length][scene name utf8][jpeg]
export const FRAME_REMEMBERED = 3; // same layout: the last real picture of a scene, kept on disk
// OBS draws a scene that is not live as black (its windows, cameras and screens only render on air); such a
// 256x144 thumbnail is about 1.2 KB. Anything bigger has something on it and is worth remembering.
const REAL_MIN = 2200;

export function createBridge({ getObsConf, send, log = () => {}, allowKeys = () => false, layout = { load: () => ({ buttons: [] }), save: () => {} }, pictures = { load: () => ({}), save: () => {} } }) {
  const obs = { c: null };
  let st = null;               // cached snapshot, kept current by events
  let stopped = false;
  let status = { state: "starting", detail: "" }; // state: starting | connected | waiting | auth | refused
  let demand = { clients: 0, preview: 0, thumbs: 0, live: 0, max: 0 };
  const lastSeq = new Map();
  let override = null;         // one-off transition of a StudioTake, restored when it ends
  let tbar = 0, tbarTouch = 0;
  let meters = new Map(), metersTimer = null;
  let statsTimer = null, prevOut = { bytes: 0, at: 0 };
  let thumbTimer = null, thumbBusy = false, thumbIdx = 0;
  let resyncTimer = null, freshAt = 0, freshP = null;
  let retryTimer = null;

  const evt = (op, data) => send({ type: "evt", op, data });

  // ---- connection loop ------------------------------------------------------

  async function connectLoop() {
    let delay = 1500;
    while (!stopped) {
      const conf = getObsConf();
      const c = new ObsWs({
        host: conf.host, port: conf.port, password: conf.password,
        onEvent: onObsEvent,
        onClose: (why) => {
          log(`OBS connection closed (${why})`);
          obs.c = null; st = null;
          setStatus("waiting", "OBS closed");
          evt("ObsOnline", { online: false });
          stopTimers();
          scheduleRetry(1000);
        },
      });
      try {
        await c.connect();
        obs.c = c;
        st = await buildSnapshot();
        setStatus("connected", `OBS ${st.obs.version}`);
        log(`connected to OBS ${st.obs.version}`);
        evt("ObsOnline", { online: true });
        send({ type: "state.sync", data: { ...st, now: Date.now() } });
        if (demand.thumbs > 0) freshThumbs(); // phones were waiting in Present mode while OBS was closed
        startTimers();
        return; // onClose restarts the loop
      } catch (e) {
        try { c.close(); } catch { /* */ }
        obs.c = null;
        const why = e.message;
        if (why === "auth") setStatus("auth", "wrong obs-websocket password");
        else if (why === "refused" || why === "closed" || why === "timeout") setStatus("waiting", "OBS not running or WebSocket server is off");
        else { setStatus("waiting", why); log("OBS connect failed: " + why); }
        delay = why === "auth" ? 5000 : Math.min(delay * 1.4, 4000);
        await new Promise((r) => { retryTimer = setTimeout(r, delay); });
      }
    }
  }
  function scheduleRetry(ms) {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (!stopped && !obs.c) connectLoop(); }, ms);
  }
  function setStatus(state, detail) {
    if (status.state === state && status.detail === detail) return;
    status = { state, detail };
  }

  // ---- snapshot ---------------------------------------------------------------

  async function buildSnapshot() {
    const c = obs.c;
    const R = (t, d) => c.request(t, d);
    const [ver, scenesR, studio, inputsR, special, trList, trCur, stream, record, replay, stats] = await Promise.all([
      R("GetVersion"), R("GetSceneList"), R("GetStudioModeEnabled"), R("GetInputList"), c.tryRequest("GetSpecialInputs"),
      R("GetSceneTransitionList"), R("GetCurrentSceneTransition"),
      c.tryRequest("GetStreamStatus"), c.tryRequest("GetRecordStatus"), c.tryRequest("GetReplayBufferStatus"), c.tryRequest("GetStats"),
    ]);
    // obs-websocket numbers scenes from the bottom of the Scenes dock (index 0 = last), so flip to dock order.
    const scenes = [...scenesR.scenes].sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
    const globals = new Set(special ? Object.values(special).filter((v) => typeof v === "string" && v) : []);

    const audio = [];
    await Promise.all(inputsR.inputs.map(async (i) => {
      if (NO_AUDIO.has(i.inputKind)) return;
      const [vol, mute] = await Promise.all([c.tryRequest("GetInputVolume", { inputName: i.inputName }), c.tryRequest("GetInputMute", { inputName: i.inputName })]);
      if (!vol || !mute) return;
      audio.push({ name: i.inputName, kind: i.inputKind, volumeDb: vol.inputVolumeDb, muted: mute.inputMuted, pinned: globals.has(i.inputName) });
    }));
    // Keep OBS's own input order, global devices first.
    const order = new Map(inputsR.inputs.map((i, n) => [i.inputName, n]));
    audio.sort((a, b) => (b.pinned - a.pinned) || (order.get(a.name) - order.get(b.name)));

    const items = {};
    await Promise.all(scenes.map(async (sceneName) => {
      const r = await c.tryRequest("GetSceneItemList", { sceneName });
      items[sceneName] = (r?.sceneItems ?? [])
        .sort((a, b) => b.sceneItemIndex - a.sceneItemIndex) // top of the list = highest index, like the Sources dock
        .map((x) => ({ id: x.sceneItemId, name: x.sourceName, enabled: x.sceneItemEnabled, locked: !!x.sceneItemLocked, kind: x.inputKind || (x.sourceType === "OBS_SOURCE_TYPE_SCENE" ? "scene" : "") }));
    }));

    const snap = {
      obs: { name: os.hostname(), version: ver.obsVersion },
      scenes,
      program: scenesR.currentProgramSceneName,
      preview: studio.studioModeEnabled ? scenesR.currentPreviewSceneName : scenesR.currentProgramSceneName,
      studioMode: studio.studioModeEnabled,
      inputs: audio,
      items,
      transitions: trList.transitions.map((t) => t.transitionName),
      // OBS names are localised ("ตัด", "เฟด"), so tell the UI what each one does instead of letting it guess.
      transitionKinds: Object.fromEntries(trList.transitions.map((t) => [t.transitionName, kindOfTransition(t.transitionKind)])),
      transition: trCur.transitionName,
      duration: trCur.transitionDuration ?? 300,
      tr: null,
      tbar: 0,
      stream: { active: !!stream?.outputActive, since: stream?.outputActive ? Date.now() - (stream.outputDuration ?? 0) : 0, bytes: stream?.outputBytes ?? 0, dropped: stream?.outputSkippedFrames ?? 0, total: stream?.outputTotalFrames ?? 0 },
      record: { active: !!record?.outputActive, paused: !!record?.outputPaused, since: record?.outputActive ? Date.now() - (record.outputDuration ?? 0) : 0, bytes: record?.outputBytes ?? 0 },
      replay: { active: !!replay?.outputActive },
      stats: statsOf(stats, stream),
      layout: layout.load(),
      now: Date.now(),
    };
    tbar = 0;
    return snap;
  }

  function statsOf(s, stream) {
    return {
      cpu: s?.cpuUsage ?? 0, fps: s?.activeFps ?? 0, memMb: s?.memoryUsage ?? 0, renderMs: s?.averageFrameRenderTime ?? 0,
      diskGb: (s?.availableDiskSpace ?? 0) / 1024,
      dropPct: stream?.outputTotalFrames ? ((stream.outputSkippedFrames ?? 0) / stream.outputTotalFrames) * 100 : 0,
      kbps: 0,
    };
  }

  /** A fresh snapshot, shared by callers that ask within the same moment. */
  function freshSnapshot() {
    if (freshP && Date.now() - freshAt < 1500) return freshP;
    freshAt = Date.now();
    freshP = buildSnapshot().then((s) => { st = s; return s; }, (e) => { freshP = null; throw e; });
    return freshP;
  }

  function scheduleResync() {
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(async () => {
      if (!obs.c) return;
      try { freshP = null; const s = await freshSnapshot(); send({ type: "state.sync", data: { ...s, now: Date.now() } }); } catch (e) { log("resync failed: " + e.message); }
    }, 250);
  }

  // ---- OBS events -> relay events --------------------------------------------

  function onObsEvent(type, d) {
    if (type === "InputVolumeMeters") return onMeters(d);
    if (!st) return;
    switch (type) {
      case "CurrentProgramSceneChanged":
        st.program = d.sceneName;
        return evt("ProgramSceneChanged", { sceneName: d.sceneName });
      case "CurrentPreviewSceneChanged":
        st.preview = d.sceneName;
        return evt("PreviewSceneChanged", { sceneName: d.sceneName });
      case "StudioModeStateChanged":
        st.studioMode = d.studioModeEnabled;
        if (!st.studioMode) tbar = 0;
        return evt("StudioModeChanged", { studioMode: d.studioModeEnabled });
      case "InputVolumeChanged": {
        const i = st.inputs.find((x) => x.name === d.inputName);
        if (i) i.volumeDb = d.inputVolumeDb;
        return i && evt("InputVolumeChanged", { inputName: d.inputName, inputVolumeDb: d.inputVolumeDb });
      }
      case "InputMuteStateChanged": {
        const i = st.inputs.find((x) => x.name === d.inputName);
        if (i) i.muted = d.inputMuted;
        return i && evt("InputMuteStateChanged", { inputName: d.inputName, inputMuted: d.inputMuted });
      }
      case "SceneItemEnableStateChanged": {
        const it = (st.items[d.sceneName] || []).find((x) => x.id === d.sceneItemId);
        if (it) it.enabled = d.sceneItemEnabled;
        return evt("SceneItemEnableStateChanged", { sceneName: d.sceneName, sceneItemId: d.sceneItemId, sceneItemEnabled: d.sceneItemEnabled });
      }
      case "SceneItemLockStateChanged": {
        const it = (st.items[d.sceneName] || []).find((x) => x.id === d.sceneItemId);
        if (it) it.locked = d.sceneItemLocked;
        return evt("SceneItemLockStateChanged", { sceneName: d.sceneName, sceneItemId: d.sceneItemId, sceneItemLocked: d.sceneItemLocked });
      }
      case "CurrentSceneTransitionChanged":
        if (override) return; // our one-off for a StudioTake: the UI must not see it
        st.transition = d.transitionName;
        return evt("CurrentSceneTransitionChanged", { transitionName: d.transitionName });
      case "CurrentSceneTransitionDurationChanged":
        if (override) return;
        st.duration = d.transitionDuration;
        return evt("CurrentSceneTransitionDurationChanged", { transitionDuration: d.transitionDuration });
      case "SceneTransitionStarted":
        return onTransitionStarted(d.transitionName);
      case "SceneTransitionEnded":
        st.tr = null; tbar = 0;
        evt("TransitionEnded", { to: st.program });
        if (override) setTimeout(restoreOverride, 40);
        return;
      case "StreamStateChanged":
        if (d.outputActive && !st.stream.active) Object.assign(st.stream, { since: Date.now(), bytes: 0, dropped: 0, total: 0 });
        st.stream.active = d.outputActive;
        return evt("StreamStateChanged", { ...st.stream });
      case "RecordStateChanged":
        if (d.outputActive && !st.record.active) Object.assign(st.record, { since: Date.now(), bytes: 0 });
        st.record.active = d.outputActive;
        st.record.paused = d.outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED";
        if (!d.outputActive) st.record.paused = false;
        return evt("RecordStateChanged", { ...st.record });
      case "ReplayBufferStateChanged":
        st.replay.active = d.outputActive;
        return evt("ReplayBufferStateChanged", { ...st.replay });
      case "ReplayBufferSaved":
        return evt("ReplayBufferSaved", { path: String(d.savedReplayPath ?? "").split(/[\\/]/).pop() });
      case "ExitStarted":
        return; // the socket close that follows flips us to offline
      case "SceneListChanged": case "InputCreated": case "InputRemoved": case "InputNameChanged": case "SceneCreated": case "SceneRemoved":
      case "SceneNameChanged": case "SceneItemCreated": case "SceneItemRemoved": case "SceneItemListReindexed":
      case "CurrentSceneCollectionChanged": case "CurrentProfileChanged": case "SceneTransitionVideoEnded":
        if (type !== "SceneTransitionVideoEnded") scheduleResync();
        return;
    }
  }

  /** Real OBS reports program/preview changes when a transition *ends*, and reports a started transition
   *  before it says where it goes. So: studio mode -> preview is the target; otherwise ask OBS (it already
   *  answers with the new scene). Manual T-bar moves are shown by the UI's own T-bar, not as an auto transition. */
  function onTransitionStarted(name) {
    const at = Date.now();
    if (tbar > 0 || at - tbarTouch < 1500) return;
    setTimeout(async () => {
      if (!st) return;
      const from = st.program;
      let to = st.studioMode ? st.preview : from;
      if (!st.studioMode) {
        const r = await obs.c?.tryRequest("GetCurrentProgramScene");
        to = r?.currentProgramSceneName ?? r?.sceneName ?? from;
      }
      if (to === from) return;
      const duration = override?.duration ?? st.duration;
      const kind = st.transitionKinds?.[name];
      st.tr = { from, to, kind, transition: name, start: at, duration };
      evt("TransitionStarted", { from, to, transition: name, kind, duration, at });
    }, 30);
  }

  // ---- levels / stats / preview ------------------------------------------------

  function onMeters(d) {
    if (!st || demand.clients <= 0) return;
    for (const m of d.inputs ?? []) {
      const ch = m.inputLevelsMul ?? [];
      const l = ch[0]?.[1] ?? 0, r = ch[1]?.[1] ?? l;
      const p = meters.get(m.inputName);
      if (p) { p[0] = Math.max(p[0], l); p[1] = Math.max(p[1], r); } else meters.set(m.inputName, [l, r]);
    }
  }

  function startTimers() {
    stopTimers();
    metersTimer = setInterval(() => {
      if (!meters.size) return;
      const levels = {};
      for (const i of st?.inputs ?? []) levels[i.name] = meters.get(i.name) ?? [0, 0];
      meters = new Map();
      evt("Levels", { levels });
    }, 100);
    statsTimer = setInterval(pollStats, 1000);
    applyDemand();
  }
  function stopTimers() {
    clearInterval(metersTimer); clearInterval(statsTimer); clearTimeout(thumbTimer); loops.forEach((l) => { clearTimeout(l.timer); l.timer = null; });
    metersTimer = statsTimer = thumbTimer = null;
    meters = new Map();
  }

  async function pollStats() {
    if (!obs.c || !st || demand.clients <= 0) return;
    try {
      const [s, so, ro] = await Promise.all([
        obs.c.request("GetStats"),
        st.stream.active ? obs.c.tryRequest("GetStreamStatus") : null,
        st.record.active ? obs.c.tryRequest("GetRecordStatus") : null,
      ]);
      const now = Date.now();
      const stats = statsOf(s, so);
      if (so) {
        Object.assign(st.stream, { bytes: so.outputBytes, dropped: so.outputSkippedFrames, total: so.outputTotalFrames });
        if (prevOut.at && so.outputBytes >= prevOut.bytes) stats.kbps = ((so.outputBytes - prevOut.bytes) * 8) / ((now - prevOut.at) / 1000) / 1000;
        prevOut = { bytes: so.outputBytes, at: now };
      } else prevOut = { bytes: 0, at: 0 };
      if (ro) Object.assign(st.record, { bytes: ro.outputBytes, paused: !!ro.outputPaused });
      st.stats = stats;
      evt("Stats", { stats, stream: { ...st.stream }, record: { ...st.record } });
    } catch { /* transient; next tick retries */ }
  }

  function applyDemand() {
    if (demand.preview > 0 && obs.c) previewLoop();
    if (demand.thumbs > 0 && obs.c && !thumbTimer && !thumbBusy) thumbLoop();
  }

  /** Present mode shows what every scene looks like: one small screenshot per tick, scene by scene. */
  async function thumbLoop() {
    thumbTimer = null;
    if (demand.thumbs <= 0 || !obs.c || !st) return;
    thumbBusy = true;
    const busy = !!st.tr || tbar > 0; // keep OBS free while a transition is rendering
    try {
      const scenes = st.scenes;
      if (!busy && scenes.length) {
        const name = scenes[thumbIdx++ % scenes.length];
        const r = await obs.c.request("GetSourceScreenshot", { sourceName: name, imageFormat: "jpg", imageWidth: 256, imageHeight: 144, imageCompressionQuality: 38 });
        const b64 = String(r.imageData ?? "").split(",")[1];
        const nm = Buffer.from(name, "utf8").subarray(0, 255);
        if (b64 && thumbLast.get(name) !== b64) { // unchanged picture (still image, paused video): send nothing
          thumbLast.set(name, b64);
          const img = Buffer.from(b64, "base64");
          send(Buffer.concat([Buffer.from([FRAME_THUMB, nm.length]), nm, img]));
          if (img.length >= REAL_MIN) { remembered.set(name, b64); saveRemembered(); }
        }
      }
    } catch { /* scene may have vanished mid-request */ }
    thumbBusy = false;
    if (demand.thumbs > 0 && obs.c) thumbTimer = setTimeout(thumbLoop, busy ? 400 : demand.max > 0 ? 0 : demand.live > 0 ? 30 : 1500);
  }

  // Program and preview each run their own loop, paced by how fast OBS answers (no fixed sleeps), so the picture
  // is as live as the screenshot API allows (~15 fps program, ~8 fps preview). The relay link drops frames when backed up.
  const thumbLast = new Map(); // scene -> last screenshot (base64) so unchanged pictures are not re-sent
  const remembered = new Map(Object.entries(pictures.load() ?? {}).filter(([, v]) => typeof v === "string"));

  function saveRemembered() {
    const keep = new Set(st?.scenes ?? []);
    for (const n of remembered.keys()) if (st && !keep.has(n)) remembered.delete(n); // scene deleted or renamed
    pictures.save(Object.fromEntries(remembered));
  }

  /** A phone opened Present mode: it has no pictures yet. Send what each scene last looked like, and let the
   *  thumbnail loop send every scene again even when its picture has not changed. */
  function freshThumbs() {
    thumbLast.clear();
    for (const name of st?.scenes ?? []) {
      const b64 = remembered.get(name);
      if (!b64) continue;
      const nm = Buffer.from(name, "utf8").subarray(0, 255);
      send(Buffer.concat([Buffer.from([FRAME_REMEMBERED, nm.length]), nm, Buffer.from(b64, "base64")]));
    }
  }
  const ECO = [500, 800]; // while nobody asked for the live rate (saves CPU/GPU on the streaming PC)
  const loops = [{ timer: null, busy: false, every: 66, last: "" }, { timer: null, busy: false, every: 120, last: "" }];

  function previewLoop() {
    for (const ch of [FRAME_PGM, FRAME_PVW]) if (!loops[ch].timer && !loops[ch].busy) frameLoop(ch);
  }

  async function frameLoop(ch) {
    const L = loops[ch];
    L.timer = null;
    if (demand.preview <= 0 || !obs.c || !st) return;
    if (ch === FRAME_PVW && !st.studioMode) { L.timer = setTimeout(() => frameLoop(ch), 400); return; } // nothing to show yet
    L.busy = true;
    const t0 = Date.now();
    try {
      const name = ch === FRAME_PVW ? st.preview : st.program;
      const r = await obs.c.request("GetSourceScreenshot", { sourceName: name, imageFormat: "jpg", imageWidth: demand.max > 0 ? 640 : 480, imageHeight: demand.max > 0 ? 360 : 270, imageCompressionQuality: demand.max > 0 ? 55 : 45 });
      const b64 = String(r.imageData ?? "").split(",")[1];
      if (b64) send(Buffer.concat([Buffer.from([ch]), Buffer.from(b64, "base64")]));
    } catch { /* scene may have vanished mid-request */ }
    L.busy = false;
    if (demand.preview > 0 && obs.c) L.timer = setTimeout(() => frameLoop(ch), Math.max(0, (demand.max > 0 ? 16 : demand.live > 0 ? L.every : ECO[ch]) - (Date.now() - t0)));
  }

  // ---- requests from the relay ------------------------------------------------

  async function restoreOverride() {
    const o = override;
    if (!o) return;
    clearTimeout(o.timer);
    override = null;
    try {
      // st.transition was frozen during the override, so compare against what we actually changed.
      if (o.nameChanged) await obs.c?.request("SetCurrentSceneTransition", { transitionName: o.prev.name });
      if (o.durChanged) await obs.c?.request("SetCurrentSceneTransitionDuration", { transitionDuration: o.prev.duration }).catch(() => {});
    } catch (e) { log("could not restore transition: " + e.message); }
    scheduleResync();
  }

  async function studioTake(d) {
    if (!st.studioMode) throw new Error("studio mode is off");
    const name = typeof d.transitionName === "string" && d.transitionName ? d.transitionName : null;
    const dur = d.duration != null && Number.isFinite(Number(d.duration)) ? clamp(Math.round(Number(d.duration)), 0, 20000) : null;
    if (!name && dur == null) return obs.c.request("TriggerStudioModeTransition");
    if (override || st.tr || tbar > 0) throw new Error("transition in progress");
    const prev = { name: st.transition, duration: st.duration };
    override = { prev, duration: dur ?? st.duration, timer: null, nameChanged: false, durChanged: false };
    try {
      if (name && name !== st.transition) { override.nameChanged = true; await obs.c.request("SetCurrentSceneTransition", { transitionName: name }); }
      if (dur != null && dur !== st.duration) { override.durChanged = true; await obs.c.request("SetCurrentSceneTransitionDuration", { transitionDuration: dur }).catch(() => {}); }
      await obs.c.request("TriggerStudioModeTransition");
    } catch (e) {
      await restoreOverride();
      throw e;
    }
    override.timer = setTimeout(restoreOverride, (override.duration || 0) + 2500);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function setTbar(d) {
    if (!st.studioMode) throw new Error("studio mode is off");
    const position = clamp(Number(d.position), 0, 1);
    if (!Number.isFinite(position)) throw new Error("bad position");
    const release = d.release === true;
    tbarTouch = Date.now();
    if (release && position >= 0.999) {
      // OBS does not commit a released T-bar by itself over WebSocket (it springs back). What works on OBS 31:
      // hold the end, release, then make the previewed scene the program scene.
      const target = st.preview;
      await obs.c.request("SetTBarPosition", { position: 1, release: false });
      await sleep(100);
      await obs.c.request("SetTBarPosition", { position: 1, release: true });
      await sleep(120);
      await obs.c.request("SetCurrentProgramScene", { sceneName: target });
      tbar = 0;
      return evt("TBarChanged", { position: 0, completed: true });
    }
    await obs.c.request("SetTBarPosition", { position, release });
    tbar = release && position <= 0.001 ? 0 : position;
    evt("TBarChanged", { position: tbar });
  }

  const str = (v, what) => { if (typeof v !== "string" || !v || v.length > 256) throw new Error(`bad ${what}`); return v; };
  const tri = (v) => { if (!TOGGLE.has(v)) throw new Error("bad state"); return v; };

  /** Button building blocks that need more than one OBS request (toggle, look up by name) or return data. */
  async function buttonOp(op, d) {
    const c = obs.c;
    if (op === "SetSourceVisible") {
      const sceneName = str(d.sceneName, "sceneName"), sourceName = str(d.sourceName, "sourceName"), state = tri(d.state);
      const { sceneItemId } = await c.request("GetSceneItemId", { sceneName, sourceName });
      const on = state === "toggle" ? !(await c.request("GetSceneItemEnabled", { sceneName, sceneItemId })).sceneItemEnabled : state === "on";
      await c.request("SetSceneItemEnabled", { sceneName, sceneItemId, sceneItemEnabled: on });
    } else if (op === "SetFilterState") {
      const sourceName = str(d.sourceName, "sourceName"), filterName = str(d.filterName, "filterName"), state = tri(d.state);
      const on = state === "toggle" ? !(await c.request("GetSourceFilter", { sourceName, filterName })).filterEnabled : state === "on";
      await c.request("SetSourceFilterEnabled", { sourceName, filterName, filterEnabled: on });
    } else if (op === "SetMuteState") {
      const inputName = str(d.inputName, "inputName"), state = tri(d.state);
      if (state === "toggle") await c.request("ToggleInputMute", { inputName });
      else await c.request("SetInputMute", { inputName, inputMuted: state === "on" });
    } else if (op === "SetText") {
      const inputName = str(d.inputName, "inputName");
      if (typeof d.text !== "string" || d.text.length > 2000) throw new Error("bad text");
      await c.request("SetInputSettings", { inputName, inputSettings: { text: d.text }, overlay: true });
    } else if (op === "TriggerHotkeyByName") {
      await c.request("TriggerHotkeyByName", { hotkeyName: str(d.hotkeyName, "hotkeyName") });
    } else if (op === "ListFilters") {
      const r = await c.request("GetSourceFilterList", { sourceName: str(d.sourceName, "sourceName") });
      return r.filters.map((f) => ({ name: f.filterName, enabled: f.filterEnabled }));
    } else if (op === "ListHotkeys") {
      return (await c.request("GetHotkeyList")).hotkeys.slice(0, 400);
    } else if (op === "SetLayout") {
      const clean = cleanLayout(d.layout);
      layout.save(clean);
      if (st) st.layout = clean;
      evt("LayoutChanged", { layout: clean });
    }
    return undefined;
  }

  async function handleRelay(m) {
    if (m.type === "demand") {
      const before = demand.thumbs;
      demand = { clients: m.clients | 0, preview: m.preview | 0, thumbs: m.thumbs | 0, live: m.live | 0, max: m.max | 0 };
      if (demand.thumbs > before) freshThumbs();
      applyDemand();
      return;
    }
    if (m.type === "sync.request") {
      if (!obs.c) return send({ type: "evt", op: "ObsOnline", cid: m.cid, data: { online: false } });
      try { const s = await freshSnapshot(); send({ type: "state.sync", cid: m.cid, data: { ...s, now: Date.now() } }); } catch (e) { log("sync failed: " + e.message); }
      return;
    }
    if (m.type !== "req") return;
    const reply = (ok, error, data) => send({ type: "res", id: m.id, cid: m.cid, ok, ...(error ? { error } : {}), ...(data !== undefined ? { data } : {}) });
    if (typeof m.op !== "string" || !ALLOWED_OPS.has(m.op)) return reply(false, "not_allowed");
    if (!obs.c || !st) return reply(false, "obs_offline");
    if (m.ctl && typeof m.seq === "number") {
      if (m.seq <= (lastSeq.get(m.ctl) ?? -1)) return reply(true); // out-of-order update for the same control
      lastSeq.set(m.ctl, m.seq);
    }
    try {
      const d = m.data && typeof m.data === "object" ? m.data : {};
      if (m.op === "StudioTake") await studioTake(d);
      else if (m.op === "SetTBarPosition") await setTbar(d);
      else if (m.op === "PresentKey") {
        if (!allowKeys()) throw new Error("slide keys are off on this computer");
        if (!SLIDE_KEYS.has(d.key)) throw new Error("bad key");
        await sendSlideKey(d.key);
      } else if (BUTTON_OPS.has(m.op)) {
        return reply(true, undefined, await buttonOp(m.op, d));
      } else {
        const spec = OPS[m.op];
        const args = pick(spec.f, d);
        for (const [k, set] of Object.entries(spec.enum ?? {})) if (!set.has(args[k])) throw new Error(`bad ${k}`);
        await obs.c.request(m.op, args);
      }
      reply(true);
    } catch (e) {
      reply(false, String(e.message || "failed").slice(0, 120));
    }
  }

  return {
    start() { stopped = false; connectLoop(); },
    stop() { stopped = true; clearTimeout(retryTimer); clearTimeout(resyncTimer); stopTimers(); obs.c?.close(); },
    handleRelay,
    /** A request to OBS from the agent itself (not from a phone, so no allowlist): "Add to OBS" for YouTube. */
    request: (type, data) => (obs.c?.ready ? obs.c.request(type, data) : Promise.reject(new Error("OBS is not connected."))),
    status: () => ({ ...status, obs: st ? st.obs : null }),
    /** Called when the relay link itself drops: pause expensive work, the relay forgets our demand. */
    relayDown() { demand = { clients: 0, preview: 0, thumbs: 0, live: 0, max: 0 }; clearTimeout(thumbTimer); thumbTimer = null; loops.forEach((l) => { clearTimeout(l.timer); l.timer = null; }); },
    /** Called when the relay link (re)opens so clients get a snapshot even if OBS was already connected. */
    relayUp() { if (st) send({ type: "state.sync", data: { ...st, now: Date.now() } }); else evt("ObsOnline", { online: false }); },
  };
}
