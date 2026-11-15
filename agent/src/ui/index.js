// The setup page files. build.mjs inlines them (__UI__) so the exe needs no loose files.
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

export const ui = typeof __UI__ !== "undefined"
  ? __UI__
  : { page: read("./setup.html"), script: read("./setup.js"), style: read("./setup.css"), ytPage: read("./yt.html"), ytScript: read("./yt.js"), ytStyle: read("./yt.css") };
