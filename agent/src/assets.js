// The phone web UI (relay/public), served by the local relay. build.mjs inlines it (__ASSETS__) so the exe is one file.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contentType } from "./localrelay.js";

/** Returns path -> { type, body } | null. Only files that exist in the table can be served (no path tricks). */
export function loadAssets() {
  const table = new Map();
  if (typeof __ASSETS__ !== "undefined") {
    for (const [name, b64] of Object.entries(__ASSETS__)) table.set("/" + name, Buffer.from(b64, "base64"));
  } else {
    const dir = new URL("../../relay/public/", import.meta.url);
    for (const f of readdirSync(fileURLToPath(dir))) if (/\.(html|js|css|svg|webmanifest|png|ico)$/.test(f)) table.set("/" + f, readFileSync(new URL(f, dir)));
  }
  return (path) => {
    const body = table.get(path);
    return body ? { type: contentType(path), body } : null;
  };
}
