// OBS Remote web UI. No build step: plain ES modules, no inline styles (strict CSP).
import { icon, hydrate, kindIcon, sourceIcon } from "./icons.js";
import { kindOf, STAGES } from "./kinds.js";
import { createEasy } from "./easy.js";
import { createMachines } from "./machines.js";
import { createButtons } from "./buttons.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const root = document.documentElement;
const params = new URLSearchParams(location.search);

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

const setIcon = (btn, name) => btn.replaceChildren(icon(name));
/** Button content = icon + label; the icon can carry an animation class (see .ic.anim in app.css). */
const setBtn = (btn, name, text, cls = "") => {
  const sig = `${name}|${text}|${cls}`;
  if (btn.dataset.sig === sig) return; // Stats ticks call this every second; don't restart the icon animation
  btn.dataset.sig = sig;
  btn.replaceChildren(icon(name, cls), h("span", {}, text));
};

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const PREFS = "obsr.prefs", AUTH = "obsr.auth";
const prefs = { size: "m", detail: "auto", layout: "auto", mode: "obs", preview: "live", hidden: [], pins: null, ...store.get(PREFS) };
if (params.get("mode") === "easy" || params.get("mode") === "obs") prefs.mode = params.get("mode");

// ---------------------------------------------------------------------------
// Adaptive layout: phone = one tab at a time + compact controls;
// big screens (tablet / desktop) = dashboard + full controls. The user can override each.
// ---------------------------------------------------------------------------

let layoutKey = "";
function applyLayout() {
  const big = innerWidth >= 600 && innerHeight >= 500;
  const layout = prefs.layout === "auto" ? (big ? "wide" : "phone") : prefs.layout;
  const detail = prefs.detail === "auto" ? (big ? "full" : "simple") : prefs.detail;
  root.dataset.layout = layout;
  root.dataset.detail = detail;
  root.dataset.size = prefs.size;
  root.dataset.mode = prefs.mode === "easy" ? "easy" : "obs";
  if (prefs.mode === "easy") { easy.build(); easy.render(); }
  const key = layout + detail;
  const changed = key !== layoutKey;
  layoutKey = key;
  if (changed && S.data) { renderMixer(); renderSources(); renderStats(); }
  updateMixerMode();
  syncPreview();
}
const detail = () => root.dataset.detail;
const layout = () => root.dataset.layout;

function paintPv() {
  for (const id of ["#btnPv", "#ezPv"]) $(id).setAttribute("aria-pressed", String(prefs.preview !== "off"));
  $$(".screen .off, .ez-screen .off").forEach((el) => (el.textContent = prefs.preview === "off" ? "preview off" : "no preview"));
}

/** OBS-style view <-> Present view. */
function setMode(m) {
  prefs.mode = m;
  store.set(PREFS, prefs);
  applyLayout();
  window.scrollTo(0, 0);
}

function updateMixerMode() {
  const mx = $(".panel.max");
  $("#mixer").classList.toggle("strips", mx?.id === "p-mixer"); // OBS-style rows by default; console strips when enlarged
}

// ---------------------------------------------------------------------------
// State + transport
// ---------------------------------------------------------------------------

const S = {
  data: null,          // last state.sync, mutated by events
  linkOpen: false,
  obsOnline: false,
  skew: 0,             // local clock - OBS clock
  arming: null,        // scene we asked for but OBS has not confirmed yet
  viewScene: null,     // scene shown in Sources (null = follow program)
  hist: { cpu: [], kbps: [] },
  tr: null,            // running automatic transition { from, to, kind, start, duration }
  tbar: 0,             // manual transition position 0..1
  perm: "owner",
  devices: [],
};

// Counters for the Diagnostics box and for debugging in the field.
const diag = { start: Date.now(), msgs: 0, frames: 0, frameBytes: 0, reconnects: 0, rtt: null, rpcMs: null, rpcN: 0, rpcFail: 0, lastErr: "", lastClose: "" };

const holds = new Map(); // control id -> ignore OBS echo until this time (Infinity while dragging)
const held = (ctl) => (holds.get(ctl) ?? 0) > performance.now();

const link = {
  ws: null, tries: 0, hello: false, timer: 0, ping: 0, last: 0, demo: null, auth: null,
  open() {
    clearTimeout(this.timer);
    refreshConn();
    const a = this.auth;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // The token travels as a WebSocket subprotocol, not in the URL, so it stays out of logs and history.
    const ws = new WebSocket(`${proto}://${location.host}/ws/client?room=${a.room}`, [`obsr.${a.token}`]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let pingAt = 0;
    const ping = () => {
      if (Date.now() - this.last > 45000) return ws.close();
      pingAt = performance.now();
      ws.send("ping");
    };
    ws.onopen = () => {
      this.last = Date.now();
      clearInterval(this.ping);
      ping();
      this.ping = setInterval(ping, 8000);
    };
    ws.onmessage = (e) => {
      this.last = Date.now();
      if (e.data === "pong") { diag.rtt = Math.round(performance.now() - pingAt); refreshConn(); return; }
      onMessage(e.data);
    };
    ws.onclose = (e) => {
      clearInterval(this.ping);
      if (this.ws !== ws) return;
      this.ws = null;
      S.linkOpen = false;
      diag.reconnects++;
      diag.lastClose = `${e.code} ${e.reason || ""}`.trim();
      diag.rtt = null;
      refreshConn();
      if (e.code === 4001) return forget("This device was removed from OBS. Pair it again.");
      if (!this.hello && this.tries >= 4) toast("Can't reach the relay. Check the address, or forget this device and pair again.");
      const wait = Math.min(10000, 500 * 2 ** this.tries++) + Math.random() * 300;
      this.timer = setTimeout(() => this.open(), wait);
    };
  },
  send(m) {
    if (this.demo) { this.demo.send(m); return true; }
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  },
  reconnectNow() {
    if (this.demo || !this.auth || this.ws) return;
    this.tries = 0;
    this.open();
  },
  close() {
    clearTimeout(this.timer);
    clearInterval(this.ping);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  },
};

function onMessage(data) {
  diag.msgs++;
  if (typeof data !== "string") return showFrame(data);
  let m;
  try { m = JSON.parse(data); } catch { return; }
  switch (m.type) {
    case "hello":
      link.hello = true;
      link.tries = 0;
      S.linkOpen = true;
      S.obsOnline = !!m.obs;
      S.perm = m.perm || "owner";
      root.dataset.perm = S.perm;
      $("#shareBox").hidden = S.perm !== "owner" || !!link.demo;
      previewSent = null;
      refreshConn();
      syncPreview();
      if (S.perm === "owner") link.send({ type: "devices" });
      break;
    case "devices":
      S.devices = m.data || [];
      renderDevices();
      break;
    case "invite.code":
      showInvite(m);
      break;
    case "invite.error":
      toast("Only the owner can share access");
      break;
    case "presence":
      S.obsOnline = !!m.obs;
      refreshConn();
      if (m.obs) link.send({ type: "sync" });
      logEv(m.obs ? "OBS connected" : "OBS disconnected", m.obs ? "" : "err");
      break;
    case "state.sync":
      applySnapshot(m.data);
      break;
    case "evt":
      onEvent(m.op, m.data || {});
      break;
    case "res": {
      const p = pending.get(m.id);
      if (p) { clearTimeout(p.t); pending.delete(m.id); p.resolve(m); }
      break;
    }
  }
}

// ---- RPC with timeout, rollback and per-control throttling (PLAN.md §3) ----

const pending = new Map();
const seqs = new Map();
let rid = 0;
const ERR = {
  obs_offline: "OBS is offline",
  not_allowed: "That command is blocked by the OBS allowlist",
  timeout: "No answer from OBS",
  offline: "Not connected",
};

function rpc(op, data, ctl) {
  if (!link.demo) machines.fanout(op, data);
  const id = `${++rid}${Math.random().toString(36).slice(2, 6)}`;
  const t0 = performance.now();
  const msg = { v: 1, type: "req", id, op, data };
  if (ctl) { msg.ctl = ctl; msg.seq = (seqs.get(ctl) ?? 0) + 1; seqs.set(ctl, msg.seq); }
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "timeout" }); }, 2000);
    pending.set(id, { resolve, t });
    if (!link.send(msg)) { clearTimeout(t); pending.delete(id); resolve({ ok: false, error: "offline" }); }
  }).then((r) => {
    const ms = performance.now() - t0;
    diag.rpcN++;
    if (r.ok) diag.rpcMs = diag.rpcMs == null ? ms : diag.rpcMs * 0.8 + ms * 0.2; // smoothed round trip to OBS
    if (!r.ok) {
      diag.rpcFail++;
      diag.lastErr = `${op}: ${r.error}`;
      toast(`${ERR[r.error] ?? r.error ?? "Failed"}`);
      logEv(`${op} failed: ${r.error}`, "err");
      holds.clear();
      S.arming = null;
      link.send({ type: "sync" }); // roll the UI back to what OBS really has
    }
    return r;
  });
}

