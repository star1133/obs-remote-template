// "My buttons": big buttons the user builds from whatever their OBS has: scenes, sources, filters, mics, media,
// text, hotkeys, stream/record, slides. A button is a short list of steps, so one tap can do several things.
// The buttons are saved on the OBS computer (SetLayout), so every phone and tablet shows the same ones.

const MEDIA = "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_";
const COLORS = ["#2c6cb4", "#e5483f", "#43b05c", "#f0a020", "#9b59d0", "#1fa3a3", "#d0587e", "#6b7280"];
const uid = () => "b" + Math.random().toString(36).slice(2, 9);

/** What a step can do. `f` lists its fields: scene, source-of-scene, audio/text/media/any source, filter, hotkey, choice, text, number. */
const TYPES = {
  scene: { label: "Go to a scene", icon: "scenes", f: [{ k: "sceneName", t: "scene" }, { k: "mode", t: "opt", o: [["program", "Go live now"], ["preview", "Line up as NEXT"]] }] },
  source: { label: "Show / hide something", icon: "eye", f: [{ k: "sceneName", t: "scene" }, { k: "sourceName", t: "itemOf" }, { k: "state", t: "opt", o: [["toggle", "Switch on / off"], ["on", "Show"], ["off", "Hide"]] }] },
  mute: { label: "Mute / unmute audio", icon: "mic", f: [{ k: "inputName", t: "audio" }, { k: "state", t: "opt", o: [["toggle", "Switch mute on / off"], ["on", "Mute"], ["off", "Unmute"]] }] },
  filter: { label: "Turn a filter on / off", icon: "star", f: [{ k: "sourceName", t: "any" }, { k: "filterName", t: "filter" }, { k: "state", t: "opt", o: [["toggle", "Switch on / off"], ["on", "On"], ["off", "Off"]] }] },
  media: { label: "Play / pause a video", icon: "play", f: [{ k: "inputName", t: "media" }, { k: "action", t: "opt", o: [["PLAY", "Play"], ["PAUSE", "Pause"], ["RESTART", "Restart"], ["NEXT", "Next"], ["PREVIOUS", "Previous"], ["STOP", "Stop"]] }] },
  slides: { label: "Next / previous slide", icon: "next", f: [{ k: "key", t: "opt", o: [["next", "Next slide"], ["prev", "Previous slide"], ["first", "First slide"], ["last", "Last slide"]] }] },
  text: { label: "Change a text", icon: "text", f: [{ k: "inputName", t: "textsrc" }, { k: "text", t: "text" }] },
  stream: { label: "Stream", icon: "live", f: [{ k: "state", t: "opt", o: [["toggle", "Start / stop"], ["start", "Start"], ["stop", "Stop"]] }] },
  record: { label: "Record", icon: "record", f: [{ k: "state", t: "opt", o: [["toggle", "Start / stop"], ["start", "Start"], ["stop", "Stop"]] }] },
  hotkey: { label: "Press an OBS hotkey", icon: "switch", f: [{ k: "hotkeyName", t: "hotkey" }] },
  volume: { label: "Set a volume", icon: "volume", f: [{ k: "inputName", t: "audio" }, { k: "db", t: "number", min: -60, max: 6, hint: "dB (0 = full)" }] },
  studio: { label: "TAKE (Preview first)", icon: "take", f: [{ k: "action", t: "opt", o: [["take", "TAKE"]] }] },
  wait: { label: "Wait", icon: "pause", f: [{ k: "ms", t: "number", min: 50, max: 60000, hint: "milliseconds" }] },
};

const DEFAULTS = { scene: { mode: "program" }, source: { state: "toggle" }, mute: { state: "toggle" }, filter: { state: "toggle" }, media: { action: "PLAY" }, slides: { key: "next" }, text: { text: "" }, stream: { state: "toggle" }, record: { state: "toggle" }, volume: { db: 0 }, studio: { action: "take" }, wait: { ms: 500 } };

/** The picks shown first when making a button: one tap on a card creates it with that action. */
const STARTERS = ["scene", "source", "mute", "slides", "media", "filter", "text", "stream", "hotkey"];

