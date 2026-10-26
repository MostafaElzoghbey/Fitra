// T-009: DO audio fan-out over the real Workers pool (Fake provider).
//
// Teacher (ar) speaks -> en + fr students receive type-0x02 translated frames,
// a second ar student receives the byte-identical original relay, and the
// speaker never hears their own speech (FR-015). Non-holder frames are gated
// (rule 6), over-rate frames are dropped, oversize frames are rejected, and
// undecodable frames are dropped without killing the room.
import { env } from "cloudflare:test";
import {
  decodeAudioFrame,
  FITRA_AUDIO_TYPE_DOWNLINK,
  isServerMsg,
  type ServerMsg,
} from "@fitra/shared";
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
  return `T009${String(roomSeq).padStart(3, "0")}`;
}

function tokenFor(room: string, join: Join): Promise<string> {
  return signJoinToken(
    { room, pid: join.pid, role: join.role, lang: join.lang },
    SECRET,
  );
}

/**
 * Client-side view of one participant socket: buffers inbound text control
 * frames (validated by isServerMsg) AND inbound binary audio frames, so
 * assertions never race the DO.
 */
class Inbox {
  readonly text: ServerMsg[] = [];
  readonly binary: Uint8Array[] = [];
  private readonly waiters: Array<() => void> = [];
  private textCursor = 0;
  private binCursor = 0;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev: MessageEvent) => {
      const data: unknown = ev.data;
      if (typeof data === "string") {
        const parsed: unknown = JSON.parse(data);
        if (!isServerMsg(parsed)) {
          throw new Error(`isServerMsg rejected a server frame: ${data}`);
        }
        this.text.push(parsed);
        this.wake();
      } else if (data instanceof ArrayBuffer) {
        this.binary.push(new Uint8Array(data));
        this.wake();
      } else if (data instanceof Uint8Array) {
        this.binary.push(data.slice());
        this.wake();
      } else if (typeof Blob !== "undefined" && data instanceof Blob) {
        // workerd delivers inbound binary as Blob; resolve it async — the
        // `nextBinaryWhere` poll below picks it up once landed.
        void (data as Blob).arrayBuffer().then((buf: ArrayBuffer) => {
          this.binary.push(new Uint8Array(buf));
          this.wake();
        });
      } else {
        throw new Error(`unexpected frame type: ${typeof data}`);
      }
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

  async nextError(timeoutMs = 1500): Promise<Extract<ServerMsg, { t: "error" }>> {
    return this.nextOfType("error", timeoutMs);
  }

  /** Oldest not-yet-consumed binary frame matching `pred`, waiting when late. */
  async nextBinaryWhere(
    pred: (frame: Uint8Array) => boolean,
    timeoutMs = 3000,
  ): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const window = this.binary.slice(this.binCursor);
      const idx = window.findIndex(pred);
      if (idx >= 0) {
        const found = window[idx];
        if (found === undefined) throw new Error("unreachable");
        this.binCursor += idx + 1;
        return found;
      }
      if (Date.now() >= deadline) break;
      await this.tick();
    }
    throw new Error(
      `timed out waiting for a matching binary frame; got ${this.binary.length - this.binCursor} other binary frames`,
    );
  }

  get textPending(): number {
    return this.text.length - this.textCursor;
  }

  get binPending(): number {
    return this.binary.length - this.binCursor;
  }

  /** Fails when any further text frame arrives inside `timeoutMs`. */
  async quietText(timeoutMs = 200): Promise<void> {
    const before = this.text.length;
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    expect(this.text.length).toBe(before);
  }

  /** Fails when any further binary frame arrives inside `timeoutMs`. */
  async quietBinary(timeoutMs = 300): Promise<void> {
    const before = this.binary.length;
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    expect(this.binary.length).toBe(before);
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

/** Teacher (ar) + en/fr/ar students, all join frames drained. */
async function quartet(room: string): Promise<{
  readonly teacher: Inbox;
  readonly sEn: Inbox;
  readonly sFr: Inbox;
  readonly sAr2: Inbox;
}> {
  const teacher = await connect(room, {
    pid: "t",
    role: "teacher",
    lang: "ar",
    name: "Layla",
  });
  await drainWelcomeAndHands(teacher, 1);
  const sEn = await connect(room, {
    pid: "s-en",
    role: "student",
    lang: "en",
    name: "Marco",
  });
  await teacher.nextOfType("welcome");
  await drainWelcomeAndHands(sEn, 1);
  const sFr = await connect(room, {
    pid: "s-fr",
    role: "student",
    lang: "fr",
    name: "Aisha",
  });
  await teacher.nextOfType("welcome");
  await sEn.nextOfType("welcome");
  await drainWelcomeAndHands(sFr, 1);
  const sAr2 = await connect(room, {
    pid: "s-ar2",
    role: "student",
    lang: "ar",
    name: "Omar",
  });
  await teacher.nextOfType("welcome");
  await sEn.nextOfType("welcome");
  await sFr.nextOfType("welcome");
  await drainWelcomeAndHands(sAr2, 1);
  return { teacher, sEn, sFr, sAr2 };
}

async function teacherTakesFloor(
  teacher: Inbox,
  sEn: Inbox,
  sFr: Inbox,
  sAr2: Inbox,
): Promise<void> {
  teacher.ws.send(JSON.stringify({ t: "speaking-start" }));
  const changed = await teacher.nextOfType("floor-changed");
  expect(changed).toEqual({
    t: "floor-changed",
    floor: { kind: "teacher" },
    reason: "teacher-start",
  });
  expect(await sEn.nextOfType("floor-changed")).toEqual(changed);
  expect(await sFr.nextOfType("floor-changed")).toEqual(changed);
  expect(await sAr2.nextOfType("floor-changed")).toEqual(changed);
}

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

function payloadOf(frame: Uint8Array): Uint8Array {
  return decodeAudioFrame(frame).payload;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function connectAll(room: string, joins: Join[]): Promise<Inbox[]> {
  const inboxes: Inbox[] = [];
  for (const join of joins) {
    const inbox = await connect(room, join);
    await drainWelcomeAndHands(inbox, 1);
    for (const prev of inboxes) await prev.nextOfType("welcome");
    inboxes.push(inbox);
  }
  return inboxes;
}

async function teacherTakesFloorOn(
  inboxes: Inbox[],
  reason = "teacher-start",
): Promise<void> {
  const teacher = inboxes[0];
  if (teacher === undefined) throw new Error("no teacher inbox");
  teacher.ws.send(JSON.stringify({ t: "speaking-start" }));
  const changed = await teacher.nextOfType("floor-changed");
  expect(changed).toEqual({
    t: "floor-changed",
    floor: { kind: "teacher" },
    reason,
  });
  for (const other of inboxes.slice(1)) {
    expect(await other.nextOfType("floor-changed")).toEqual(changed);
  }
}

function countMatchingEchoes(inbox: Inbox, payload: Uint8Array): number {
  let count = 0;
  for (const frame of inbox.binary) {
    try {
      const d = decodeAudioFrame(frame);
      if (d.type === FITRA_AUDIO_TYPE_DOWNLINK && equalBytes(d.payload, payload)) {
        count += 1;
      }
    } catch {
      // Control/binary garbage: not an echo.
    }
  }
  return count;
}

function captionsOf(inbox: Inbox): Extract<ServerMsg, { t: "caption" }>[] {
  return inbox.text.filter(
    (m): m is Extract<ServerMsg, { t: "caption" }> => m.t === "caption",
  );
}

describe("pair-fanout dedupe, pre-warm, captions, rejoin (latency/quality M0.5)", () => {
  it("feeds each translation pair exactly once per frame (N listeners share one feed)", async () => {
    const room = freshRoom();
    const [teacher, sEn1, sEn2, sFr] = await connectAll(room, [
      { pid: "t", role: "teacher", lang: "ar", name: "Layla" },
      { pid: "s-en1", role: "student", lang: "en", name: "Marco" },
      { pid: "s-en2", role: "student", lang: "en", name: "Maya" },
      { pid: "s-fr", role: "student", lang: "fr", name: "Aisha" },
    ]);
    if (teacher === undefined || sEn1 === undefined || sEn2 === undefined || sFr === undefined) {
      throw new Error("missing inboxes");
    }
    await teacherTakesFloorOn([teacher, sEn1, sEn2, sFr]);

    // 4 frames: pre-warmed at grant, every frame must reach the pair feed
    // exactly once -> 4 echoes per listener. Bug shape: 2 en listeners double
    // feed ar->en (6 echoes) while fr gets 3.
    const payload = new Uint8Array(160).fill(0x77);
    for (let i = 0; i < 4; i += 1) {
      teacher.ws.send(uplinkFrame(i, payload));
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(countMatchingEchoes(sEn1, payload)).toBe(4);
    expect(countMatchingEchoes(sEn2, payload)).toBe(4);
    expect(countMatchingEchoes(sFr, payload)).toBe(4);
    await sEn1.quietBinary();
    await sEn2.quietBinary();
  });

  it("pre-warms sessions at floor grant: session-status arrives before any audio", async () => {
    const room = freshRoom();
    const { teacher, sEn, sFr, sAr2 } = await quartet(room);
    await teacherTakesFloor(teacher, sEn, sFr, sAr2);

    // No audio frames were sent: the grant itself must open the pairs. Pair
    // statuses interleave arbitrarily on every inbox, so scan until the pair
    // matches instead of assuming an order.
    async function statusFor(
      inbox: Inbox,
      pair: string,
    ): Promise<Extract<ServerMsg, { t: "session-status" }>> {
      for (let seen = 0; seen < 8; seen += 1) {
        const st = await inbox.nextOfType("session-status");
        if (st.pair === pair) return st;
      }
      throw new Error(`no session-status for ${pair}`);
    }
    const enStatus = await statusFor(sEn, "ar->en");
    expect(["connecting", "live"]).toContain(enStatus.status);
    await statusFor(sFr, "ar->fr");
  });

  it("routes captions: both kinds to target-lang members, never to speaker/same-lang", async () => {
    const room = freshRoom();
    const { teacher, sEn, sFr, sAr2 } = await quartet(room);
    await teacherTakesFloor(teacher, sEn, sFr, sAr2);

    const payload = new Uint8Array(160).fill(0x66);
    for (let i = 0; i < 3; i += 1) {
      teacher.ws.send(uplinkFrame(i, payload));
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    // One listener belongs to exactly one pair, so one caption stream of each
    // kind; the routing contract is about kind/lang membership.
    const enCaptions = captionsOf(sEn);
    expect(enCaptions.length).toBeGreaterThanOrEqual(2);
    expect(enCaptions.some((c) => c.kind === "input")).toBe(true);
    expect(enCaptions.some((c) => c.kind === "output")).toBe(true);
    for (const cap of enCaptions) {
      expect(typeof cap.text).toBe("string");
      expect(cap.text.length).toBeGreaterThan(0);
    }
    // Same-lang listeners (incl. the speaker) get neither kind.
    expect(captionsOf(sAr2)).toEqual([]);
    expect(captionsOf(teacher)).toEqual([]);
    // Per-pair output routing: the fr pair targets fr.
    expect(captionsOf(sFr).some((c) => c.kind === "output")).toBe(true);
  });

  it("teacher socket replacement keeps membership and floor (teacherRejoin, no teacher-taken)", async () => {
    const room = freshRoom();
    const teacherJoin: Join = {
      pid: "t",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    };
    const [t1, sEn] = await connectAll(room, [
      teacherJoin,
      { pid: "s-en", role: "student", lang: "en", name: "Marco" },
    ]);
    if (t1 === undefined || sEn === undefined) throw new Error("missing inboxes");

    const t2 = await connect(room, teacherJoin);
    // teacherRejoin's floor-changed broadcast precedes the welcome frame, so
    // read it BEFORE drainWelcomeAndHands (nextOfType would skip past it).
    const changed = await t2.nextOfType("floor-changed");
    expect(changed.reason).toBe("teacher-rejoin");
    await drainWelcomeAndHands(t2, 1);

    expect(
      t2.text.filter((m) => m.t === "error" && m.code === "teacher-taken"),
    ).toEqual([]);

    // sEn receives the same teacher-rejoin floor sync; drain it so the next
    // floor-changed it observes is the floor grant itself.
    expect((await sEn.nextOfType("floor-changed")).reason).toBe(
      "teacher-rejoin",
    );

    // Membership row survived the replaced socket's close: translation flows.
    await teacherTakesFloorOn([t2, sEn]);
    const payload = new Uint8Array(160).fill(0x88);
    for (let i = 0; i < 4; i += 1) {
      t2.ws.send(uplinkFrame(i, payload));
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(countMatchingEchoes(sEn, payload)).toBe(4);
  });
});

describe("ClassRoom audio fan-out (T-009, FR-015/020..025)", () => {
  it("en+fr students receive translated frames when the ar teacher speaks", async () => {
    const room = freshRoom();
    const { teacher, sEn, sFr, sAr2 } = await quartet(room);
    await teacherTakesFloor(teacher, sEn, sFr, sAr2);

    // The first frame opens the provider sessions (open gap drops audio by
    // design); the frames after it must be translated and fanned out.
    const payload = new Uint8Array(160);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff;
    teacher.ws.send(uplinkFrame(0, payload));
    await new Promise((resolve) => setTimeout(resolve, 400));
    teacher.ws.send(uplinkFrame(1, payload));
    teacher.ws.send(uplinkFrame(2, payload));

    const enFrame = await sEn.nextBinaryWhere(
      (f) => {
        try {
          const d = decodeAudioFrame(f);
          return (
            d.type === FITRA_AUDIO_TYPE_DOWNLINK &&
            equalBytes(d.payload, payload)
          );
        } catch {
          return false;
        }
      },
    );
    expect(enFrame.length).toBe(8 + payload.length);
    const frFrame = await sFr.nextBinaryWhere((f) =>
      equalBytes(payloadOf(f), payload),
    );
    expect(decodeAudioFrame(frFrame).type).toBe(FITRA_AUDIO_TYPE_DOWNLINK);
  });

  it("the teacher receives nothing of their own speech (FR-015)", async () => {
    const room = freshRoom();
    const { teacher, sEn, sFr, sAr2 } = await quartet(room);
    await teacherTakesFloor(teacher, sEn, sFr, sAr2);

    const payload = new Uint8Array(160).fill(0xab);
    teacher.ws.send(uplinkFrame(0, payload));
    await new Promise((resolve) => setTimeout(resolve, 400));
    teacher.ws.send(uplinkFrame(1, payload));
    // Listeners must hear it (proves the speech was fanned out at all).
    await sEn.nextBinaryWhere((f) => equalBytes(payloadOf(f), payload));

    await teacher.quietBinary();
    await teacher.quietText();
  });

  it("a same-language second ar student gets a 24 kHz type-0x02 re-wrap", async () => {
    const room = freshRoom();
    const { teacher, sEn, sFr, sAr2 } = await quartet(room);
    await teacherTakesFloor(teacher, sEn, sFr, sAr2);

    // 80 samples of constant 0x5a5a: linear upsampling of a constant is the
    // same constant, 80 * 24/16 = 120 samples = 240 bytes.
    const payload = new Uint8Array(160).fill(0x5a);
    const original = uplinkFrame(7, payload);
    teacher.ws.send(original);
    await new Promise((resolve) => setTimeout(resolve, 400));
    teacher.ws.send(original.slice());

    const relayed = await sAr2.nextBinaryWhere((f) => {
      try {
        const d = decodeAudioFrame(f);
        return (
          d.type === FITRA_AUDIO_TYPE_DOWNLINK && d.payload.length === 240
        );
      } catch {
        return false;
      }
    });
    const decoded = decodeAudioFrame(relayed);
    expect(decoded.type).toBe(FITRA_AUDIO_TYPE_DOWNLINK);
    expect(decoded.payload.length).toBe(240);
    const view = new DataView(
      decoded.payload.buffer,
      decoded.payload.byteOffset,
      decoded.payload.byteLength,
    );
    expect(view.getInt16(0, true)).toBe(0x5a5a);
    expect(view.getInt16(238, true)).toBe(0x5a5a);
    // Per-listener downlink sequencing starts at 0 for the relay leg.
    expect(decoded.seq).toBe(0);
  });

  it("non-holder binary is dropped with error{not-your-floor} (rule 6)", async () => {
    const room = freshRoom();
    const { teacher, sEn, sFr, sAr2 } = await quartet(room);
    await teacherTakesFloor(teacher, sEn, sFr, sAr2);

    sEn.ws.send(uplinkFrame(0, new Uint8Array(160).fill(0x01)));
    expect(await sEn.nextError()).toMatchObject({
      t: "error",
      code: "not-your-floor",
    });

    // Nobody hears the dropped frame: the holder gets no binary from it.
    await teacher.quietBinary();
    await sFr.quietBinary();
    await sAr2.quietBinary();
  });

  it("over-rate audio is dropped (repeated bursts answer error{rate-limited})", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await drainWelcomeAndHands(teacher, 1);
    teacher.ws.send(JSON.stringify({ t: "speaking-start" }));
    await teacher.nextOfType("floor-changed");

    for (let i = 0; i < 30; i += 1) {
      teacher.ws.send(uplinkFrame(i, new Uint8Array(16).fill(0x02)));
    }
    expect(await teacher.nextError(2000)).toMatchObject({
      t: "error",
      code: "rate-limited",
    });
  });

  it("a frame larger than 8 KiB is rejected with error{frame-too-large}", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await drainWelcomeAndHands(teacher, 1);
    teacher.ws.send(JSON.stringify({ t: "speaking-start" }));
    await teacher.nextOfType("floor-changed");

    teacher.ws.send(uplinkFrame(0, new Uint8Array(9000).fill(0x03)));
    expect(await teacher.nextError()).toMatchObject({
      t: "error",
      code: "frame-too-large",
    });
  });

  it("an undecodable frame is dropped silently and the room stays alive", async () => {
    const room = freshRoom();
    const teacher = await connect(room, {
      pid: "t",
      role: "teacher",
      lang: "ar",
      name: "Layla",
    });
    await drainWelcomeAndHands(teacher, 1);
    teacher.ws.send(JSON.stringify({ t: "speaking-start" }));
    await teacher.nextOfType("floor-changed");

    teacher.ws.send(new Uint8Array([0x01, 0x01, 0x00]));
    await teacher.quietText();
    await teacher.quietBinary();

    teacher.ws.send(JSON.stringify({ t: "ping", id: 9 }));
    expect(await teacher.nextOfType("pong")).toEqual({ t: "pong", id: 9 });
  });
});
