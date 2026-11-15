// Present mode: big numbered screen buttons, live NEXT / ON AIR monitors, TAKE, slide controls.
// app.js owns the connection and the state; this module only draws and sends requests through `api`.

const MEDIA = (a) => `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${a}`;
const isSlideshow = (k = "") => /slideshow/.test(k);
const isMedia = (k = "") => /ffmpeg|vlc|media/.test(k);
const isWindow = (k = "") => /window_capture|display_capture|monitor_capture/.test(k);

export function createEasy(api) {
  const { S, $, $$, h, icon, rpc, toast, bindHold, kindOfT, setBtn, prefs } = api;
  const thumbs = new Map();   // scene name -> object URL of its latest screenshot
  const memo = new Map();     // scene name -> object URL of the last real picture the OBS computer remembers
  let built = false;
  let key = "";

  const D = () => S.data;
  const active = () => document.documentElement.dataset.mode === "easy";

  /** Screens the presenter wants as buttons (Settings > Present view lets people hide the rest). */
  const shown = () => (D()?.scenes ?? []).filter((n) => !prefs.hidden?.includes(n));

  function pick(name) {
    const d = D();
    if (!d) return;
    if (d.studioMode) { if (name !== d.preview) rpc("SetCurrentPreviewScene", { sceneName: name }); }
    else if (name !== d.program) api.directProgram(name);
  }

  const take = () => rpc("StudioTake", {});
  const cut = () => rpc("StudioTake", { transitionName: D().transitions.find((t) => kindOfT(t) === "cut") ?? "Cut", duration: 0 });

  /** Scene to the left/right of the one that matters now (next screen in studio, on-air screen otherwise). */
  function stepScene(dir) {
    const d = D();
    if (!d) return;
    const base = d.studioMode ? d.preview : d.program;
    const list = shown();
    const i = list.indexOf(base);
    const n = i < 0 ? list[dir > 0 ? 0 : list.length - 1] : list[i + dir];
    if (n) pick(n);
    else toast(dir > 0 ? "That is the last screen" : "That is the first screen", "info", 1200);
  }

  /** Every source in a scene that can be paged or played. */
  function slideSources(scene) {
    const items = D()?.items[scene] || [];
    return items.filter((it) => it.enabled && (isSlideshow(it.kind) || isMedia(it.kind) || isWindow(it.kind)));
  }

  function mediaBtn(label, ic, fn, cls = "") {
    return h("button", { class: "ez-ctl " + cls, "aria-label": label, title: label, onclick: fn }, icon(ic));
  }

  function slideCard(it, tag) {
    const act = (a) => rpc("TriggerMediaInputAction", { inputName: it.name, mediaAction: MEDIA(a) });
    let body, sub;
    if (isWindow(it.kind)) {
      sub = "PowerPoint / PDF window";
      body = [
        mediaBtn("Previous page", "prev", () => rpc("PresentKey", { key: "prev" })),
        mediaBtn("Next page", "next", () => rpc("PresentKey", { key: "next" }), "big"),
      ];
    } else if (isSlideshow(it.kind)) {
      sub = "Picture slideshow";
      body = [
        mediaBtn("Previous picture", "prev", () => act("PREVIOUS")),
        mediaBtn("Pause", "pause", () => act("PAUSE")),
        mediaBtn("Play", "play", () => act("PLAY")),
        mediaBtn("Next picture", "next", () => act("NEXT"), "big"),
      ];
    } else {
      sub = "Video / playlist";
      body = [
        mediaBtn("Previous item", "prev", () => act("PREVIOUS")),
        mediaBtn("Restart", "replay", () => act("RESTART")),
        mediaBtn("Pause", "pause", () => act("PAUSE")),
        mediaBtn("Play", "play", () => act("PLAY")),
        mediaBtn("Next item", "next", () => act("NEXT"), "big"),
      ];
    }
    return h("div", { class: "ez-card" },
      h("div", { class: "ez-card-t" }, h("b", {}, it.name), h("small", {}, `${sub}${tag ? " · " + tag : ""}`)),
      h("div", { class: "ez-ctls" }, ...body));
  }

  function sceneCard() {
    return h("div", { class: "ez-card" },
      h("div", { class: "ez-card-t" }, h("b", {}, "Screen by screen"), h("small", {}, D().studioMode ? "moves NEXT, then press TAKE" : "goes live")),
      h("div", { class: "ez-ctls" }, mediaBtn("Previous screen", "prev", () => stepScene(-1)), mediaBtn("Next screen", "next", () => stepScene(1), "big")));
  }

  function renderSlides() {
    const d = D();
    const cards = [];
    const seen = new Set();
    const add = (scene, tag) => slideSources(scene).forEach((it) => { if (!seen.has(it.name)) { seen.add(it.name); cards.push(slideCard(it, tag)); } });
    add(d.program, d.studioMode ? "on air" : "");
    if (d.studioMode && d.preview !== d.program) add(d.preview, "next");
    cards.push(sceneCard());
    $("#ezSlides").replaceChildren(...cards);
  }

  /** What a screen mostly is, so a still frame is understood: a video that is paused, a slideshow, a screen, a picture. */
  function kindBadge(scene) {
    const items = (D().items[scene] || []).filter((it) => it.enabled);
    const has = (re) => items.some((it) => re.test(it.kind || ""));
    if (has(/ffmpeg|vlc|media/)) return ["play", "VIDEO"];
    if (has(/slideshow/)) return ["image", "SLIDES"];
    if (has(/window_capture|display_capture|monitor_capture|game_capture/)) return ["window", "SCREEN"];
    if (has(/image/)) return ["image", "IMAGE"];
    if (has(/dshow|v4l2|av_capture/)) return ["camera", "CAMERA"];
    return null;
  }

  /** Multiview on a computer screen: a grid of `cols` small windows; NEXT and ON AIR each take a k x k block
   *  (k = cols / 2), on top in studio mode, ON AIR on the left otherwise with the screens beside it. */
  function grid(n, studio) {
    const cols = studio ? (n <= 4 ? 4 : n <= 12 ? 6 : 8) : (n <= 4 ? 4 : n <= 9 ? 6 : 8);
    const k = cols / 2;
    const below = studio ? n : Math.max(0, n - k * k); // screens under the big windows
    const rows = k + Math.ceil(below / cols);
    const empty = studio || n > k * k ? (cols - (below % cols)) % cols : k * k - n;
    return { cols, k, rows, empty };
  }

  let fitSig = "";
  /** Size the multiview so all of it fits on the screen without scrolling. */
  function fitMultiview() {
    const d = D();
    if (!d) return;
    const sig = `${shown().length}|${d.studioMode}`;
    if (sig === fitSig) return;
    fitSig = sig;
    const g = grid(shown().length, d.studioMode);
    const mv = $("#ezMv");
    const top = $(".ez-bar").getBoundingClientRect().height;
    const strip = d.studioMode ? 4.6 * parseFloat(getComputedStyle(mv).fontSize) : 0;
    const gap = parseFloat(getComputedStyle(mv).rowGap) || 0;
    const below = parseFloat(getComputedStyle($("#easy")).paddingBottom) || 24; // includes the home-bar inset
    const room = innerHeight - top - strip - below - gap * (g.rows + 1);
    mv.style.setProperty("--cols", String(g.cols));
    mv.style.setProperty("--k", String(g.k));
    mv.style.setProperty("--mv-max", `${Math.max(560, Math.floor((room * g.cols * 16) / (9 * g.rows)))}px`);
  }

  function renderScenes() {
    const d = D();
    const studio = d.studioMode;
    $("#ezHint").textContent = studio ? "tap to line up NEXT, then press TAKE" : "tap to go live";
    const fill = Array.from({ length: grid(shown().length, studio).empty }, () => h("span", { class: "ez-fill", "aria-hidden": "true" }));
    $("#ezScenes").replaceChildren(...shown().map((name, i) => {
      const air = name === d.program, nxt = studio && name === d.preview;
      const url = thumbs.get(name) ?? memo.get(name);
      return h("button", {
        class: "ez-scene" + (stale.has(name) ? " stale" : "") + (blank.has(name) ? " blank" : "") + (air ? " air" : "") + (nxt ? " next" : "") + (S.arming === name ? " arming" : ""),
        role: "option", "aria-selected": String(studio ? nxt : air), onclick: () => pick(name),
      },
      h("span", { class: "ez-th" }, url ? h("img", { src: url, alt: "", draggable: "false" }) : null, h("span", { class: "ez-nm" }, name)),
      (() => { const k = kindBadge(name); return k ? h("span", { class: "ez-kind", title: k[1] }, icon(k[0]), k[1]) : null; })(),
      h("span", { class: "ez-num" }, String(i + 1)),
      air ? h("span", { class: "ez-tag air" }, "ON AIR") : nxt ? h("span", { class: "ez-tag next" }, "NEXT") : null);
    }), ...fill);
  }

  function renderFx() {
    const d = D();
    const sig = d.transitions.join("|") + "#" + d.transition + "#" + d.duration;
    if ($("#ezFx").dataset.sig !== sig) {
      $("#ezFx").dataset.sig = sig;
      $("#ezFx").replaceChildren(...d.transitions.map((t) =>
        h("button", { role: "radio", "aria-checked": String(t === d.transition), onclick: () => { d.transition = t; renderFx(); rpc("SetCurrentSceneTransition", { transitionName: t }); } }, t)));
      $("#ezDur").replaceChildren(...[0.25, 0.5, 1, 2].map((s) =>
        h("button", { role: "radio", "aria-checked": String(s * 1000 === d.duration), onclick: () => api.setDur(s * 1000) }, `${s} s`)));
    }
  }

  function renderOut() {
    const d = D();
    setBtn($("#ezStream"), "live", d.stream.active ? "Stop streaming" : "Start streaming", d.stream.active ? "anim" : "");
    setBtn($("#ezRecord"), d.record.active ? "stop" : "record", d.record.active ? "Stop recording" : "Start recording", d.record.active && !d.record.paused ? "anim" : "");
    $("#ezStream").classList.toggle("on", d.stream.active);
    $("#ezRecord").classList.toggle("on", d.record.active);
    $("#ezLive").hidden = !d.stream.active;
    $("#ezRec").hidden = !d.record.active;
  }

  function render() {
    if (!built || !active()) return;
    const d = D();
    $("#ezName").textContent = $("#obsName").textContent;
    $("#ezDot").dataset.s = $("#connDot").dataset.s;
    if (!d) return;
    const studio = d.studioMode;
    $("#ezStage").classList.toggle("is-studio", studio);
    $("#ezNextBox").hidden = !studio;
    $("#ezGo").hidden = !studio;
    $("#ezStudio").setAttribute("aria-pressed", String(studio));
    $("#ezAirName").textContent = d.program;
    $("#ezNextName").textContent = d.preview;
    const busy = !!S.tr || S.tbar > 0;
    $("#ezTake").disabled = !studio || busy;
    $("#ezCut").disabled = !studio || busy;
    $("#ezStage").classList.toggle("mixing", busy);
    const sig = [shown().join(), d.program, d.preview, studio, S.arming, JSON.stringify(d.items)].join("|");
    if (sig !== key) { key = sig; renderScenes(); }
    fitMultiview();
    renderSlidesIfChanged();
    renderFx();
    renderOut();
  }

  let slideSig = "";
  function renderSlidesIfChanged() {
    const d = D();
    const sig = [d.program, d.preview, d.studioMode, JSON.stringify([d.items[d.program], d.items[d.preview]])].join("|");
    if (sig !== slideSig) { slideSig = sig; renderSlides(); }
  }

  /** Programme / preview monitors: the same frames the OBS-style view receives. */
  function frame(ch, url) {
    if (!built) return;
    const [img, scr] = ch === 1 ? ["#ezImgB", "#ezScrB"] : ["#ezImgA", "#ezScrA"];
    $(img).src = url;
    $(scr).classList.add("has");
  }

  const stale = new Set(); // scenes whose newest picture was black while an older real one exists
  const blank = new Set(); // off-air scenes OBS has never drawn: shown as a placeholder, not a black box
  const probe = document.createElement("canvas");
  probe.width = 16; probe.height = 9;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  /** True when a picture is (almost) all black: OBS draws inactive sources black, which is not what the screen looks like. */
  async function isBlack(url) {
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      pctx.drawImage(img, 0, 0, 16, 9);
      const d = pctx.getImageData(0, 0, 16, 9).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return sum / (144 * 3) < 6;
    } catch { return false; }
  }

  /** One scene's thumbnail arrived. Black frames never replace a real picture we already have: keep the last good one. */
  async function thumb(name, url) {
    // OBS draws a scene's live sources (windows, cameras, screens) only while it is on air or lined up, so a black
    // picture off air means "not drawn", not "nothing there". The scene on air is the one place black is real.
    if (name !== D()?.program && (await isBlack(url))) {
      URL.revokeObjectURL(url);
      if (thumbs.has(name) || memo.has(name)) { if (!stale.has(name)) { stale.add(name); markStale(name); } }
      else if (!blank.has(name)) { blank.add(name); markStale(name); }
      return;
    }
    if (stale.delete(name) | blank.delete(name)) markStale(name);
    const old = thumbs.get(name);
    thumbs.set(name, url);
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1500);
    setTileImage(name, url);
  }

  /** The last real picture of a scene, from the OBS computer's memory. Shown (marked as an old picture) until a
   *  live one arrives, so a screen that is black off air still shows what it looks like. */
  function remembered(name, url) {
    const old = memo.get(name);
    memo.set(name, url);
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1500);
    if (thumbs.has(name) && !stale.has(name)) return; // a live picture is already showing
    const ours = thumbs.get(name); // older than what the OBS computer remembers
    if (ours) { thumbs.delete(name); setTimeout(() => URL.revokeObjectURL(ours), 1500); }
    stale.add(name);
    blank.delete(name);
    markStale(name);
    setTileImage(name, url);
  }

  function setTileImage(name, url) {
    if (!built || !active()) return;
    const i = shown().indexOf(name);
    const th = i >= 0 && $$(".ez-scene .ez-th", $("#ezScenes"))[i];
    if (!th) return;
    let el = th.querySelector("img");
    if (!el) th.prepend((el = h("img", { alt: "", draggable: "false" })));
    el.src = url;
  }

  function markStale(name) {
    const i = shown().indexOf(name);
    const el = $$(".ez-scene", $("#ezScenes"))[i];
    el?.classList.toggle("stale", stale.has(name));
    el?.classList.toggle("blank", blank.has(name));
  }

  function onKey(e) {
    if (!active() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("input, select, textarea, dialog[open]")) return;
    if (!D() || document.querySelector("dialog[open]")) return;
    const k = e.key;
    const go = (dir) => {
      const s = slideSources(D().program)[0]; // the first pageable source on air, else move between screens
      if (!s) return stepScene(dir);
      if (isWindow(s.kind)) return rpc("PresentKey", { key: dir > 0 ? "next" : "prev" });
      rpc("TriggerMediaInputAction", { inputName: s.name, mediaAction: MEDIA(dir > 0 ? "NEXT" : "PREVIOUS") });
    };
    if (k === "ArrowRight" || k === "PageDown" || k === " ") go(1);
    else if (k === "ArrowLeft" || k === "PageUp") go(-1);
    else if (k === "Enter" && D().studioMode) take();
    else if (/^[1-9]$/.test(k)) { const n = shown()[Number(k) - 1]; if (n) pick(n); else return; }
    else return;
    e.preventDefault();
  }

  function build() {
    if (built) return;
    built = true;
    api.hydrate($("#easy"));
    $("#ezFull").replaceChildren(icon("expand"));
    $("#ezSettings").replaceChildren(icon("display"));
    $("#ezTake").addEventListener("click", take);
    $("#ezCut").addEventListener("click", cut);
    $("#ezStudio").addEventListener("click", () => rpc("SetStudioModeEnabled", { studioModeEnabled: !D().studioMode }));
    $("#ezSettings").addEventListener("click", () => $("#btnDisplay").click());
    $("#ezFull").addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => toast("This browser can't go full screen here", "info"));
    });
    bindHold($("#ezStream"), () => rpc(D().stream.active ? "StopStream" : "StartStream", {}), () => true, 800);
    bindHold($("#ezRecord"), () => rpc(D().record.active ? "StopRecord" : "StartRecord", {}), () => D().record.active, 800);
    addEventListener("keydown", onKey);
    addEventListener("resize", () => { fitSig = ""; if (active()) fitMultiview(); });
  }

  /** Transition progress under the monitors (0..1, or null when idle). */
  function progress(p) {
    const m = $("#ezMeter");
    m.classList.toggle("run", p != null);
    m.style.setProperty("--p", String(p ?? 0));
  }

  /** Another computer took over: its scenes are different, so forget every picture of the last one. */
  function reset() {
    for (const url of [...thumbs.values(), ...memo.values()]) URL.revokeObjectURL(url);
    thumbs.clear(); memo.clear(); stale.clear(); blank.clear();
    key = ""; slideSig = ""; fitSig = "";
    if (built) { $("#ezScenes").replaceChildren(); $("#ezImgA").removeAttribute("src"); $("#ezImgB").removeAttribute("src"); $("#ezScrA").classList.remove("has"); $("#ezScrB").classList.remove("has"); }
  }

  return { build, render, frame, thumb, remembered, progress, reset };
}