const lanes = new Map();
const LANE_MS = 33; // ~30 Hz, latest value wins
function stream(ctl, op, data) {
  let L = lanes.get(ctl);
  if (!L) lanes.set(ctl, (L = { timer: 0, next: null }));
  if (L.timer) { L.next = { op, data }; return; }
  rpc(op, data, ctl);
  L.timer = setTimeout(() => {
    L.timer = 0;
    if (L.next) { const n = L.next; L.next = null; stream(ctl, n.op, n.data); }
  }, LANE_MS);
}
function flush(ctl) {
  const L = lanes.get(ctl);
  if (!L?.next) return;
  clearTimeout(L.timer);
  const n = L.next;
  L.next = null;
  rpc(n.op, n.data, ctl);
  L.timer = setTimeout(() => (L.timer = 0), LANE_MS);
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function toast(msg, kind = "err", ms = 3600) {
  const el = h("div", { class: "toast " + (kind === "err" ? "" : kind), role: "status" }, msg);
  $("#toasts").append(el);
  setTimeout(() => el.remove(), ms);
}

const logBuf = [];
function logEv(msg, kind = "") {
  const t = new Date().toTimeString().slice(0, 8);
  logBuf.push({ t, msg, kind });
  if (logBuf.length > 80) logBuf.shift();
  const ol = $("#log");
  ol.append(h("li", { class: kind }, h("time", {}, t), h("span", {}, msg)));
  while (ol.children.length > 80) ol.firstChild.remove();
}

const pad = (n) => String(n).padStart(2, "0");
function fmtTc(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
const elapsed = (since) => Date.now() - S.skew - since;
const fmtDb = (db) => (db <= -99 ? "−∞" : (db > 0 ? "+" : db < 0 ? "−" : "") + Math.abs(db).toFixed(1));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Fader taper: position 0..1 <-> dB. 0 dB sits at ~85% of travel, like a console.
const DB_MIN = -60, DB_MAX = 6, CURVE = 0.6;
const posToDb = (p) => (p <= 0.002 ? -100 : DB_MIN + (DB_MAX - DB_MIN) * p ** CURVE);
const dbToPos = (db) => (db <= DB_MIN ? 0 : clamp(((db - DB_MIN) / (DB_MAX - DB_MIN)) ** (1 / CURVE), 0, 1));
root.style.setProperty("--zero", dbToPos(0).toFixed(3));
const linToPos = (v) => (v <= 0.0001 ? 0 : clamp((20 * Math.log10(v) + 60) / 60, 0, 1));

/** Press-and-hold to confirm. `need()` says whether a hold is required right now; otherwise a tap runs fn. */
function bindHold(btn, fn, need = () => true, ms = 700) {
  let t = 0, fired = false;
  const cancel = () => { clearTimeout(t); t = 0; btn.classList.remove("arming"); };
  const begin = () => {
    if (!need()) return;
    fired = false;
    btn.classList.add("arming");
    t = setTimeout(() => { fired = true; cancel(); navigator.vibrate?.(30); fn(); }, ms);
  };
  btn.classList.add("hold");
  btn.style.setProperty("--hold", ms + "ms");
  btn.addEventListener("pointerdown", (e) => { if (e.button === 0 || e.pointerType !== "mouse") begin(); });
  for (const ev of ["pointerup", "pointerleave", "pointercancel", "keyup"]) btn.addEventListener(ev, cancel);
  btn.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) begin(); });
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    if (fired) { fired = false; return; }
    if (need()) toast("Keep holding to confirm", "info", 1400);
    else fn();
  });
}

// ---------------------------------------------------------------------------
// Snapshot + events
// ---------------------------------------------------------------------------

function applySnapshot(d) {
  const old = S.data;
  S.data = d;
  S.skew = Date.now() - d.now;
  S.obsOnline = true;
  S.tr = d.tr ? { ...d.tr } : null;
  S.tbar = d.tbar ?? 0;
  if (!prefs.pins) prefs.pins = d.inputs.filter((i) => i.pinned).map((i) => i.name);
  $("#obsName").textContent = d.obs?.name ?? "OBS";
  machines.learn(d.obs?.name);
  // A snapshot can arrive mid-drag (e.g. after a failed request). Keep the faders alive: only rebuild
  // the mixer when the set of inputs changed, otherwise keep what the user is holding.
  const same = old && old.inputs.length === d.inputs.length && old.inputs.every((o, i) => o.name === d.inputs[i].name);
  if (same) {
    d.inputs.forEach((n, i) => {
      const o = old.inputs[i];
      if (held("vol:" + n.name)) n.volumeDb = o.volumeDb;
      if (held("mute:" + n.name)) n.muted = o.muted;
      Object.assign(o, n); // chRefs/closures keep pointing at the same objects
      d.inputs[i] = o;
    });
  }
  renderAll(same);
  refreshConn();
}

function renderAll(keepMixer = false) {
  renderScenes(); renderSwitcher();
  if (keepMixer) S.data.inputs.forEach(paintCh); else renderMixer();
  renderSources(); renderOutputs(); renderStats(); renderStatusBar(); renderHeader();
  easy.render();
  mine.render();
}

