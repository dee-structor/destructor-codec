import { i as ed25519, n as getPublicKeyAsync, r as signAsync } from "./vendor/gateway-runtime-CMyVbEq5.js";

const $ = (id) => document.getElementById(id);

const els = {
  shell: document.querySelector(".codec-shell"),
  clock: $("clock"),
  linkState: $("link-state"),
  transportLabel: $("transport-label"),
  primaryStatus: $("primary-status"),
  secondaryStatus: $("secondary-status"),
  sessionId: $("session-id"),
  transcript: $("transcript"),
  waveform: $("waveform"),
  connect: $("connect-btn"),
  call: $("call-btn"),
  hangup: $("hangup-btn"),
  demo: $("demo-btn"),
  gatewayUrl: $("gateway-url"),
  token: $("gateway-token"),
  sessionKey: $("session-key"),
  transport: $("transport")
};

const saved = JSON.parse(localStorage.getItem("destructor-codec-settings") || "{}");
for (const [key, el] of Object.entries({
  gatewayUrl: els.gatewayUrl,
  token: els.token,
  sessionKey: els.sessionKey,
  transport: els.transport
})) {
  if (saved[key]) el.value = saved[key];
  el.addEventListener("change", saveSettings);
}

function saveSettings() {
  localStorage.setItem("destructor-codec-settings", JSON.stringify({
    gatewayUrl: els.gatewayUrl.value.trim(),
    token: els.token.value.trim(),
    sessionKey: els.sessionKey.value.trim(),
    transport: els.transport.value
  }));
}

let gateway = null;
let talk = null;
let demoTimer = null;
let waveRaf = null;
let waveMode = "idle";
const liveTranscriptRows = new Map();

setInterval(() => {
  els.clock.textContent = new Date().toLocaleTimeString([], { hour12: false });
}, 250);

function setState(state, primary, secondary) {
  els.shell.dataset.state = state;
  els.primaryStatus.textContent = primary;
  els.secondaryStatus.textContent = secondary || "";
  els.linkState.textContent = state === "live" ? "ONLINE" : state === "demo" ? "SIM" : state === "error" ? "FAULT" : "OFFLINE";
}

function logLine(who, text) {
  const p = document.createElement("p");
  const speaker = document.createElement("span");
  speaker.textContent = who.toUpperCase();
  const textNode = document.createTextNode(text);
  p.append(speaker, textNode);
  els.transcript.appendChild(p);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return { row: p, textNode };
}

function updateTranscriptLine({ key, who, text, final = false, delta = false }) {
  const cleanText = String(text || "").trim();
  if (!cleanText) return;
  let entry = liveTranscriptRows.get(key);
  if (!entry) {
    entry = { ...logLine(who, ""), text: "" };
    liveTranscriptRows.set(key, entry);
  }
  entry.text = final ? cleanText : mergeTranscriptText(entry.text, cleanText, delta);
  entry.textNode.nodeValue = entry.text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
  if (final) liveTranscriptRows.delete(key);
}

function mergeTranscriptText(previous, next, isDelta) {
  const prior = String(previous || "").trim();
  const incoming = String(next || "").trim();
  if (!prior) return incoming;
  if (!incoming) return prior;
  if (!isDelta || incoming.startsWith(prior)) return incoming;
  if (prior.endsWith(incoming)) return prior;
  return `${prior}${needsTranscriptSpace(prior, incoming) ? " " : ""}${incoming}`.replace(/\s+/g, " ").trim();
}

