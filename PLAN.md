# OBS Remote Control ผ่าน Cloudflare — แผนงาน (Draft v0.1)

## 0. สรุป

ทำ **ปลั๊กอิน OBS แบบ native (C++)** ที่ต่อ **ออกไปหา** Cloudflare เอง (outbound) จึงไม่ต้องเปิดพอร์ต ไม่ต้อง port-forward
และไม่ต้องอยู่ network เดียวกัน ฝั่งผู้ใช้เข้า **เว็บที่ต้องล็อกอิน** (Cloudflare Pages) แล้วคุยกับ OBS ผ่าน
**Relay บน Cloudflare Workers + Durable Objects**

```
 [Browser / มือถือ]  --WSS-->  [Cloudflare Worker + Durable Object "Room"]  <--WSS--  [OBS Plugin]
   Web UI (Pages)               - ตรวจ auth / token                             - Dock ใน OBS (ตั้งค่า/ควบคุม)
   Login (Access/Passkey)       - ส่งต่อข้อความระหว่าง browser <-> OBS         - เรียก obs-websocket API ภายใน
                                - rate limit, audit log (D1)                    - allowlist คำสั่ง
```

**ทำไมใช้แบบนี้**
- OBS 28+ มี obs-websocket ติดมาอยู่แล้ว และมี **C API (`obs-websocket-api.h`) ให้ปลั๊กอินอื่นเรียก request ได้ทุกตัว**
  (`obs_websocket_call_request`) จึงได้ฟีเจอร์ครบ (ฉาก, เสียง, source, filter, stream, record, video settings ฯลฯ)
  โดยไม่ต้องเขียนเองทีละอย่าง และไม่ต้องเปิดพอร์ต 4455 ออก network
- Durable Object = 1 ห้องต่อ 1 เครื่อง OBS ทำให้ state ตรงกันทุก client และรองรับหลายคนคุมพร้อมกัน
- ทางเลือกที่ง่ายกว่าแต่ไม่ใช่ปลั๊กอิน: `cloudflared` tunnel + Cloudflare Access ครอบ obs-websocket ไว้ (ดูหัวข้อ 9)

---

## 1. ส่วนประกอบ (Components)

| ส่วน | เทคโนโลยี | หน้าที่ |
|---|---|---|
| `plugin/` | C++17, CMake, obs-plugintemplate, Qt6, IXWebSocket (หรือ QtWebSockets) | ต่อ relay, แปลงคำสั่ง → obs-websocket request, ส่ง event กลับ, มี Dock UI |
| `relay/` | Cloudflare Workers (TypeScript) + Durable Objects (WebSocket Hibernation) + D1 | auth, จับคู่อุปกรณ์, ส่งต่อข้อความ, rate limit, audit log |
| `web/` | Cloudflare Pages, Svelte หรือ React + Vite, TypeScript | หน้า login, dashboard ควบคุม, หน้า settings |
| `protocol/` | JSON schema (zod) ใช้ร่วมกัน | นิยามข้อความทั้งหมด + version |

---

## 2. ฟีเจอร์ (ข้อ 1: Web UI ตั้งค่าได้หลายอย่าง)

> **ปรับแนวคิด (v0.2):** ไม่ทำให้ตั้งค่าได้ละเอียดทุกอย่าง แต่ทำให้ **คุมงานได้หลายงานโดยไม่ต้องนั่งเฝ้าจอ**
> = ควบคุมเฉพาะที่ใช้จริง + **ระบบอัตโนมัติ + แจ้งเตือน** ให้ OBS ดูแลตัวเองได้ ส่วนการตั้งค่าละเอียด (filter, transform,
> resolution ฯลฯ) ให้ไปทำใน OBS ตรงๆ

### 2.1 ควบคุม (เท่าที่จำเป็น)
- **ฉาก**: ปุ่มใหญ่ต่อฉาก กดสลับได้ทันที + เลือก transition
- **Source**: เปิด/ปิดเฉพาะตัวที่ผู้ใช้ "ปักหมุด" ไว้ (ไม่โชว์ทั้งหมดให้รก)
- **เสียง**: volume + mute เฉพาะ input ที่ปักหมุด + VU meter
- **Stream / Record / Replay Buffer**: start/stop + เวลาที่ผ่านไป
- **ภาพ preview** เล็กๆ + สุขภาพระบบ (CPU, dropped frames, bitrate, พื้นที่ดิสก์)
- **Preset / Macro**: ปุ่มเดียวทำหลายอย่าง เช่น "เริ่มรายการ" = สลับฉาก Intro → รอ 10 วิ → เปิดไมค์ → ฉาก Main

