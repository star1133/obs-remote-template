# OBS Remote — คุม OBS จากมือถือ/iPad ที่ไหนก็ได้

โค้ดต้นแบบ (template) สำหรับทำระบบคุม OBS ผ่านเว็บ เปิดเผยภายใต้สัญญาอนุญาต [MIT](LICENSE) นำไปใช้ แก้ไข หรือแจกต่อได้ ไม่ได้ผูกกับเซิร์ฟเวอร์ของใคร: รันในเครื่องอย่างเดียว หรือ deploy relay ขึ้นบัญชี Cloudflare ของคุณเอง

*A template for controlling OBS Studio from a phone or tablet: Windows agent, web UI, and a relay you deploy to your own Cloudflare account. MIT licensed.*

หน้าตาเหมือน OBS (Scenes / Sources / Audio Mixer / Scene Transitions / Controls, Studio Mode แบบ Preview–Program, แถบสถานะล่าง) ใช้ได้ทั้งโทรศัพท์ (แท็บ กะทัดรัด) และ iPad/คอม (แดชบอร์ดเต็ม)

```
มือถือ/iPad ──https──►  Cloudflare Worker (relay)  ◄──wss──  OBS Remote agent  ──ws://127.0.0.1:4455──►  OBS
   (เว็บ UI)            ลิงก์สาธารณะ, จับคู่ด้วย QR          (โปรแกรมเล็กๆ บนคอมที่เปิด OBS)          (obs-websocket ที่มีใน OBS อยู่แล้ว)
```

ไม่ต้องใส่ไฟล์ปลั๊กอินเข้า OBS — ตัวติดตั้งตั้งค่า OBS ให้เอง ส่วนการตั้งค่า (QR, สถานะ, อุปกรณ์) อยู่ใน **หน้าต่าง OBS Remote** โปรแกรมเล็กๆ แยกจาก OBS (ไม่ใช่หน้าเว็บ ใช้แรมราว 20 MB) เปิดจาก OBS → Tools → OBS Remote (ไม่มีไอคอนบนเดสก์ท็อป เปิดแค่ OBS พอ)

## ใช้งาน (ผู้ใช้ทั่วไป) — 3 ขั้นตอน

1. ดับเบิลคลิก **`OBS-Remote-Setup.exe`** ครั้งเดียว (ถ้า OBS เปิดอยู่ ตัวติดตั้งจะรอให้ปิดก่อน แล้วเปิด OBS ให้ใหม่ตอนเสร็จ)
   - ติดตั้งโปรแกรมที่ `%LOCALAPPDATA%\OBS Remote` และปลั๊กอิน OBS ที่ `%ProgramData%\obs-studio\plugins\obs-remote` (ไม่ต้องใช้สิทธิ์ admin)
   - ปลั๊กอินเปิด OBS Remote พร้อม OBS และปิดตามเมื่อปิด OBS ไม่มีไอคอนข้างนาฬิกา ไม่เปิดพร้อม Windows
   - เปิด WebSocket ของ OBS ให้ (ถ้าเปิดอยู่แล้วจะไม่แตะรหัสผ่านเดิม)
2. เปิด OBS แล้วเปิดหน้าต่าง **OBS Remote** (OBS → *Tools → OBS Remote*) → เลือกสิทธิ์ → **Show code**
3. ใช้กล้องมือถือสแกน QR → เปิดหน้าควบคุมได้เลย ทุกเครือข่าย (4G/ไวไฟอื่น) พอจับคู่สำเร็จ QR จะซ่อนเอง

แชร์ให้คนอื่น: ในหน้าควบคุม → ⚙ Settings → *Share access* → สร้างลิงก์ "ควบคุมได้" หรือ "ดูอย่างเดียว" (ใช้ได้ครั้งเดียว, 5 นาที) และกด Remove เพื่อถอนสิทธิ์ได้

อัปเดต: ถ้า build ด้วย `set UPDATE_REPO=<owner>/<repo>` (repo ที่มี release ชื่อไฟล์ `OBS-Remote-Setup.exe`) หน้าต่าง OBS Remote จะแจ้งเมื่อมีรุ่นใหม่ กด **Update now** ครั้งเดียว โปรแกรมโหลดตัวติดตั้งจาก GitHub ตรวจ SHA-256 แล้วติดตั้งทับเงียบๆ โดยเก็บห้องและการจับคู่เดิมไว้ ไม่ต้องปิด OBS