function needsTranscriptSpace(previous, next) {
  return !/[([{/"'“‘-]$/.test(previous) && !/^[.,!?;:%)\]}’”]/.test(next);
}

class GatewayClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.ws = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.connectNonce = "";
    this.connectSent = false;
    this.connectResolve = null;
    this.connectReject = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.ws = new WebSocket(this.url);
      const fail = (error) => reject(error instanceof Error ? error : new Error(String(error)));
      this.ws.addEventListener("open", async () => {
        window.setTimeout(() => this.sendConnect(), 250);
      }, { once: true });
      this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
      this.ws.addEventListener("close", () => {
        for (const item of this.pending.values()) item.reject(new Error("Gateway websocket closed"));
        this.pending.clear();
        this.emit({ event: "gateway.close", payload: {} });
      });
      this.ws.addEventListener("error", fail, { once: true });
    });
  }

  async sendConnect() {
    if (this.connectSent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.connectSent = true;
    const role = "operator";
    const scopes = ["operator.read", "operator.write", "operator.approvals"];
    const client = {
      id: "openclaw-control-ui",
      version: "destructor-codec/0.1.6",
      platform: navigator.platform || "web",
      mode: "webchat",
      instanceId: crypto.randomUUID()
    };
    try {
      const deviceIdentity = await getOrCreateDeviceIdentity();
      const device = await signDeviceIdentity({
        deviceIdentity,
        client,
        role,
        scopes,
        token: this.token || null,
        nonce: this.connectNonce || ""
      });
      const hello = await this.request("connect", {
        minProtocol: 4,
        maxProtocol: 4,
        client,
        role,
        scopes,
        caps: ["tool-events"],
        auth: this.token ? { token: this.token } : undefined,
        device,
        userAgent: navigator.userAgent,
        locale: navigator.language
      });
      this.connectResolve?.(hello);
    } catch (error) {
      this.connectReject?.(error);
    }
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw || ""));
    } catch {
      return;
    }
    if (message.type === "event") {
      if (message.event === "connect.challenge" && message.payload?.nonce) {
        this.connectNonce = message.payload.nonce;
        this.sendConnect();
      }
      this.emit(message);
      return;
    }
    if (message.type !== "res") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.payload);
    else {
      const detail = message.error?.message || message.error?.code || "Gateway request failed";
      pending.reject(new Error(detail));
    }
  }

  request(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Gateway is not connected"));
    }
    const id = crypto.randomUUID();
    const payload = { type: "req", id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

class RelayTalk {
  constructor(client, sessionKey, transport) {
    this.client = client;
    this.sessionKey = sessionKey;
    this.transport = transport;
    this.session = null;
    this.media = null;
    this.inputContext = null;
    this.outputContext = null;
    this.inputSource = null;
    this.processor = null;
    this.closed = true;
    this.unsubscribe = null;
    this.playHead = 0;
    this.suppressMicUntil = 0;
    this.activeRuns = new Map();
  }

  async start() {
    this.closed = false;
    this.session = await this.createSession();
    els.sessionId.textContent = this.session.relaySessionId ? this.session.relaySessionId.slice(0, 8) : "CLIENT";
    this.unsubscribe = this.client.onEvent((event) => this.handleGatewayEvent(event));
    if (this.transport !== "gateway-relay") {
      throw new Error("This custom shell currently supports Gateway relay. Switch transport back to Gateway relay.");
    }
    this.outputContext = new AudioContext({ sampleRate: this.session.audio?.outputSampleRateHz || 24000 });
    this.inputContext = new AudioContext({ sampleRate: this.session.audio?.inputSampleRateHz || 24000 });
    this.media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this.startMicPump();
    setState("live", "CONNECTING", "Realtime relay session created");
  }

  async createSession() {
    return this.client.request("talk.session.create", {
      sessionKey: this.sessionKey,
      mode: "realtime",
      transport: this.transport,
      brain: "agent-consult"
    });
  }

  startMicPump() {
    this.inputSource = this.inputContext.createMediaStreamSource(this.media);
    this.processor = this.inputContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (this.closed) return;
      if (performance.now() < this.suppressMicUntil) return;
      const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
      this.client.request("talk.session.appendAudio", {
        sessionId: this.session.relaySessionId,
        audioBase64: bytesToBase64(pcm),
        timestamp: Math.round(this.inputContext.currentTime * 1000)
      }).catch((error) => {
        logLine("system", `Audio uplink failed: ${error.message}`);
        this.stop();
      });
    };
    this.inputSource.connect(this.processor);
    this.processor.connect(this.inputContext.destination);
  }

  handleGatewayEvent(event) {
    if (event.event === "chat") {
      this.handleChatEvent(event.payload);
      return;
    }
    if (event.event !== "talk.event") return;
    const payload = event.payload || {};
    if (payload.relaySessionId !== this.session?.relaySessionId) return;
    const talkEvent = payload.talkEvent;
    if (talkEvent) this.handleTalkLifecycle(talkEvent);
    if (payload.type === "ready") {
      setState("live", "LISTENING", "Voice link open");
      waveMode = "listen";
    } else if (payload.type === "audio" && payload.audioBase64) {
      setState("live", "RX AUDIO", "DestructoR666 speaking");
      waveMode = "speak";
      this.playPcm16(payload.audioBase64);
    } else if (payload.type === "transcript" && payload.text) {
      this.handleTranscript(payload);
    } else if (payload.type === "toolCall") {
      this.handleToolCall(payload);
    } else if (payload.type === "error") {
      setState("error", "FAULT", payload.message || "Realtime relay error");
      logLine("system", payload.message || "Realtime relay error");
    } else if (payload.type === "close") {
      setState("idle", "CLOSED", payload.reason || "Session closed");
      this.stopLocal();
    }
  }

  handleTalkLifecycle(event) {
    const type = event.type || "";
    if (type.includes("tool")) setState("live", "CONSULTING", "Routing through OpenClaw");
    if (type === "turn.started") waveMode = "listen";
    if (type === "input.audio.committed") {
      setState("live", "THINKING", "Processing speech");
      waveMode = "think";
    }
  }

  handleTranscript(payload) {
    const talkEvent = payload.talkEvent || {};
    const eventType = talkEvent.type || "";
    const role = payload.role || talkEvent.payload?.role || (eventType.startsWith("output.") ? "assistant" : "voice");
    const text = payload.text || talkEvent.payload?.text || "";
    const final = payload.final === true || talkEvent.final === true || eventType.endsWith(".done");
    const delta = !final && (eventType.endsWith(".delta") || payload.final !== true);
    const key = [
      role,
      talkEvent.turnId || payload.turnId || talkEvent.itemId || payload.itemId || "current"
    ].join(":");
    updateTranscriptLine({
      key,
      who: role,
      text,
      final,
      delta
    });
  }

  async handleToolCall(call) {
    const callId = call.callId;
    if (!callId) return;
    const name = call.name || "openclaw_agent_consult";
    logLine("system", `Tool call: ${name}`);
    try {
      if (name !== "openclaw_agent_consult") {
        await this.client.request("talk.session.submitToolResult", {
          sessionId: this.session.relaySessionId,
          callId,
          result: { error: `Tool ${name} is not wired in this shell yet.` }
        });
        return;
      }
      const run = await this.client.request("talk.client.toolCall", {
        sessionKey: this.sessionKey,
        callId,
        name,
        args: parseMaybeJson(call.args),
        relaySessionId: this.session.relaySessionId
      });
      const runId = run.runId || run.idempotencyKey;
      if (!runId) throw new Error("OpenClaw did not return a run id");
      this.activeRuns.set(runId, callId);
      await this.client.request("talk.session.submitToolResult", {
        sessionId: this.session.relaySessionId,
        callId,
        result: {
          status: "working",
          tool: name,
          message: "Checking with OpenClaw."
        },
        options: { willContinue: true }
      });
    } catch (error) {
      await this.client.request("talk.session.submitToolResult", {
        sessionId: this.session.relaySessionId,
        callId,
        result: { error: error.message }
      });
    }
  }

  async handleChatEvent(payload) {
    const runId = payload?.runId;
    if (!runId || !this.activeRuns.has(runId)) return;
    if (payload.state === "final" || payload.state === "error" || payload.state === "aborted") {
      const callId = this.activeRuns.get(runId);
      this.activeRuns.delete(runId);
      const text = payload.state === "final"
        ? extractText(payload.message) || "OpenClaw finished with no speakable text."
        : payload.errorMessage || `OpenClaw ${payload.state}`;
      await this.client.request("talk.session.submitToolResult", {
        sessionId: this.session.relaySessionId,
        callId,
        result: payload.state === "final" ? { result: text } : { error: text }
      });
    }
  }

  playPcm16(base64) {
    const bytes = base64ToBytes(base64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const sampleRate = this.session.audio?.outputSampleRateHz || 24000;
    const audioBuffer = this.outputContext.createBuffer(1, pcm.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
    const source = this.outputContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputContext.destination);
    const now = this.outputContext.currentTime;
    this.playHead = Math.max(now, this.playHead);
    source.start(this.playHead);
    this.playHead += audioBuffer.duration;
    this.suppressMicUntil = Math.max(
      this.suppressMicUntil,
      performance.now() + Math.max(0, this.playHead - now) * 1000 + 350
    );
    source.onended = () => {
      if (!this.closed && this.outputContext.currentTime >= this.playHead - 0.05) {
        setState("live", "LISTENING", "Voice link open");
        waveMode = "listen";
      }
    };
  }

  async stop() {
    if (!this.closed && this.session?.relaySessionId) {
      this.client.request("talk.session.close", { sessionId: this.session.relaySessionId }).catch(() => {});
    }
    this.stopLocal();
  }

  stopLocal() {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.processor?.disconnect();
    this.inputSource?.disconnect();
    this.media?.getTracks().forEach((track) => track.stop());
    this.inputContext?.close();
    this.outputContext?.close();
    this.processor = null;
    this.inputSource = null;
    this.media = null;
    this.inputContext = null;
    this.outputContext = null;
    this.session = null;
    this.playHead = 0;
    this.suppressMicUntil = 0;
    this.activeRuns.clear();
    els.sessionId.textContent = "NO SESSION";
    waveMode = "idle";
  }
}

els.connect.addEventListener("click", async () => {
  saveSettings();
  clearDemo();
  setState("idle", "CONNECTING", "Opening Gateway websocket");
  try {
    gateway?.close();
    gateway = new GatewayClient(els.gatewayUrl.value.trim(), els.token.value.trim());
    const hello = await gateway.connect();
    logLine("system", `Gateway connected${hello?.serverVersion ? `: ${hello.serverVersion}` : ""}`);
    setState("idle", "READY", "Gateway connected");
    els.call.disabled = false;
  } catch (error) {
    setState("error", "AUTH/LINK FAULT", error.message);
    logLine("system", error.message);
  }
});

els.call.addEventListener("click", async () => {
  if (!gateway) return;
  saveSettings();
  clearDemo();
  els.transportLabel.textContent = els.transport.value === "gateway-relay" ? "RELAY" : "WEBRTC";
  els.call.disabled = true;
  els.hangup.disabled = false;
  try {
    talk = new RelayTalk(gateway, els.sessionKey.value.trim(), els.transport.value);
    await talk.start();
  } catch (error) {
    setState("error", "CALL FAILED", error.message);
    logLine("system", error.message);
    els.call.disabled = false;
    els.hangup.disabled = true;
  }
});

els.hangup.addEventListener("click", async () => {
  await talk?.stop();
  talk = null;
  setState("idle", "READY", gateway ? "Gateway connected" : "Gateway not connected");
  els.call.disabled = !gateway;
  els.hangup.disabled = true;
});

els.demo.addEventListener("click", () => {
  if (demoTimer) {
    clearDemo();
    return;
  }
  runDemo();
});

function runDemo() {
  talk?.stop();
  setState("demo", "DEMO LINK", "Simulated codec traffic");
  els.demo.textContent = "STOP DEMO";
  els.sessionId.textContent = "SIM-14085";
  waveMode = "speak";
  const script = [
    ["system", "Burst carrier detected on 140.85."],
    ["ti", "Hey, can you hear me?"],
    ["destructor", "Loud and clear. Interface drip has entered the chat."],
    ["system", "OpenClaw consult channel armed."],
    ["destructor", "Say the word and I will stop cosplaying as an admin panel."]
  ];
  let i = 0;
  demoTimer = setInterval(() => {
    const line = script[i % script.length];
    logLine(line[0], line[1]);
    waveMode = i % 2 ? "listen" : "speak";
    i += 1;
  }, 1400);
}

function clearDemo() {
  if (!demoTimer) return;
  clearInterval(demoTimer);
  demoTimer = null;
  els.demo.textContent = "DEMO";
  els.sessionId.textContent = talk?.session?.relaySessionId?.slice(0, 8) || "NO SESSION";
  waveMode = talk ? "listen" : "idle";
  setState(talk ? "live" : "idle", talk ? "LISTENING" : "READY", gateway ? "Gateway connected" : "Gateway not connected");
}

function drawWaveform() {
  const canvas = els.waveform;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const t = performance.now() / 1000;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = waveMode === "idle" ? "rgba(126,169,155,0.45)" : waveMode === "think" ? "#ffb84a" : "#38f2b5";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x < w; x += 1) {
    const amp = waveMode === "idle" ? 4 : waveMode === "think" ? 18 : waveMode === "speak" ? 35 : 24;
    const y = h / 2
      + Math.sin(x * 0.035 + t * 5) * amp
      + Math.sin(x * 0.011 + t * 2.1) * amp * 0.42;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  waveRaf = requestAnimationFrame(drawWaveform);
}

function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

async function getOrCreateDeviceIdentity() {
  if (!globalThis.isSecureContext) {
    throw new Error("Browser device identity requires a secure context. Open this as http://localhost:8766/apps/destructor-codec/ or HTTPS.");
  }
  const key = "destructor-codec-device-v1";
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "null");
    if (stored?.version === 1 && stored.deviceId && stored.publicKey && stored.privateKey) return stored;
  } catch {}
  const privateKeyBytes = ed25519.randomSecretKey();
  const publicKeyBytes = await getPublicKeyAsync(privateKeyBytes);
  const identity = {
    version: 1,
    deviceId: await sha256Hex(publicKeyBytes),
    publicKey: base64UrlEncode(publicKeyBytes),
    privateKey: base64UrlEncode(privateKeyBytes),
    createdAtMs: Date.now()
  };
  localStorage.setItem(key, JSON.stringify(identity));
  return identity;
}

async function signDeviceIdentity({ deviceIdentity, client, role, scopes, token, nonce }) {
  const signedAt = Date.now();
  const payload = [
    "v2",
    deviceIdentity.deviceId,
    client.id,
    client.mode,
    role,
    scopes.join(","),
    String(signedAt),
    token || "",
    nonce || ""
  ].join("|");
  const signature = await signAsync(
    new TextEncoder().encode(payload),
    base64UrlDecode(deviceIdentity.privateKey)
  );
  return {
    id: deviceIdentity.deviceId,
    publicKey: deviceIdentity.publicKey,
    signature: base64UrlEncode(signature),
    signedAt,
    nonce: nonce || ""
  };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return base64ToBytes(normalized + "=".repeat((4 - normalized.length % 4) % 4));
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseMaybeJson(value) {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { text: value };
  }
}

function extractText(message) {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((item) => item.text || item.content || "").filter(Boolean).join("\n");
  }
  return "";
}

drawWaveform();
setState("idle", "READY", "Gateway not connected");