const BUTTON_STATE_OPS = new Set(["ProgramSceneChanged", "SceneItemEnableStateChanged", "InputMuteStateChanged", "StreamStateChanged", "RecordStateChanged"]);
function onEvent(op, d) {
  if (op === "ObsOnline") { // also before the first snapshot: OBS may simply not be running yet
    S.obsOnline = !!d.online;
    refreshConn();
    logEv(d.online ? "OBS connected" : "OBS closed", d.online ? "" : "err");
    return;
  }
  const D = S.data;
  if (!D) return;
  if (BUTTON_STATE_OPS.has(op)) queueMicrotask(() => mine.paint()); // after the switch below has updated the state
  switch (op) {
    case "ProgramSceneChanged":
      D.program = d.sceneName; S.arming = null;
      renderScenes(); renderSwitcher(); renderSources(); renderMixer(); $("#pvScene").textContent = D.program; machines.render();
      logEv(`Program → ${D.program}`);
      break;
    case "PreviewSceneChanged": D.preview = d.sceneName; renderScenes(); renderSwitcher(); break;
    case "StudioModeChanged":
      D.studioMode = d.studioMode;
      if (!D.studioMode) { S.tbar = 0; S.tr = null; }
      renderScenes(); renderSwitcher(); logEv(`Switcher mode ${d.studioMode ? "on" : "off"}`); break;
    case "TransitionStarted":
      S.tr = { from: d.from, to: d.to, kind: d.kind ?? kindOf(d.transition), start: d.at ?? Date.now() - S.skew, duration: d.duration || 500 };
      logEv(`${d.transition ?? "Transition"} ${d.from ? d.from + " → " + d.to : ""}`.trim());
      renderSwitcher(); runMeter(); break;
    case "TransitionEnded": S.tr = null; renderSwitcher(); break;
    case "TBarChanged":
      if (!held("tbar")) { S.tbar = d.position; renderSwitcher(); runMeter(); }
      if (d.completed) logEv("Manual transition completed");
      break;
    case "InputVolumeChanged": {
      const i = D.inputs.find((x) => x.name === d.inputName);
      if (i && !held("vol:" + i.name)) { i.volumeDb = d.inputVolumeDb; paintCh(i); }
      break;
    }
    case "InputMuteStateChanged": {
      const i = D.inputs.find((x) => x.name === d.inputName);
      if (i && !held("mute:" + i.name)) { i.muted = d.inputMuted; paintCh(i); }
      logEv(`${d.inputName} ${d.inputMuted ? "muted" : "unmuted"}`);
      break;
    }
    case "SceneItemEnableStateChanged": {
      const it = (D.items[d.sceneName] || []).find((x) => x.id === d.sceneItemId);
      if (it) { it.enabled = d.sceneItemEnabled; renderSources(); }
      break;
    }
    case "SceneItemLockStateChanged": {
      const it = (D.items[d.sceneName] || []).find((x) => x.id === d.sceneItemId);
      if (it) { it.locked = d.sceneItemLocked; renderSources(); }
      break;
    }
    case "LayoutChanged": D.layout = d.layout; mine.render(); break;
    case "CurrentSceneTransitionChanged": D.transition = d.transitionName; renderSwitcher(); break;
    case "CurrentSceneTransitionDurationChanged": D.duration = d.transitionDuration; renderSwitcher(); break;
    case "StreamStateChanged":
      Object.assign(D.stream, d); renderOutputs(); renderHeader(); machines.render(); logEv(d.active ? "Stream started" : "Stream stopped"); break;
    case "RecordStateChanged":
      Object.assign(D.record, d); renderOutputs(); renderHeader(); logEv(d.active ? (d.paused ? "Recording paused" : "Recording") : "Recording stopped"); break;
    case "ReplayBufferStateChanged": Object.assign(D.replay, d); renderOutputs(); break;
    case "ReplayBufferSaved": toast("Replay saved", "info"); logEv("Replay saved: " + d.path); break;
    case "Stats":
      Object.assign(D.stats, d.stats); Object.assign(D.stream, d.stream); Object.assign(D.record, d.record);
      pushHist(); renderStats(); renderStatusBar(); renderOutputs(); break;
    case "Levels": paintLevels(d.levels); break;
  }
}

// ---------------------------------------------------------------------------
// Header / connection
// ---------------------------------------------------------------------------

function refreshConn() {
  const dot = $("#connDot"), txt = $("#connTxt");
  let s, t;
  if (!S.linkOpen && !link.demo) { s = "wait"; t = "reconnecting"; }
  else if (!S.obsOnline) { s = "off"; t = "OBS offline"; }
  else if (!S.data) { s = "wait"; t = "syncing"; }
  else { s = "ok"; t = "online"; }
  dot.dataset.s = s;
  txt.textContent = s === "ok" && diag.rtt != null ? `${t} · ${diag.rtt} ms` : t;
  const off = s !== "ok";
  $("#app").dataset.off = off ? "1" : "0";
  $("#offline").hidden = !(s === "off");
  machines.render();
  easy.render();
}

function renderHeader() {
  const D = S.data;
  if (!D) return;
  $("#bLive").hidden = !D.stream.active;
  $("#bRec").hidden = !D.record.active;
  $("#bRec").dataset.paused = D.record.paused ? "1" : "0";
  $("#stLive").hidden = !D.stream.active;
  $("#stRec").hidden = !D.record.active;
  $("#app").dataset.live = D.stream.active ? "1" : "0";
  $("#tabs [data-tab=live] .ic").classList.toggle("anim", D.stream.active);
  document.title = (D.stream.active ? "● LIVE — " : "") + "OBS Remote";
  updateTimes();
}

function updateTimes() {
  const D = S.data;
  if (!D) return;
  if (D.stream.active) {
    const tc = fmtTc(elapsed(D.stream.since));
    $("#bLive time").textContent = tc;
    $("#stLive time").textContent = tc;
  }
  if (D.record.active) {
    const tc = fmtTc(elapsed(D.record.since));
    $("#bRec time").textContent = tc;
    $("#stRec time").textContent = tc + (D.record.paused ? " (paused)" : "");
  }
  if (lastFrameAt && Date.now() - lastFrameAt > 6000) { $$(".screen, .ez-screen").forEach((x) => x.classList.remove("has")); lastFrameAt = 0; }
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

function renderScenes() {
  const D = S.data;
  if (!D) return;
  // Like OBS: the highlighted row is what a click changes (preview in studio mode, program otherwise).
  $("#sceneGrid").replaceChildren(
    ...D.scenes.map((name) => {
      const pgm = name === D.program, pvw = D.studioMode && name === D.preview;
      const sel = D.studioMode ? pvw : pgm;
      return h("button", {
        class: "scene" + (sel ? " sel" : "") + (D.studioMode && pgm ? " pgm" : "") + (S.arming === name ? " arming" : ""),
        role: "option", "aria-selected": String(sel),
        onclick: () => pickScene(name),
      }, h("span", { class: "n" }, name), h("small", {}, D.studioMode ? (pgm ? "PGM" : pvw ? "PVW" : "") : ""));
    }),
  );
  $("#pvScene").textContent = D.program;
}

function pickScene(name) {
  const D = S.data;
  if (D.studioMode) { if (name !== D.preview) rpc("SetCurrentPreviewScene", { sceneName: name }); return; }
  directProgram(name);
}

/** Straight to program using the selected effect (this is what the PGM bus does). */
function directProgram(name) {
  const D = S.data;
  if (name === D.program) return;
  S.arming = name;
  renderScenes(); renderSwitcher();
  setTimeout(() => { if (S.arming === name) { S.arming = null; renderScenes(); renderSwitcher(); } }, 2500);
  rpc("SetCurrentProgramScene", { sceneName: name });
}

// ---------------------------------------------------------------------------
// Switcher: PGM/PVW buses, effect + rate, stage meter, CUT / AUTO and a manual T-bar
// ---------------------------------------------------------------------------

const RATES = [250, 500, 1000, 2000];
/** What a transition does. The agent reports it (OBS names are localised); the name is only a fallback. */
const kindOfT = (name) => S.data?.transitionKinds?.[name] ?? kindOf(name);
let tbDrag = false;
let stagesSig = "";
let namesSig = "";
let meterRaf = 0;

function setDur(v) {
  if (!Number.isFinite(v)) return;
  v = clamp(Math.round(v), 50, 20000);
  S.data.duration = v;
  renderSwitcher();
  rpc("SetCurrentSceneTransitionDuration", { transitionDuration: v });
}

function renderSwitcher() {
  const D = S.data;
  if (!D) return;
  const on = D.studioMode;
  $("#swStudio").setAttribute("aria-pressed", String(on));
  for (const id of ["monPvw", "xcol", "studioRow"]) $("#" + id).hidden = !on;
  $("#p-preview").classList.toggle("is-studio", on);
  $("#pgmCap").textContent = on ? "Program" : "Preview";
  $("#swHint").textContent = on ? "" : "Studio Mode is off: clicking a scene goes straight to the screen using this transition.";

  const busy = !!S.tr || S.tbar > 0;
  const bus = (el, current, pick, arming, locked) => el.replaceChildren(...D.scenes.map((n) =>
    h("button", { class: (n === current ? "on " : "") + (arming && S.arming === n ? "arming" : ""), "aria-pressed": String(n === current), disabled: locked, onclick: () => pick(n) }, n)));
  bus($("#busPgm"), D.program, directProgram, true, S.tbar > 0);
  // PVW can't change while a transition is running or the T-bar is part-way (OBS refuses it too).
  bus($("#busPvw"), D.preview, (n) => { if (n !== D.preview) rpc("SetCurrentPreviewScene", { sceneName: n }); }, false, busy || !on);

  const sel = $("#trSel");
  const sig = D.transitions.join("");
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.replaceChildren(...D.transitions.map((t) => h("option", { value: t }, t)));
  }
  sel.value = D.transition;
  $("#fxRates").replaceChildren(...RATES.map((ms) =>
    h("button", { role: "radio", "aria-checked": String(ms === D.duration), onclick: () => setDur(ms) }, `${ms / 1000} s`)));
  if (document.activeElement !== $("#durIn")) $("#durIn").value = D.duration;

  $("#btnCut").disabled = !on || busy;
  $("#btnAuto").disabled = !on || busy;
  $("#tbCancel").hidden = !(on && S.tbar > 0 && !tbDrag);
  $("#tbar").setAttribute("aria-disabled", String(!on || !!S.tr));
  buildStages();
  paintMeter();
  easy.render();
}

