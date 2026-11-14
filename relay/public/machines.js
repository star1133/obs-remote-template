// Several OBS computers in one controller.
// The active computer gets the full UI over `link`. Every other computer keeps a light connection of its own
// (status only, no pictures) so its chip shows what it is doing, and can "mirror" the active computer's commands.

const KEY = "obsr.machines", LEGACY = "obsr.auth";

/** Commands worth repeating on a mirrored computer. Volume, mute and per-source toggles stay local (names differ per PC). */
const MIRRORED = new Set([
  "SetCurrentProgramScene", "SetCurrentPreviewScene", "StudioTake", "TriggerStudioModeTransition", "SetStudioModeEnabled",
  "SetCurrentSceneTransition", "SetCurrentSceneTransitionDuration", "StartStream", "StopStream", "StartRecord", "StopRecord",
  "ToggleRecordPause", "TriggerMediaInputAction", "PresentKey", "SaveReplayBuffer",
  "SetSourceVisible", "SetFilterState", "SetMuteState", "SetText", "TriggerHotkeyByName",
]);

class Peer {
  constructor(m, onChange) {
    this.m = m;
    this.onChange = onChange;
    this.ws = null; this.tries = 0; this.timer = 0; this.poll = 0; this.ping = 0;
    this.open_ = false; this.obs = false; this.program = ""; this.live = false; this.rec = false; this.gone = false;
    this.pending = new Map(); this.rid = 0; this.last = 0;
  }
  start() {
    if (this.ws || this.gone) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/client?room=${this.m.room}`, [`obsr.${this.m.token}`]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.last = Date.now();
      ws.send(JSON.stringify({ type: "sub", preview: false, thumbs: false }));
      ws.send(JSON.stringify({ type: "sync" }));
      clearInterval(this.poll); clearInterval(this.ping);
      this.poll = setInterval(() => this.send({ type: "sync" }), 4000);
      this.ping = setInterval(() => { if (Date.now() - this.last > 45000) ws.close(); else if (ws.readyState === 1) ws.send("ping"); }, 8000);
    };
    ws.onmessage = (e) => {
      this.last = Date.now();
      if (typeof e.data !== "string" || e.data === "pong") return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "hello") { this.open_ = true; this.tries = 0; this.obs = !!m.obs; }
      else if (m.type === "presence") { this.obs = !!m.obs; if (m.obs) this.send({ type: "sync" }); }
      else if (m.type === "state.sync") {
        const d = m.data; this.obs = true;
        this.program = d.program ?? ""; this.live = !!d.stream?.active; this.rec = !!d.record?.active;
        if (d.obs?.name) this.onChange("name", this.m.room, d.obs.name);
      } else if (m.type === "res") {
        const p = this.pending.get(m.id);
        if (p) { clearTimeout(p.t); this.pending.delete(m.id); p.resolve(m); }
      }
      this.onChange("status");
    };
    ws.onclose = (e) => {
      clearInterval(this.poll); clearInterval(this.ping);
      if (this.ws !== ws) return;
      this.ws = null; this.open_ = false; this.obs = false;
      if (e.code === 4001) this.gone = true;
      this.onChange("status");
      if (!this.gone) this.timer = setTimeout(() => this.start(), Math.min(15000, 800 * 2 ** this.tries++));
    };
  }
  send(m) { if (this.ws?.readyState !== 1) return false; this.ws.send(JSON.stringify(m)); return true; }
  rpc(op, data) {
    const id = `m${++this.rid}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: "timeout" }); }, 2500);
      this.pending.set(id, { resolve, t });
      if (!this.send({ v: 1, type: "req", id, op, data })) { clearTimeout(t); this.pending.delete(id); resolve({ ok: false, error: "offline" }); }
    });
  }
  stop() {
    clearTimeout(this.timer); clearInterval(this.poll); clearInterval(this.ping);
    const ws = this.ws; this.ws = null; ws?.close();
  }
}