ถอนการติดตั้ง: Settings ของ Windows → Apps → OBS Remote หรือ `%LOCALAPPDATA%\OBS Remote\obs-remote.exe uninstall` (ลบปลั๊กอิน ไอคอน และไฟล์ทั้งหมด) หรือกด *Uninstall…* ในหน้าต่าง OBS Remote

## แบบไม่ต้องมีบัญชี Cloudflare (ลิงก์ชั่วคราว)

ดับเบิลคลิก **`build-installer.cmd`** แล้วเอา `OBS-Remote-Setup.exe` ไปติดตั้ง — ตัวโปรแกรมจะเป็น relay ของตัวเองบนคอมที่เปิด OBS และเปิดลิงก์สาธารณะด้วย Cloudflare Quick Tunnel (โหลด `cloudflared` ครั้งแรกอัตโนมัติ ~60 MB)
- ลิงก์ (`xxxx.trycloudflare.com`) **อยู่ได้จนกว่าจะรีสตาร์ตคอม**: ปิดแล้วเปิด OBS ใหม่ อัปเดตโปรแกรม หรือเน็ตหลุดแล้วกลับมา ก็ยังเป็นลิงก์เดิม มือถือที่จับคู่ไว้ใช้ต่อได้เลย (อุโมงค์ทำงานต่อหลังปิด OBS เพื่อเก็บลิงก์ไว้ กด *Quit* หรือ Uninstall เพื่อปิด) ถ้ารีสตาร์ตคอมจะได้ลิงก์ใหม่ ต้องสแกน QR ใหม่ (ปุ่ม *Open the control page on this computer* ในหน้าต่าง OBS Remote เปิดหน้าเว็บบนคอมเครื่องนั้นได้เลย)
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
| OBS / Relay / จำนวนอุปกรณ์ | หน้าต่าง OBS Remote หรือ `http://127.0.0.1:47890/` บนคอมนั้น |
| สถานะจากบรรทัดคำสั่ง | `obs-remote.exe status` |
| log ของ agent | `%LOCALAPPDATA%\OBS Remote\agent.log` |
| log/diagnostics ฝั่งมือถือ | ⚙ Settings → Diagnostics → Copy |
| ลองหน้า UI โดยไม่ต้องมี OBS | `https://<relay>/?demo` |

ปัญหาที่เจอบ่อย
- **"waiting for OBS"** — OBS ยังไม่เปิด หรือ WebSocket ปิดอยู่ (OBS → Tools → WebSocket Server Settings → Enable)
- **"wrong WebSocket password"** — ใส่รหัสผ่านที่ช่อง *obs-websocket password* ในหน้าต่าง OBS Remote
- **ไม่เห็นเมนู Tools → OBS Remote** — ปลั๊กอินเริ่มทำงานตอนเปิด OBS ใหม่ ปิดแล้วเปิด OBS อีกครั้ง หรือดับเบิลคลิก `%LOCALAPPDATA%\OBS Remote\obs-remote.exe`
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
- `agent/plugin/` — ปลั๊กอิน OBS ตัวเล็ก (C, ไม่ลิงก์ libobs) ที่เปิด/ปิด agent พร้อม OBS · `node build.mjs` คอมไพล์ใหม่ถ้ามี MinGW gcc ไม่งั้นใช้ `obs-remote.dll` ที่ commit ไว้
- `PLAN.md` — แผนและรายละเอียดโปรโตคอล

## พัฒนา/ทดสอบ
```
cd relay && npm install && npx wrangler dev        # relay ที่ http://127.0.0.1:8787  (เปิด /?demo ดู UI)
cd relay && npm test                               # ทดสอบ relay + โปรโตคอล
cd agent && npm install && npm test                # agent ↔ OBS จำลอง ↔ relay
cd agent && node test/dock.mjs                     # ทดสอบการเขียน/ลบ dock เก่าใน config ของ OBS (ใช้ไฟล์ชั่วคราว)
cd agent && node test/setup-api.mjs                # หน้าต่างตั้งค่าอ่านสถานะ/รหัสจับคู่ได้ และต้องมีโทเคน
cd agent && node test/update.mjs                   # ปุ่มอัปเดต: เทียบเวอร์ชัน, ตรวจ SHA-256, คำสั่งติดตั้งที่เก็บโหมด/relay เดิม (GitHub จำลอง)
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
