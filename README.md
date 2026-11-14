# OBS Remote — คุม OBS จากมือถือ/iPad ที่ไหนก็ได้

โค้ดต้นแบบ (template) สำหรับทำระบบคุม OBS ผ่านเว็บ เปิดเผยภายใต้สัญญาอนุญาต [MIT](LICENSE) นำไปใช้ แก้ไข หรือแจกต่อได้ ไม่ได้ผูกกับเซิร์ฟเวอร์ของใคร: รันในเครื่องอย่างเดียว หรือ deploy relay ขึ้นบัญชี Cloudflare ของคุณเอง

*A template for controlling OBS Studio from a phone or tablet: Windows agent, web UI, and a relay you deploy to your own Cloudflare account. MIT licensed.*

หน้าตาเหมือน OBS (Scenes / Sources / Audio Mixer / Scene Transitions / Controls, Studio Mode แบบ Preview–Program, แถบสถานะล่าง) ใช้ได้ทั้งโทรศัพท์ (แท็บ กะทัดรัด) และ iPad/คอม (แดชบอร์ดเต็ม)

```
มือถือ/iPad ──https──►  Cloudflare Worker (relay)  ◄──wss──  OBS Remote agent  ──ws://127.0.0.1:4455──►  OBS
   (เว็บ UI)            ลิงก์สาธารณะ, จับคู่ด้วย QR          (โปรแกรมเล็กๆ บนคอมที่เปิด OBS)          (obs-websocket ที่มีใน OBS อยู่แล้ว)
```

ไม่ต้องใส่ไฟล์ปลั๊กอินเข้า OBS — ตัวติดตั้งตั้งค่า OBS ให้เอง และเพิ่ม **dock "OBS Remote"** ใน OBS (เมนู Docks) ที่แสดง QR/สถานะ

## ใช้งาน (ผู้ใช้ทั่วไป) — 3 ขั้นตอน

1. ดับเบิลคลิก **`OBS-Remote-Setup.exe`** (ปิด OBS ก่อนจะดีที่สุด)
   - ติดตั้งโปรแกรมที่ `%LOCALAPPDATA%\OBS Remote`, ตั้งให้เปิดอัตโนมัติพร้อม Windows
   - เปิด WebSocket ของ OBS ให้ (ถ้าเปิดอยู่แล้วจะไม่แตะรหัสผ่านเดิม)
   - เพิ่ม dock "OBS Remote" ใน OBS
2. เปิด OBS → จะเห็น dock **OBS Remote** (ถ้าไม่เห็น: เมนู *Docks → OBS Remote*) แสดง QR
3. ใช้กล้องมือถือสแกน QR → เปิดหน้าควบคุมได้เลย ทุกเครือข่าย (4G/ไวไฟอื่น) พอจับคู่สำเร็จ QR จะซ่อนเอง (กด "Add another device" เพื่อเพิ่มเครื่องอื่น)

แชร์ให้คนอื่น: ในหน้าควบคุม → ⚙ Settings → *Share access* → สร้างลิงก์ "ควบคุมได้" หรือ "ดูอย่างเดียว" (ใช้ได้ครั้งเดียว, 5 นาที) และกด Remove เพื่อถอนสิทธิ์ได้

ถอนการติดตั้ง: `%LOCALAPPDATA%\OBS Remote\obs-remote.exe uninstall` (ลบ dock, ปุ่มเริ่มอัตโนมัติ และไฟล์ทั้งหมด)

## แบบไม่ต้องมีบัญชี Cloudflare (ลิงก์ชั่วคราว)

