#!/usr/bin/env node
/**
 * Live AR->EN translation probe against the production host.
 *
 * Joins teacher(ar) + student(en) over real WebSockets, streams ~4 s of
 * speech-like 16 kHz PCM (vibrato tone), and reports:
 *   - session-status control frames for ar->en (expect `live`)
 *   - binary downlink frames arriving at the student (expect >= 1, type 0x02)
 *
 * Usage: node scripts/prod-translate-probe.mjs [baseUrl]
 * No secrets needed (key stays server-side). Exits non-zero on failure.
 */
import Ws from "/tmp/fitra-probe/node_modules/ws/wrapper.mjs";
import { execFileSync } from "node:child_process";

const BASE = process.argv[2] ?? "https://fitra-lab.wasalny.workers.dev";
const HOST = new URL(BASE).host;

function curlJson(path, body) {
  const out = execFileSync(
    "curl",
    [
      "-sS",
      "--max-time",
      "20",
      "-X",
      "POST",
      "-H",
      "content-type: application/json",
      "--data-binary",
      JSON.stringify(body),
      `${BASE}${path}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out);
}

/** IPv4 address curl can actually reach (its cert-validated connection). */
function reachableIpv4() {
  const ip = execFileSync(
    "curl",
    ["-sS", "-o", "/dev/null", "-w", "%{remote_ip}", "--max-time", "20", "-4", `${BASE}/rooms`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`no usable IPv4 (got ${ip})`);
  return ip;
}

function frame(type, seq, speaker, payload) {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 1);
  dv.setUint8(1, type);
  dv.setUint16(2, seq, true);
  dv.setUint16(4, speaker, true);
  dv.setUint16(6, 0, true);
  out.set(payload, 8);
  return out;
}

/** Speech-like vibrato tone: 220 Hz carrier, 5 Hz vibrato, syllabic AM. */
function speechLikeFrame(seq) {
  const rate = 16000;
  const n = 1600;
  const pcm = new Uint8Array(n * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i += 1) {
    const t = (seq * n + i) / rate;
    const f = 220 + 60 * Math.sin(2 * Math.PI * 5 * t);
    const am = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3.2 * t);
    const s = Math.sin(2 * Math.PI * f * t) * 0.35 * am;
    dv.setInt16(i * 2, Math.round(s * 32767), true);
  }
  return pcm;
}

function connect(ip, room, token, name) {
  return new Promise((resolve, reject) => {
    const ws = new Ws(
      `wss://${ip}/rooms/${encodeURIComponent(room)}/ws?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`,
      { servername: HOST, headers: { host: HOST } },
    );
    const inbox = { control: [], binary: [], binaryAt: [] };
    ws.on("message", (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) {
        inbox.binary.push(new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
        inbox.binaryAt.push(Date.now());
      } else {
        try {
          inbox.control.push(JSON.parse(buf.toString("utf8")));
        } catch { /* ignore */ }
      }
    });
    ws.on("open", () => resolve({ ws, inbox }));
    ws.on("error", reject);
  });
}

function waitFor(inbox, pred, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const hit = inbox.control.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() >= deadline) {
        return reject(new Error(`timeout; control so far: ${JSON.stringify(inbox.control)}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ip = reachableIpv4();
console.log(`probing ${BASE} via ${ip}`);

const { code } = curlJson("/rooms", { teacherLang: "ar" });
const room = code;
console.log(`room ${code} created`);

const teacherJoin = curlJson(`/rooms/${code}/join`, { name: "Layla", role: "teacher", lang: "ar" });
const studentJoin = curlJson(`/rooms/${code}/join`, { name: "Marco", role: "student", lang: "en" });

const teacher = await connect(ip, room, teacherJoin.token, "Layla");
const student = await connect(ip, room, studentJoin.token, "Marco");
await waitFor(teacher.inbox, (m) => m.t === "welcome");
await waitFor(student.inbox, (m) => m.t === "welcome");
console.log("both sockets welcomed");

teacher.ws.send(JSON.stringify({ t: "speaking-start" }));
await waitFor(teacher.inbox, (m) => m.t === "floor-changed" && m.floor.kind === "teacher");
console.log("teacher holds the floor");

const FRAMES = 40;
for (let i = 0; i < FRAMES; i++) {
  teacher.ws.send(frame(1, i % 65536, 0, speechLikeFrame(i)));
  await sleep(100);
}
console.log(`streamed ${FRAMES} speech-like frames (16 kHz)`);
// Give the round trip (Gemini + fan-out) time to land.
await sleep(8000);

const statuses = student.inbox.control.filter((m) => m.t === "session-status");
const errors = student.inbox.control.filter((m) => m.t === "error");
const frames = student.inbox.binary;
const payloadBytes = frames.map((f) => f.length - 8);
const totalBytes = payloadBytes.reduce((sum, n) => sum + n, 0);
const firstAt = student.inbox.binaryAt[0] ?? 0;
const lastAt = student.inbox.binaryAt.at(-1) ?? firstAt;
const spanMs = Math.max(1, lastAt - firstAt);
const bytesPerSec = Math.round((totalBytes * 1000) / spanMs);
const uniqueSizes = [...new Set(payloadBytes)];
const echoOnly =
  uniqueSizes.length === 1 && (uniqueSizes[0] === 3200 || uniqueSizes[0] === 4800);

console.log(`session-status frames: ${JSON.stringify(statuses)}`);
console.log(`error frames: ${JSON.stringify(errors)}`);
console.log(`student binary frames: ${frames.length}`);
console.log(
  `downlink bytes: ${totalBytes} over ${spanMs}ms = ${bytesPerSec}B/s; payload sizes: ${uniqueSizes.slice(0, 6).join(",")}${uniqueSizes.length > 6 ? ",..." : ""}`,
);
if (frames.length > 0) {
  const first = frames[0];
  const dv = new DataView(first.buffer, first.byteOffset, first.byteLength);
  console.log(
    `first downlink: ver=${dv.getUint8(0)} type=${dv.getUint8(1)} seq=${dv.getUint16(2, true)} speaker=${dv.getUint16(4, true)} payload=${first.length - 8}B`,
  );
}

teacher.ws.close();
student.ws.close();

const live = statuses.some((m) => m.pair === "ar->en" && m.status === "live");
if (!live) throw new Error("FAIL: ar->en session never reached live");
if (errors.length > 0) throw new Error(`FAIL: error frames: ${JSON.stringify(errors)}`);
if (statuses.some((m) => m.status === "session-degraded")) {
  throw new Error("FAIL: ar->en reported session-degraded");
}
if (frames.length < 10) {
  throw new Error(`FAIL: only ${frames.length} downlink frames (expected translated stream)`);
}
if (echoOnly) {
  throw new Error(
    `FAIL: every downlink payload is ${uniqueSizes[0]}B — this is the fake provider echo, not translated audio`,
  );
}
if (bytesPerSec < 40000) {
  throw new Error(
    `FAIL: downlink rate ${bytesPerSec}B/s < 40000 — 24 kHz PCM16 mono streams at ~48000B/s (16 kHz mislabeled plays 1.5x fast)`,
  );
}
console.log("\nPROBE PASS: ar->en live, 24 kHz translated downlink audio reached the student.");
