// Builds dist/OBS-Remote-Setup.exe: one double-clickable file (Node single-executable app).
//   RELAY_URL=https://obs-remote.you.workers.dev [REG_KEY=...] node build.mjs
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const relay = (process.env.RELAY_URL ?? "").trim().replace(/\/+$/, "");
const key = process.env.REG_KEY ?? "";
if (relay && !/^https:\/\/[^\s/]+$/i.test(relay) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(relay)) {
  console.error(`RELAY_URL must look like https://name.workers.dev (got "${relay}")`);
  process.exit(1);
}
if (!relay) console.log("No RELAY_URL: this installer makes each computer its own relay with a free public link (no Cloudflare account).\n");

mkdirSync(dist, { recursive: true });
// The phone UI travels inside the exe so the local relay can serve it.
const pub = join(root, "../relay/public");
const assets = Object.fromEntries(readdirSync(pub).filter((f) => /\.(html|js|css|svg|webmanifest|png|ico)$/.test(f)).map((f) => [f, readFileSync(join(pub, f)).toString("base64")]));
const ui = Object.fromEntries(["html", "js", "css"].map((e) => [e === "html" ? "page" : e === "js" ? "script" : "style", readFileSync(join(root, "src/ui", `setup.${e}`), "utf8")]));

await build({
  entryPoints: [join(root, "src/main.js")],
  outfile: join(dist, "obs-remote.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node24", minify: false, logLevel: "error",
  define: { __VERSION__: JSON.stringify(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version), __RELAY__: JSON.stringify(relay), __REGKEY__: JSON.stringify(key), __UI__: JSON.stringify(ui), __ASSETS__: JSON.stringify(assets) },
});

writeFileSync(join(dist, "sea-config.json"), JSON.stringify({ main: join(dist, "obs-remote.cjs"), output: join(dist, "sea.blob"), disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", join(dist, "sea-config.json")], { stdio: "inherit" });

const exe = join(dist, "OBS-Remote-Setup.exe");
copyFileSync(process.execPath, exe);
// Icon + version info first (rcedit rewrites resources), then the app blob goes in.
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const { rcedit } = await import("rcedit");
await rcedit(exe, {
  icon: join(root, "assets/icon.ico"),
  "version-string": { ProductName: "OBS Remote", FileDescription: "OBS Remote", CompanyName: "OBS Remote", InternalName: "OBS Remote", OriginalFilename: "OBS-Remote-Setup.exe", LegalCopyright: "OBS Remote" },
  "file-version": `${version}.0`, "product-version": `${version}.0`,
});
execFileSync(process.execPath, [join(root, "node_modules/postject/dist/cli.js"), exe, "NODE_SEA_BLOB", join(dist, "sea.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { stdio: "inherit" });

console.log(`\nBuilt ${exe} (${(statSync(exe).size / 1048576).toFixed(0)} MB)${relay ? `, relay ${relay}` : ""}`);