### 2.2 อัตโนมัติ (หัวใจของ "ไม่ต้องเฝ้าจอ")
- **ตั้งเวลา (Schedule)**: เริ่ม/หยุด stream-record ตามเวลา, สลับฉากตามเวลา (เช่น 19:55 ฉาก "Starting soon", 20:00 เริ่มรายการ)
- **Playlist ฉาก**: วนฉากอัตโนมัติทุก N นาที (เช่น ช่วงพัก/โฆษณา)
- **กฎ (Rules) แบบ "ถ้า...ให้..."** (เลือกจาก template ไม่ต้องเขียนโค้ด):
  - stream หลุด → ลองต่อใหม่อัตโนมัติ / สลับไปฉาก "BRB"
  - ไม่มีเสียงไมค์เกิน X วินาที ขณะ live → แจ้งเตือน
  - กล้อง/source ดำหรือหาย → สลับฉากสำรอง + แจ้งเตือน
  - dropped frames เกิน X% / CPU สูง → แจ้งเตือน
  - ดิสก์เหลือน้อย → แจ้งเตือน / หยุด record
  - ไฟล์วิดีโอ (media source) เล่นจบ → ไปฉากถัดไป
- กฎทำงาน **ในปลั๊กอินบนเครื่อง OBS** → ถึงเน็ตฝั่งเว็บหลุดหรือไม่มีใครเปิดเว็บก็ยังทำงาน

### 2.3 แจ้งเตือน
- ส่งเข้า **Discord / Telegram / LINE (Messaging API) / Web Push** บนมือถือ
- ข้อความมีปุ่มลัด เช่น "สลับไป BRB", "หยุด stream" (ลิงก์เข้าเว็บ ต้องล็อกอินก่อนกด)
- สรุปหลังจบรายการ: ระยะเวลา, dropped frames, ปัญหาที่เกิด

### 2.4 หลายงาน / หลายเครื่อง
- บัญชีเดียวผูก OBS ได้หลายเครื่อง → หน้า **ภาพรวม** เห็นทุกเครื่องในจอเดียว (สถานะ live/record, สุขภาพ, แจ้งเตือนล่าสุด)
- กดเข้าแต่ละเครื่องเพื่อคุมละเอียด

### 2.5 ตัดออก / เลื่อนไปทีหลัง
- Filter, transform, ตั้ง resolution/FPS, profile/scene collection, audio ขั้นสูง → **ทำใน OBS เอง** (อาจเพิ่มทีหลังถ้าจำเป็น)
- หลายผู้ใช้ + สิทธิ์ (Owner / Operator / Viewer) → Phase หลัง

---

## 3. ไม่บั๊กตอนเลือก/ไถ/ปรับ (ข้อ 2)

ปัญหาที่เจอบ่อยในรีโมต OBS: slider กระตุก/เด้งกลับ, ค่าค้าง, สองคนคุมแล้วตีกัน, หลุดแล้ว state ผิด

