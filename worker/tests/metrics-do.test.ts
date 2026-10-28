// T-020: DO metrics broadcast over the real Workers pool (Fake provider).
//
// PROTOCOL section 3.3 / SPEC FR-042/043 / TEST-PLAN section 2 (M0.6): a live
// room receives `metrics` within ~2 s of audio/control activity; the frame
// validates against isServerMsg (which routes metrics through isRoomMetrics);
// rates are real counts (not the 20:1 billing ratio); `sessions` lists the
// live pairs with reconnect counts; `errorsLastMin` increments after an
// `error` frame; `e2eLatencyMs` is null; an idle room emits nothing (no timer
// wakes it).
import { env } from "cloudflare:test";
import { isServerMsg, type ServerMsg } from "@fitra/shared";
import { afterEach, describe, expect, it } from "vitest";
import { signJoinToken, type JoinRole } from "../src/auth/token.js";

const SECRET = env.JOIN_TOKEN_HMAC_SECRET;

interface Join {
  readonly pid: string;
  readonly role: JoinRole;
  readonly lang: string;
  readonly name: string;
}

let roomSeq = 0;

function freshRoom(): string {
  roomSeq += 1;
  return `T020${String(roomSeq).padStart(3, "0")}`;
}

function tokenFor(room: string, join: Join): Promise<string> {
  return signJoinToken(
    { room, pid: join.pid, role: join.role, lang: join.lang },
    SECRET,
  );
}

/**
 * Client-side view of one participant socket: buffers inbound text control
 * frames (validated by isServerMsg) so assertions never race the DO.
 */
class Inbox {
  readonly text: ServerMsg[] = [];
  private readonly waiters: Array<() => void> = [];
  textCursor = 0;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev: MessageEvent) => {
      const data: unknown = ev.data;
      if (typeof data !== "string") return; // binary audio frames ignored here
      const parsed: unknown = JSON.parse(data);
      if (!isServerMsg(parsed)) {
        throw new Error(`isServerMsg rejected a server frame: ${data}`);
      }
      this.text.push(parsed);
      this.wake();
    });
    ws.addEventListener("close", () => {
      this.wake();
    });
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private async tick(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      setTimeout(resolve, 5);
    });
  }

  async nextOfType<T extends ServerMsg["t"]>(
    t: T,
    timeoutMs = 1500,
  ): Promise<Extract<ServerMsg, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const window = this.text.slice(this.textCursor);
      const hit = window.find(
        (m): m is Extract<ServerMsg, { t: T }> => m.t === t,
      );
      if (hit !== undefined) {
        this.textCursor += window.indexOf(hit) + 1;
        return hit;
      }
      if (Date.now() >= deadline) break;
      await this.tick();
    }
    throw new Error(
      `timed out waiting for ${t}; received: ${JSON.stringify(this.text.slice(this.textCursor))}`,
    );
  }

  /** Fails when any further text frame arrives inside `timeoutMs`. */
  async quietText(timeoutMs = 200): Promise<void> {
    const before = this.text.length;
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    expect(this.text.length).toBe(before);
  }
}

const openSockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of openSockets.splice(0)) ws.close(1000, "test-teardown");
});