function buildStages() {
  const D = S.data;
  const kind = S.tr?.kind ?? kindOfT(D.transition);
  if (stagesSig === kind) return;
  stagesSig = kind;
  const bar = $("#stgBar");
  const head = $(".stg-head", bar);
  bar.replaceChildren(...STAGES[kind].map((st, i) => {
    const seg = h("div", { class: "stg" + (kind === "dip" && i === 1 ? " later" : "") }, h("i", { class: "stg-fill" }), h("span", {}, st.label));
    seg.style.flexGrow = String(st.w);
    return seg;
  }), head);
}

/** Position 0..1 of whatever is mixing: an automatic transition (time based) or the T-bar. */
function mixPos() {
  if (S.tr) return clamp((Date.now() - S.skew - S.tr.start) / S.tr.duration, 0, 1);
  return S.tbar;
}

function paintMeter() {
  const D = S.data;
  if (!D) return;
  const running = !!S.tr || S.tbar > 0 || tbDrag;
  const p = mixPos();
  const box = $("#stages");
  easy.progress(running ? p : null);
  box.classList.toggle("run", running);
  box.style.setProperty("--tp", p.toFixed(4));
  const kind = S.tr?.kind ?? kindOfT(D.transition);
  let a = 0;
  let current = "";
  $$(".stg", box).forEach((seg, i) => {
    const w = STAGES[kind][i]?.w ?? 1;
    const f = running ? clamp((p - a) / w, 0, 1) : 0;
    $(".stg-fill", seg).style.width = (f * 100).toFixed(1) + "%";
    const on = running && p >= a && p < a + w;
    seg.classList.toggle("on", on);
    seg.classList.toggle("done", running && p >= a + w);
    if (on) current = STAGES[kind][i].label;
    a += w;
  });
  const names = running ? `A ${S.tr?.from ?? D.program} → B ${S.tr?.to ?? D.preview}` : `PGM ${D.program} · PVW ${D.preview}`;
  if (names !== namesSig) { namesSig = names; $("#stgNames").textContent = names; }
  $("#stgPct").textContent = running ? `${Math.round(p * 100)}%${current ? " · " + current : ""}` : "idle";
  const tb = $("#tbar");
  tb.style.setProperty("--p", S.tbar.toFixed(4));
  tb.setAttribute("aria-valuenow", String(Math.round(S.tbar * 100)));
}

/** Animate the meter while an automatic transition runs. */
function runMeter() {
  if (meterRaf || !S.tr) return;
  const tick = () => {
    meterRaf = 0;
    if (!S.tr) return;
    paintMeter();
    // Safety net: if the "ended" event is lost, don't leave the meter hanging.
    if (Date.now() - S.skew - S.tr.start > S.tr.duration + 1500) { S.tr = null; renderSwitcher(); return; }
    meterRaf = requestAnimationFrame(tick);
  };
  meterRaf = requestAnimationFrame(tick);
}

function setTbar(pos) {
  S.tbar = clamp(pos, 0, 1);
  paintMeter();
  stream("tbar", "SetTBarPosition", { position: S.tbar, release: false });
}

function endTbar() {
  flush("tbar");
  holds.set("tbar", performance.now() + 600);
  if (S.tbar >= 0.97) { S.tbar = 0; rpc("SetTBarPosition", { position: 1, release: true }); }      // reached the end: complete
  else if (S.tbar <= 0.03) { S.tbar = 0; rpc("SetTBarPosition", { position: 0, release: true }); } // back home: cancel
  renderSwitcher();
}

/** Relative drag like the faders (no jump on touch), keyboard arrows, End = complete, Home = cancel. */
function bindTbar() {
  const el = $("#tbar");
  let st = null;
  el.addEventListener("pointerdown", (e) => {
    if (el.getAttribute("aria-disabled") === "true" || (e.pointerType === "mouse" && e.button !== 0)) return;
    const rect = el.getBoundingClientRect();
    const knob = $(".tb-knob", el).getBoundingClientRect().width;
    st = { id: e.pointerId, len: rect.width - knob || 1, last: e.clientX, x0: e.clientX, y0: e.clientY, active: e.pointerType !== "touch" };
    el.setPointerCapture(e.pointerId);
    if (st.active) { tbDrag = true; holds.set("tbar", Infinity); el.classList.add("drag"); }
  });
  el.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id) return;
    if (!st.active) {
      const ax = Math.abs(e.clientX - st.x0), ay = Math.abs(e.clientY - st.y0);
      if (ax > 6 && ax > ay) { st.active = true; st.last = e.clientX; tbDrag = true; holds.set("tbar", Infinity); el.classList.add("drag"); } else return;
    }
    const fine = detail() === "full" && Math.abs(e.clientY - st.y0) > 70;
    setTbar(S.tbar + ((e.clientX - st.last) / st.len) * (fine ? 0.2 : 1));
    st.last = e.clientX;
  });
  const end = () => {
    if (!st) return;
    const was = st.active;
    st = null;
    el.classList.remove("drag");
    if (was) { tbDrag = false; endTbar(); }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.2 : 0.05;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") setTbar(S.tbar + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") setTbar(S.tbar - step);
    else if (e.key === "End") S.tbar = 1;
    else if (e.key === "Home") S.tbar = 0;
    else return;
    e.preventDefault();
    endTbar();
  });
}

// ---------------------------------------------------------------------------
// Mixer
// ---------------------------------------------------------------------------

const chRefs = new Map();
const isPinned = (n) => prefs.pins?.includes(n);

/** Like OBS's mixer: global devices plus sources used by the scene on air. Full lists everything. */
function inProgram(inp) {
  const D = S.data;
  return isPinned(inp.name) || inp.pinned || (D.items[D.program] || []).some((it) => it.name === inp.name);
}

function renderMixer() {
  const D = S.data;
  if (!D) return;
  const box = $("#mixer");
  chRefs.clear();
  const full = detail() === "full";
  const list = D.inputs.filter((i) => full || inProgram(i));
  box.replaceChildren(...(list.length ? list.map(buildChannel) : [h("p", { class: "empty" }, "No audio sources in this scene")]));
  list.forEach(paintCh);
  updateMixerMode();
}