| ปัญหา | วิธีแก้ |
|---|---|
| ลาก slider แล้วส่งคำสั่งรัว | **Throttle ~30 Hz + latest-wins** (เก็บแค่ค่าล่าสุด ส่งทีละอัน) และส่งค่าสุดท้ายเสมอตอนปล่อยนิ้ว (`pointerup`) |
| slider เด้งกลับเพราะ event จาก OBS สวนมา | ระหว่างที่ผู้ใช้ **กำลังลาก** ให้ ignore event ของ control นั้น, ปล่อยแล้วค่อย sync กับค่าจริง |
| คำสั่งมาไม่เรียงลำดับ | ทุกข้อความมี `seq` ต่อ control; ฝั่ง plugin ทิ้งค่าที่เก่ากว่าที่ apply ไปแล้ว |
| UI โชว์ค่าที่ OBS ยังไม่ได้ทำจริง | **Optimistic UI + confirm**: แสดงทันที แต่ถ้า error / timeout 2s ให้ rollback + toast แจ้ง |
| หลุดแล้วต่อใหม่ state ผิด | ต่อใหม่ทุกครั้ง → ขอ **full snapshot** (`state.sync`) ก่อนเปิดให้กด; auto reconnect แบบ exponential backoff |
| มือถือไถหน้าแล้วโดน slider | slider ใช้ `touch-action: none` เฉพาะตัว, ระยะ dead-zone, ปุ่มสำคัญ (Stop Stream) ต้อง **กดค้าง/ยืนยัน** |
| หลายคนคุมพร้อมกัน | Durable Object เป็นจุดเดียวที่ broadcast state → ทุก client เห็นค่าเดียวกัน; แสดงว่าใครกำลังลากอะไรอยู่ |
| เรียก obs API จาก thread ผิด | plugin รับข้อความใน network thread แล้ว **queue ไปทำใน OBS/UI thread** (`obs_queue_task`) |
| event ถี่เกินไป (VU meter) | plugin รวม/ลด rate ก่อนส่ง, ส่งแบบ binary หรือ array สั้น |

ทดสอบ: unit test ของ throttle/seq, เทสต์ด้วย network จำลอง lag 300ms + packet loss, Playwright บนจอมือถือ

---

## 4. ความปลอดภัย (ข้อ 3 และ 5)

**หลักคือ: OBS ไม่เปิดพอร์ตใดๆ, ทุกอย่างผ่าน TLS, ต้องผ่านการยืนยันตัวตน 2 ชั้น (ผู้ใช้ + อุปกรณ์)**

1. **การล็อกอินผู้ใช้ (เว็บ)**
   - MVP: **Cloudflare Access** ครอบโดเมนเว็บ + relay (login ด้วย Google / GitHub / email OTP) แล้ว Worker ตรวจ JWT `Cf-Access-Jwt-Assertion`
   - ระยะยาว: ระบบ login ของเราเองด้วย **Passkey (WebAuthn)** + session cookie `HttpOnly; Secure; SameSite=Strict`
2. **การจับคู่ OBS กับบัญชี (Pairing)**
   - Dock ใน OBS แสดง **รหัส 6–8 หลัก / QR** อายุ 5 นาที → ผู้ใช้กรอกในเว็บ → relay ออก **device token** ให้ plugin
   - plugin สร้าง **Ed25519 keypair** เก็บ private key ไว้ในเครื่อง (Windows DPAPI / macOS Keychain) ใช้เซ็น challenge ตอนต่อ relay ทุกครั้ง
   - เพิกถอนอุปกรณ์ได้จากเว็บและจาก Dock
3. **Authorization**
   - สิทธิ์ต่อผู้ใช้: Owner / Operator / Viewer
   - **Allowlist คำสั่ง** ในปลั๊กอิน: ไม่อนุญาตคำสั่งเสี่ยง เช่น ตั้ง path ไฟล์ record, แก้ stream key, รันสคริปต์, `CallVendorRequest` ที่ไม่รู้จัก — คำสั่งเหล่านี้ทำได้เฉพาะใน OBS เอง
   - plugin เป็นผู้ตัดสินสุดท้าย (relay โดน hack ก็สั่งเกิน allowlist ไม่ได้)
4. **E2E encryption (Phase 2)** — browser กับ plugin แลก key (X25519) ตอน pairing แล้วเข้ารหัส payload ด้วย AES-GCM; relay เห็นแค่ metadata
5. **อื่นๆ**
   - Rate limit ต่อ user/device ใน Durable Object, จำกัดขนาดข้อความ
   - Audit log (ใคร สั่งอะไร เมื่อไร) ใน D1 + โชว์ใน Dock
   - Validate ทุกข้อความด้วย schema ทั้งสองฝั่ง
   - CSP เข้มงวด, ไม่มี inline script
   - **Kill switch ใน OBS**: ปิด remote ได้ทันที + ตั้ง "ต้องกดยอมรับใน OBS ก่อน client ใหม่เข้าได้"
   - ไม่ส่ง stream key / password ใดๆ ออกจากเครื่อง

