// Panel layout for the OBS-style view on big screens, like OBS's own docks: rows of panels, each panel a share of
// its row's width, each row its own height (or as tall as its content). Saved per device in prefs.dock.
// Edit mode: drag a title bar onto another panel to move it, drag the edge handles to resize, arrow keys for fine
// steps, hide panels and bring them back. Without a saved layout the CSS default in app.css applies.

const IDS = ["p-preview", "p-scenes", "p-sources", "p-mixer", "p-switcher", "p-live", "p-stats", "p-log"];
const NAMES = { "p-preview": "Preview", "p-scenes": "Scenes", "p-sources": "Sources", "p-mixer": "Audio Mixer", "p-switcher": "Scene Transitions", "p-live": "Controls", "p-stats": "Stats", "p-log": "Activity" };
const MIN_SHARE = 0.08; // a panel keeps at least this much of its row
const MIN_H = 90;       // px

/** The look of the CSS default (wide screens), as a layout that can be edited. */
const DEFAULT = () => ({
  rows: [
    { h: 0, items: [{ id: "p-preview", w: 1 }] },
    { h: 0, items: [{ id: "p-scenes", w: 1 }, { id: "p-sources", w: 1 }, { id: "p-mixer", w: 1.7 }, { id: "p-switcher", w: 1 }, { id: "p-live", w: 0.8 }] },
    { h: 0, items: [{ id: "p-stats", w: 2 }, { id: "p-log", w: 3 }] },
  ],
  hidden: [],
});

/** Keep only known panels, each once; panels missing from a saved layout go at the end. */
function clean(d) {
  const seen = new Set();
  const rows = (Array.isArray(d?.rows) ? d.rows : []).map((r) => ({
    h: Number.isFinite(r?.h) && r.h >= MIN_H ? Math.round(r.h) : 0,
    items: (Array.isArray(r?.items) ? r.items : []).filter((it) => IDS.includes(it?.id) && !seen.has(it.id) && seen.add(it.id))
      .map((it) => ({ id: it.id, w: Number.isFinite(it.w) && it.w > 0 ? it.w : 1 })),
  })).filter((r) => r.items.length);
  const missing = IDS.filter((id) => !seen.has(id));
  if (missing.length) rows.push({ h: 0, items: missing.map((id) => ({ id, w: 1 })) });
  return { rows, hidden: (Array.isArray(d?.hidden) ? d.hidden : []).filter((id) => IDS.includes(id)) };
}