ดับเบิลคลิก **`build-installer.cmd`** แล้วเอา `OBS-Remote-Setup.exe` ไปติดตั้ง — ตัวโปรแกรมจะเป็น relay ของตัวเองบนคอมที่เปิด OBS และเปิดลิงก์สาธารณะด้วย Cloudflare Quick Tunnel (โหลด `cloudflared` ครั้งแรกอัตโนมัติ ~60 MB)
- ลิงก์ (`xxxx.trycloudflare.com`) **เปลี่ยนทุกครั้งที่เปิดโปรแกรมใหม่** ต้องสแกน QR ใหม่ (ปุ่ม *Open the control page* ใน dock เปิดหน้าเว็บบนคอมเครื่องนั้นได้เลย)
- ต้องเปิดคอมและโปรแกรมทิ้งไว้ ถ้าแอนตี้ไวรัสสแกน HTTPS (เช่น Avast Web Shield) อาจบล็อกอุโมงค์ — หน้า setup จะแจ้งสถานะ "Public link"
- ยังไม่ได้ยืนยันปลายทางจริงว่าลิงก์สาธารณะเปิดหน้าเว็บได้ (ดูสรุปงาน)

## ตั้งค่าครั้งแรก (เจ้าของระบบ — ทำครั้งเดียว) แบบใช้ Cloudflare

