// Runs in YouTube tabs. Captures the picture and sound of the video element itself (not the page around it) and
// sends them to each OBS browser source over WebRTC, on this computer only. YouTube keeps the same video element
// when you pick another clip, so OBS follows along; a new element (Shorts, miniplayer) is picked up within a second.

(() => {
  const MAX_BITRATE = 16_000_000; // the link never leaves this computer, so quality can be high
  let port = null;
  let sending = false; // this tab is the one OBS shows
  const pcs = new Map(); // player id -> RTCPeerConnection
  const asked = new Map(); // player id -> number of its latest request; an older one arriving late is ignored
  let el = null, src = "", stream = null, last = "";

  /** The video worth sending: the biggest one on screen that has a picture, preferring one that plays. */
  function pickVideo() {
    let best = null, bestScore = 0;
    for (const v of document.querySelectorAll("video")) {
      if (v.readyState < 2 || !v.videoWidth) continue;
      const r = v.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      const score = area * (v.paused ? 1 : 4);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  const live = (list) => list.find((t) => t.readyState === "live") ?? null;

  /** Keeps every connection fed with the current video's tracks (new element, or new tracks after a clip change). */
  function feed() {
    const v = pickVideo();
    // A new clip in the same element gets a new source; its old capture stops producing frames, so capture again.
    if (v && (v !== el || v.currentSrc !== src || !live(stream?.getVideoTracks() ?? []))) {
      try { stream = v.captureStream(); el = v; src = v.currentSrc; } catch { return; } // protected (DRM) video: nothing to capture
    }
    if (!stream) return;
    const video = live(stream.getVideoTracks()), audio = live(stream.getAudioTracks());
    if (video) video.contentHint = "motion";
    for (const pc of pcs.values()) {
      for (const t of pc.getTransceivers()) {
        const want = t.receiver.track.kind === "video" ? video : audio;
        if (t.sender.track !== want) t.sender.replaceTrack(want).catch(() => {});
      }
    }
  }

  function videoId() {
    const u = new URL(location.href);
    return u.searchParams.get("v") || (u.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/) || [])[1] || "";
  }

  function state() {
    const v = el && el.isConnected ? el : pickVideo();
    // ad: YouTube marks its player while an advert plays; OBS hides the picture and sound until the clip is back
    const s = { type: "state", playing: !!v && !v.paused && !v.ended, ad: !!document.querySelector(".html5-video-player.ad-showing"), title: document.title.replace(/ - YouTube( Music)?$/, ""), videoId: videoId() };
    const key = JSON.stringify(s);
    if (key !== last) { last = key; send(s); }
  }

  /** Asks the sender to use a higher bitrate from the start (Chrome reads these from the answer it receives). */
  function boost(sdp) {
    const P = "x-google-start-bitrate=8000;x-google-max-bitrate=16000";
    const lines = sdp.split("\r\n");
    const pts = new Set(); // payload types of the video codecs (not their retransmission twins)
    let video = false;
    for (const l of lines) {
      if (l.startsWith("m=")) video = l.startsWith("m=video");
      const m = video && l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//);
      if (m) pts.add(m[1]);
    }
    const withFmtp = new Set(lines.map((l) => l.match(/^a=fmtp:(\d+) /)?.[1]).filter(Boolean));
    const out = [];
    for (const l of lines) {
      const f = l.match(/^a=fmtp:(\d+) /);
      out.push(f && pts.has(f[1]) ? `${l};${P}` : l);
      const r = l.match(/^a=rtpmap:(\d+) /);
      if (r && pts.has(r[1]) && !withFmtp.has(r[1])) out.push(`a=fmtp:${r[1]} ${P}`);
    }
    return out.join("\r\n");
  }

  async function offer(id) {
    close(id);
    const pc = new RTCPeerConnection({ iceServers: [] });
    pcs.set(id, pc);
    pc.onicecandidate = (e) => send({ type: "signal", to: id, data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") offer(id); };
    const v = pc.addTransceiver("video", { direction: "sendonly" });
    pc.addTransceiver("audio", { direction: "sendonly" });
    // Hardware H.264 first when the computer has it: less CPU than VP8 at 1080p.
    const caps = RTCRtpSender.getCapabilities?.("video")?.codecs ?? [];
    const rank = (c) => (/h264/i.test(c.mimeType) ? 0 : /vp8/i.test(c.mimeType) ? 1 : /vp9/i.test(c.mimeType) ? 2 : 3);
    try { v.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b))); } catch { /* keep Chrome's order */ }
    feed();
    await pc.setLocalDescription(await pc.createOffer());
    send({ type: "signal", to: id, data: { sdp: pc.localDescription.toJSON() } });
  }

  function close(id) {
    const pc = pcs.get(id);
    if (!pc) return;
    pcs.delete(id);
    try { pc.close(); } catch { /* already closed */ }
  }

  async function onSignal(id, data) {
    const pc = pcs.get(id);
    if (!pc || !data) return;
    try {
      if (data.sdp?.type === "answer") {
        await pc.setRemoteDescription({ type: "answer", sdp: boost(data.sdp.sdp) });
        for (const t of pc.getTransceivers()) {
          if (t.receiver.track.kind !== "video") continue;
          const p = t.sender.getParameters();
          if (p.encodings?.length) { p.encodings[0].maxBitrate = MAX_BITRATE; p.degradationPreference = "maintain-resolution"; t.sender.setParameters(p).catch(() => {}); }
        }
      } else if ("candidate" in data) {
        await pc.addIceCandidate(data.candidate ?? null);
      }
    } catch { /* a stale message from an earlier connection */ }
  }

  function send(m) {
    if (!port) connect();
    try { port.postMessage(m); } catch { port = null; }
  }

  function connect() {
    port = chrome.runtime.connect({ name: "yt" });
    last = "";
    port.onMessage.addListener((m) => {
      if (m.type === "start") { sending = true; [...pcs.keys()].forEach(close); asked.clear(); m.players.forEach(offer); }
      else if (m.type === "stop") { sending = false; [...pcs.keys()].forEach(close); }
      else if (m.type === "join") { // the worker only sends these to the tab on air
        const n = m.n ?? 0;
        if (n <= (asked.get(m.id) ?? -1) && pcs.has(m.id)) return;
        asked.set(m.id, n);
        sending = true;
        offer(m.id);
      }
      else if (m.type === "leave") close(m.id);
      else if (m.type === "signal") onSignal(m.from, m.data);
    });
    port.onDisconnect.addListener(() => { // the extension was reloaded or its worker restarted
      port = null; sending = false; [...pcs.keys()].forEach(close);
      setTimeout(() => { try { connect(); state(); } catch { /* extension removed: this script is orphaned */ } }, 1000);
    });
  }

  connect();
  for (const e of ["play", "playing", "pause", "ended", "loadeddata", "emptied"]) document.addEventListener(e, () => { state(); if (sending) feed(); }, true);
  document.addEventListener("yt-navigate-finish", () => state());
  setInterval(() => { state(); if (sending) feed(); }, 1000);
  // Keeps the extension's worker awake while this tab is the one on air.
  setInterval(() => { if (sending) send({ type: "ping" }); }, 15000);
  state();
})();
