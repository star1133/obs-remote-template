// Publishes the built installer as a GitHub release and writes the manifest (version, size, checksum) to
// relay/public/dl/manifest.json (ignored by git).
//   OBSR_RELEASE_REPO=owner/name node tools/publish-download.mjs     (needs `gh auth login`)
// Without OBSR_RELEASE_REPO only the manifest is written.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.OBSR_RELEASE_REPO || "";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "agent/dist/OBS-Remote-Setup.exe");
const exe = readFileSync(file);
const version = JSON.parse(readFileSync(join(root, "agent/package.json"), "utf8")).version;
const sha256 = createHash("sha256").update(exe).digest("hex");
const tag = `v${version}`;

if (REPO) {
  const gh = (...args) => execFileSync("gh", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
  let exists = true;
  try { gh("release", "view", tag, "--repo", REPO); } catch { exists = false; }
  const notes = `Windows 10/11, 64-bit. Double-click to install.\n\nSHA-256: \`${sha256}\`\n\n` +
    "Windows may show a SmartScreen warning because the installer is not code-signed: choose More info, then Run anyway.";
  if (exists) { // same version rebuilt: replace the file and the checksum in the notes
    gh("release", "upload", tag, file, "--repo", REPO, "--clobber");
    gh("release", "edit", tag, "--repo", REPO, "--notes", notes);
  } else gh("release", "create", tag, file, "--repo", REPO, "--title", `OBS Remote ${version}`, "--notes", notes);
} else console.log("OBSR_RELEASE_REPO is not set: skipped the GitHub release");

const dir = join(root, "relay/public/dl");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "OBS-Remote-Setup.exe", version, size: exe.length, sha256,
  url: REPO ? `https://github.com/${REPO}/releases/download/${tag}/OBS-Remote-Setup.exe` : "" }));
console.log(`${tag}${REPO ? ` on github.com/${REPO}` : ""}, ${(exe.length / 1048576).toFixed(1)} MB, sha256 ${sha256}`);