function buildChannel(inp) {
  const name = inp.name;
  const fader = h("div", { class: "fader", role: "slider", tabindex: "0", "aria-label": `${name} volume`, "aria-valuemin": String(DB_MIN), "aria-valuemax": String(DB_MAX) },
    h("div", { class: "fill" }), h("div", { class: "tick" }),
    h("div", { class: "vu" }, h("i", { class: "l" }), h("i", { class: "r" }), h("b")),
    h("div", { class: "thumb" }));
  const db = h("span", { class: "db" });
  const badge = h("span", { class: "bdg", hidden: true });
  const mute = h("button", { class: "mute", "aria-label": `Mute ${name}`, "aria-pressed": "false", onclick: () => toggleMute(inp) }, icon("volume"), h("span", { class: "mt" }, "MUTE"));
  const dbin = h("input", { class: "dbin", inputmode: "decimal", "aria-label": `${name} dB`, onchange: (e) => typeDb(inp, e.target.value) });
  dbin.addEventListener("focus", () => dbin.select());
  const pin = h("button", { class: "pin", "aria-label": `Pin ${name}`, onclick: () => togglePin(name) }, icon("star"));
  const ext = h("div", { class: "ext full-only" }, dbin,
    h("div", { class: "row2" }, h("button", { "aria-label": "Down 1 dB", onclick: () => nudge(inp, -1) }, "−1"), h("button", { "aria-label": "Up 1 dB", onclick: () => nudge(inp, 1) }, "+1")), pin);
  const root_ = h("div", { class: "ch" }, mute,
    h("div", { class: "meta" }, h("span", { class: "nm" }, icon(kindIcon(inp.kind)), name), badge, db), fader, ext);
  chRefs.set(name, { root: root_, fader, db, dbin, mute, pin, badge, pk: 0, pkAt: 0 });
  bindFader(fader, inp);
  return root_;
}

function paintCh(inp) {
  const r = chRefs.get(inp.name);
  if (!r) return;
  r.fader.style.setProperty("--p", dbToPos(inp.volumeDb).toFixed(4));
  r.fader.setAttribute("aria-valuenow", inp.volumeDb.toFixed(1));
  r.fader.setAttribute("aria-valuetext", fmtDb(inp.volumeDb) + " dB");
  r.db.textContent = fmtDb(inp.volumeDb) + " dB";
  if (document.activeElement !== r.dbin) r.dbin.value = inp.volumeDb <= -99 ? "−∞" : inp.volumeDb.toFixed(1);
  r.root.classList.toggle("muted", inp.muted);
  r.root.classList.toggle("dimmed", !inProgram(inp));
  r.mute.setAttribute("aria-pressed", String(inp.muted));
  r.pin.setAttribute("aria-pressed", String(isPinned(inp.name)));
  // Like OBS: blue "Global" for desktop/mic devices, green "Preview" for sources only in the preview scene.
  const D = S.data;
  const inPvw = D.studioMode && (D.items[D.preview] || []).some((it) => it.name === inp.name) && !(D.items[D.program] || []).some((it) => it.name === inp.name);
  const tag = inp.pinned ? "Global" : inPvw ? "Preview" : "";
  r.badge.hidden = !tag;
  r.badge.textContent = tag;
  r.badge.className = "bdg " + (tag === "Preview" ? "pvw" : "glob");
}

function setDb(inp, db) {
  db = Math.round(clamp(db, -100, DB_MAX) * 10) / 10;
  if (db === inp.volumeDb) return;
  inp.volumeDb = db;
  paintCh(inp);
  stream("vol:" + inp.name, "SetInputVolume", { inputName: inp.name, inputVolumeDb: db });
}

function release(inp) {
  const ctl = "vol:" + inp.name;
  flush(ctl);
  holds.set(ctl, performance.now() + 500); // let OBS's echo of our last value settle before listening again
}

function nudge(inp, d) { setDb(inp, Math.max(-60, inp.volumeDb) + d); release(inp); }
function typeDb(inp, text) {
  const t = text.replace("−", "-").trim();
  const v = /inf|∞/i.test(t) ? -100 : parseFloat(t);
  if (Number.isNaN(v)) return paintCh(inp);
  setDb(inp, v);
  release(inp);
  paintCh(inp);
}
function toggleMute(inp) {
  inp.muted = !inp.muted;
  holds.set("mute:" + inp.name, performance.now() + 500);
  paintCh(inp);
  rpc("SetInputMute", { inputName: inp.name, inputMuted: inp.muted });
}
function togglePin(name) {
  const set = new Set(prefs.pins);
  set.has(name) ? set.delete(name) : set.add(name);
  prefs.pins = [...set];
  store.set(PREFS, prefs);
  chRefs.forEach((_, n) => paintCh(S.data.inputs.find((i) => i.name === n)));
}

/** Drag handling: relative movement (no accidental jumps), 6px dead-zone for touch so list scrolling still works,
 *  and "fine" mode (5x slower) when the finger/pointer is held well away from the fader. */
function bindFader(el, inp) {
  const ctl = "vol:" + inp.name;
  let st = null;
  const begin = () => { st.active = true; el.classList.add("drag"); holds.set(ctl, Infinity); };
  const end = () => {
    if (!st) return;
    const was = st.active;
    st = null;
    el.classList.remove("drag", "hot");
    if (was) release(inp);
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    const th = $(".thumb", el).getBoundingClientRect();
    const vertical = rect.height > rect.width;
    const len = (vertical ? rect.height - th.height : rect.width - th.width) || 1;
    const coord = vertical ? -e.clientY : e.clientX;
    st = { id: e.pointerId, vertical, len, rect, pos: dbToPos(inp.volumeDb), c0: coord, last: coord, x0: e.clientX, y0: e.clientY, active: false };
    el.setPointerCapture(e.pointerId);
    if (e.pointerType !== "touch") {
      // mouse / pen: click on the track jumps there
      const frac = vertical ? (rect.bottom - e.clientY - th.height / 2) / len : (e.clientX - rect.left - th.width / 2) / len;
      st.pos = clamp(frac, 0, 1);
      begin();
      setDb(inp, posToDb(st.pos));
    }
  });
  el.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id) return;
    const coord = st.vertical ? -e.clientY : e.clientX;
    if (!st.active) {
      const along = Math.abs(coord - st.c0);
      const across = Math.abs(st.vertical ? e.clientX - st.x0 : e.clientY - st.y0);
      if (along > 6 && along > across) { begin(); st.last = coord; } else return;
    }
    const r = st.rect;
    const away = st.vertical ? Math.max(r.left - e.clientX, e.clientX - r.right, 0) : Math.max(r.top - e.clientY, e.clientY - r.bottom, 0);
    const fine = detail() === "full" && away > 60;
    el.classList.toggle("hot", fine);
    st.pos = clamp(st.pos + ((coord - st.last) / st.len) * (fine ? 0.2 : 1), 0, 1);
    st.last = coord;
    setDb(inp, posToDb(st.pos));
  });
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 3 : e.altKey ? 0.1 : 0.5;
    const cur = Math.max(-60, inp.volumeDb);
    const to = { ArrowRight: cur + step, ArrowUp: cur + step, ArrowLeft: cur - step, ArrowDown: cur - step, PageUp: cur + 6, PageDown: cur - 6, Home: -100, End: DB_MAX }[e.key];
    if (to == null) return;
    e.preventDefault();
    setDb(inp, to);
    release(inp);
  });
  el.addEventListener("dblclick", () => { if (detail() === "full") { setDb(inp, 0); release(inp); } });
}