async function connect(room: string, join: Join): Promise<Inbox> {
  const token = await tokenFor(room, join);
  const stub = env.CLASSROOM.getByName(room);
  const res = await stub.fetch(
    `https://classroom.invalid/ws?token=${encodeURIComponent(token)}&name=${encodeURIComponent(join.name)}`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(res.status, "upgrade should succeed").toBe(101);
  const ws = res.webSocket;
  if (ws === null) throw new Error("101 response carried no WebSocket");
  ws.accept();
  openSockets.push(ws);
  return new Inbox(ws);
}

async function drainWelcomeAndHands(inbox: Inbox, welcomes: number): Promise<void> {
  for (let i = 0; i < welcomes; i += 1) {
    await inbox.nextOfType("welcome");
  }
  await inbox.nextOfType("hands");
}

/** 8-byte type-0x01 uplink audio frame (16 kHz mono PCM16LE payload). */
function uplinkFrame(seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0x01);
  view.setUint8(1, 0x01);
  view.setUint16(2, seq, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  out.set(payload, 8);
  return out;
}

/** Teacher (ar) + en student, floor granted to the teacher, joins drained. */
async function liveRoom(room: string): Promise<{
  readonly teacher: Inbox;
  readonly student: Inbox;
}> {
  const teacher = await connect(room, {
    pid: "t",
    role: "teacher",
    lang: "ar",
    name: "Layla",
  });
  await drainWelcomeAndHands(teacher, 1);
  const student = await connect(room, {
    pid: "s-en",
    role: "student",
    lang: "en",
    name: "Marco",
  });
  await teacher.nextOfType("welcome");
  await drainWelcomeAndHands(student, 1);

  teacher.ws.send(JSON.stringify({ t: "speaking-start" }));
  const changed = await teacher.nextOfType("floor-changed");
  expect(changed.floor).toEqual({ kind: "teacher" });
  expect(await student.nextOfType("floor-changed")).toEqual(changed);
  // The grant pre-warms ar->en; the fake provider goes live on a macrotask.
  await teacher.nextOfType("session-status");
  await student.nextOfType("session-status");
  return { teacher, student };
}

describe("T-020: DO metrics broadcast", () => {
  it("emits a valid metrics frame with real counts while audio flows", async () => {
    const room = freshRoom();
    const { teacher, student } = await liveRoom(room);

    // Let the forced pre-warm pulse clear the 2 s throttle, then discard
    // frames already queued by the join/floor handshake.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    teacher.textCursor = teacher.text.length;
    student.textCursor = student.text.length;

    // 25 frames over ~2.5 s: the pulse at t=0 carries 1 inbound frame, the
    // next pulse (after the 2 s throttle) carries a real sliding-window count.
    const payload = new Uint8Array(320).fill(0x11);
    for (let seq = 0; seq < 25; seq += 1) {
      teacher.ws.send(uplinkFrame(seq, payload));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    let metrics = await student.nextOfType("metrics", 3000);
    for (let i = 0; i < 4 && metrics.m.inboundMsgPerSec < 3; i += 1) {
      metrics = await student.nextOfType("metrics", 3000);
    }
    const m = metrics.m;
    // Real counts, not the 20:1 billing ratio: several frames in the last
    // second must read as an integer >= 3, never a fraction like 3/20 = 0.15.
    expect(Number.isInteger(m.inboundMsgPerSec)).toBe(true);
    expect(m.inboundMsgPerSec).toBeGreaterThanOrEqual(3);
    expect(Number.isInteger(m.outboundMsgPerSec)).toBe(true);
    expect(m.outboundMsgPerSec).toBeGreaterThan(0);
    expect(m.e2eLatencyMs).toBeNull();
    expect(m.doActiveSec).toBeGreaterThanOrEqual(0);
    expect(m.sessions).toEqual([
      { pair: "ar->en", status: "live", reconnects: 0 },
    ]);
  }, 30_000);

  it("increments errorsLastMin after a non-floor audio frame error", async () => {
    const room = freshRoom();
    const { student } = await liveRoom(room);

    // Student sends audio without holding the floor -> error{not-your-floor}.
    student.ws.send(uplinkFrame(0, new Uint8Array(320).fill(0x22)));
    const err = await student.nextOfType("error");
    expect(err.code).toBe("not-your-floor");
    student.textCursor = student.text.length;

    // The error path itself does not pulse; wait out the 2 s throttle, then
    // any handled control message piggybacks a metrics frame.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    student.ws.send(JSON.stringify({ t: "ping", id: 1 }));
    await student.nextOfType("pong");
    const metrics = await student.nextOfType("metrics", 2500);
    expect(metrics.m.errorsLastMin).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it("emits nothing from an idle room (no timer wakes the DO)", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await drainWelcomeAndHands(teacher, 1);
    // Join activity may legitimately pulse once (floor publication); drain
    // anything already in flight, then the room must stay silent: no timers.
    await new Promise((resolve) => setTimeout(resolve, 300));
    teacher.textCursor = teacher.text.length;
    await teacher.quietText(3000);
  }, 20_000);
});
