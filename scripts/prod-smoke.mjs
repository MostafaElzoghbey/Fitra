#!/usr/bin/env node
/**
 * T-017 production smoke (Fake provider, no secrets, no Gemini spend).
 *
 * Usage: node scripts/prod-smoke.mjs [baseUrl]
 * Exercises the live host end to end over real WebSockets (docs/MIC-CONTROL.md):
 * create -> join teacher+student -> mics -> audio fan-out both directions ->
 * force-mute -> unmute.
 */
const BASE = process.argv[2] ?? "https://fitra-lab.wasalny.workers.dev";
const WS_BASE = BASE.replace(/^http/, "ws");

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
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

function connect(token, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${WS_BASE}/rooms/${encodeURIComponent(room)}/ws?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`,
    );
    const inbox = { control: [], binary: 0 };
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") inbox.control.push(JSON.parse(ev.data));
      else inbox.binary += 1;
    });
    ws.addEventListener("open", () => resolve({ ws, inbox }), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

function waitFor(inbox, pred, timeoutMs = 8000, since = 0) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const hit = inbox.control.find((m, i) => i >= since && pred(m));
      if (hit) return resolve(hit);
      if (Date.now() >= deadline) return reject(new Error("timeout waiting for control message"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { code } = await api("/rooms", { teacherLang: "ar" });
var room = code;
console.log(`room ${code} created`);

const teacherJoin = await api(`/rooms/${code}/join`, { name: "Layla", role: "teacher", lang: "ar" });
const studentJoin = await api(`/rooms/${code}/join`, { name: "Marco", role: "student", lang: "en" });
console.log("teacher + student tokens minted (different isolates OK)");

const teacher = await connect(teacherJoin.token, "Layla");
const student = await connect(studentJoin.token, "Marco");
await waitFor(teacher.inbox, (m) => m.t === "welcome");
await waitFor(student.inbox, (m) => m.t === "welcome");
console.log("both sockets welcomed");

const studentId = teacher.inbox.control
  .filter((m) => m.t === "welcome")
  .flatMap((m) => m.roster)
  .find((r) => r.role === "student")?.participantId;
if (!studentId) throw new Error("FAIL: no student in roster");

// Teacher speaks: opens their mic, streams 5 frames.
teacher.ws.send(JSON.stringify({ t: "mic-open" }));
await waitFor(teacher.inbox, (m) => m.t === "mic-changed" && m.micOpen === true);
const pcm = new Uint8Array(3200).fill(7);
for (let i = 0; i < 5; i++) teacher.ws.send(frame(1, i, 0, pcm));
await sleep(1500);
console.log(`student received binary frames: ${student.inbox.binary} (expect >=1)`);
console.log(`teacher received own speech frames: ${teacher.inbox.binary} (expect 0)`);
if (student.inbox.binary < 1) throw new Error("FAIL: student got no translated audio");
if (teacher.inbox.binary !== 0) throw new Error("FAIL: speaker heard own speech");

// Simultaneous speech: Marco opens his mic while Layla keeps hers open; both
// pipes fan out independently (PROTOCOL section 2).
student.ws.send(JSON.stringify({ t: "mic-open" }));
await waitFor(student.inbox, (m) => m.t === "mic-changed" && m.micOpen === true && m.participantId === studentId);
const before = teacher.inbox.binary;
for (let i = 0; i < 5; i++) student.ws.send(frame(1, i, 1, pcm));
await sleep(1500);
console.log(`teacher received student speech frames: ${teacher.inbox.binary - before} (expect >=1)`);
if (teacher.inbox.binary - before < 1) throw new Error("FAIL: teacher got no student audio");

// Force-mute: teacher cuts Marco's mic; reopening answers mic-forced-muted.
teacher.ws.send(JSON.stringify({ t: "mute", participantId: studentId }));
await waitFor(student.inbox, (m) => m.t === "mic-changed" && m.participantId === studentId && m.micOpen === false);
await waitFor(
  student.inbox,
  (m) => m.t === "welcome" && m.roster.some((r) => r.participantId === studentId && r.forcedMuted === true),
);
student.ws.send(JSON.stringify({ t: "mic-open" }));
await waitFor(student.inbox, (m) => m.t === "error" && m.code === "mic-forced-muted");
console.log("force-mute + mic-forced-muted OK");

// Unmute clears the force only; the student reopens their own mic. The `since`
// cursor skips the earlier (unforced) welcomes so the predicate matches the
// snapshot this unmute produced.
const cursor = student.inbox.control.length;
teacher.ws.send(JSON.stringify({ t: "unmute", participantId: studentId }));
await waitFor(
  student.inbox,
  (m) => m.t === "welcome" && m.roster.some((r) => r.participantId === studentId && r.forcedMuted === false),
  8000,
  cursor,
);
student.ws.send(JSON.stringify({ t: "mic-open" }));
await waitFor(
  student.inbox,
  (m) => m.t === "mic-changed" && m.participantId === studentId && m.micOpen === true,
  8000,
  cursor,
);
console.log("unmute + student self-unmute OK");

teacher.ws.close();
student.ws.close();
console.log("\nPROD SMOKE PASS: create/join/mics/simultaneous fan-out/force-mute/unmute all live.");