---

## 5. ควบคุมใน OBS เองได้ (ข้อ 4)

Dock ชื่อ **"Remote Control"** (Qt) ใน OBS:
- สถานะการเชื่อมต่อ (Connected / Reconnecting / Off) + ปุ่มเปิด/ปิด remote
- Pairing: แสดงรหัส/QR, รายการอุปกรณ์และผู้ใช้ที่เข้าถึง + ปุ่ม revoke
- รายชื่อคนที่กำลังเชื่อมต่อตอนนี้ + เตะออกได้
- Audit log ล่าสุด
- ตั้งค่า: relay URL, allowlist (เลือกได้ว่าเปิดให้รีโมตทำอะไรได้บ้าง), ต้องยืนยันใน OBS สำหรับคำสั่งสำคัญ (เช่น Stop Stream)
- Quick controls ที่ซ้ำกับเว็บ (preset/macro) เผื่อใช้ hotkey ใน OBS

---

## 6. Protocol (ร่าง)

```jsonc
// browser -> relay -> plugin
{ "v": 1, "type": "req", "id": "uuid", "op": "SetInputVolume",
  "data": { "inputUuid": "...", "inputVolumeDb": -12.5 }, "ctl": "vol:mic", "seq": 42 }

// plugin -> relay -> browser
{ "v": 1, "type": "res", "id": "uuid", "ok": true }
{ "v": 1, "type": "evt", "op": "InputVolumeChanged", "data": { ... } }
{ "v": 1, "type": "state.sync", "data": { "scenes": [...], "inputs": [...], "outputs": {...} } }
```

- `op` ใช้ชื่อ request/event ของ obs-websocket v5 ตรงๆ (ลดงานแปลง) แต่ผ่าน allowlist
- relay ไม่แก้ payload แค่ตรวจสิทธิ์ + ส่งต่อ

---

## 7. ลำดับงาน (Roadmap)

| Phase | งาน | ผลลัพธ์ |
|---|---|---|
| 0 | Spike: plugin เรียก `obs_websocket_call_request` ได้, Worker+DO echo WebSocket ได้ | พิสูจน์ว่าแนวทางใช้ได้ |
| 1 | Protocol + relay (Access auth, pairing, room) + plugin ต่อ relay + Dock เบื้องต้น | สั่งสลับฉากจากเน็ตอื่นได้ |
| 2 | Web UI: ฉาก, source/เสียงที่ปักหมุด (slider anti-bug), stream/record, สุขภาพระบบ, preview, macro | คุมงานจากมือถือได้ |
| 3 | อัตโนมัติ + แจ้งเตือน: schedule, playlist ฉาก, rules template, Discord/Telegram/LINE/Web Push, หน้าภาพรวมหลายเครื่อง | ไม่ต้องเฝ้าจอ |
| 4 | Security hardening: allowlist UI, audit log, rate limit, revoke, kill switch, E2E, pen-test | พร้อมให้คนอื่นใช้ |
| 5 | Installer (Windows .exe / macOS .pkg / Linux), auto-update check, docs | แจกจ่าย |

---

## 8. Resolution / ค่าแนะนำ

**ค่า OBS สำหรับสตรีม** (Settings → Video / Output)

| การใช้งาน | Base (Canvas) | Output | FPS | Bitrate (video) | หมายเหตุ |
|---|---|---|---|---|---|
| ทั่วไป / เน็ตอัปโหลด ≥ 10 Mbps | 1920×1080 | 1920×1080 | 60 | 6000 kbps | ค่ามาตรฐาน Twitch/YouTube/Facebook |
| เน็ตอัปโหลด 5–10 Mbps / เครื่องไม่แรง | 1920×1080 | 1280×720 | 60 | 4500 kbps | ภาพลื่น คุ้มที่สุด |
| เกมช้า/พูดคุย | 1920×1080 | 1920×1080 | 30 | 4500 kbps | |
| YouTube คุณภาพสูง | 2560×1440 | 2560×1440 | 60 | 9000–18000 kbps | ต้องเน็ตแรง |
| แนวตั้ง (TikTok/Shorts) | 1080×1920 | 1080×1920 | 30–60 | 4000–6000 kbps | |

