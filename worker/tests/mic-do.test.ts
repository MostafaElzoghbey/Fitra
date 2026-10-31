// T-028: mic control wired into the ClassRoom DO (docs/MIC-CONTROL.md,
// docs/PROTOCOL.md section 3, worker/src/mic.ts pure machine).
//
// Real DO-pool tests: every frame goes through
// `env.CLASSROOM.getByName(roomCode)` over genuine `WebSocketPair`s, so
// `routeControl`/`routeBinary` and the in-memory mic machine all execute
// inside workerd. Each test takes a fresh room code, so DO instances never
// leak mic state between cases.
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
  return `T028${String(roomSeq).padStart(3, "0")}`;
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

  /** Fails when any further non-metrics frame arrives inside `timeoutMs`. */
  async quiet(timeoutMs = 150): Promise<void> {
    const before = this.received.filter((m) => m.t !== "metrics").length;
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    expect(this.received.filter((m) => m.t !== "metrics").length).toBe(before);
  }

  /** Fails when an `error` frame arrives after `afterIndex` inside `timeoutMs`. */
  async quietErrorsAfter(afterIndex: number, timeoutMs = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    const late = this.received
      .slice(afterIndex)
      .filter((m) => m.t === "error");
    expect(late).toEqual([]);
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

function welcomeOf(msg: ServerMsg): Extract<ServerMsg, { t: "welcome" }> {
  if (msg.t !== "welcome") {
    throw new Error(`expected welcome, got ${JSON.stringify(msg)}`);
  }
  return msg;
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
  const a = await connect(room, {
    pid: "s-a",
    role: "student",
    lang: "en",
    name: "Marco",
  });
  await a.nextOfType("welcome");
  await teacher.nextOfType("welcome");
  const b = await connect(room, {
    pid: "s-b",
    role: "student",
    lang: "fr",
    name: "Aisha",
  });
  await b.nextOfType("welcome");
  await teacher.nextOfType("welcome");
  await a.nextOfType("welcome");
  return { teacher, a, b };
}

describe("ClassRoom mic control via the pure machine (T-028)", () => {
  it("student mic-open broadcasts mic-changed{true} to every socket", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(a.ws, { t: "mic-open" });
    const changed = { t: "mic-changed", participantId: "s-a", micOpen: true };
    expect(await teacher.nextOfType("mic-changed")).toEqual(changed);
    expect(await a.nextOfType("mic-changed")).toEqual(changed);
    expect(await b.nextOfType("mic-changed")).toEqual(changed);
  });

  it("forced student mic-open answers error{mic-forced-muted} to the sender only", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(teacher.ws, { t: "mute", participantId: "s-a" });
    const sync = welcomeOf(await teacher.nextOfType("welcome"));
    expect(sync.roster.find((r) => r.participantId === "s-a")).toMatchObject({
      forcedMuted: true,
      micOpen: false,
    });
    await a.nextOfType("welcome");
    await b.nextOfType("welcome");

    send(a.ws, { t: "mic-open" });
    expect(await a.nextError()).toMatchObject({
      t: "error",
      code: "mic-forced-muted",
    });
    await teacher.quiet();
    await b.quiet();
  });

  it("mute-all cuts open mics, latches the room, and a late joiner is admitted force-muted", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(a.ws, { t: "mic-open" });
    for (const inbox of [teacher, a, b]) {
      await inbox.nextOfType("mic-changed");
    }

    send(teacher.ws, { t: "mute-all" });
    const cut = { t: "mic-changed", participantId: "s-a", micOpen: false };
    expect(await teacher.nextOfType("mic-changed")).toEqual(cut);
    expect(await a.nextOfType("mic-changed")).toEqual(cut);
    expect(await b.nextOfType("mic-changed")).toEqual(cut);
    for (const inbox of [teacher, a, b]) {
      const roster = welcomeOf(await inbox.nextOfType("welcome")).roster;
      expect(roster.find((r) => r.participantId === "s-a")).toMatchObject({
        forcedMuted: true,
        micOpen: false,
      });
      expect(roster.find((r) => r.participantId === "t")).toMatchObject({
        forcedMuted: false,
      });
    }

    // The latch applies at admission: the newcomer's welcome shows them
    // force-muted before they ever try to speak.
    const late = await connect(room, {
      pid: "s-c",
      role: "student",
      lang: "en",
      name: "Nadia",
    });
    const lateRoster = welcomeOf(await late.nextOfType("welcome")).roster;
    expect(lateRoster.find((r) => r.participantId === "s-c")).toMatchObject({
      forcedMuted: true,
      micOpen: false,
    });
    await teacher.nextOfType("welcome");

    send(a.ws, { t: "mic-open" });
    expect(await a.nextError()).toMatchObject({
      t: "error",
      code: "mic-forced-muted",
    });
  });

  it("unmute-all clears every flag; students may open their own mics again", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(teacher.ws, { t: "mute-all" });
    for (const inbox of [teacher, a, b]) {
      await inbox.nextOfType("welcome");
    }
    send(teacher.ws, { t: "unmute-all" });
    for (const inbox of [teacher, a, b]) {
      const roster = welcomeOf(await inbox.nextOfType("welcome")).roster;
      for (const entry of roster) expect(entry.forcedMuted).toBe(false);
    }

    send(a.ws, { t: "mic-open" });
    const changed = { t: "mic-changed", participantId: "s-a", micOpen: true };
    expect(await teacher.nextOfType("mic-changed")).toEqual(changed);
    expect(await a.nextOfType("mic-changed")).toEqual(changed);
    expect(await b.nextOfType("mic-changed")).toEqual(changed);
  });

  it("student mute/mute-all are role violations (bad-message); teacher controls survive", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(a.ws, { t: "mute", participantId: "s-b" });
    expect(await a.nextError()).toMatchObject({
      t: "error",
      code: "bad-message",
    });
    send(a.ws, { t: "mute-all" });
    expect(await a.nextError()).toMatchObject({
      t: "error",
      code: "bad-message",
    });
    await teacher.quiet();
    await b.quiet();

    // The rejected frames changed nothing: s-b still opens freely.
    send(b.ws, { t: "mic-open" });
    const changed = { t: "mic-changed", participantId: "s-b", micOpen: true };
    expect(await teacher.nextOfType("mic-changed")).toEqual(changed);
    expect(await a.nextOfType("mic-changed")).toEqual(changed);
    expect(await b.nextOfType("mic-changed")).toEqual(changed);
  });

  it("teacher mute of an absent student answers error{mute-absent}", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(teacher.ws, { t: "mute", participantId: "s-ghost" });
    expect(await teacher.nextError()).toMatchObject({
      t: "error",
      code: "mute-absent",
    });
    await a.quiet();
    await b.quiet();
  });

  it("unmute never auto-opens: audio still gated until the student opens their mic", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(teacher.ws, { t: "mute", participantId: "s-b" });
    for (const inbox of [teacher, a, b]) await inbox.nextOfType("welcome");
    send(teacher.ws, { t: "unmute", participantId: "s-b" });
    for (const inbox of [teacher, a, b]) {
      const roster = welcomeOf(await inbox.nextOfType("welcome")).roster;
      expect(roster.find((r) => r.participantId === "s-b")).toMatchObject({
        forcedMuted: false,
        micOpen: false,
      });
    }

    b.ws.send(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]));
    expect(await b.nextError()).toMatchObject({
      t: "error",
      code: "mic-closed",
    });
  });

  it("binary gate: closed-mic frames are counted and answered; open-mic frames pass", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    b.ws.send(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]));
    const drop1 = await b.nextError();
    expect(drop1).toMatchObject({ t: "error", code: "mic-closed" });
    expect(drop1.message).toMatch(/violation 1/);

    b.ws.send(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]));
    const drop2 = await b.nextError();
    expect(drop2.message).toMatch(/violation 2/);

    send(b.ws, { t: "mic-open" });
    for (const inbox of [teacher, a, b]) {
      await inbox.nextOfType("mic-changed");
    }
    const before = b.received.length;
    b.ws.send(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]));
    await b.quietErrorsAfter(before);
    expect(b.received.filter((m) => m.t === "error")).toHaveLength(2);
  });

  it("mic-close broadcasts mic-changed{false} to every socket", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(a.ws, { t: "mic-open" });
    for (const inbox of [teacher, a, b]) {
      await inbox.nextOfType("mic-changed");
    }
    send(a.ws, { t: "mic-close" });
    const closed = { t: "mic-changed", participantId: "s-a", micOpen: false };
    expect(await teacher.nextOfType("mic-changed")).toEqual(closed);
    expect(await a.nextOfType("mic-changed")).toEqual(closed);
    expect(await b.nextOfType("mic-changed")).toEqual(closed);
  });

  it("an open-mic student leaving broadcasts the cut and a roster without them", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(a.ws, { t: "mic-open" });
    for (const inbox of [teacher, a, b]) {
      await inbox.nextOfType("mic-changed");
    }
    a.ws.close(1000, "bye");
    const closed = { t: "mic-changed", participantId: "s-a", micOpen: false };
    expect(await teacher.nextOfType("mic-changed")).toEqual(closed);
    expect(await b.nextOfType("mic-changed")).toEqual(closed);
    expect(
      welcomeOf(await teacher.nextOfType("welcome")).roster.map(
        (r) => r.participantId,
      ),
    ).toEqual(["t", "s-b"]);
    await b.nextOfType("welcome");
  });

  it("a teacher leaving cuts only the teacher leg; the mic room keeps working", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(teacher.ws, { t: "mic-open" });
    for (const inbox of [teacher, a, b]) {
      await inbox.nextOfType("mic-changed");
    }
    teacher.ws.close(1000, "bye");
    const closed = { t: "mic-changed", participantId: "t", micOpen: false };
    expect(await a.nextOfType("mic-changed")).toEqual(closed);
    expect(await b.nextOfType("mic-changed")).toEqual(closed);
    await a.nextOfType("welcome");
    await b.nextOfType("welcome");

    // Students are unaffected by the teacher departure.
    send(b.ws, { t: "mic-open" });
    const changed = { t: "mic-changed", participantId: "s-b", micOpen: true };
    expect(await a.nextOfType("mic-changed")).toEqual(changed);
    expect(await b.nextOfType("mic-changed")).toEqual(changed);
  });

  it("a second mute-all after the first is just a roster ping (no cut spam)", async () => {
    const room = freshRoom();
    const { teacher, a, b } = await trio(room);

    send(teacher.ws, { t: "mute-all" });
    for (const inbox of [teacher, a, b]) await inbox.nextOfType("welcome");
    send(teacher.ws, { t: "mute-all" });
    for (const inbox of [teacher, a, b]) await inbox.nextOfType("welcome");

    await teacher.quiet();
    await a.quiet();
    await b.quiet();
  });
});
