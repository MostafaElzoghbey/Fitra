import { describe, expect, it } from "vitest";
import {
  isClientMsg,
  isRoomMetrics,
  isRosterEntry,
  isServerMsg,
} from "../src/index.js";

describe("client message guards (PROTOCOL.md section 3, mic model)", () => {
  const validClient = [
    { t: "mic-open" },
    { t: "mic-open", epoch: 0 },
    { t: "mic-open", epoch: 0xffff },
    { t: "mic-close" },
    { t: "mic-close", epoch: 42 },
    { t: "mute-all" },
    { t: "unmute-all" },
    { t: "mute", participantId: "abc" },
    { t: "unmute", participantId: "abc" },
    { t: "ping", id: 7 },
  ] as const;

  it.each(validClient.map((m) => [JSON.stringify(m), m] as const))(
    "accepts valid %s",
    (_label, msg) => {
      expect(isClientMsg(msg)).toBe(true);
    },
  );

  it("rejects wrong shapes for every client variant", () => {
    const invalid: unknown[] = [
      null,
      undefined,
      42,
      "ping",
      [],
      {},
      { t: "unknown-tag" },
      // removed floor-era tags must not come back
      { t: "speaking-start" },
      { t: "speaking-stop" },
      { t: "raise-hand" },
      { t: "lower-hand" },
      { t: "grant", participantId: "abc" },
      { t: "deny", participantId: "abc" },
      { t: "revoke" },
      { t: "mute" }, // missing participantId
      { t: "mute", participantId: 42 }, // wrong type
      { t: "unmute" },
      { t: "unmute", participantId: null },
      { t: "mute-all", participantId: "x" }, // mute-all takes no payload
      { t: "mic-open", participantId: "x" }, // mic-open takes no payload
      { t: "mic-open", epoch: -1 },
      { t: "mic-open", epoch: 0x10000 },
      { t: "mic-close", epoch: 1.5 },
      { t: "mic-close", epoch: "1" },
      { t: "ping" }, // missing id
      { t: "ping", id: "7" }, // wrong type
      { t: 42 },
      { participantId: "abc" }, // missing t
    ];
    for (const value of invalid) {
      expect(isClientMsg(value)).toBe(false);
    }
  });

  it("does not accept server messages as client messages", () => {
    expect(isClientMsg({ t: "pong", id: 1 })).toBe(false);
    expect(
      isClientMsg({
        t: "welcome",
        participantId: "a",
        participantIndex: 0,
        roster: [],
      }),
    ).toBe(false);
  });
});

describe("roster / metrics guards", () => {
  it("accepts valid RosterEntry values with mic flags", () => {
    expect(
      isRosterEntry({
        participantId: "p1",
        participantIndex: 0,
        name: "Layla",
        role: "teacher",
        lang: "ar-EG",
        micOpen: false,
        forcedMuted: false,
      }),
    ).toBe(true);
    expect(
      isRosterEntry({
        participantId: "p2",
        participantIndex: 1,
        name: "Omar",
        role: "student",
        lang: "en-US",
        micOpen: true,
        forcedMuted: false,
      }),
    ).toBe(true);
    expect(
      isRosterEntry({
        participantId: "p3",
        participantIndex: 2,
        name: "Aisha",
        role: "student",
        lang: "fr-FR",
        micOpen: false,
        forcedMuted: true,
      }),
    ).toBe(true);
  });

  it("rejects malformed RosterEntry shapes", () => {
    const invalid: unknown[] = [
      null,
      {},
      { participantId: "p1", name: "x", role: "teacher" }, // missing lang + mic flags
      { participantId: "p1", name: "x", role: "admin", lang: "ar" }, // bad role
      { participantId: 1, name: "x", role: "student", lang: "ar" },
      {
        participantId: "p1",
        name: "x",
        role: "student",
        lang: "ar",
        micOpen: "yes",
        forcedMuted: false,
      }, // wrong micOpen type
      {
        participantId: "p1",
        name: "x",
        role: "student",
        lang: "ar",
        micOpen: true,
      }, // missing forcedMuted
      {
        // Floor-era roster entry (no mic flags, no index) must not come back.
        participantId: "p1",
        name: "x",
        role: "student",
        lang: "ar",
      },
      {
        // Missing index: the client cannot attribute caption/audio speakers.
        participantId: "p1",
        name: "x",
        role: "student",
        lang: "ar",
        micOpen: false,
        forcedMuted: false,
      },
      {
        // Wrong index type.
        participantId: "p1",
        participantIndex: "0",
        name: "x",
        role: "student",
        lang: "ar",
        micOpen: false,
        forcedMuted: false,
      },
    ];
    for (const value of invalid) expect(isRosterEntry(value)).toBe(false);
  });

  it("accepts valid RoomMetrics values incl. null latency and speaker-scoped pairs", () => {
    expect(
      isRoomMetrics({
        e2eLatencyMs: null,
        sessions: [],
        inboundMsgPerSec: 0,
        outboundMsgPerSec: 0,
        errorsLastMin: 0,
        doActiveSec: 1,
      }),
    ).toBe(true);
    expect(
      isRoomMetrics({
        e2eLatencyMs: 123,
        sessions: [
          { pair: "0:ar-en", status: "live", reconnects: 0 },
          { pair: "2:en-ar", status: "connecting", reconnects: 1 },
        ],
        inboundMsgPerSec: 10.5,
        outboundMsgPerSec: 20,
        errorsLastMin: 0,
        doActiveSec: 60,
      }),
    ).toBe(true);
  });

  it("rejects malformed RoomMetrics shapes", () => {
    const invalid: unknown[] = [
      null,
      {},
      {
        e2eLatencyMs: "fast",
        sessions: [],
        inboundMsgPerSec: 0,
        outboundMsgPerSec: 0,
        errorsLastMin: 0,
        doActiveSec: 0,
      },
      {
        e2eLatencyMs: null,
        sessions: [{ pair: "ar-en", status: "live" }], // missing reconnects
        inboundMsgPerSec: 0,
        outboundMsgPerSec: 0,
        errorsLastMin: 0,
        doActiveSec: 0,
      },
      {
        e2eLatencyMs: null,
        sessions: [],
        inboundMsgPerSec: 0,
        outboundMsgPerSec: 0,
        errorsLastMin: 0,
      }, // missing doActiveSec
    ];
    for (const value of invalid) expect(isRoomMetrics(value)).toBe(false);
  });
});