export function createDock({ $, $$, h, icon, prefs, save, onChange = () => {} }) {
  let editing = false;
  const main = () => $("#panels");
  const wide = () => document.documentElement.dataset.layout === "wide";
  const panel = (id) => document.getElementById(id);
  /** Shown right now: not hidden by the user, not a full-detail panel in simple mode. */
  const visible = (d, id) => !d.hidden.includes(id) && !(panel(id).classList.contains("full-only") && document.documentElement.dataset.detail === "simple");

  function model() { return prefs.dock ? clean(prefs.dock) : null; }
  function store(d) { prefs.dock = d; save(); apply(); if (editing) paintBar(); onChange(); }

  /** Turn the row model into one CSS grid: the column lines are every place a panel edge falls in any row.
   *  `dragging`: a resize is in progress, so keep its handle (it holds the pointer). */
  function apply(dragging = false) {
    const m = main();
    const d = model();
    const custom = !!d && wide();
    document.documentElement.dataset.dock = custom ? "custom" : "";
    for (const id of IDS) {
      const p = panel(id);
      p.style.gridColumn = p.style.gridRow = "";
      p.style.removeProperty("--rowh");
      p.classList.remove("dock-hidden", "fixed-h");
    }
    if (!custom) { m.style.gridTemplateColumns = m.style.gridTemplateRows = m.style.gridTemplateAreas = ""; return; }
    const rows = d.rows.map((r) => ({ ...r, items: r.items.filter((it) => visible(d, it.id)) })).filter((r) => r.items.length);
    for (const id of d.hidden) panel(id).classList.add("dock-hidden");
    const at = (x) => Math.round(x * 10000) / 10000;
    const cuts = new Set([0, 1]);
    for (const r of rows) {
      const sum = r.items.reduce((a, it) => a + it.w, 0);
      let acc = 0;
      for (const it of r.items) { acc += it.w; cuts.add(at(acc / sum)); }
    }
    const xs = [...cuts].sort((a, b) => a - b);
    m.style.gridTemplateAreas = "none";
    m.style.gridTemplateColumns = xs.slice(1).map((x, i) => `minmax(0, ${((x - xs[i]) * 1000).toFixed(1)}fr)`).join(" ");
    m.style.gridTemplateRows = rows.map((r) => (r.h ? `${r.h}px` : "auto")).join(" ");
    rows.forEach((r, ri) => {
      const sum = r.items.reduce((a, it) => a + it.w, 0);
      let acc = 0;
      for (const it of r.items) {
        const s = xs.indexOf(at(acc / sum)) + 1;
        acc += it.w;
        const p = panel(it.id);
        p.style.gridColumn = `${s} / ${xs.indexOf(at(acc / sum)) + 1}`;
        p.style.gridRow = String(ri + 1);
        if (r.h) { p.classList.add("fixed-h"); p.style.setProperty("--rowh", `${r.h}px`); }
      }
    });
    if (editing && !dragging) drawHandles(d, rows);
  }

  // ---- edit mode -------------------------------------------------------------------------------

  function where(d, id) {
    for (let ri = 0; ri < d.rows.length; ri++) {
      const ii = d.rows[ri].items.findIndex((it) => it.id === id);
      if (ii >= 0) return [ri, ii];
    }
    return [-1, -1];
  }

  /** Edge handles: right edge = width against the next panel in the row, bottom edge = the row's height. */
  function drawHandles(d, rows) {
    $$(".dk-h").forEach((x) => x.remove());
    rows.forEach((r) => r.items.forEach((it, i) => {
      const p = panel(it.id);
      if (i < r.items.length - 1) p.append(handle("x", it.id, r.items[i + 1].id));
      p.append(handle("y", it.id));
    }));
  }

  function handle(axis, id, nextId) {
    const el = h("div", { class: `dk-h dk-${axis}`, tabindex: "0", role: "separator", "aria-orientation": axis === "x" ? "vertical" : "horizontal",
      "aria-label": axis === "x" ? `Width of ${NAMES[id]} and ${NAMES[nextId]}` : `Height of the row with ${NAMES[id]}`,
      title: axis === "x" ? "Drag to change the width · arrow keys for fine steps" : "Drag to change the height · arrow keys for fine steps · double-click: fit the content" });
    const width = (dxPx) => {
      const d = model();
      const [ri] = where(d, id);
      const r = d.rows[ri];
      const a = r.items.find((it) => it.id === id), b = r.items.find((it) => it.id === nextId);
      const sum = r.items.reduce((s, it) => s + it.w, 0);
      const rowPx = main().clientWidth;
      const pair = a.w + b.w, min = MIN_SHARE * sum;
      const na = Math.min(pair - min, Math.max(min, a.w + (dxPx / rowPx) * sum));
      a.w = na; b.w = pair - na;
      return d;
    };
    const height = (px) => {
      const d = model();
      const [ri] = where(d, id);
      d.rows[ri].h = px == null ? 0 : Math.max(MIN_H, Math.round(px));
      return d;
    };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX, y0 = e.clientY;
      const start = model();
      const h0 = panel(id).getBoundingClientRect().height;
      let last = start;
      el.classList.add("on");
      const move = (ev) => {
        prefs.dock = start; // every step starts from the layout at pointerdown
        last = axis === "x" ? width(ev.clientX - x0) : height(h0 + ev.clientY - y0);
        prefs.dock = last; apply(true);
      };
      const up = () => { el.classList.remove("on"); el.removeEventListener("pointermove", move); store(last); };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up, { once: true });
      el.addEventListener("pointercancel", up, { once: true });
    });
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 5 : 1;
      let d = null;
      if (axis === "x" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) d = width((e.key === "ArrowRight" ? 1 : -1) * step * 0.01 * main().clientWidth);
      if (axis === "y" && (e.key === "ArrowUp" || e.key === "ArrowDown")) d = height(panel(id).getBoundingClientRect().height + (e.key === "ArrowDown" ? 1 : -1) * step * 4);
      if (axis === "y" && (e.key === "Delete" || e.key === "Backspace")) d = height(null);
      if (!d) return;
      e.preventDefault();
      store(d);
      focusHandle(axis, id);
    });
    if (axis === "y") el.addEventListener("dblclick", () => store(height(null)));
    return el;
  }
  const focusHandle = (axis, id) => panel(id).querySelector(`.dk-${axis}`)?.focus();

  /** Move a panel next to another one (left/right), into a new row (above/below), or swap with it (middle). */
  function moveTo(id, target, zone) {
    const d = model();
    if (id === target) return;
    const [ri, ii] = where(d, id);
    const it = d.rows[ri].items.splice(ii, 1)[0];
    if (zone === "swap") {
      const [tr, ti] = where(d, target);
      const t = d.rows[tr].items[ti];
      d.rows[tr].items[ti] = { id, w: t.w };
      d.rows[ri].items.splice(ii, 0, { id: target, w: it.w });
    } else if (target == null) {
      d.rows.push({ h: 0, items: [it] });
    } else {
      const [tr, ti] = where(d, target);
      const row = d.rows[tr];
      if (zone === "left" || zone === "right") {
        const share = row.items.reduce((s, x) => s + x.w, 0) / row.items.length; // arrive at an average width
        row.items.splice(zone === "left" ? ti : ti + 1, 0, { id, w: share });
      } else d.rows.splice(zone === "top" ? tr : tr + 1, 0, { h: 0, items: [{ id, w: 1 }] });
    }
    d.rows = d.rows.filter((r) => r.items.length);
    store(d);
  }

  /** Arrow keys on a focused title bar: left/right swaps with the neighbour, up/down moves to the next row. */
  function keyMove(id, key) {
    const d = model();
    const rows = d.rows;
    const [ri, ii] = where(d, id);
    const row = rows[ri];
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const j = ii + (key === "ArrowRight" ? 1 : -1);
      if (j < 0 || j >= row.items.length) return;
      [row.items[ii], row.items[j]] = [row.items[j], row.items[ii]];
    } else {
      const it = row.items.splice(ii, 1)[0];
      const to = ri + (key === "ArrowDown" ? 1 : -1);
      if (to < 0 || to >= rows.length) rows.splice(to < 0 ? 0 : rows.length, 0, { h: 0, items: [it] });
      else rows[to].items.push(it);
      d.rows = rows.filter((r) => r.items.length);
    }
    store(d);
    panel(id).querySelector(".ph").focus();
  }

  let drag = null;
  function zoneAt(x, y) {
    const els = document.elementsFromPoint(x, y);
    const p = els.map((e) => e.closest?.("#panels > .panel")).find((e) => e && e.id !== drag?.id && !e.classList.contains("dock-hidden"));
    if (!p) return main().contains(els[0]) || els[0] === main() ? { target: null, zone: "end", rect: null } : null;
    const r = p.getBoundingClientRect();
    const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
    const zone = fx < 0.25 ? "left" : fx > 0.75 ? "right" : fy < 0.3 ? "top" : fy > 0.7 ? "bottom" : "swap";
    return { target: p.id, zone, rect: r };
  }
  function showDrop(z) {
    const box = $("#dkDrop");
    if (!z) { box.hidden = true; return; }
    const r = z.rect ?? main().getBoundingClientRect();
    const k = { left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5], swap: [0, 0, 1, 1], end: [0, 0.85, 1, 0.15] }[z.zone];
    Object.assign(box.style, { left: `${r.left + k[0] * r.width}px`, top: `${r.top + k[1] * r.height}px`, width: `${k[2] * r.width}px`, height: `${k[3] * r.height}px` });
    box.dataset.zone = z.zone;
    box.hidden = false;
  }

  function startDrag(e) {
    if (!editing || e.button > 0 || e.target.closest("button, .dk-h")) return;
    const p = e.currentTarget.closest(".panel");
    e.preventDefault();
    const ghost = h("div", { class: "dk-ghost" }, NAMES[p.id]);
    document.body.append(ghost);
    drag = { id: p.id, ghost, z: null };
    p.classList.add("dk-moving");
    const move = (ev) => {
      Object.assign(ghost.style, { left: `${ev.clientX + 12}px`, top: `${ev.clientY + 12}px` });
      drag.z = zoneAt(ev.clientX, ev.clientY);
      showDrop(drag.z);
    };
    const up = () => {
      removeEventListener("pointermove", move);
      ghost.remove();
      p.classList.remove("dk-moving");
      showDrop(null);
      const z = drag.z;
      const id = drag.id;
      drag = null;
      if (z) moveTo(id, z.target, z.target == null ? "end" : z.zone);
    };
    move(e);
    addEventListener("pointermove", move);
    addEventListener("pointerup", up, { once: true });
    addEventListener("pointercancel", up, { once: true });
  }

  function paintBar() {
    const d = model() ?? DEFAULT();
    const chips = $("#dkHidden");
    chips.replaceChildren(...d.hidden.map((id) => h("button", { type: "button", class: "dk-chip", title: `Show ${NAMES[id]} again`, onclick: () => { const m = model(); m.hidden = m.hidden.filter((x) => x !== id); store(m); } }, icon("plus"), NAMES[id])));
    $("#dkHiddenWrap").hidden = !d.hidden.length;
  }

  function edit(on) {
    editing = on && wide();
    document.documentElement.toggleAttribute("data-editing", editing);
    $("#dkBar").hidden = !editing;
    $("#btnLayout").setAttribute("aria-pressed", String(editing));
    if (editing && !prefs.dock) { prefs.dock = DEFAULT(); save(); }
    for (const id of IDS) {
      const ph = panel(id).querySelector(".ph");
      ph.tabIndex = editing ? 0 : -1;
      let x = ph.querySelector(".dk-hide");
      if (editing && !x) {
        x = h("button", { type: "button", class: "icon dk-hide", "aria-label": `Hide ${NAMES[id]}`, title: "Hide this panel" }, icon("close"));
        x.addEventListener("click", () => { const m = model(); m.hidden = [...new Set([...m.hidden, id])]; store(m); });
        ph.querySelector(".expand").before(x);
      }
      if (x) x.hidden = !editing;
    }
    if (!editing) $$(".dk-h").forEach((x) => x.remove());
    apply();
    paintBar();
  }

  function bind() {
    for (const id of IDS) {
      const ph = panel(id).querySelector(".ph");
      ph.addEventListener("pointerdown", startDrag);
      ph.addEventListener("keydown", (e) => { if (editing && e.target === ph && /^Arrow/.test(e.key)) { e.preventDefault(); keyMove(id, e.key); } });
    }
    $("#btnLayout").replaceChildren(icon("display"), h("span", {}, "Layout"));
    $("#btnLayout").addEventListener("click", () => edit(!editing));
    $("#dkDone").addEventListener("click", () => edit(false));
    $("#dkReset").addEventListener("click", () => store(DEFAULT()));
    addEventListener("keydown", (e) => { if (editing && e.key === "Escape" && !document.querySelector("dialog[open]")) edit(false); });
  }

  return { apply, edit, bind, get editing() { return editing; }, paintBar };
}