- Encoder: NVENC (NVIDIA) / AMF (AMD) / QuickSync (Intel) ก่อน x264, Keyframe 2s, Rate control CBR
- Audio 160 kbps, 48 kHz

**ค่าสำหรับระบบรีโมต (ฝั่งปลั๊กอิน)**
- Thumbnail preview: **480×270 JPEG quality ~60, 1–2 fps** (ปรับเป็น 640×360 ได้ถ้าเน็ตดี) — ประหยัดเน็ตและ CPU
- VU meter: 10–15 Hz, slider: 30 Hz, stats: 1 Hz
- Web UI: responsive ตั้งแต่ 360px (มือถือ) ถึง 1920px, ปุ่มขนาดแตะได้ ≥ 44px

---

## 9. ทางเลือกอื่น (เทียบ)

| แบบ | ข้อดี | ข้อเสีย |
|---|---|---|
| **A. Native plugin + CF Worker relay (แนะนำ)** | ติดตั้งในตัว OBS, ไม่เปิดพอร์ต, ควบคุม security เองได้ครบ, มี Dock | ต้องเขียน C++ และ build ข้าม OS |
| B. cloudflared tunnel + Cloudflare Access + obs-websocket | ทำได้ในวันเดียว แทบไม่ต้องเขียน backend | ต้องติดตั้ง cloudflared แยก, ไม่ใช่ปลั๊กอิน, obs-websocket เปิดทุกคำสั่ง (ไม่มี allowlist) |
| C. Lua/Python script ใน OBS | ง่าย | ทำ WebSocket client/Dock UI ยาก, ไม่เสถียรเท่า |

ทำ B เป็น prototype สำหรับ Web UI ระหว่างที่ plugin ยังไม่เสร็จได้ เพราะ protocol ใช้ชื่อคำสั่งเดียวกับ obs-websocket

---

## 10. คำถามที่ต้องตัดสินใจ

1. ใช้คนเดียว หรือจะเปิดให้คนอื่นสมัครใช้ (มีผลกับระบบ login: Cloudflare Access พอสำหรับใช้เอง/ทีมเล็ก)
2. OS ที่ต้องรองรับก่อน: Windows อย่างเดียว หรือ macOS/Linux ด้วย
3. Frontend: Svelte (เบา เร็ว) หรือ React (คนรู้จักเยอะ)
4. มีโดเมนบน Cloudflare แล้วหรือยัง
5. อยากให้แจ้งเตือนเข้าช่องทางไหน (Discord / Telegram / LINE / Web Push)
6. ปกติคุม OBS กี่เครื่องพร้อมกัน และงานส่วนใหญ่เป็นแบบไหน (live เกม, สัมมนา, 24/7, ถ่ายทอดงาน)

---

## สถานะปัจจุบัน (อัปเดต)

- ทำแล้ว: `relay/` (Worker + Durable Object Room, pairing code, allowlist ฝั่ง plugin จำลอง, rate limit, preview แบบ subscribe) ผ่าน `npm test` 19/19
- ทำแล้ว: Web UI ใน `relay/public/` (ไม่ต้อง build) — มือถือ = แท็บ + ปุ่มกะทัดรัด, iPad/เดสก์ท็อป = แดชบอร์ด + ควบคุมละเอียด (พิมพ์ dB, ±1 dB, studio mode, transition, ทุก source, log), กดขยายแต่ละพาเนลเต็มจอได้, ตั้งค่า Size/Controls/Layout เองได้
- ทำแล้ว: ชุดไอคอนเส้นหมึก `public/icons.js` (+ ดูทั้งหมดที่ `/icons.html`) สไตล์จาก skill `line-art-animation`
- ลองใช้ UI โดยไม่ต้องมี OBS: เปิด `/?demo` (ใช้ `public/sim.js`) หรือรัน `node test/mock-obs.mjs` คู่กับ `npm run dev`
- ยังไม่ทำ: ปลั๊กอิน C++ (`plugin/`), Phase 3 (schedule/rules/แจ้งเตือน), login ผู้ใช้แบบ Access/Passkey