describe("server message guards (PROTOCOL.md section 3, mic model)", () => {
  const rosterEntry = {
    participantId: "p1",
    participantIndex: 0,
    name: "Layla",
    role: "teacher",
    lang: "ar-EG",
    micOpen: false,
    forcedMuted: false,
  };

  const validServer = [
    {
      t: "welcome",
      participantId: "p1",
      participantIndex: 0,
      roster: [rosterEntry],
    },
    { t: "mic-changed", participantId: "p2", micOpen: true },
    { t: "mic-changed", participantId: "p2", micOpen: false },
    { t: "session-status", pair: "0:ar-en", status: "live" },
    { t: "session-status", pair: "2:en-ar", status: "reconnecting", attempt: 2 },
    { t: "caption", kind: "input", text: "hello", final: true, speaker: 0 },
    { t: "caption", kind: "output", text: "مرحبا", final: false, speaker: 2 },
    {
      t: "metrics",
      m: {
        e2eLatencyMs: null,
        sessions: [],
        inboundMsgPerSec: 1,
        outboundMsgPerSec: 2,
        errorsLastMin: 0,
        doActiveSec: 3,
      },
    },
    { t: "error", code: "mic-forced-muted", message: "Teacher muted you" },
    { t: "pong", id: 11 },
  ];

  it.each(validServer.map((m) => [JSON.stringify(m), m] as const))(
    "accepts valid %s",
    (_label, msg) => {
      expect(isServerMsg(msg)).toBe(true);
    },
  );

  it("rejects wrong shapes for every server variant", () => {
    const invalid: unknown[] = [
      null,
      undefined,
      42,
      [],
      {},
      { t: "bogus" },
      // removed floor-era tags must not come back
      { t: "floor-changed", floor: { kind: "none" }, reason: "x" },
      { t: "hands", raised: [] },
      // welcome
      { t: "welcome", participantId: "p1" },
      { t: "welcome", participantId: "p1", participantIndex: 0, roster: [{ participantId: "p1" }] },
      {
        t: "welcome",
        participantId: "p1",
        participantIndex: 0,
        floor: { kind: "none" }, // floor is gone from the wire
        roster: [],
      },
      // mic-changed
      { t: "mic-changed", participantId: "p2" }, // missing micOpen
      { t: "mic-changed", micOpen: true }, // missing participantId
      { t: "mic-changed", participantId: "p2", micOpen: "yes" },
      // session-status
      { t: "session-status", pair: "ar-en", status: "bogus" },
      { t: "session-status", status: "live" }, // missing pair
      { t: "session-status", pair: "ar-en", status: "live", attempt: "two" },
      // caption
      { t: "caption", kind: "input", text: "x" }, // missing final + speaker
      { t: "caption", kind: "sideways", text: "x", final: true, speaker: 0 },
      { t: "caption", kind: "input", text: "x", final: true }, // missing speaker
      { t: "caption", kind: "input", text: "x", final: true, speaker: "0" },
      { t: "caption", kind: "input", text: "x", final: true, speaker: 0, extra: 1 },
      // metrics
      { t: "metrics", m: {} },
      { t: "metrics" },
      // error
      { t: "error", code: "room-full" }, // missing message
      { t: "error", message: "x" }, // missing code
      // pong
      { t: "pong" },
      { t: "pong", id: "11" },
      { t: 7 },
    ];
    for (const value of invalid) expect(isServerMsg(value)).toBe(false);
  });

  it("does not accept client messages as server messages", () => {
    expect(isServerMsg({ t: "ping", id: 1 })).toBe(false);
    expect(isServerMsg({ t: "mute", participantId: "a" })).toBe(false);
    expect(isServerMsg({ t: "mute-all" })).toBe(false);
  });
});