function paintLevels(lv) {
  if (document.hidden) return;
  const now = performance.now();
  for (const [name, [l, r]] of Object.entries(lv)) {
    const ref = chRefs.get(name);
    if (!ref) continue;
    const pl = linToPos(l), pr = linToPos(r), peak = Math.max(pl, pr);
    if (peak >= ref.pk || now - ref.pkAt > 1200) { ref.pk = peak; ref.pkAt = now; }
    ref.fader.style.setProperty("--l", pl.toFixed(3));
    ref.fader.style.setProperty("--r", pr.toFixed(3));
    ref.fader.style.setProperty("--pk", ref.pk.toFixed(3));
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function renderSources() {
  const D = S.data;
  if (!D) return;
  const scene = S.viewScene && D.scenes.includes(S.viewScene) ? S.viewScene : D.program;
  $("#sceneChips").replaceChildren(...D.scenes.map((n) =>
    h("button", { role: "tab", class: n === D.program ? "pgm" : "", "aria-selected": String(n === scene), onclick: () => { S.viewScene = n === D.program ? null : n; renderSources(); } }, n)));
  const items = D.items[scene] || [];
  const mkTg = (cls, ic, label, pressed, fn) => h("button", { class: "tg " + cls, "aria-label": label, "aria-pressed": String(pressed), onclick: fn }, icon(ic));
  $("#srcList").replaceChildren(...(items.length ? items.map((it) =>
    h("div", { class: "src" + (it.enabled ? "" : " off") },
      h("span", { class: "sic" }, icon(sourceIcon(it.kind))),
      h("span", { class: "nm" }, it.name),
      mkTg("eye", "eye", `${it.name} visible`, it.enabled, () => {
        it.enabled = !it.enabled;
        renderSources();
        rpc("SetSceneItemEnabled", { sceneName: scene, sceneItemId: it.id, sceneItemEnabled: it.enabled });
      }),
      mkTg("lk", "lock", `${it.name} locked`, !!it.locked, () => {
        it.locked = !it.locked;
        renderSources();
        rpc("SetSceneItemLocked", { sceneName: scene, sceneItemId: it.id, sceneItemLocked: it.locked });
      }))) : [h("p", { class: "empty" }, "No sources in this scene")]));
}

// ---------------------------------------------------------------------------
// Outputs + health
// ---------------------------------------------------------------------------

function renderOutputs() {
  const D = S.data;
  if (!D) return;
  const { stream: st, record: rc, replay: rp, stats } = D;

  const os = $("#outStream");
  os.classList.toggle("on", st.active);
  setBtn($("[data-k=btn]", os), "live", st.active ? "Stop Streaming" : "Start Streaming", st.active ? "anim" : "");
  $("[data-k=foot]", os).textContent = st.active ? `${Math.round(stats.kbps)} kbps · dropped ${st.dropped} frames · hold to stop` : "Press and hold to go live";

  const or = $("#outRecord");
  or.classList.toggle("on", rc.active);
  setBtn($("[data-k=btn]", or), rc.active ? "stop" : "record", rc.active ? "Stop Recording" : "Start Recording", rc.active && !rc.paused ? "anim" : "");
  setBtn($("[data-k=pause]", or), rc.paused ? "play" : "pause", rc.paused ? "Resume" : "Pause");
  $("[data-k=pause]", or).hidden = !rc.active;
  $("[data-k=foot]", or).textContent = rc.active ? `${(rc.bytes / 1e6).toFixed(0)} MB · ${stats.diskGb.toFixed(0)} GB free · hold to stop` : `${stats.diskGb.toFixed(0)} GB free`;

  const orp = $("#outReplay");
  setBtn($("[data-k=btn]", orp), "replay", rp.active ? "Stop Replay Buffer" : "Start Replay Buffer", rp.active ? "anim" : "");
  setBtn($("[data-k=save]", orp), "save", "Save Replay");
  $("[data-k=save]", orp).disabled = !rp.active;
  updateTimes();
}

const TILES = [
  ["cpu", "CPU", "%", (s) => s.cpu.toFixed(0), (s) => (s.cpu > 90 ? "bad" : s.cpu > 70 ? "warn" : ""), "cpu"],
  ["fps", "FPS", "", (s) => s.fps.toFixed(0), () => ""],
  ["drop", "Dropped", "%", (s) => s.dropPct.toFixed(1), (s) => (s.dropPct > 5 ? "bad" : s.dropPct > 1 ? "warn" : "")],
  ["kbps", "Bitrate", "kbps", (s) => Math.round(s.kbps), () => "", "kbps"],
  ["disk", "Disk free", "GB", (s) => s.diskGb.toFixed(0), (s) => (s.diskGb < 10 ? "bad" : s.diskGb < 30 ? "warn" : "")],
  ["mem", "Memory", "MB", (s) => Math.round(s.memMb), () => ""],
  ["render", "Render", "ms", (s) => s.renderMs.toFixed(1), (s) => (s.renderMs > 12 ? "warn" : ""), null, true],
];
const TILE_ICON = { cpu: "cpu", fps: "fps", drop: "drop", kbps: "bitrate", disk: "disk", mem: "memory", render: "render" };
const tileRefs = {};
const SVGNS = "http://www.w3.org/2000/svg";

function renderStats() {
  const D = S.data;
  if (!D) return;
  const box = $("#stats");
  if (!box.children.length) {
    for (const [id, label, unit, , , spark, fullOnly] of TILES) {
      const v = h("div", { class: "v" });
      const el = h("div", { class: "stat" + (fullOnly ? " full-only" : "") }, h("div", { class: "k" }, icon(TILE_ICON[id]), label), v);
      if (spark) {
        const svg = document.createElementNS(SVGNS, "svg");
        svg.setAttribute("viewBox", "0 0 60 20");
        svg.setAttribute("preserveAspectRatio", "none");
        const pl = document.createElementNS(SVGNS, "polyline");
        svg.append(pl);
        el.append(svg);
        tileRefs[id] = { el, v, unit, pl };
      } else tileRefs[id] = { el, v, unit };
      box.append(el);
    }
  }
  for (const [id, , , fmt, cls, spark] of TILES) {
    const r = tileRefs[id];
    r.v.replaceChildren(String(fmt(D.stats)), h("small", {}, r.unit));
    r.el.className = "stat " + cls(D.stats) + (r.el.classList.contains("full-only") ? " full-only" : "");
    if (spark && r.pl) {
      const a = S.hist[spark];
      const max = Math.max(...a, spark === "cpu" ? 50 : 1);
      r.pl.setAttribute("points", a.map((v, i) => `${i},${(20 - (v / max) * 18).toFixed(1)}`).join(" "));
    }
  }
}

function renderStatusBar() {
  const D = S.data;
  if (!D) return;
  const st = D.stats;
  $("#stCpu").textContent = `CPU: ${st.cpu.toFixed(1)}%, ${st.fps.toFixed(2)} fps`;
  $("#stNet").textContent = D.stream.active ? `${Math.round(st.kbps)} kb/s` : "";
  $("#stDrop").textContent = D.stream.active ? `Dropped Frames ${D.stream.dropped} (${st.dropPct.toFixed(1)}%)` : "";
  $("#stLink").textContent = S.linkOpen || link.demo ? (diag.rtt != null ? `${diag.rtt} ms` : "") : "reconnecting";
}

function pushHist() {
  const { cpu, kbps } = S.data.stats;
  for (const [k, v] of [["cpu", cpu], ["kbps", kbps]]) {
    S.hist[k].push(v);
    if (S.hist[k].length > 60) S.hist[k].shift();
  }
}

// ---------------------------------------------------------------------------
// Preview frames
// ---------------------------------------------------------------------------

const cur = [{ url: "", img: "#pvImg", scr: "#scrPgm" }, { url: "", img: "#pvImgB", scr: "#scrPvw" }];
let lastFrameAt = 0, previewSent = null;
/** A frame is one channel byte (0 = program, 1 = preview) followed by a JPEG/PNG/SVG image. */
const imgType = (b) => (b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x89 ? "image/png" : "image/svg+xml");
function showFrame(buf) {
  if (buf.byteLength < 9) return;
  diag.frames++;
  diag.frameBytes += buf.byteLength;
  const chb = new Uint8Array(buf, 0, 1)[0];
  if (chb === 2) { // scene thumbnail for Present mode: [2][name length][name][image]
    const n = new Uint8Array(buf, 1, 1)[0];
    if (buf.byteLength < 3 + n + 4) return;
    const name = new TextDecoder().decode(new Uint8Array(buf, 2, n));
    const img = buf.slice(2 + n);
    easy.thumb(name, URL.createObjectURL(new Blob([img], { type: imgType(new Uint8Array(img, 0, 4)) })));
    return;
  }
  const ch = chb === 1 ? 1 : 0;
  const type = imgType(new Uint8Array(buf, 1, 4));
  const c = cur[ch];
  const url = URL.createObjectURL(new Blob([buf.slice(1)], { type }));
  easy.frame(ch, url);
  const prev = c.url;
  c.url = url;
  $(c.img).src = url;
  if (prev) setTimeout(() => URL.revokeObjectURL(prev), 1500);
  $(c.scr).classList.add("has");
  lastFrameAt = Date.now();
}

/** Only ask OBS for frames while a preview is actually on screen. */
function syncPreview() {
  const mx = $(".panel.max");
  const tab = $("#panels").dataset.tab;
  const easyOn = root.dataset.mode === "easy";
  root.dataset.preview = prefs.preview;
  const visible = prefs.preview !== "off" && !document.hidden && (easyOn || (mx ? mx.id === "p-preview" : layout() === "wide" || tab === "scenes" || tab === "switch"));
  const want = visible && (S.linkOpen || !!link.demo);
  const rate = prefs.preview === "eco" ? "eco" : prefs.preview === "max" ? "max" : "live";
  const sig = `${want}${want && easyOn}${rate}`; // thumbnails only while the Present view is showing
  if (sig === previewSent) return;
  previewSent = sig;
  $$(".screen .off, .ez-screen .off").forEach((el) => (el.textContent = prefs.preview === "off" ? "preview off" : "no preview"));
  link.send({ type: "sub", preview: want, thumbs: want && easyOn, rate });
}

// ---------------------------------------------------------------------------
// Sharing (owner only): invite codes and the device list
// ---------------------------------------------------------------------------

function showInvite(m) {
  $("#inviteOut").hidden = false;
  $("#inviteCode").textContent = `${String(m.room).toUpperCase()}-${m.code}`;
  $("#inviteLink").value = `${location.origin}${location.pathname}#pair=${m.room}-${m.code}`;
  $("#inviteHint").textContent = `${m.role === "viewer" ? "View only" : "Can control"} · valid 5 minutes, works once.`;
}

function renderDevices() {
  const ul = $("#deviceList");
  ul.replaceChildren(...S.devices.map((d) => h("li", {},
    h("span", { class: "dot", "data-s": d.online ? "ok" : "" }),
    h("span", { class: "name" }, d.name),
    h("span", { class: "tag" }, d.role === "viewer" ? "view" : d.role === "operator" ? "control" : "owner"),
    d.cid === link.auth?.cid ? null : h("button", { type: "button", onclick: () => { if (confirm(`Remove ${d.name}?`)) link.send({ type: "revoke", cid: d.cid }); } }, "Remove"))));
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

function showPair(msg = "", adding = false) {
  if (!adding) link.close(); // adding another computer keeps the current one running behind the form
  $("#app").hidden = true;
  $("#pair").hidden = false;
  $("#pairCancel").hidden = !(adding || machines.count());
  $("#pairInput").value = "";
  $("#pairErr").textContent = msg;
  $("#pairInput").focus();
}

function forget(msg) {
  const next = machines.remove(machines.activeRoom);
  link.close();
  link.auth = null;
  S.data = null;
  if (next) { toast("Removed. Switched to " + machines.label(next), "info"); switchActive(next); }
  else showPair(msg || "");
}

/** Another computer becomes the one the whole UI shows. */
function switchActive(m) {
  link.close();
  holds.clear(); pending.clear();
  S.data = null; S.obsOnline = false; S.linkOpen = false; S.devices = []; S.arming = null; S.tr = null;
  previewSent = null;
  easy.reset();
  $("#obsName").textContent = machines.label(m);
  $("#pair").hidden = true;
  start({ room: m.room, token: m.token, cid: m.cid });
}

async function doPair(raw) {
  // Room (10 characters) then code (12 characters); dashes, spaces and case don't matter.
  const flat = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  const m = flat.match(/^([a-z2-7]{10})([a-z0-9]{12})$/);
  const err = $("#pairErr");
  if (!m) { err.textContent = "That doesn't look right. Expected the 22 characters shown under the QR code."; return; }
  m[2] = m[2].toUpperCase();
  err.textContent = "";
  const ua = navigator.userAgent;
  const name = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Browser";
  try {
    const res = await fetch("/api/pair", { method: "POST", body: JSON.stringify({ room: m[1], code: m[2], name }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = { bad_code: "Wrong code.", no_code: "That code expired. Generate a new one in the OBS dock.", locked: "Too many wrong tries. Generate a new code in the OBS dock." }[j.error] ?? "Pairing failed.";
      return;
    }
    const auth = { room: m[1], token: j.clientToken, cid: j.cid };
    const adding = machines.count() > 0;
    machines.add(auth);
    if (adding) switchActive(auth); else start(auth);
  } catch {
    err.textContent = "Can't reach the relay.";
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function start(auth) {
  $("#pair").hidden = true;
  $("#app").hidden = false;
  link.auth = auth;
  link.hello = false;
  link.tries = 0;
  refreshConn();
  link.open();
}

async function startDemo() {
  const { createSim } = await import("./sim.js");
  const lag = Number(params.get("lag")) || 40;
  const sim = createSim((m) => {
    if (m instanceof ArrayBuffer && !previewSent?.startsWith("true")) return;
    setTimeout(() => onMessage(m instanceof ArrayBuffer ? m : JSON.stringify(m)), lag / 2);
  });
  link.demo = { send: (m) => { if (m.type === "sub") sim.thumbs(m.thumbs); if (m.type === "req" || m.type === "sync") setTimeout(() => sim.handle(m.type === "sync" ? { type: "sync.request", cid: "demo" } : { ...m, cid: "demo" }), lag / 2); } };
  $("#pair").hidden = true;
  $("#app").hidden = false;
  S.linkOpen = true;
  onMessage(JSON.stringify({ type: "hello", role: "client", cid: "demo", obs: true }));
  sim.start();
  sim.sync("demo");
  if (params.has("stream")) { sim.handle({ type: "req", op: "StartStream", data: {}, id: "x" }); }
}

function bindUi() {
  setIcon($("#btnDisplay"), "display");
  mine.bind();
  $$(".expand").forEach((b) => {
    setIcon(b, "expand");
    b.addEventListener("click", () => {
      const p = b.closest(".panel");
      const on = !p.classList.contains("max");
      $$(".panel.max").forEach((x) => { x.classList.remove("max"); setIcon($(".expand", x), "expand"); $(".expand", x).setAttribute("aria-label", "Enlarge panel"); });
      if (on) { p.classList.add("max"); setIcon(b, "close"); b.setAttribute("aria-label", "Close"); }
      document.body.classList.toggle("lock", on);
      updateMixerMode(); syncPreview();
      if (on) window.scrollTo(0, 0);
    });
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") $(".panel.max .expand")?.click(); });

  $$("#tabs button").forEach((b) => b.addEventListener("click", () => {
    $("#panels").dataset.tab = b.dataset.tab;
    $$("#tabs button").forEach((x) => (x === b ? x.setAttribute("aria-current", "page") : x.removeAttribute("aria-current")));
    window.scrollTo(0, 0);
    syncPreview();
  }));

  $("#btnMode").addEventListener("click", () => setMode("easy"));
  const pvToggle = () => { prefs.preview = prefs.preview === "off" ? (prefs.prevOn || "live") : (prefs.prevOn = prefs.preview, "off"); store.set(PREFS, prefs); paintPv(); syncPreview(); };
  for (const id of ["#btnPv", "#ezPv"]) { $(id).replaceChildren(icon("eye")); $(id).addEventListener("click", pvToggle); }
  paintPv();
  $("#ezMode").addEventListener("click", () => setMode("obs"));

  // Scenes tools
  $("#swStudio").addEventListener("click", () => rpc("SetStudioModeEnabled", { studioModeEnabled: !S.data.studioMode }));
  $("#trSel").addEventListener("change", (e) => { S.data.transition = e.target.value; renderSwitcher(); rpc("SetCurrentSceneTransition", { transitionName: e.target.value }); });
  $("#btnSettings").addEventListener("click", () => $("#btnDisplay").click());
  $("#btnInvite").addEventListener("click", () => link.send({ type: "invite", role: $("#inviteRole").value }));
  $("#btnCopyInvite").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("#inviteLink").value); toast("Link copied", "info", 1500); } catch { $("#inviteLink").select(); } });
  $("#btnAuto").addEventListener("click", () => rpc("StudioTake", {}));
  $("#btnCut").addEventListener("click", () => rpc("StudioTake", { transitionName: S.data.transitions.find((t) => kindOfT(t) === "cut") ?? "Cut", duration: 0 }));
  $("#tbCancel").addEventListener("click", () => { S.tbar = 0; renderSwitcher(); rpc("SetTBarPosition", { position: 0, release: true }); });
  bindTbar();
  $("#durIn").addEventListener("change", (e) => setDur(Number(e.target.value)));
  $("#durDn").addEventListener("click", () => setDur(S.data.duration - 50));
  $("#durUp").addEventListener("click", () => setDur(S.data.duration + 50));

  // Outputs
  bindHold($("#outStream [data-k=btn]"), () => rpc(S.data.stream.active ? "StopStream" : "StartStream", {}), () => true, 800);
  bindHold($("#outRecord [data-k=btn]"), () => rpc(S.data.record.active ? "StopRecord" : "StartRecord", {}), () => S.data.record.active, 800);
  $("#outRecord [data-k=pause]").addEventListener("click", () => rpc("ToggleRecordPause", {}));
  $("#outReplay [data-k=btn]").addEventListener("click", () => rpc(S.data.replay.active ? "StopReplayBuffer" : "StartReplayBuffer", {}));
  $("#outReplay [data-k=save]").addEventListener("click", () => rpc("SaveReplayBuffer", {}));

  // Display preferences
  const dlg = $("#display");
  const reflect = () => $$(".seg").forEach((seg) => $$("button", seg).forEach((b) => b.setAttribute("aria-pressed", String(prefs[seg.dataset.pref] === b.dataset.v))));
  $("#btnDisplay").addEventListener("click", () => { reflect(); fillSceneToggles(); fillDiag(); dlg.showModal(); });
  $("#btnShowAll").addEventListener("click", () => { prefs.hidden = []; store.set(PREFS, prefs); fillSceneToggles(); easy.render(); });
  $("#btnCopyDiag").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(diagText()); toast("Diagnostics copied", "info", 1600); }
    catch { $("#diagOut").focus(); toast("Select the text and copy it manually", "info"); }
  });
  $$(".seg button").forEach((b) => b.addEventListener("click", () => {
    prefs[b.closest(".seg").dataset.pref] = b.dataset.v;
    store.set(PREFS, prefs);
    reflect();
    applyLayout();
    paintPv();
  }));
  const forgetBtn = $("#btnForget");
  setBtn(forgetBtn, "trash", "Hold to forget device");
  bindHold(forgetBtn, () => { dlg.close(); forget(); }, () => true, 1000);

  // Pairing form
  $("#pairForm").addEventListener("submit", (e) => { e.preventDefault(); doPair($("#pairInput").value); });
  $("#pairCancel").addEventListener("click", () => { $("#pair").hidden = true; if (machines.active()) $("#app").hidden = false; syncPreview(); });
  $("#btnAddMachine").addEventListener("click", () => { $("#display").close(); showPair("", true); });

  // Lifecycle
  let rz = 0;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(applyLayout, 120); });
  document.addEventListener("visibilitychange", () => {
    syncPreview();
    if (!document.hidden) { link.reconnectNow(); if (S.linkOpen) link.send({ type: "sync" }); }
  });
  addEventListener("online", () => link.reconnectNow());
  setInterval(updateTimes, 1000);
}

