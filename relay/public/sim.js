// Fake OBS used for UI development and tests. Runs in the browser (?demo) and in Node (test/mock-obs.mjs).
// It speaks the same JSON protocol as the real plugin: req/res/evt/state.sync (see PLAN.md §6).

import { kindOf } from "./kinds.js";

export const ALLOW = new Set([
  "SetCurrentProgramScene", "SetCurrentPreviewScene", "TriggerStudioModeTransition", "SetStudioModeEnabled",
  "SetTBarPosition", "StudioTake", // StudioTake is a plugin-defined op: take with an optional one-off transition/duration
  "SetInputVolume", "SetInputMute", "SetSceneItemEnabled", "SetSceneItemLocked",
  "SetCurrentSceneTransition", "SetCurrentSceneTransitionDuration",
  "StartStream", "StopStream", "StartRecord", "StopRecord", "ToggleRecordPause",
  "StartReplayBuffer", "StopReplayBuffer", "SaveReplayBuffer",
  "SetSourceVisible", "SetFilterState", "SetMuteState", "SetText", "TriggerHotkeyByName", "ListFilters", "ListHotkeys", "SetLayout", // user-made buttons
  "TriggerMediaInputAction", "PresentKey", // slides: media/slideshow controls and PowerPoint/PDF page keys
]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const hueOf = (n) => [...n].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

export function createSim(send, opts = {}) {
  const tickFast = opts.fast ?? 100;
  const s = {
    name: "STUDIO-PC",
    version: "31.0.0",
    scenes: ["Starting Soon", "Main", "Gameplay", "Camera Full", "Slides", "Video", "Deck", "Ending"],
    program: "Starting Soon",
    preview: "Main",
    studioMode: false,
    inputs: [
      { name: "Mic/Aux", kind: "wasapi_input_capture", volumeDb: -6.0, muted: false, pinned: true },
      { name: "Desktop Audio", kind: "wasapi_output_capture", volumeDb: -12.0, muted: false, pinned: true },
      { name: "Game", kind: "wasapi_process_output_capture", volumeDb: -9.5, muted: false, pinned: true },
      { name: "Music", kind: "ffmpeg_source", volumeDb: -22.0, muted: true, pinned: true },
      { name: "Browser Alerts", kind: "browser_source", volumeDb: -15.0, muted: false, pinned: false },
    ],
    items: {
      "Starting Soon": [{ id: 1, name: "Countdown", enabled: true, locked: false }, { id: 2, name: "Logo", enabled: true, locked: false }],
      Main: [{ id: 3, name: "Camera", enabled: true, locked: false }, { id: 4, name: "Game Capture", enabled: true, locked: false }, { id: 5, name: "Chat", enabled: true, locked: false }, { id: 6, name: "Alerts", enabled: false, locked: false }],
      Gameplay: [{ id: 7, name: "Game Capture", enabled: true, locked: false }, { id: 8, name: "Camera (small)", enabled: true, locked: false }],
      "Camera Full": [{ id: 9, name: "Camera", enabled: true, locked: false }],
      Slides: [{ id: 10, name: "Photo Slideshow", enabled: true, locked: false, kind: "slideshow" }],
      Video: [{ id: 12, name: "Intro Video", enabled: true, locked: false, kind: "ffmpeg_source" }],
      Deck: [{ id: 13, name: "PowerPoint window", enabled: true, locked: false, kind: "window_capture" }],
      Ending: [{ id: 11, name: "Credits", enabled: true, locked: false }],
    },
    transitions: ["Cut", "Fade", "Fade to Color", "Swipe", "Slide"],
    transition: "Fade",
    duration: 500,
    tr: null,   // running automatic transition: { from, to, kind, start, duration }
    tbar: 0,    // manual transition position 0..1 (studio mode)
    stream: { active: false, since: 0, bytes: 0, dropped: 0, total: 0 },
    record: { active: false, paused: false, since: 0, bytes: 0 },
    replay: { active: false },
    stats: { cpu: 11, fps: 60, dropPct: 0, kbps: 0, diskGb: 182, memMb: 940, renderMs: 3.1 },
  };
  const lastSeq = new Map();
  let page = 1; // fake slide number, shown in the frames of the slide scenes
  let timers = [];
  let t0 = Date.now();

  const sceneByName = (n) => s.scenes.includes(n);
  const input = (n) => s.inputs.find((i) => i.name === n);
  const snapshot = () => ({
    obs: { name: s.name, version: s.version },
    scenes: s.scenes,
    program: s.program,
    preview: s.preview,
    studioMode: s.studioMode,
    inputs: s.inputs,
    items: s.items,
    transitions: s.transitions,
    transitionKinds: Object.fromEntries(s.transitions.map((t) => [t, kindOf(t)])),
    transition: s.transition,
    duration: s.duration,
    tr: s.tr,
    tbar: s.tbar,
    stream: s.stream,
    record: s.record,
    replay: s.replay,
    stats: s.stats,
    layout: s.layout ?? { buttons: [] },
    now: Date.now(),
  });
  const evt = (op, data) => send({ type: "evt", op, data });
  const sync = (cid) => send({ type: "state.sync", cid, data: snapshot() });

  // ---- transitions ----------------------------------------------------------

  /** Start an automatic transition from -> to (program already points at `to`). Cut is instant. */
  function startTransition(from, to, name = s.transition, duration = s.duration) {
    const kind = kindOf(name);
    if (kind === "cut" || duration <= 0 || from === to) return;
    const tr = { from, to, kind, transition: name, start: Date.now(), duration };
    s.tr = tr;
    evt("TransitionStarted", { from, to, transition: name, kind, duration, at: tr.start });
    timers.push(setTimeout(() => {
      if (s.tr !== tr) return;
      s.tr = null;
      evt("TransitionEnded", { to });
    }, duration));
  }

  function swapAndTransition(name, duration) {
    const from = s.program;
    s.program = s.preview;
    s.preview = from;
    evt("ProgramSceneChanged", { sceneName: s.program });
    evt("PreviewSceneChanged", { sceneName: s.preview });
    startTransition(from, s.program, name, duration);
  }

  function apply(op, d) {
    switch (op) {
      case "SetCurrentProgramScene": {
        if (!sceneByName(d.sceneName)) throw new Error("no such scene");
        if (s.tbar > 0) throw new Error("T-bar is in use");
        const from = s.program;
        s.program = d.sceneName;
        evt("ProgramSceneChanged", { sceneName: s.program });
        return startTransition(from, s.program);
      }
      case "SetCurrentPreviewScene":
        if (!s.studioMode) throw new Error("studio mode is off");
        if (!sceneByName(d.sceneName)) throw new Error("no such scene");
        if (s.tbar > 0 || s.tr) throw new Error("transition in progress");
        s.preview = d.sceneName;
        return evt("PreviewSceneChanged", { sceneName: s.preview });
      case "SetStudioModeEnabled":
        s.studioMode = !!d.studioModeEnabled;
        if (!s.studioMode) { s.tbar = 0; evt("TBarChanged", { position: 0 }); }
        return evt("StudioModeChanged", { studioMode: s.studioMode });
      case "TriggerStudioModeTransition":
      case "StudioTake": {
        if (!s.studioMode) throw new Error("studio mode is off");
        if (s.tr || s.tbar > 0) throw new Error("transition in progress");
        const name = op === "StudioTake" && d.transitionName ? d.transitionName : s.transition;
        if (!s.transitions.includes(name)) throw new Error("no such transition");
        const dur = op === "StudioTake" && d.duration != null ? clamp(Math.round(Number(d.duration)), 0, 20000) : s.duration;
        return swapAndTransition(name, dur);
      }
      case "SetTBarPosition": {
        if (!s.studioMode) throw new Error("studio mode is off");
        if (s.tr) throw new Error("transition in progress");
        const pos = clamp(Number(d.position), 0, 1);
        if (!Number.isFinite(pos)) throw new Error("bad position");
        s.tbar = pos;
        if (d.release && pos >= 0.999) {
          // Handle reached the end: the manual transition completes and the buses swap.
          s.tbar = 0;
          const p = s.program;
          s.program = s.preview;
          s.preview = p;
          evt("ProgramSceneChanged", { sceneName: s.program });
          evt("PreviewSceneChanged", { sceneName: s.preview });
          return evt("TBarChanged", { position: 0, completed: true });
        }
        if (d.release && pos <= 0.001) s.tbar = 0;
        return evt("TBarChanged", { position: s.tbar });
      }
      case "SetInputVolume": {
        const i = input(d.inputName);
        if (!i) throw new Error("no such input");
        i.volumeDb = clamp(Number(d.inputVolumeDb), -100, 26);
        return evt("InputVolumeChanged", { inputName: i.name, inputVolumeDb: i.volumeDb });
      }
      case "SetInputMute": {
        const i = input(d.inputName);
        if (!i) throw new Error("no such input");
        i.muted = !!d.inputMuted;
        return evt("InputMuteStateChanged", { inputName: i.name, inputMuted: i.muted });
      }
      case "SetSceneItemEnabled": {
        const it = (s.items[d.sceneName] || []).find((x) => x.id === d.sceneItemId);
        if (!it) throw new Error("no such item");
        it.enabled = !!d.sceneItemEnabled;
        return evt("SceneItemEnableStateChanged", { sceneName: d.sceneName, sceneItemId: it.id, sceneItemEnabled: it.enabled });
      }
      case "SetSceneItemLocked": {
        const it = (s.items[d.sceneName] || []).find((x) => x.id === d.sceneItemId);
        if (!it) throw new Error("no such item");
        it.locked = !!d.sceneItemLocked;
        return evt("SceneItemLockStateChanged", { sceneName: d.sceneName, sceneItemId: it.id, sceneItemLocked: it.locked });
      }
      case "SetCurrentSceneTransition":
        if (!s.transitions.includes(d.transitionName)) throw new Error("no such transition");
        s.transition = d.transitionName;
        return evt("CurrentSceneTransitionChanged", { transitionName: s.transition });
      case "SetCurrentSceneTransitionDuration":
        s.duration = clamp(Math.round(Number(d.transitionDuration)), 50, 20000);
        return evt("CurrentSceneTransitionDurationChanged", { transitionDuration: s.duration });
      case "StartStream":
        if (s.stream.active) throw new Error("already active");
        Object.assign(s.stream, { active: true, since: Date.now(), bytes: 0, dropped: 0, total: 0 });
        return evt("StreamStateChanged", { ...s.stream });
      case "StopStream":
        if (!s.stream.active) throw new Error("not active");
        s.stream.active = false;
        return evt("StreamStateChanged", { ...s.stream });
      case "StartRecord":
        if (s.record.active) throw new Error("already active");
        Object.assign(s.record, { active: true, paused: false, since: Date.now(), bytes: 0 });
        return evt("RecordStateChanged", { ...s.record });
      case "StopRecord":
        if (!s.record.active) throw new Error("not active");
        s.record.active = false;
        s.record.paused = false;
        return evt("RecordStateChanged", { ...s.record });
      case "ToggleRecordPause":
        if (!s.record.active) throw new Error("not active");
        s.record.paused = !s.record.paused;
        return evt("RecordStateChanged", { ...s.record });
      case "StartReplayBuffer":
        s.replay.active = true;
        return evt("ReplayBufferStateChanged", { ...s.replay });
      case "StopReplayBuffer":
        s.replay.active = false;
        return evt("ReplayBufferStateChanged", { ...s.replay });
      case "SaveReplayBuffer":
        if (!s.replay.active) throw new Error("replay buffer is off");
        return evt("ReplayBufferSaved", { path: "Replay " + new Date().toTimeString().slice(0, 8) + ".mkv" });
      case "TriggerMediaInputAction":
        if (/NEXT$/.test(d.mediaAction)) page++;
        else if (/PREVIOUS$/.test(d.mediaAction)) page = Math.max(1, page - 1);
        else if (/RESTART$/.test(d.mediaAction)) page = 1;
        return;
      case "SetSourceVisible": {
        const it = (s.items[d.sceneName] || []).find((x) => x.name === d.sourceName);
        if (!it) throw new Error("no such source in that scene");
        it.enabled = d.state === "toggle" ? !it.enabled : d.state === "on";
        return void evt("SceneItemEnableStateChanged", { sceneName: d.sceneName, sceneItemId: it.id, sceneItemEnabled: it.enabled });
      }
      case "SetMuteState": {
        const i = input(d.inputName);
        if (!i) throw new Error("no such input");
        i.muted = d.state === "toggle" ? !i.muted : d.state === "on";
        return void evt("InputMuteStateChanged", { inputName: i.name, inputMuted: i.muted });
      }
      case "SetFilterState": {
        s.filters ??= {};
        const f = (s.filters[d.sourceName] ??= [{ name: "Color Correction", enabled: true }, { name: "Sharpen", enabled: false }]).find((x) => x.name === d.filterName);
        if (!f) throw new Error("no such filter");
        f.enabled = d.state === "toggle" ? !f.enabled : d.state === "on";
        return;
      }
      case "ListFilters":
        s.filters ??= {};
        return (s.filters[d.sourceName] ??= [{ name: "Color Correction", enabled: true }, { name: "Sharpen", enabled: false }]);
      case "ListHotkeys": return ["OBSBasic.StartStreaming", "OBSBasic.StopStreaming", "OBSBasic.StartRecording", "OBSBasic.StopRecording", "ReplayBuffer.Save"];
      case "TriggerHotkeyByName": return;
      case "SetText": s.texts ??= {}; s.texts[d.inputName] = String(d.text).slice(0, 2000); return;
      case "SetLayout":
        s.layout = { buttons: Array.isArray(d.layout?.buttons) ? d.layout.buttons.slice(0, 60) : [] };
        return void evt("LayoutChanged", { layout: s.layout });
      case "PresentKey":
        page = d.key === "next" ? page + 1 : d.key === "prev" ? Math.max(1, page - 1) : d.key === "first" ? 1 : page;
        return;
      default:
        throw new Error("unknown op");
    }
  }

  function handle(m) {
    if (m.type === "sync.request") return sync(m.cid);
    if (m.type !== "req") return;
    const reply = (ok, error, data) => send({ type: "res", id: m.id, cid: m.cid, ok, ...(error ? { error } : {}), ...(data !== undefined ? { data } : {}) });
    if (!ALLOW.has(m.op)) return reply(false, "not_allowed");
    // Drop out-of-order updates for the same control (PLAN.md §3).
    if (m.ctl && typeof m.seq === "number") {
      if (m.seq <= (lastSeq.get(m.ctl) ?? -1)) return reply(true);
      lastSeq.set(m.ctl, m.seq);
    }
    try {
      const out = apply(m.op, m.data || {});
      reply(true, undefined, out && typeof out === "object" ? out : undefined);
    } catch (e) {
      reply(false, e.message);
    }
  }

  // ---- ambient behaviour ----------------------------------------------------

  const levelState = new Map();
  function levels() {
    const t = (Date.now() - t0) / 1000;
    const out = {};
    s.inputs.forEach((i, n) => {
      if (i.muted) return void (out[i.name] = [0, 0]);
      const speech = Math.max(0, Math.sin(t * (1.3 + n * 0.37)) * Math.sin(t * 0.41 + n)) ** 2;
      const base = i.kind.includes("input") ? 0.15 + speech * 0.85 : 0.35 + Math.sin(t * 0.9 + n) * 0.2;
      const gain = 10 ** (i.volumeDb / 20);
      const prev = levelState.get(i.name) ?? 0;
      const v = Math.max(prev * 0.8, clamp(base * gain * (0.85 + Math.random() * 0.3), 0, 1));
      levelState.set(i.name, v);
      out[i.name] = [v, clamp(v * (0.9 + Math.random() * 0.1), 0, 1)];
    });
    return out;
  }

  /** What is mixing right now: an automatic transition, a manual T-bar move, or nothing. */
  function mixing() {
    if (s.tbar > 0) return { from: s.program, to: s.preview, kind: kindOf(s.transition), p: s.tbar };
    if (s.tr) return { from: s.tr.from, to: s.tr.to, kind: s.tr.kind, p: clamp((Date.now() - s.tr.start) / s.tr.duration, 0, 1) };
    return null;
  }

  function frame(scene = s.program, chan = 0) {
    const t = (Date.now() - t0) / 1000;
    const layer = (name, id) => {
      const hue = hueOf(name);
      const x = 240 + Math.sin(t + hue) * 150;
      return (
        `<defs><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,22%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,10%)"/></linearGradient></defs>` +
        `<rect width="480" height="270" fill="url(#g${id})"/>` +
        `<circle cx="${x.toFixed(0)}" cy="150" r="34" fill="hsl(${hue},80%,60%)" opacity=".85"/>` +
        (s.items[name]?.some((i) => /slideshow|ffmpeg|window/.test(i.kind || "")) ? `<text x="240" y="190" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="700" fill="#fff" opacity=".9">${page}</text>` : "")
      );
    };
    const m = mixing();
    let body, tag = "";
    if (!m || chan === 1) body = layer(scene, "a");
    else {
      const { from, to, kind, p } = m;
      tag = `${kind.toUpperCase()} ${Math.round(p * 100)}%`;
      if (kind === "dip") {
        // A fades to black over the first half, then B fades up from black.
        body = p < 0.5
          ? `<g opacity="${(1 - p * 2).toFixed(3)}">${layer(from, "a")}</g>`
          : `<g opacity="${((p - 0.5) * 2).toFixed(3)}">${layer(to, "b")}</g>`;
      } else if (kind === "wipe") {
        const w = (p * 480).toFixed(1);
        body = `${layer(from, "a")}<clipPath id="c"><rect width="${w}" height="270"/></clipPath><g clip-path="url(#c)">${layer(to, "b")}</g><rect x="${w}" width="3" height="270" fill="#fff" opacity=".8"/>`;
      } else if (kind === "slide") {
        const dx = (p * 480).toFixed(1);
        body = `<g transform="translate(${-dx} 0)">${layer(from, "a")}</g><g transform="translate(${(480 - dx).toFixed(1)} 0)">${layer(to, "b")}</g>`;
      } else if (kind === "cut") body = layer(p < 0.5 ? from : to, "a");
      else body = `${layer(from, "a")}<g opacity="${p.toFixed(3)}">${layer(to, "b")}</g>`; // mix: cross-dissolve
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="#000"/>${body}` +
      (tag ? `<text x="460" y="30" text-anchor="end" font-family="monospace" font-size="16" fill="#fff" opacity=".85">${tag}</text>` : "") +
      `</svg>`;
    const bytes = new TextEncoder().encode(svg);
    const out = new Uint8Array(bytes.length + 1);
    out[0] = chan;
    out.set(bytes, 1);
    return out.buffer;
  }

  /** Scene thumbnail frame: [2][name length][name][image]. */
  function thumbFrame(scene) {
    const img = new Uint8Array(frame(scene, 0)).subarray(1);
    const nm = new TextEncoder().encode(scene).subarray(0, 255);
    const out = new Uint8Array(2 + nm.length + img.length);
    out[0] = 2; out[1] = nm.length;
    out.set(nm, 2);
    out.set(img, 2 + nm.length);
    return out.buffer;
  }
  let thumbsOn = false, thumbIdx = 0;

  function start() {
    stop();
    t0 = Date.now();
    timers.push(setInterval(() => evt("Levels", { levels: levels() }), tickFast));
    timers.push(setInterval(() => {
      const st = s.stats;
      st.cpu = clamp(st.cpu + (Math.random() - 0.5) * 3, 5, 60);
      st.memMb = clamp(st.memMb + (Math.random() - 0.4) * 6, 700, 2200);
      st.renderMs = clamp(st.renderMs + (Math.random() - 0.5) * 0.3, 1.5, 8);
      if (s.stream.active) {
        s.stream.bytes += 6000 * 125;
        s.stream.total += s.stats.fps;
        if (Math.random() < 0.06) s.stream.dropped += 1 + Math.floor(Math.random() * 4);
        st.kbps = 5800 + Math.random() * 400;
      } else st.kbps = 0;
      if (s.record.active && !s.record.paused) {
        s.record.bytes += 8000 * 125;
        st.diskGb = Math.max(0, st.diskGb - 0.001);
      }
      st.dropPct = s.stream.total ? (s.stream.dropped / s.stream.total) * 100 : 0;
      evt("Stats", { stats: st, stream: s.stream, record: s.record });
    }, 1000));
    // Idle: ~1.5 fps. While something is mixing, send faster so the blend is visible.
    let n = 0;
    timers.push(setInterval(() => { if (thumbsOn && !mixing()) send(thumbFrame(s.scenes[thumbIdx++ % s.scenes.length])); }, 350));
    timers.push(setInterval(() => { if (mixing() || ++n % 6 === 0) { send(frame()); if (s.studioMode) send(frame(s.preview, 1)); } }, 110));
  }
  function stop() {
    timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
    timers = [];
  }

  return { handle, start, stop, snapshot, sync, state: s, thumbs: (on) => { thumbsOn = !!on; } };
}
