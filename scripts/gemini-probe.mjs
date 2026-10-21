#!/usr/bin/env node
/**
 * T-014 — Gemini Live Translate raw-WS probe (MANUAL, user-run only).
 *
 * Resolves OQ-01 (setup placement), OQ-02 (realtimeInput envelope),
 * OQ-03 (speechConfig), OQ-07 (echo=false silence).
 * Reads GEMINI_API_KEY from env. Never commit a key. Never run in CI.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/gemini-probe.mjs [--probe=1,2,3,4]
 *
 * Endpoint shape is per public Live API docs; if the handshake itself
 * fails, paste the first 5 log lines back — that *is* the finding.
 */

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("FATAL: set GEMINI_API_KEY in env first. Never put it in a file.");
  process.exit(2);
}

const MODEL = "models/gemini-3.5-live-translate-preview";
const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
  `?key=${API_KEY}`;

const which = (process.argv.find((a) => a.startsWith("--probe=")) ?? "--probe=1,2,3,4")
  .split("=")[1]
  .split(",")
  .map((s) => s.trim());

function sine16k(seconds, hz = 440) {
  const n = Math.floor(16000 * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(12000 * Math.sin((2 * Math.PI * hz * i) / 16000));
  return Buffer.from(pcm.buffer);
}

async function frameText(data) {
  if (typeof data === "string") return data;
  if (data !== null && typeof data === "object" && typeof data.text === "function") {
    return data.text();
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

function frameBytes(data) {
  if (typeof data === "string") return 0;
  if (data !== null && typeof data === "object" && typeof data.size === "number") return data.size;
  return data?.byteLength ?? 0;
}

function waitFor(ws, pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error(`TIMEOUT waiting for ${label}`));
    }, timeoutMs);
    async function onMsg(ev) {
      let msg;
      try {
        msg = JSON.parse(await frameText(ev.data));
      } catch {
        return; // binary audio — handled by callers counting bytes
      }
      if (pred(msg)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(msg);
      }
    }
    ws.addEventListener("message", onMsg);
  });
}

async function openSocket() {
  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", (e) => rej(new Error(`WS open failed: ${e.message ?? e.type}`)), {
      once: true,
    });
  });
  let audioBytes = 0;
  ws.addEventListener("message", (ev) => {
    audioBytes += frameBytes(ev.data);
  });
  return { ws, audioBytes: () => audioBytes };
}

function baseSetup(extra) {
  return {
    setup: {
      model: MODEL,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: { targetLanguageCode: "en", echoTargetLanguage: false },
        ...(extra?.generationConfig ?? {}),
      },
      ...(extra?.setup ?? {}),
    },
  };
}

async function probeSetup(label, setupMsg) {
  const { ws } = await openSocket();
  ws.send(JSON.stringify(setupMsg));
  try {
    const msg = await waitFor(ws, (m) => "setupComplete" in m, 15000, "setupComplete");
    console.log(`[PASS] ${label}: setupComplete ->`, JSON.stringify(msg).slice(0, 200));
    ws.close();
    return true;
  } catch (err) {
    console.log(`[FAIL] ${label}: ${err.message} (check close code in server logs)`);
    ws.close();
    return false;
  }
}

async function probeAudio(label, setupMsg) {
  const { ws } = await openSocket();
  let audioBytes = 0;
  ws.addEventListener("message", async (ev) => {
    const raw = ev.data;
    if (typeof raw === "string") {
      try {
        const msg = JSON.parse(raw);
        const parts = msg?.serverContent?.modelTurn?.parts ?? [];
        for (const part of parts) {
          if (typeof part?.inlineData?.data === "string") {
            audioBytes += Math.floor(part.inlineData.data.length * 3 / 4);
          }
        }
      } catch {
        // not JSON — ignore
      }
      return;
    }
    audioBytes += frameBytes(raw);
  });
  ws.send(JSON.stringify(setupMsg));
  await waitFor(ws, (m) => "setupComplete" in m, 15000, "setupComplete");
  // 3 s of 16 kHz sine in 100 ms realtimeInput chunks, then 10 s listen window.
  const chunk = sine16k(0.1);
  for (let i = 0; i < 30; i++) {
    ws.send(
      JSON.stringify({
        realtimeInput: { audio: { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" } },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 10000));
  console.log(
    audioBytes > 0
      ? `[PASS] ${label}: received ~${audioBytes} translated-audio bytes`
      : `[FAIL] ${label}: 0 translated-audio bytes (envelope or model issue)`,
  );
  ws.close();
  return audioBytes > 0;
}

const results = {};
if (which.includes("1")) {
  console.log("--- P1: transcription fields inside generationConfig (documented shape) ---");
  results.p1_documented = await probeSetup(
    "P1",
    baseSetup({ generationConfig: { inputAudioTranscription: {}, outputAudioTranscription: {} } }),
  );
}
if (which.includes("2")) {
  console.log("--- P2: transcription fields top-level on setup (reported runtime shape) ---");
  results.p2_toplevel = await probeSetup(
    "P2",
    baseSetup({ setup: { inputAudioTranscription: {}, outputAudioTranscription: {} } }),
  );
}
if (which.includes("3")) {
  console.log("--- P3: 16 kHz PCM stream -> translated audio back (uses P1/P2 winner) ---");
  const winner = results.p1_documented
    ? { generationConfig: { inputAudioTranscription: {}, outputAudioTranscription: {} } }
    : { setup: { inputAudioTranscription: {}, outputAudioTranscription: {} } };
  results.p3_audio = await probeAudio("P3", baseSetup(winner));
}
if (which.includes("4")) {
  console.log("--- P4: sessionResumption + contextWindowCompression accepted ---");
  results.p4_resume = await probeSetup(
    "P4",
    baseSetup({
      setup: {
        sessionResumption: {},
        contextWindowCompression: { triggerTokens: 20000, slidingWindow: { targetTokens: 8000 } },
      },
    }),
  );
}

console.log("\n=== SUMMARY (paste into docs/OPEN-QUESTIONS.md) ===");
console.log(JSON.stringify({ model: MODEL, results }, null, 2));