/** Tick = this screen is a button in Present view. */
function fillSceneToggles() {
  const box = $("#sceneToggles");
  const scenes = S.data?.scenes ?? [];
  if (!scenes.length) { box.replaceChildren(h("p", { class: "hint" }, "Connect to OBS to see your screens.")); return; }
  box.replaceChildren(...scenes.map((n) => h("label", {},
    h("input", { type: "checkbox", checked: !prefs.hidden.includes(n) ? true : null, onchange: (e) => {
      prefs.hidden = e.target.checked ? prefs.hidden.filter((x) => x !== n) : [...prefs.hidden, n];
      store.set(PREFS, prefs);
      easy.render();
    } }), n)));
}

function diagText() {
  const D = S.data;
  const up = Math.round((Date.now() - diag.start) / 1000);
  return [
    `OBS Remote UI   ${new Date().toISOString()}`,
    `mode            ${link.demo ? "demo" : "relay"}  layout=${layout()} detail=${detail()} size=${prefs.size}`,
    `screen          ${innerWidth}x${innerHeight} @${devicePixelRatio}x  ${navigator.maxTouchPoints ? "touch" : "no touch"}`,
    `link            ${S.linkOpen ? "open" : "closed"}  obs=${S.obsOnline ? "online" : "offline"}  relay rtt=${diag.rtt ?? "-"} ms`,
    `obs round trip  ${diag.rpcMs == null ? "-" : diag.rpcMs.toFixed(0) + " ms"} (smoothed)  requests=${diag.rpcN} failed=${diag.rpcFail}`,
    `messages        ${diag.msgs}  preview frames=${diag.frames} (${(diag.frameBytes / 1024).toFixed(0)} KB)`,
    `reconnects      ${diag.reconnects}  last close=${diag.lastClose || "-"}`,
    `last error      ${diag.lastErr || "-"}`,
    `state           ${D ? `${D.scenes.length} scenes, ${D.inputs.length} inputs, program="${D.program}", switcher=${D.studioMode}, transition=${D.transition} ${D.duration}ms` : "no snapshot yet"}`,
    `uptime          ${up}s   skew=${S.skew} ms`,
    `ua              ${navigator.userAgent}`,
  ].join("\n");
}
const fillDiag = () => ($("#diagOut").textContent = diagText());

