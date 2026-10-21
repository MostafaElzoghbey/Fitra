#!/usr/bin/env node
/**
 * T-017 production smoke (Fake provider, no secrets, no Gemini spend).
 *
 * Usage: node scripts/prod-smoke.mjs [baseUrl]
 * Exercises the live host end to end over real WebSockets:
 * create -> join teacher+student -> floor -> audio fan-out both directions.
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

function waitFor(inbox, pred, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const hit = inbox.control.find(pred);
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

// Teacher speaks: takes floor, streams 5 frames.
teacher.ws.send(JSON.stringify({ t: "speaking-start" }));
await waitFor(teacher.inbox, (m) => m.t === "floor-changed" && m.floor.kind === "teacher");
const pcm = new Uint8Array(3200).fill(7);
for (let i = 0; i < 5; i++) teacher.ws.send(frame(1, i, 0, pcm));
await sleep(1500);
console.log(`student received binary frames: ${student.inbox.binary} (expect >=1)`);
console.log(`teacher received own speech frames: ${teacher.inbox.binary} (expect 0)`);
if (student.inbox.binary < 1) throw new Error("FAIL: student got no translated audio");
if (teacher.inbox.binary !== 0) throw new Error("FAIL: speaker heard own speech");

// Hand-over: student raises hand, teacher grants, student speaks.
student.ws.send(JSON.stringify({ t: "raise-hand" }));
await sleep(300);
teacher.ws.send(JSON.stringify({ t: "speaking-stop" }));
await waitFor(teacher.inbox, (m) => m.t === "floor-changed" && m.floor.kind === "none");
const hands = teacher.inbox.control.filter((m) => m.t === "hands").pop();
const studentId = teacher.inbox.control
  .filter((m) => m.t === "welcome")
  .flatMap((m) => m.roster)
  .find((r) => r.role === "student")?.participantId;
if (!studentId) throw new Error("FAIL: no student in roster");
console.log(`hands raised: ${JSON.stringify(hands?.raised)}`);
teacher.ws.send(JSON.stringify({ t: "grant", participantId: studentId }));
await waitFor(student.inbox, (m) => m.t === "floor-changed" && m.floor.kind === "student");
student.ws.send(JSON.stringify({ t: "speaking-start" }));
const before = teacher.inbox.binary;
for (let i = 0; i < 5; i++) student.ws.send(frame(1, i, 1, pcm));
await sleep(1500);
console.log(`teacher received student speech frames: ${teacher.inbox.binary - before} (expect >=1)`);
if (teacher.inbox.binary - before < 1) throw new Error("FAIL: teacher got no student audio");

// Revoke -> silence.
teacher.ws.send(JSON.stringify({ t: "revoke" }));
await waitFor(student.inbox, (m) => m.t === "floor-changed" && m.floor.kind === "none");
console.log("revoke broadcast OK");

teacher.ws.close();
student.ws.close();
console.log("\nPROD SMOKE PASS: create/join/floor/fan-out/handover/revoke all live.");