export function createButtons({ S, $, h, icon, rpc, toast, bindHold }) {
  const D = () => S.data;
  const canEdit = () => S.perm === "owner" || S.perm === "operator";
  const buttons = () => D()?.layout?.buttons ?? [];
  let editing = false;

  // ---- what OBS has, for the pickers -------------------------------------------------------------
  const uniq = (a) => [...new Set(a)];
  const allItems = () => Object.values(D()?.items ?? {}).flat();
  const lists = {
    scene: () => D()?.scenes ?? [],
    audio: () => (D()?.inputs ?? []).map((i) => i.name),
    textsrc: () => uniq(allItems().filter((i) => /^text_/.test(i.kind || "")).map((i) => i.name)),
    media: () => uniq(allItems().filter((i) => /ffmpeg|vlc|slideshow|media/.test(i.kind || "")).map((i) => i.name)),
    any: () => uniq([...allItems().map((i) => i.name), ...(D()?.inputs ?? []).map((i) => i.name)]),
  };

  // ---- running a button --------------------------------------------------------------------------
  async function runStep(st) {
    const d = D();
    switch (st.type) {
      case "scene": return rpc(st.mode === "preview" ? "SetCurrentPreviewScene" : "SetCurrentProgramScene", { sceneName: st.sceneName });
      case "source": return rpc("SetSourceVisible", { sceneName: st.sceneName, sourceName: st.sourceName, state: st.state });
      case "mute": return rpc("SetMuteState", { inputName: st.inputName, state: st.state });
      case "filter": return rpc("SetFilterState", { sourceName: st.sourceName, filterName: st.filterName, state: st.state });
      case "media": return rpc("TriggerMediaInputAction", { inputName: st.inputName, mediaAction: MEDIA + st.action });
      case "slides": return rpc("PresentKey", { key: st.key });
      case "text": return rpc("SetText", { inputName: st.inputName, text: st.text ?? "" });
      case "hotkey": return rpc("TriggerHotkeyByName", { hotkeyName: st.hotkeyName });
      case "volume": return rpc("SetInputVolume", { inputName: st.inputName, inputVolumeDb: Number(st.db) });
      case "studio": return rpc("StudioTake", {});
      case "stream": { const on = d.stream.active; if (st.state === "start" && on || st.state === "stop" && !on) return { ok: true }; return rpc(on ? "StopStream" : "StartStream", {}); }
      case "record": { const on = d.record.active; if (st.state === "start" && on || st.state === "stop" && !on) return { ok: true }; return rpc(on ? "StopRecord" : "StartRecord", {}); }
      case "wait": await new Promise((r) => setTimeout(r, Math.min(60000, Math.max(50, Number(st.ms) || 500)))); return { ok: true };
      default: return { ok: false, error: "unknown step" };
    }
  }

  async function run(b) {
    if (!D()) return;
    if (!b.steps.length) return toast("This button has nothing to do yet. Tap Edit.", "info");
    for (const st of b.steps) {
      const r = await runStep(st);
      if (!r?.ok) return; // rpc already told the user what failed
    }
  }

  /** On/off look for single-step buttons whose result OBS can tell us (a scene on air, a source shown, a mic muted...). */
  function stateOf(b) {
    const d = D();
    if (!d || b.steps.length !== 1) return null;
    const st = b.steps[0];
    if (st.type === "scene" && st.mode !== "preview") return d.program === st.sceneName;
    if (st.type === "source" && st.state === "toggle") { const it = (d.items[st.sceneName] ?? []).find((x) => x.name === st.sourceName); return it ? it.enabled : null; }
    if (st.type === "mute" && st.state === "toggle") { const i = d.inputs.find((x) => x.name === st.inputName); return i ? !i.muted : null; }
    if (st.type === "stream") return d.stream.active;
    if (st.type === "record") return d.record.active;
    return null;
  }

  const describe = (b) => (!b.steps.length ? "Nothing yet" : b.steps.length === 1 ? TYPES[b.steps[0].type]?.label ?? "" : `${b.steps.length} actions`);

  // ---- the grid ----------------------------------------------------------------------------------
  function tile(b) {
    const s = stateOf(b);
    const first = b.steps[0];
    const el = h("button", { type: "button", class: "mb-tile" + (s === true ? " on" : "") + (s === false ? " off" : "") + (editing ? " editing" : ""), "data-state": s == null ? "" : String(s) },
      h("span", { class: "mb-ic" }, icon(TYPES[first?.type]?.icon ?? "star")),
      h("b", {}, b.label || "Button"),
      h("small", {}, editing ? "Tap to edit" : describe(b)));
    el.style.setProperty("--c", b.color || COLORS[0]);
    el.addEventListener("click", () => (editing ? openEditor(b) : run(b)));
    el._b = b;
    return el;
  }

  function renderInto(el, { inline = false } = {}) {
    if (!el) return;
    const list = buttons();
    const kids = list.map(tile);
    if (!list.length) {
      kids.push(h("p", { class: "mb-empty" }, canEdit() ? "No buttons yet. Make one for anything in OBS: show a camera, mute a mic, flip a slide, run several things at once." : "No buttons have been made yet."));
    }
    if (canEdit() && (editing || !inline)) kids.push(h("button", { type: "button", class: "mb-tile mb-new", onclick: () => openEditor(null) }, h("span", { class: "mb-ic" }, icon("plus")), h("b", {}, "New button")));
    el.replaceChildren(...kids);
  }

  function render() {
    renderInto($("#ezMine"), { inline: true });
    $("#ezMineAdd").hidden = !canEdit();
    $("#ezMineEdit").hidden = !canEdit() || !buttons().length;
    $("#ezMineEdit").textContent = editing ? "Done" : "Edit";
    $("#ezMineAdd").textContent = "+ New";
    if (dlg.open) renderInto($("#mbGrid"));
    $("#mbEdit").textContent = editing ? "Done" : "Edit";
    $("#mbEdit").hidden = !canEdit() || !buttons().length;
  }

  /** Cheap refresh of the on/off look only (no rebuild, so a press in progress is never lost). */
  function paint() {
    for (const el of document.querySelectorAll(".mb-tile:not(.mb-new):not(.mb-prev)")) {
      if (!el._b) continue;
      const s = stateOf(el._b);
      el.classList.toggle("on", s === true);
      el.classList.toggle("off", s === false);
      el.dataset.state = s == null ? "" : String(s);
    }
  }

  function toggleEdit() { editing = !editing; render(); }

  // ---- saving ------------------------------------------------------------------------------------
  async function save(list) {
    const r = await rpc("SetLayout", { layout: { buttons: list } });
    if (r.ok) { if (D()) D().layout = { buttons: list }; render(); }
    return r.ok;
  }

  // ---- editor ------------------------------------------------------------------------------------
  const editor = h("dialog", { class: "mb-dlg", "aria-label": "Edit button" });
  document.body.append(editor);
  const dlg = h("dialog", { class: "mb-dlg mb-page", "aria-label": "My buttons" },
    h("div", { class: "mb-top" }, h("h3", {}, "My buttons"), h("span", { class: "grow" }),
      h("button", { type: "button", id: "mbEdit", onclick: toggleEdit }, "Edit"),
      h("button", { type: "button", class: "primary", onclick: () => dlg.close() }, "Close")),
    h("div", { class: "mb-grid", id: "mbGrid" }));
  document.body.append(dlg);

  function field(st, f, rerender, box) {
    const label = { sceneName: "Scene", sourceName: "What", inputName: "Which", filterName: "Filter", hotkeyName: "Hotkey", state: "Do", mode: "Do", action: "Do", key: "Do", text: "New text", db: "Volume", ms: "For how long" }[f.k] ?? f.k;
    let input;
    const choices = (arr) => {
      const sel = h("select", {}, h("option", { value: "" }, "Choose…"), ...arr.map((v) => h("option", { value: Array.isArray(v) ? v[0] : v }, Array.isArray(v) ? v[1] : v)));
      return sel;
    };
    if (f.t === "opt") input = choices(f.o);
    else if (f.t === "text") input = h("input", { type: "text", maxlength: "2000", placeholder: "Type the text to show" });
    else if (f.t === "number") input = h("input", { type: "number", min: String(f.min), max: String(f.max), step: "any", placeholder: f.hint });
    else if (f.t === "itemOf") input = choices(uniq((D()?.items?.[st.sceneName] ?? []).map((i) => i.name)));
    else if (f.t === "filter" || f.t === "hotkey") {
      input = choices([]);
      const load = f.t === "filter"
        ? st.sourceName ? rpc("ListFilters", { sourceName: st.sourceName }).then((r) => (r.ok ? r.data.map((x) => x.name) : [])) : Promise.resolve([])
        : rpc("ListHotkeys", {}).then((r) => (r.ok ? r.data : []));
      load.then((names) => {
        input.replaceChildren(h("option", { value: "" }, names.length ? "Choose…" : f.t === "filter" ? "Pick the source first (or none has filters)" : "OBS did not list any hotkeys"), ...names.map((n) => h("option", { value: n }, n)));
        input.value = st[f.k] ?? "";
      });
    } else input = choices(lists[f.t]());
    if (f.t !== "text" && f.t !== "number") input.value = st[f.k] ?? "";
    else if (st[f.k] != null) input.value = st[f.k];
    input.addEventListener("change", () => {
      st[f.k] = f.t === "number" ? Number(input.value) : input.value;
      if (f.k === "sceneName" || f.k === "sourceName") { if (f.k === "sceneName") delete st.sourceName; rerender(); }
    });
    box.append(h("label", { class: "mb-f" }, h("span", {}, label), input));
  }

  function openEditor(existing, starter) {
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : { id: uid(), label: "", color: COLORS[0], icon: "", group: "", steps: starter ? [{ type: starter, ...DEFAULTS[starter] }] : [] };
    const draw = () => {
      const steps = draft.steps.map((st, i) => {
        const T = TYPES[st.type];
        const body = h("div", { class: "mb-fields" });
        const again = () => draw();
        T.f.forEach((f) => field(st, f, again, body));
        const typeSel = h("select", { "aria-label": "What it does" }, ...Object.entries(TYPES).map(([k, v]) => h("option", { value: k }, v.label)));
        typeSel.value = st.type;
        typeSel.addEventListener("change", () => { draft.steps[i] = { type: typeSel.value, ...DEFAULTS[typeSel.value] }; draw(); });
        return h("div", { class: "mb-step" },
          h("div", { class: "mb-steph" }, h("b", {}, `${i + 1}`), typeSel,
            h("button", { type: "button", class: "mb-x", "aria-label": "Remove this action", onclick: () => { draft.steps.splice(i, 1); draw(); } }, "×")),
          body);
      });
      const swatches = COLORS.map((c) => {
        const b = h("button", { type: "button", class: "mb-sw" + (draft.color === c ? " on" : ""), "aria-label": "Colour " + c, "aria-pressed": String(draft.color === c) });
        b.style.setProperty("--c", c);
        b.addEventListener("click", () => { draft.color = c; draw(); });
        return b;
      });
      const name = h("input", { type: "text", maxlength: "40", placeholder: "Button name, e.g. Show camera" });
      name.value = draft.label;
      name.addEventListener("input", () => { draft.label = name.value; });
      const starters = h("div", { class: "mb-starters" }, ...STARTERS.map((k) => h("button", { type: "button", class: "mb-starter", onclick: () => { draft.steps.push({ type: k, ...DEFAULTS[k] }); draw(); } }, h("span", { class: "mb-ic" }, icon(TYPES[k].icon)), TYPES[k].label)));
      const prev = tile({ ...draft, label: draft.label || "Preview" });
      prev.classList.add("mb-prev"); prev.disabled = true;
      editor.replaceChildren(...[
        h("h3", {}, existing ? "Edit button" : "New button"),
        prev,
        h("label", { class: "mb-f" }, h("span", {}, "Name"), name),
        h("div", { class: "mb-f" }, h("span", {}, "Colour"), h("div", { class: "mb-sws" }, ...swatches)),
        h("h4", {}, draft.steps.length ? "When tapped, it will…" : "What should it do? Tap one:"),
        ...steps,
        draft.steps.length ? h("button", { type: "button", class: "mb-add", onclick: () => { draft.steps.push({ type: "wait", ...DEFAULTS.wait }); draw(); } }, "+ Then wait") : null,
        h("details", { class: "mb-more", open: !draft.steps.length ? true : null }, h("summary", {}, draft.steps.length ? "+ Add another action" : "Pick an action"), starters),
        h("div", { class: "mb-foot" },
          existing ? h("button", { type: "button", class: "danger", onclick: async () => { if (confirm(`Delete "${existing.label}"?`) && await save(buttons().filter((b) => b.id !== existing.id))) editor.close(); } }, "Delete") : h("span"),
          h("span", { class: "grow" }),
          h("button", { type: "button", onclick: () => editor.close() }, "Cancel"),
          h("button", { type: "button", class: "primary", onclick: async () => {
            if (!draft.steps.length) return toast("Pick what the button should do first.", "info");
            if (!draft.label.trim()) draft.label = TYPES[draft.steps[0].type].label;
            const list = buttons().slice();
            const at = list.findIndex((b) => b.id === draft.id);
            if (at >= 0) list[at] = draft; else list.push(draft);
            if (await save(list)) editor.close();
          } }, "Save")),
      ].filter(Boolean));
    };
    draw();
    if (!editor.open) editor.showModal();
  }

  function openPage() { render(); renderInto($("#mbGrid")); if (!dlg.open) dlg.showModal(); }

  function bind() {
    $("#ezMineEdit").addEventListener("click", toggleEdit);
    $("#ezMineAdd").addEventListener("click", () => openEditor(null));
    for (const id of ["#btnMine", "#ezMineOpen"]) $(id)?.addEventListener("click", openPage);
  }

  return { bind, render, paint, run, openPage };
}