// Anything unexpected becomes a visible toast and a log line instead of a silent dead control.
addEventListener("error", (e) => { diag.lastErr = `${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`; toast("Something went wrong: " + e.message); logEv(diag.lastErr, "err"); });
addEventListener("unhandledrejection", (e) => { diag.lastErr = String(e.reason?.message ?? e.reason); toast("Something went wrong: " + diag.lastErr); logEv(diag.lastErr, "err"); });
if (params.has("debug")) window.__obsr = { S, link, diag, prefs, rpc, holds, get easy() { return easy; } };

const easy = createEasy({ S, $, $$, h, icon, rpc, toast, bindHold, kindOfT, setBtn, hydrate, directProgram, setDur, prefs });
const mine = createButtons({ S, $, h, icon, rpc, toast, bindHold });
const machines = createMachines({
  store, h, $, toast,
  getActiveInfo: () => ({ state: $("#connDot").dataset.s || "wait", program: S.data?.program, live: !!S.data?.stream?.active }),
  onSwitch: (m) => switchActive(m),
  onAdd: () => showPair("", true),
});
hydrate();
bindUi();
applyLayout();

if (params.has("demo")) startDemo();
else {
  machines.load();
  const saved = machines.active();
  const hashPair = location.hash.match(/pair=([^&]+)/)?.[1];
  if (saved?.room && saved?.token && !hashPair) start(saved);
  else {
    showPair();
    if (hashPair) {
      history.replaceState(null, "", location.pathname);
      $("#pairInput").value = decodeURIComponent(hashPair).toUpperCase();
      doPair(decodeURIComponent(hashPair));
    }
  }
}
