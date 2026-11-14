// Minimal obs-websocket v5 client (Hello / Identify / Request / Event). Uses the global WebSocket (Node >= 22).
import { createHash } from "node:crypto";

const OP = { Hello: 0, Identify: 1, Identified: 2, Reidentify: 3, Event: 5, Request: 6, RequestResponse: 7, RequestBatch: 8, RequestBatchResponse: 9 };

// Event subscription bitmask (see obs-websocket protocol.md).
export const EVT = {
  General: 1 << 0, Config: 1 << 1, Scenes: 1 << 2, Inputs: 1 << 3, Transitions: 1 << 4, Filters: 1 << 5, Outputs: 1 << 6,
  SceneItems: 1 << 7, MediaInputs: 1 << 8, Vendors: 1 << 9, Ui: 1 << 10,
  InputVolumeMeters: 1 << 16,
};
export const EVT_DEFAULT = EVT.General | EVT.Config | EVT.Scenes | EVT.Inputs | EVT.Transitions | EVT.Outputs | EVT.SceneItems | EVT.Ui | EVT.InputVolumeMeters;

const sha256b64 = (s) => createHash("sha256").update(s).digest("base64");

export class ObsWs {
  /** @param {{host:string, port:number, password:string, onEvent:(type:string,data:any)=>void, onClose:(why:string)=>void}} o */
  constructor(o) {
    this.o = o;
    this.ws = null;
    this.pending = new Map();
    this.n = 0;
    this.ready = false;
  }

  /** Resolves once identified. Rejects with a short reason (`refused`, `auth`, `timeout`, ...). */
  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why) => { if (!settled) { settled = true; try { this.ws?.close(); } catch { /* */ } reject(new Error(why)); } };
      const timer = setTimeout(() => fail("timeout"), timeoutMs);
      let ws;
      try {
        ws = new WebSocket(`ws://${this.o.host}:${this.o.port}`, "obswebsocket.json");
      } catch (e) {
        clearTimeout(timer);
        return reject(new Error("refused"));
      }
      this.ws = ws;
      ws.onerror = () => fail("refused");
      ws.onclose = (e) => {
        clearTimeout(timer);
        const was = this.ready;
        this.ready = false;
        for (const p of this.pending.values()) p.reject(new Error("closed"));
        this.pending.clear();
        if (e.code === 4009) fail("auth");
        else if (!settled) fail("closed");
        else if (was) this.o.onClose(e.reason || `code ${e.code}`);
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        const d = m.d ?? {};
        switch (m.op) {
          case OP.Hello: {
            const id = { rpcVersion: 1, eventSubscriptions: EVT_DEFAULT };
            if (d.authentication) {
              const secret = sha256b64(this.o.password + d.authentication.salt);
              id.authentication = sha256b64(secret + d.authentication.challenge);
            }
            ws.send(JSON.stringify({ op: OP.Identify, d: id }));
            break;
          }
          case OP.Identified:
            if (settled) break;
            settled = true;
            clearTimeout(timer);
            this.ready = true;
            resolve(d);
            break;
          case OP.Event:
            try { this.o.onEvent(d.eventType, d.eventData ?? {}); } catch (e) { console.error("event handler:", e); }
            break;
          case OP.RequestResponse: {
            const p = this.pending.get(d.requestId);
            if (!p) break;
            this.pending.delete(d.requestId);
            if (d.requestStatus?.result) p.resolve(d.responseData ?? {});
            else p.reject(Object.assign(new Error(d.requestStatus?.comment || `error ${d.requestStatus?.code}`), { code: d.requestStatus?.code }));
            break;
          }
        }
      };
    });
  }

  request(type, data, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.ready) return reject(new Error("obs_offline"));
      const requestId = String(++this.n);
      const t = setTimeout(() => { this.pending.delete(requestId); reject(new Error("timeout")); }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      try {
        this.ws.send(JSON.stringify({ op: OP.Request, d: { requestType: type, requestId, ...(data ? { requestData: data } : {}) } }));
      } catch (e) {
        clearTimeout(t);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }

  /** Like request() but resolves to null instead of throwing (for optional data). */
  async tryRequest(type, data) {
    try { return await this.request(type, data); } catch { return null; }
  }

  close() {
    this.ready = false;
    try { this.ws?.close(); } catch { /* */ }
  }
}
