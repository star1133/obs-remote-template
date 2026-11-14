import { ICONS, icon } from "./icons.js";

const $ = (s) => document.querySelector(s);
const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

$("#grid").replaceChildren(...Object.keys(ICONS).map((n) => h("div", { class: "cell" }, icon(n), h("span", {}, n))));

$("#sizes").replaceChildren(...[14, 18, 24, 32, 48, 72].flatMap((px) =>
  ["scenes", "audio", "live", "game"].map((n) => {
    const i = icon(n);
    i.style.width = i.style.height = px + "px";
    return i;
  })));

const sample = ["scenes", "audio", "sources", "live", "mic", "speaker", "game", "music", "globe", "record", "replay", "cpu", "disk", "signal", "phone", "tablet", "desktop"];
for (const id of ["paper", "night"]) $("#" + id).replaceChildren(...sample.map((n) => icon(n)));

const state = (label, node) => h("div", { class: "lab" }, node, h("span", {}, label));
// `.ch.muted` is what draws the slash on the volume icon, same as in the mixer.
const muted = h("div", { class: "ch muted bare" }, icon("volume"));
$("#anim").replaceChildren(
  state("live (on air)", icon("live", "anim")),
  state("record (rec)", icon("record", "anim")),
  state("logo", icon("logo", "anim")),
  state("replay armed", icon("replay", "anim")),
  state("unmuted", icon("volume")),
  state("muted", muted),
);

$("#btns").replaceChildren(
  h("button", { class: "big" }, icon("live"), h("span", {}, "Hold to go live")),
  h("button", { class: "big" }, icon("record"), h("span", {}, "Start recording")),
  h("button", {}, icon("replay"), h("span", {}, "Start buffer")),
  h("button", {}, icon("save"), h("span", {}, "Save replay")),
  h("button", { class: "icon", "aria-label": "Display" }, icon("display")),
  h("button", { class: "icon", "aria-label": "Enlarge" }, icon("expand")),
);
