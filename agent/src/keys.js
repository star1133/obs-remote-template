// Slide keys for PowerPoint / PDF windows that OBS captures. Only these four fixed keys can ever be sent
// (no text from the network reaches the command line), and only when the owner turned the option on.
import { spawn } from "node:child_process";

const KEYS = { next: "{PGDN}", prev: "{PGUP}", first: "{HOME}", last: "{END}" };
export const SLIDE_KEYS = new Set(Object.keys(KEYS));

export function sendSlideKey(name) {
  const k = KEYS[name];
  if (!k) return Promise.reject(new Error("bad key"));
  if (process.platform !== "win32") return Promise.reject(new Error("keys unsupported on this OS"));
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${k}')`;
  return new Promise((resolve, reject) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, stdio: "ignore" });
    const t = setTimeout(() => { p.kill(); reject(new Error("key timeout")); }, 5000);
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("exit", (c) => { clearTimeout(t); c ? reject(new Error("key failed")) : resolve(); });
  });
}
