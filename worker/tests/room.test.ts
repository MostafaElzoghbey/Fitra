// T-006: ClassRoom DO — join-token auth on upgrade, membership, roster and the
// Hibernation WebSocket API (docs/PROTOCOL.md sections 1/3/4, SPEC FR-001..007,
// FR-050/052, ARCHITECTURE.md section 3).
//
// Real DO-pool tests: every connection goes through
// `env.CLASSROOM.getByName(roomCode)` (the `idFromName` routing the Worker uses)
// over a genuine `WebSocketPair`, so `acceptWebSocket`, `webSocketMessage` and
// `webSocketClose` all execute inside workerd. Each test takes a fresh room
// code, so DO instances never leak state between cases.
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { isServerMsg, type ServerMsg } from "@fitra/shared";
import { afterEach, describe, expect, it } from "vitest";
import { signJoinToken, type JoinRole } from "../src/auth/token.js";

const SECRET = env.JOIN_TOKEN_HMAC_SECRET;
const MAX_STUDENTS = env.MAX_STUDENTS;

interface Join {
  readonly pid: string;
  readonly role: JoinRole;
  readonly lang: string;
  readonly name: string;
}

let roomSeq = 0;

function freshRoom(): string {
  roomSeq += 1;
  return `T006${String(roomSeq).padStart(3, "0")}`;
}

function tokenFor(room: string, join: Join): Promise<string> {
  return signJoinToken(
    { room, pid: join.pid, role: join.role, lang: join.lang },
    SECRET,
  );
}

interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

/**
 * Client-side view of one participant socket: buffers every inbound control
 * frame and resolves `nextOfType`/`closed()` off the workerd event queue so
 * assertions never race the DO.
 */
class Inbox {
  readonly received: ServerMsg[] = [];
  private readonly waiters: Array<() => void> = [];
  private cursor = 0;
  private closeInfo: CloseInfo | null = null;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev: MessageEvent) => {
      const data: unknown = ev.data;
      if (typeof data !== "string") {
        throw new Error(`expected a text control frame, got ${typeof data}`);
      }
      const parsed: unknown = JSON.parse(data);
      if (!isServerMsg(parsed)) {
        throw new Error(`isServerMsg rejected a server frame: ${data}`);
      }
      this.received.push(parsed);
      this.wake();
    });
    ws.addEventListener("close", (ev: CloseEvent) => {
      this.closeInfo = { code: ev.code, reason: ev.reason };
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

  private async until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) return false;
      await this.tick();
    }
    return true;
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

  async closed(timeoutMs = 1000): Promise<CloseInfo> {
    if (!(await this.until(() => this.closeInfo !== null, timeoutMs))) {
      throw new Error(
        `socket did not close within ${timeoutMs}ms; received: ${JSON.stringify(this.received)}`,
      );
    }
    if (this.closeInfo === null) throw new Error("unreachable");
    return this.closeInfo;
  }

  /** Fails when any further non-metrics frame arrives inside `timeoutMs`. */
  async quiet(timeoutMs = 150): Promise<void> {
    const before = this.received.filter((m) => m.t !== "metrics").length;
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    expect(this.received.filter((m) => m.t !== "metrics").length).toBe(before);
  }
}

const openSockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of openSockets.splice(0)) ws.close(1000, "test-teardown");
});

function wsUrl(query: string): string {
  return `https://classroom.invalid/ws?${query}`;
}

async function upgrade(
  room: string,
  query: string,
): Promise<{ status: number; error: unknown; inbox: Inbox | null }> {
  const stub = env.CLASSROOM.getByName(room);
  const res = await stub.fetch(wsUrl(query), {
    headers: { Upgrade: "websocket" },
  });
  if (res.status !== 101) {
    return { status: res.status, error: await res.json(), inbox: null };
  }
  const ws = res.webSocket;
  if (ws === null) throw new Error("101 response carried no WebSocket");
  ws.accept();
  openSockets.push(ws);
  return { status: res.status, error: null, inbox: new Inbox(ws) };
}

