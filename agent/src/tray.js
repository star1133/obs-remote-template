// Notification-area (system tray) icon with a right-click menu, so the whole system can be quit without a window.
// Windows has no tray API in Node, so a small hidden PowerShell process hosts the icon and talks to us over the
// local setup server. It exits by itself when the agent stops answering.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIR, SETUP_PORT } from "./config.js";
import { ICO_B64 } from "./icon-data.js";

const SCRIPT = String.raw`
param([int]$Port, [switch]$Notify)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$base = "http://127.0.0.1:$Port"
function Csrf { ((Invoke-WebRequest -UseBasicParsing "$base/" -TimeoutSec 3).Content | Select-String 'name="csrf" content="([0-9a-f]+)"').Matches[0].Groups[1].Value }
function Api($path, $body = '{}') { try { Invoke-RestMethod -Method Post "$base$path" -Headers @{ 'x-obsr-csrf' = (Csrf) } -ContentType 'application/json' -Body $body -TimeoutSec 5 | Out-Null } catch {} }

# The OBS Remote icon (written next to this script); Windows picks the size that fits the notification area.
$icon = New-Object System.Drawing.Icon ((Join-Path $PSScriptRoot 'icon.ico'), [System.Windows.Forms.SystemInformation]::SmallIconSize)

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = 'OBS Remote'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$null = $menu.Items.Add('Open the control page', $null, { Api '/api/open' })
$null = $menu.Items.Add('Show QR code / settings', $null, { Start-Process "$base/" })
$null = $menu.Items.Add('-')
$null = $menu.Items.Add('Quit OBS Remote', $null, { Api '/api/quit'; $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$null = $menu.Items.Add('Quit and do not start with Windows', $null, { Api '/api/quit' '{"noStartup":true}'; $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$ni.ContextMenuStrip = $menu
$ni.add_DoubleClick({ Api '/api/open' })
$ni.Visible = $true
if ($Notify) { $ni.ShowBalloonTip(3000, 'OBS Remote is running', 'Right-click this icon to open the control page or quit. In OBS: Docks > OBS Remote.', 'Info') }

# Leave when the agent is gone.
$fails = 0
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 3000
$t.add_Tick({
  try { Invoke-WebRequest -UseBasicParsing "$base/api/ping" -TimeoutSec 2 | Out-Null; $script:fails = 0 }
  catch { $script:fails++; if ($script:fails -ge 2) { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() } }
})
$t.Start()
[System.Windows.Forms.Application]::Run()
$ni.Dispose()
`;

/** Start the tray icon. Returns a handle with stop(). No-op off Windows or when OBSR_NO_TRAY=1 (tests). */
export function startTray({ notify = false, log = () => {} } = {}) {
  if (process.platform !== "win32" || process.env.OBSR_NO_TRAY === "1") return { stop() {} };
  try {
    mkdirSync(DIR, { recursive: true });
    const file = join(DIR, "tray.ps1");
    writeFileSync(file, "\ufeff" + SCRIPT); // BOM so PowerShell reads it as UTF-8
    const args = ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", file, "-Port", String(SETUP_PORT)];
    if (notify) args.push("-Notify");
    const child = spawn("powershell.exe", args, { windowsHide: true, stdio: "ignore" });
    child.on("error", (e) => log("tray: " + e.message));
    return { stop() { try { child.kill(); } catch { /* already gone */ } } };
  } catch (e) {
    log("tray: " + e.message);
    return { stop() {} };
  }
}