export function createMachines({ store, h, $, toast, getActiveInfo, onSwitch, onAdd }) {
  let st = { list: [], active: "", mirror: [] };
  const peers = new Map();

  function load() {
    const s = store.get(KEY);
    if (s?.list?.length) st = { mirror: [], ...s };
    else {
      const old = store.get(LEGACY); // a single pairing from before several computers were supported
      if (old?.room) st = { list: [{ ...old, name: "" }], active: old.room, mirror: [] };
    }
    save();
  }
  const save = () => store.set(KEY, st);
  const find = (room) => st.list.find((m) => m.room === room);
  const active = () => find(st.active) ?? null;

  function syncPeers() {
    for (const m of st.list) {
      if (m.room === st.active) { peers.get(m.room)?.stop(); peers.delete(m.room); continue; }
      if (!peers.has(m.room)) { const p = new Peer(m, onChange); peers.set(m.room, p); p.start(); }
    }
    for (const [room, p] of peers) if (!find(room)) { p.stop(); peers.delete(room); }
  }

  function onChange(what, room, value) {
    if (what === "name") { const m = find(room); if (m && !m.custom && m.name !== value) { m.name = value; save(); } }
    render();
  }

  function add(auth) {
    const i = st.list.findIndex((m) => m.room === auth.room);
    if (i >= 0) st.list[i] = { ...st.list[i], ...auth }; else st.list.push({ ...auth, name: "" });
    st.active = auth.room;
    save(); syncPeers(); render();
  }

  function switchTo(room) {
    const m = find(room);
    if (!m || room === st.active) return;
    st.active = room;
    st.mirror = st.mirror.filter((r) => r !== room);
    save(); syncPeers(); render();
    onSwitch(m);
  }

  /** Forget a computer. Returns the next one to show, or null when none is left. */
  function remove(room) {
    st.list = st.list.filter((m) => m.room !== room);
    st.mirror = st.mirror.filter((r) => r !== room);
    const wasActive = room === st.active;
    if (wasActive) st.active = st.list[0]?.room ?? "";
    save(); syncPeers(); render();
    return wasActive ? active() : undefined;
  }

  function rename(room) {
    const m = find(room);
    if (!m) return;
    const v = prompt("Name for this computer", label(m));
    if (v == null) return;
    m.name = v.trim().slice(0, 30); m.custom = !!m.name;
    save(); render();
  }

  const label = (m) => m.name || `Computer ${st.list.indexOf(m) + 1}`;

  /** Repeat a command on every mirrored computer. Failures name the computer, so one missing scene is easy to spot. */
  function fanout(op, data) {
    if (!MIRRORED.has(op)) return;
    for (const room of st.mirror) {
      const p = peers.get(room), m = find(room);
      if (!p || !m) continue;
      p.rpc(op, data).then((r) => { if (!r.ok) toast(`${label(m)}: ${r.error === "obs_offline" ? "OBS is offline" : r.error}`); });
    }
  }
  const mirrored = () => st.mirror.filter((r) => peers.get(r)?.open_ && peers.get(r)?.obs).length;

  function toggleMirror(room) {
    st.mirror = st.mirror.includes(room) ? st.mirror.filter((r) => r !== room) : [...st.mirror, room];
    save(); render();
  }

  function render() {
    const bar = $("#machines");
    if (!bar) return;
    bar.hidden = st.list.length < 2;
    if (bar.hidden) return;
    const info = getActiveInfo();
    const chips = st.list.map((m) => {
      const isActive = m.room === st.active;
      const p = peers.get(m.room);
      const state = isActive ? info.state : p?.open_ ? (p.obs ? "ok" : "off") : "wait";
      const program = isActive ? info.program : p?.program;
      const live = isActive ? info.live : p?.live;
      const sub = state === "off" ? "OBS offline" : state === "wait" ? "connecting…" : program || "—";
      const mir = st.mirror.includes(m.room);
      return h("div", { class: "mach-chip" + (isActive ? " on" : "") + (mir ? " mir" : ""), "data-s": state },
        h("button", { type: "button", class: "mach-main", "aria-pressed": String(isActive), title: isActive ? "Double-click to rename" : "Switch to this computer",
          onclick: () => switchTo(m.room), ondblclick: () => rename(m.room) },
        h("span", { class: "dot", "data-s": state }),
        h("span", { class: "mach-txt" }, h("b", {}, label(m), live ? h("i", { class: "mach-live" }, "LIVE") : null), h("small", {}, sub))),
        isActive ? null : h("button", { type: "button", class: "mach-mir", "aria-pressed": String(mir), title: mir ? "Mirroring: commands from the active computer also go here" : "Mirror the active computer's commands here",
          onclick: () => toggleMirror(m.room) }, mir ? "Mirroring" : "Mirror"));
    });
    bar.replaceChildren(...chips, h("button", { type: "button", class: "mach-add", onclick: onAdd, "aria-label": "Add a computer" }, "+"));
    bar.dataset.mirroring = String(mirrored());
  }

  /** The active computer reported its own name (its Windows host name): use it unless the user chose one. */
  function learn(name) { const m = active(); if (m && name && !m.custom && m.name !== name) { m.name = name; save(); render(); } }

  return { load, learn, active, add, switchTo, remove, rename, fanout, render, syncPeers, count: () => st.list.length, label, find, get activeRoom() { return st.active; } };
}