async function connect(room: string, join: Join): Promise<Inbox> {
  const token = await tokenFor(room, join);
  const query = `token=${encodeURIComponent(token)}&name=${encodeURIComponent(join.name)}`;
  const { status, inbox } = await upgrade(room, query);
  expect(status, "upgrade should succeed").toBe(101);
  if (inbox === null) throw new Error("unreachable: 101 without a socket");
  return inbox;
}

/**
 * Upgrade that is expected to be REJECTED after the handshake: the DO upgrades,
 * answers with a single `error` frame and closes (FR-004 / FR-052).
 */
async function connectExpectingRejection(room: string, join: Join): Promise<Inbox> {
  const token = await tokenFor(room, join);
  const query = `token=${encodeURIComponent(token)}&name=${encodeURIComponent(join.name)}`;
  const { status, inbox } = await upgrade(room, query);
  expect(status, "rejected join still completes the handshake").toBe(101);
  if (inbox === null) throw new Error("unreachable: 101 without a socket");
  return inbox;
}

function welcomeOf(msg: ServerMsg): Extract<ServerMsg, { t: "welcome" }> {
  if (msg.t !== "welcome") {
    throw new Error(`expected welcome, got ${JSON.stringify(msg)}`);
  }
  return msg;
}

function rosterNames(msg: ServerMsg): string[] {
  return welcomeOf(msg).roster.map((entry) => entry.name);
}

function rosterIds(msg: ServerMsg): string[] {
  return welcomeOf(msg).roster.map((entry) => entry.participantId);
}

function lastRosterIds(inbox: Inbox): string[] {
  for (let i = inbox.received.length - 1; i >= 0; i -= 1) {
    const msg = inbox.received[i];
    if (msg !== undefined && msg.t === "welcome") return rosterIds(msg);
  }
  throw new Error("socket never received a welcome");
}

