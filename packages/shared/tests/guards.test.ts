import { describe, expect, it } from "vitest";
import {
  isClientMsg,
  isFloorHolder,
  isRoomMetrics,
  isRosterEntry,
  isServerMsg,
} from "../src/index.js";

describe("client message guards (PROTOCOL.md section 3)", () => {
  const validClient = [
    { t: "speaking-start" },
    { t: "speaking-stop" },
    { t: "raise-hand" },
    { t: "lower-hand" },
    { t: "grant", participantId: "abc" },
    { t: "deny", participantId: "abc" },
    { t: "revoke" },
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
      { t: "grant" }, // missing participantId
      { t: "grant", participantId: 42 }, // wrong type
      { t: "deny" },
      { t: "deny", participantId: null },
      { t: "ping" }, // missing id
      { t: "ping", id: "7" }, // wrong type
      { t: "speaking-start", extra: 1, participantId: "x" }, // unexpected keys
      { t: "revoke", participantId: "x" }, // revoke takes no participantId
      { t: "raise-hand", id: 1 }, // raise-hand takes no payload
      { t: 42 },
      { participantId: "abc" }, // missing t
    ];
    for (const value of invalid) {
      expect(isClientMsg(value)).toBe(false);
    }
  });

  it("does not accept server messages as client messages", () => {
    expect(isClientMsg({ t: "pong", id: 1 })).toBe(false);
    expect(isClientMsg({ t: "welcome", participantId: "a", participantIndex: 0 })).toBe(false);
  });
});

describe("floor / roster / metrics guards", () => {
  it("accepts every FloorHolder variant", () => {
    expect(isFloorHolder({ kind: "none" })).toBe(true);
    expect(isFloorHolder({ kind: "teacher" })).toBe(true);
    expect(isFloorHolder({ kind: "student", participantId: "p1" })).toBe(true);
  });

  it("rejects malformed FloorHolder shapes", () => {
    const invalid: unknown[] = [
      null,
      {},
      { kind: "student" }, // missing participantId
      { kind: "student", participantId: 3 },
      { kind: "nobody" },
      { kind: "none", participantId: "x" }, // none takes no payload
      { kind: "teacher", participantId: "x" }, // teacher takes no payload
    ];
    for (const value of invalid) expect(isFloorHolder(value)).toBe(false);
  });

  it("accepts valid RosterEntry values", () => {
    expect(
      isRosterEntry({ participantId: "p1", name: "Layla", role: "teacher", lang: "ar-EG" }),
    ).toBe(true);
    expect(
      isRosterEntry({ participantId: "p2", name: "Omar", role: "student", lang: "en-US" }),
    ).toBe(true);
  });

  it("rejects malformed RosterEntry shapes", () => {
    const invalid: unknown[] = [
      null,
      {},
      { participantId: "p1", name: "x", role: "teacher" }, // missing lang
      { participantId: "p1", name: "x", role: "admin", lang: "ar" }, // bad role
      { participantId: 1, name: "x", role: "student", lang: "ar" },
    ];
    for (const value of invalid) expect(isRosterEntry(value)).toBe(false);
  });

  it("accepts valid RoomMetrics values incl. null latency", () => {
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
        sessions: [{ pair: "ar-en", status: "live", reconnects: 0 }],
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

describe("server message guards (PROTOCOL.md section 3)", () => {
  const validServer = [
    {
      t: "welcome",
      participantId: "p1",
      participantIndex: 0,
      floor: { kind: "none" },
      roster: [{ participantId: "p1", name: "Layla", role: "teacher", lang: "ar-EG" }],
    },
    { t: "floor-changed", floor: { kind: "teacher" }, reason: "teacher-start" },
    { t: "hands", raised: ["p1", "p2"] },
    { t: "session-status", pair: "ar-en", status: "live" },
    { t: "session-status", pair: "ar-en", status: "reconnecting", attempt: 2 },
    { t: "caption", kind: "input", text: "hello", final: true },
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
    { t: "error", code: "room-full", message: "Room is full" },
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
      // welcome
      { t: "welcome", participantId: "p1" },
      {
        t: "welcome",
        participantId: "p1",
        participantIndex: 0,
        floor: { kind: "bogus" },
        roster: [],
      },
      {
        t: "welcome",
        participantId: "p1",
        participantIndex: 0,
        floor: { kind: "none" },
        roster: [{ participantId: "p1" }],
      },
      // floor-changed
      { t: "floor-changed", floor: { kind: "none" } }, // missing reason
      { t: "floor-changed", reason: "x" }, // missing floor
      // hands
      { t: "hands" },
      { t: "hands", raised: [1, 2] },
      // session-status
      { t: "session-status", pair: "ar-en", status: "bogus" },
      { t: "session-status", status: "live" }, // missing pair
      { t: "session-status", pair: "ar-en", status: "live", attempt: "two" },
      // caption
      { t: "caption", kind: "input", text: "x" }, // missing final
      { t: "caption", kind: "sideways", text: "x", final: true },
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
    expect(isServerMsg({ t: "grant", participantId: "a" })).toBe(false);
  });
});
