// T-007: floor control wired into the ClassRoom DO (docs/FLOOR-CONTROL.md,
// docs/PROTOCOL.md section 3, worker/src/floor.ts pure machine).
//
// Real DO-pool tests: every frame goes through
// `env.CLASSROOM.getByName(roomCode)` over genuine `WebSocketPair`s, so
// `routeControl`/`routeBinary` and the in-memory floor machine all execute
// inside workerd. Each test takes a fresh room code, so DO instances never
// leak floor state between cases.
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
  return `T007${String(roomSeq).padStart(3, "0")}`;
}

function tokenFor(room: string, join: Join): Promise<string> {
  return signJoinToken(
    { room, pid: join.pid, role: join.role, lang: join.lang },
    SECRET,
  );
}

/**
 * Client-side view of one participant socket: buffers every inbound control
 * frame so assertions never race the DO.
 */
class Inbox {
  readonly received: ServerMsg[] = [];
  private readonly waiters: Array<() => void> = [];
  private cursor = 0;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev: MessageEvent) => {
      const data: unknown = ev.data;
      if (typeof data !== "string") return;
      const parsed: unknown = JSON.parse(data);
      if (!isServerMsg(parsed)) {
        throw new Error(`isServerMsg rejected a server frame: ${data}`);
      }
      this.received.push(parsed);
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

  /** Oldest not-yet-consumed message of type `t`, waiting when it is late. */
  async nextOfType<T extends ServerMsg["t"]>(
    t: T,
    timeoutMs = 1000,
  ): Promise<Extract<ServerMsg, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const window = this.received.slice(this.cursor);
      const hit = window.find(
        (m): m is Extract<ServerMsg, { t: T }> => m.t === t,
      );
      if (hit !== undefined) {
        this.cursor += window.indexOf(hit) + 1;
        return hit;
      }
      if (Date.now() >= deadline) break;
      await this.tick();
    }
    throw new Error(
      `timed out waiting for ${t}; received: ${JSON.stringify(this.received.slice(this.cursor))}`,
    );
  }

  /** Oldest `error` frame. */
  async nextError(timeoutMs = 1000): Promise<Extract<ServerMsg, { t: "error" }>> {
    return this.nextOfType("error", timeoutMs);
  }

  /** Fails when any further frame arrives inside `timeoutMs`. */
  async quiet(timeoutMs = 150): Promise<void> {
    const before = this.received.length;
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    expect(this.received.length).toBe(before);
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

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

/** Connect a teacher plus two students and drain their join frames. */
async function trio(room: string): Promise<{
  readonly teacher: Inbox;
  readonly a: Inbox;
  readonly b: Inbox;
}> {
  const teacher = await connect(room, {
    pid: "t",
    role: "teacher",
    lang: "ar",
    name: "Layla",
  });
  await teacher.nextOfType("welcome");
  await teacher.nextOfType("hands");
  const a = await connect(room, {
    pid: "s-a",
    role: "student",
    lang: "en",
    name: "Marco",
  });
  await a.nextOfType("welcome");
  await a.nextOfType("hands");
  const b = await connect(room, {
    pid: "s-b",
    role: "student",
    lang: "fr",
    name: "Aisha",
  });
  await b.nextOfType("welcome");
  await b.nextOfType("hands");
  // Drain the roster re-syncs the joins caused on the earlier sockets.
  await teacher.nextOfType("welcome");
  await teacher.nextOfType("welcome");
  await a.nextOfType("welcome");
  return { teacher, a, b };
}

describe("ClassRoom floor control via the pure machine (T-007)", () => {
  it("student raise-hand broadcasts FIFO hands; grant dequeues onto the floor", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(a.ws, { t: "raise-hand" });
    const hands1 = await teacher.nextOfType("hands");
    expect(hands1).toEqual({ t: "hands", raised: ["s-a"] });
    expect(await a.nextOfType("hands")).toEqual(hands1);
    expect(await b.nextOfType("hands")).toEqual(hands1);

    send(b.ws, { t: "raise-hand" });
    const hands2 = await teacher.nextOfType("hands");
    expect(hands2).toEqual({ t: "hands", raised: ["s-a", "s-b"] });

    // Duplicate raise is ignored: no further hands frame.
    send(a.ws, { t: "raise-hand" });
    await teacher.quiet();
    await a.quiet();

    send(teacher.ws, { t: "grant", participantId: "s-a" });
    const floorA = await teacher.nextOfType("floor-changed");
    expect(floorA).toEqual({
      t: "floor-changed",
      floor: { kind: "student", participantId: "s-a" },
      reason: "grant",
    });
    expect(await a.nextOfType("floor-changed")).toEqual(floorA);
    expect(await b.nextOfType("floor-changed")).toEqual(floorA);
  });

  it("teacher speaking-start preempts a student holder (rule 5, reason preempted:p)", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(a.ws, { t: "raise-hand" });
    await teacher.nextOfType("hands");
    send(teacher.ws, { t: "grant", participantId: "s-a" });
    await teacher.nextOfType("floor-changed");
    await a.nextOfType("floor-changed");
    await b.nextOfType("floor-changed");

    send(teacher.ws, { t: "speaking-start" });
    const preempt = await teacher.nextOfType("floor-changed");
    expect(preempt).toEqual({
      t: "floor-changed",
      floor: { kind: "teacher" },
      reason: "preempted:s-a",
    });
    expect(await a.nextOfType("floor-changed")).toEqual(preempt);
    expect(await b.nextOfType("floor-changed")).toEqual(preempt);
  });

  it("binary frames from a non-holder are dropped with error{not-your-floor} and counted (rule 6)", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(a.ws, { t: "raise-hand" });
    await teacher.nextOfType("hands");
    send(teacher.ws, { t: "grant", participantId: "s-a" });
    await teacher.nextOfType("floor-changed");
    await a.nextOfType("floor-changed");
    await b.nextOfType("floor-changed");
    // Pre-warmed sessions (M0.5) broadcast connecting+live statuses right
    // after the grant; let their ~0 ms timers land so the quiet windows
    // below do not race them (quiet() counts raw received length).
    await new Promise((resolve) => setTimeout(resolve, 30));

    // s-b holds no floor: frame dropped, sender told, nobody else hears.
    // The running violation count rides in the message (T-012 metrics hook).
    b.ws.send(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]));
    const drop1 = await b.nextError();
    expect(drop1).toMatchObject({ t: "error", code: "not-your-floor" });
    expect(drop1.message).toMatch(/violation 1/);
    await teacher.quiet();
    await a.quiet();

    // A second violation is counted again, not swallowed.
    b.ws.send(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]));
    const drop2 = await b.nextError();
    expect(drop2).toMatchObject({ t: "error", code: "not-your-floor" });
    expect(drop2.message).toMatch(/violation 2/);

    // The holder's frames pass the gate into the T-009 fan-out: no error
    // answers the holder (translated audio reaches the other listeners as
    // binary frames, which this text-only inbox ignores by design; the
    // session-status broadcasts below are expected fan-out chatter).
    a.ws.send(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(a.received.some((m) => m.t === "error")).toBe(false);
  });

  it("grant(q) while p speaks hands the floor over (rule 9, reason handover)", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(a.ws, { t: "raise-hand" });
    await teacher.nextOfType("hands");
    send(b.ws, { t: "raise-hand" });
    await teacher.nextOfType("hands");
    await a.nextOfType("hands");
    await a.nextOfType("hands");
    await b.nextOfType("hands");
    await b.nextOfType("hands");

    send(teacher.ws, { t: "grant", participantId: "s-a" });
    await teacher.nextOfType("floor-changed");
    await a.nextOfType("floor-changed");
    await b.nextOfType("floor-changed");

    send(teacher.ws, { t: "grant", participantId: "s-b" });
    const handover = await teacher.nextOfType("floor-changed");
    expect(handover).toEqual({
      t: "floor-changed",
      floor: { kind: "student", participantId: "s-b" },
      reason: "handover",
    });
    expect(await a.nextOfType("floor-changed")).toEqual(handover);
    expect(await b.nextOfType("floor-changed")).toEqual(handover);
  });

  it("grant to an absent pid answers error{grant-absent} with no state change", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(teacher.ws, { t: "grant", participantId: "s-ghost" });
    expect(await teacher.nextError()).toMatchObject({
      t: "error",
      code: "grant-absent",
    });
    await teacher.quiet();
    await a.quiet();
    await b.quiet();
  });

  it("revoke on an IDLE floor is a no-op that still broadcasts (keeps clients in sync)", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(teacher.ws, { t: "revoke" });
    const noop = await teacher.nextOfType("floor-changed");
    expect(noop).toEqual({
      t: "floor-changed",
      floor: { kind: "none" },
      reason: "revoke-noop",
    });
    expect(await a.nextOfType("floor-changed")).toEqual(noop);
    expect(await b.nextOfType("floor-changed")).toEqual(noop);
  });

  it("role checks: student grant/deny/revoke and ungranted speaking-start are rejected", async () => {
    const room = freshRoom();
    const { teacher, a } = await trio(room);

    send(a.ws, { t: "grant", participantId: "s-a" });
    expect(await a.nextError()).toMatchObject({
      t: "error",
      code: "not-your-floor",
    });

    send(a.ws, { t: "speaking-start" });
    expect(await a.nextError()).toMatchObject({
      t: "error",
      code: "not-your-floor",
    });

    send(a.ws, { t: "revoke" });
    expect(await a.nextError()).toMatchObject({
      t: "error",
      code: "not-your-floor",
    });

    // The teacher's floor is untouched by the rejected student frames.
    await teacher.quiet();
  });
});