/** `webSocketClose` schedules the alarm asynchronously; poll until it exists. */
async function fireIdleAlarm(stub: DurableObjectStub): Promise<boolean> {
  const deadline = Date.now() + 1000;
  for (;;) {
    if (await runDurableObjectAlarm(stub)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ClassRoom upgrade auth (FR-003/050, PROTOCOL section 1)", () => {
  it("rejects a missing token with 401 and never upgrades", async () => {
    const room = freshRoom();
    const { status, error, inbox } = await upgrade(room, "name=Layla");
    expect(status).toBe(401);
    expect(error).toMatchObject({ t: "error", code: "unauthorized" });
    expect(inbox).toBeNull();
  });

  it("rejects a token signed with another secret with 401", async () => {
    const room = freshRoom();
    const forged = await signJoinToken(
      { room, pid: "p-forged", role: "teacher", lang: "ar" },
      "not-the-room-secret",
    );
    const { status } = await upgrade(
      room,
      `token=${encodeURIComponent(forged)}&name=Mallory`,
    );
    expect(status).toBe(401);
  });

  it("rejects an expired token with 401", async () => {
    const room = freshRoom();
    const expired = await signJoinToken(
      { room, pid: "p-late", role: "student", lang: "en" },
      SECRET,
      { nowS: Math.floor(Date.now() / 1000) - 3600, ttlS: 60 },
    );
    const { status } = await upgrade(
      room,
      `token=${encodeURIComponent(expired)}&name=Late`,
    );
    expect(status).toBe(401);
  });

  it("rejects a valid token minted for another room with 401", async () => {
    const room = freshRoom();
    const foreign = await tokenFor(`${room}X`, {
      pid: "p-x",
      role: "student",
      lang: "en",
      name: "Wrong",
    });
    const { status } = await upgrade(
      room,
      `token=${encodeURIComponent(foreign)}&name=Wrong`,
    );
    expect(status).toBe(401);
  });

  it("rejects an unsupported language (FR-007) without upgrading", async () => {
    const room = freshRoom();
    const token = await tokenFor(room, {
      pid: "p-klingon",
      role: "student",
      lang: "tlh",
      name: "Klingon",
    });
    const { status, error, inbox } = await upgrade(
      room,
      `token=${encodeURIComponent(token)}&name=Klingon`,
    );
    expect(status).toBe(401);
    expect(error).toMatchObject({ t: "error", code: "unsupported-language" });
    expect(inbox).toBeNull();
  });

  it("404s any path that is not the /ws endpoint", async () => {
    const room = freshRoom();
    const token = await tokenFor(room, {
      pid: "p-path",
      role: "student",
      lang: "en",
      name: "Path",
    });
    const stub = env.CLASSROOM.getByName(room);
    const res = await stub.fetch(
      `https://classroom.invalid/health?token=${encodeURIComponent(token)}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(404);
  });
});

describe("ClassRoom membership + roster (FR-001/002, PROTOCOL section 3)", () => {
  it("welcomes teacher then student with correct ids, indices and roster", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "pid-teacher",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });

    const teacherWelcome = welcomeOf(await teacher.nextOfType("welcome"));
    expect(teacherWelcome.participantId).toBe("pid-teacher");
    expect(teacherWelcome.participantIndex).toBe(0);
    expect(teacherWelcome.floor).toEqual({ kind: "none" });
    expect(teacherWelcome.roster).toEqual([
      {
        participantId: "pid-teacher",
        name: "Layla",
        role: "teacher",
        lang: "ar",
      },
    ]);
    expect(await teacher.nextOfType("hands")).toEqual({ t: "hands", raised: [] });

    const student = await connect(room, {
      pid: "pid-student",
      role: "student",
      lang: "en",
      name: "Marco",
    });

    const studentWelcome = welcomeOf(await student.nextOfType("welcome"));
    expect(studentWelcome.participantId).toBe("pid-student");
    expect(studentWelcome.participantIndex).toBe(1);
    expect(studentWelcome.floor).toEqual({ kind: "none" });
    expect(studentWelcome.roster).toEqual([
      {
        participantId: "pid-teacher",
        name: "Layla",
        role: "teacher",
        lang: "ar",
      },
      {
        participantId: "pid-student",
        name: "Marco",
        role: "student",
        lang: "en",
      },
    ]);
    expect(await student.nextOfType("hands")).toEqual({ t: "hands", raised: [] });

    const teacherSync = welcomeOf(await teacher.nextOfType("welcome"));
    expect(rosterNames(teacherSync)).toEqual(["Layla", "Marco"]);
    expect(teacherSync.participantId).toBe("pid-teacher");
    expect(teacherSync.participantIndex).toBe(0);
  });

  it("orders the roster by participantIndex", async () => {
    const room = freshRoom();
    await connect(room, { pid: "t", role: "teacher", lang: "ar", name: "Layla" });
    const student = await connect(room, {
      pid: "s1",
      role: "student",
      lang: "en",
      name: "Marco",
    });

    const welcome = welcomeOf(await student.nextOfType("welcome"));
    expect(welcome.participantIndex).toBe(1);
    expect(welcome.roster.map((entry) => [entry.role, entry.lang])).toEqual([
      ["teacher", "ar"],
      ["student", "en"],
    ]);
  });

  it("keeps two rooms with the same participantId isolated (one DO per code)", async () => {
    const roomA = freshRoom();
    const roomB = freshRoom();
    const inA = await connect(roomA, {
      pid: "shared-pid",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    const inB = await connect(roomB, {
      pid: "shared-pid",
      role: "teacher",
      lang: "fr",
      name: "Aisha",
    });
    expect(rosterIds(welcomeOf(await inA.nextOfType("welcome")))).toEqual([
      "shared-pid",
    ]);
    expect(rosterIds(welcomeOf(await inB.nextOfType("welcome")))).toEqual([
      "shared-pid",
    ]);
  });

  it("falls back to the participantId when no display name is supplied", async () => {
    const room = freshRoom();
    const token = await tokenFor(room, {
      pid: "pid-anon",
      role: "student",
      lang: "en",
      name: "unused",
    });
    const { status, inbox } = await upgrade(
      room,
      `token=${encodeURIComponent(token)}`,
    );
    expect(status).toBe(101);
    if (inbox === null) throw new Error("unreachable: 101 without a socket");
    expect(rosterNames(welcomeOf(await inbox.nextOfType("welcome")))).toEqual([
      "pid-anon",
    ]);
  });
});

describe("ClassRoom join admission (FR-004, FR-052)", () => {
  it("rejects a second teacher with error{teacher-taken} and closes the socket", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t1",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await teacher.nextOfType("welcome");

    const impostor = await connectExpectingRejection(room, {
      pid: "t2",
      role: "teacher",
      lang: "ar",
      name: "Impostor",
    });
    expect(await impostor.nextError()).toMatchObject({
      t: "error",
      code: "teacher-taken",
    });
    expect(await impostor.closed()).toMatchObject({ code: 1000 });

    await teacher.quiet();
    expect(lastRosterIds(teacher)).toEqual(["t1"]);
  });

  it(`rejects student #${MAX_STUDENTS + 1} with error{room-full} and closes the socket`, async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t1",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await teacher.nextOfType("welcome");

    for (let i = 0; i < MAX_STUDENTS; i += 1) {
      const ok = await connect(room, {
        pid: `s${i}`,
        role: "student",
        lang: "en",
        name: `Student ${i}`,
      });
      await ok.nextOfType("welcome");
    }
    // Each join re-syncs the roster to the teacher: drain every pending
    // welcome and assert on the last, which carries the full roster.
    let last = welcomeOf(await teacher.nextOfType("welcome"));
    for (let i = 1; i < MAX_STUDENTS; i += 1) {
      last = welcomeOf(await teacher.nextOfType("welcome"));
    }
    expect(last.roster).toHaveLength(1 + MAX_STUDENTS);

    const late = await connectExpectingRejection(room, {
      pid: "late",
      role: "student",
      lang: "en",
      name: "TooLate",
    });
    expect(await late.nextError()).toMatchObject({
      t: "error",
      code: "room-full",
    });
    expect(await late.closed()).toMatchObject({ code: 1000 });

    await teacher.quiet();
    expect(lastRosterIds(teacher)).toHaveLength(1 + MAX_STUDENTS);
  });

  it("frees a student slot once a member leaves", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t1",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await teacher.nextOfType("welcome");
    const student = await connect(room, {
      pid: "s1",
      role: "student",
      lang: "en",
      name: "Marco",
    });
    await student.nextOfType("welcome");
    await teacher.nextOfType("welcome");

    student.ws.close(1000, "bye");
    expect(rosterIds(welcomeOf(await teacher.nextOfType("welcome")))).toEqual([
      "t1",
    ]);

    const replacement = await connect(room, {
      pid: "s2",
      role: "student",
      lang: "fr",
      name: "Aisha",
    });
    const welcome = welcomeOf(await replacement.nextOfType("welcome"));
    expect(welcome.participantIndex).toBe(2);
    expect(rosterIds(welcome)).toEqual(["t1", "s2"]);
  });

  it("expires the room from an alarm once the last member leaves (FR-052)", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t1",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await teacher.nextOfType("welcome");

    teacher.ws.close(1000, "bye");
    expect(await fireIdleAlarm(env.CLASSROOM.getByName(room))).toBe(true);

    const late = await connectExpectingRejection(room, {
      pid: "s1",
      role: "student",
      lang: "en",
      name: "Late",
    });
    expect(await late.nextError()).toMatchObject({ t: "error", code: "room-closed" });
    expect(await late.closed()).toMatchObject({ code: 1000 });
  });
});