ต้องมี [Node.js 22+](https://nodejs.org) และบัญชี Cloudflare (ฟรีพอ)

ดับเบิลคลิก **`publish.cmd`** — มันจะ: ติดตั้งเครื่องมือ → ให้ล็อกอิน Cloudflare (เปิดเบราว์เซอร์) → deploy relay → สร้าง `OBS-Remote-Setup.exe` ที่ฝังลิงก์ relay ของคุณไว้แล้ว

แล้วเอา `.exe` ไปดับเบิลคลิกบนคอมเครื่องไหนก็ได้ (หลายเครื่องใช้ relay เดียวกันได้ แต่ละเครื่องได้ห้องของตัวเอง)

> exe ไม่ได้เซ็นดิจิทัล: Windows SmartScreen อาจเตือน "Windows protected your PC" → *More info → Run anyway*
>
> อยากจำกัดว่าใครสร้างห้องบน relay ได้: `cd relay && npx wrangler secret put REGISTRATION_KEY` แล้ว build ด้วย `set REG_KEY=...` (ดู `agent/build.mjs`)

## ตรวจว่าระบบพร้อมไหม

| ดูอะไร | ที่ไหน |
|---|---|
| OBS / Relay / จำนวนอุปกรณ์ | dock ใน OBS หรือ `http://127.0.0.1:47890/` บนคอมนั้น |
| สถานะจากบรรทัดคำสั่ง | `obs-remote.exe status` |
| log ของ agent | `%LOCALAPPDATA%\OBS Remote\agent.log` |
| log/diagnostics ฝั่งมือถือ | ⚙ Settings → Diagnostics → Copy |
| ลองหน้า UI โดยไม่ต้องมี OBS | `https://<relay>/?demo` |

ปัญหาที่เจอบ่อย
- **"waiting for OBS"** — OBS ยังไม่เปิด หรือ WebSocket ปิดอยู่ (OBS → Tools → WebSocket Server Settings → Enable)
- **"wrong WebSocket password"** — ใส่รหัสผ่านที่ช่อง *obs-websocket password* ในหน้า setup
- **ไม่เห็น dock** — ติดตั้งตอน OBS เปิดอยู่ ให้ปิด OBS แล้วรัน installer อีกครั้ง หรือ OBS → Docks → Custom Browser Docks → ชื่อ `OBS Remote`, URL `http://127.0.0.1:47890/dock`
- **มือถือเข้าไม่ได้ / หลุดบ่อย** — เปิด Settings → Diagnostics ดู `relay rtt` และ `reconnects`

## ความปลอดภัย (สรุป)
- หน้า setup ฟังที่ `127.0.0.1` เท่านั้น มีตรวจ Host/Origin + โทเคน CSRF
- มือถือจับคู่ด้วยโค้ด 6 หลักใช้ได้ครั้งเดียว/5 นาที (ผิดเกิน 10 ครั้งล็อกชั่วคราว); โทเคนเก็บแบบแฮชบน relay
- agent ส่งต่อได้เฉพาะคำสั่งใน allowlist (เปลี่ยนซีน, มิกเซอร์, สตรีม/อัด, Studio Mode ฯลฯ) — ไม่มีคำสั่งลบ/แก้ไฟล์
- เริ่ม/หยุดสตรีมต้อง **กดค้าง** เพื่อยืนยัน
- บัญชี `viewer` ดูได้อย่างเดียว (ฝั่ง relay บังคับ)

## โครงสร้างโปรเจกต์
- `relay/` — Cloudflare Worker + Durable Object + หน้าเว็บ (`public/`) · `npm test` (ต้องรัน `npx wrangler dev` ไว้)
- `agent/` — โปรแกรมบนคอม OBS · `npm test` (e2e กับ OBS จำลอง + relay) · `node build.mjs` สร้าง exe
- `PLAN.md` — แผนและรายละเอียดโปรโตคอล

## พัฒนา/ทดสอบ
```
cd relay && npm install && npx wrangler dev        # relay ที่ http://127.0.0.1:8787  (เปิด /?demo ดู UI)
cd relay && npm test                               # ทดสอบ relay + โปรโตคอล
cd agent && npm install && npm test                # agent ↔ OBS จำลอง ↔ relay
cd agent && node test/dock.mjs                     # ทดสอบการเพิ่ม dock (ใช้ไฟล์ชั่วคราว)
cd agent && RELAY_URL=http://127.0.0.1:8787 node build.mjs
```
ทดสอบกับ OBS จริงแล้ว (OBS 33): snapshot ซีน/มิกเซอร์/ทรานซิชัน, Studio Mode, T-bar, พรีวิว, dock ใน OBS

รู้ข้อจำกัด: ตอนนี้ Windows เท่านั้น · T-bar ของ OBS ผ่าน WebSocket ไม่ commit เอง agent จึงทำขั้นตอนเสริมให้ (ดู `agent/src/bridge.js`) · ภาพพรีวิวเป็น screenshot JPEG ~2–4 fps ไม่ใช่วิดีโอสด

## ตั้งเซิร์ฟเวอร์ของตัวเอง

1. กด **Use this template** (หรือ fork) แล้ว clone ลงเครื่อง
2. ดับเบิลคลิก `publish.cmd` มันจะ deploy relay กับหน้าควบคุมขึ้น Cloudflare ของคุณ (ได้ที่อยู่ `https://obs-remote.<บัญชีคุณ>.workers.dev`) แล้ว build ตัวติดตั้งที่ชี้ไปที่อยู่นั้น
3. ตัวเลือกเพิ่มเติม:
   - **โดเมนของคุณเอง:** เปิดบรรทัด `routes` ใน `relay/wrangler.jsonc` แล้วตั้ง `OBSR_DOMAIN=obs.example.com` ก่อนรัน
   - **ปล่อยไฟล์ติดตั้งบน GitHub Releases:** ตั้ง `OBSR_RELEASE_REPO=ชื่อบัญชี/ชื่อrepo` (ต้อง `gh auth login`) และใส่ `INSTALLER_URL` ใน `vars` ของ `relay/wrangler.jsonc` ให้ลิงก์ `/download/OBS-Remote-Setup.exe` พาไปที่ไฟล์นั้น
   - **จำกัดว่าใครสร้างห้องได้:** `npx wrangler secret put REGISTRATION_KEY` แล้ว build ตัวติดตั้งด้วย `REG_KEY=...`
     เมื่อตั้งคีย์แล้ว เซิร์ฟเวอร์ไม่รับห้องใหม่ที่ไม่มีคีย์ และรหัสห้องจะมีลายเซ็นจากคีย์นั้น ห้องที่แต่งขึ้นมาจะถูกปฏิเสธก่อนถึง Durable Object จึงไม่กินโควตา (ห้องที่สร้างก่อนตั้งคีย์ใส่ไว้ใน `vars.LEGACY_ROOMS`)

ภาพพรีวิวทุกภาพวิ่งผ่าน Durable Object ของคุณ ถ้ามีคนใช้เยอะ โควตาฟรีของ Cloudflare จะหมดเร็ว (ดู [ราคา Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing))

ไม่ใช่ผลิตภัณฑ์ทางการของ OBS Project

## License

[MIT](LICENSE)