describe("ClassRoom webSocketMessage routing", () => {
  it("answers a control frame rejected by isClientMsg with error{bad-message}", async () => {
    const room = freshRoom();
    const student = await connect(room, {
      pid: "s1",
      role: "student",
      lang: "en",
      name: "Marco",
    });
    await student.nextOfType("welcome");

    student.ws.send(JSON.stringify({ t: "raise-hand", bogus: 1 }));
    expect(await student.nextError()).toMatchObject({
      t: "error",
      code: "bad-message",
    });

    student.ws.send("not json at all");
    expect(await student.nextError()).toMatchObject({
      t: "error",
      code: "bad-message",
    });
  });

  it("answers an unknown message type with error{bad-message}", async () => {
    const room = freshRoom();
    const student = await connect(room, {
      pid: "s1",
      role: "student",
      lang: "en",
      name: "Marco",
    });
    await student.nextOfType("welcome");

    student.ws.send(JSON.stringify({ t: "launch-missiles" }));
    expect(await student.nextError()).toMatchObject({
      t: "error",
      code: "bad-message",
    });
  });

  it("accepts a valid control frame (ping -> pong) instead of erroring", async () => {
    const room = freshRoom();
    const student = await connect(room, {
      pid: "s1",
      role: "student",
      lang: "en",
      name: "Marco",
    });
    await student.nextOfType("welcome");

    student.ws.send(JSON.stringify({ t: "ping", id: 7 }));
    expect(await student.nextOfType("pong")).toEqual({ t: "pong", id: 7 });
  });

  it("routes valid floor messages through the floor machine (T-007)", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t1",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await teacher.nextOfType("welcome");
    await teacher.nextOfType("hands");
    const student = await connect(room, {
      pid: "s1",
      role: "student",
      lang: "en",
      name: "Marco",
    });
    await student.nextOfType("welcome");
    await student.nextOfType("hands");
    await teacher.nextOfType("welcome");

    // Student raise-hand is accepted: every socket sees the hands update.
    student.ws.send(JSON.stringify({ t: "raise-hand" }));
    expect(await student.nextOfType("hands")).toEqual({
      t: "hands",
      raised: ["s1"],
    });
    expect(await teacher.nextOfType("hands")).toEqual({
      t: "hands",
      raised: ["s1"],
    });

    // Ungranted student speaking-start is rejected, never silent.
    student.ws.send(JSON.stringify({ t: "speaking-start" }));
    expect(await student.nextError()).toMatchObject({
      t: "error",
      code: "not-your-floor",
    });

    // Student grant is a role violation, answered to the sender only.
    student.ws.send(JSON.stringify({ t: "grant", participantId: "s1" }));
    expect(await student.nextError()).toMatchObject({
      t: "error",
      code: "not-your-floor",
    });
    await teacher.quiet();
  });

  it("fans out a holder binary frame instead of erroring (T-009)", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t1",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await teacher.nextOfType("welcome");
    await teacher.nextOfType("hands");

    // Rule 6: the gate drops non-holder audio, so the teacher takes the floor
    // before the frame reaches the T-009 fan-out.
    teacher.ws.send(JSON.stringify({ t: "speaking-start" }));
    expect(await teacher.nextOfType("floor-changed")).toEqual({
      t: "floor-changed",
      floor: { kind: "teacher" },
      reason: "teacher-start",
    });

    // Nobody else is in the room, so there is nothing to fan out to — and in
    // particular no error: audio fan-out never fails silently (NFR-001) and
    // never errors loudly when there is simply no listener.
    teacher.ws.send(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]));
    await teacher.quiet();
  });

  it("drops a non-holder binary frame with error{not-your-floor} (rule 6)", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t1",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await teacher.nextOfType("welcome");
    await teacher.nextOfType("hands");

    teacher.ws.send(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]));
    expect(await teacher.nextError()).toMatchObject({
      t: "error",
      code: "not-your-floor",
    });
  });
});

describe("ClassRoom internal registry (T-017 production fix)", () => {
  it("register persists the room and lookup reports it", async () => {
    const room = freshRoom();
    const stub = env.CLASSROOM.getByName(room);
    const reg = await stub.fetch("https://classroom/internal/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: room, teacherLang: "ar" }),
    });
    expect(reg.status).toBe(200);
    const lookup = await stub.fetch("https://classroom/internal/room");
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ exists: true, code: room, teacherLang: "ar" });
  });

  it("lookup reports exists:false for a never-registered room", async () => {
    const stub = env.CLASSROOM.getByName(freshRoom());
    const lookup = await stub.fetch("https://classroom/internal/room");
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ exists: false });
  });

  it("register rejects a code that does not match the routed room", async () => {
    const stub = env.CLASSROOM.getByName(freshRoom());
    const reg = await stub.fetch("https://classroom/internal/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "SOME-OTHER-ROOM", teacherLang: "ar" }),
    });
    expect(reg.status).toBe(400);
  });
});
