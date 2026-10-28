// T-020: MetricsCollector unit tests (pure logic, no timers, no I/O).
//
// PROTOCOL section 3.3 / SPEC FR-040..043: sliding 1 s rate windows for
// inbound/outbound frame counts, a 60 s error window, `doActiveSec` since room
// creation, `e2eLatencyMs` always null from the DO, a 2 s emission throttle
// with a forced (status-change) bypass, and a reset for teardown paths.
import { describe, expect, it } from "vitest";
import {
  EMIT_THROTTLE_MS,
  ERROR_WINDOW_MS,
  MetricsCollector,
  RATE_WINDOW_MS,
} from "../src/metrics.js";
import type { RoomMetricsSession } from "@fitra/shared";

const CREATED_AT = 1_000_000;

function sessionsOf(
  pair: string,
  status: string,
  reconnects: number,
): RoomMetricsSession[] {
  return [{ pair, status, reconnects }];
}

describe("MetricsCollector: sliding 1 s rate windows", () => {
  it("counts only inbound timestamps inside the last 1000 ms", () => {
    const c = new MetricsCollector();
    c.recordInbound(0);
    c.recordInbound(500);
    c.recordInbound(900);
    c.recordInbound(1100); // 0 is now 1100 ms old -> outside the window
    const snap = c.snapshot(1100, CREATED_AT, []);
    expect(snap.inboundMsgPerSec).toBe(3);
  });

  it("counts only outbound timestamps inside the last 1000 ms", () => {
    const c = new MetricsCollector();
    c.recordOutbound(0);
    c.recordOutbound(999);
    c.recordOutbound(1000); // 0 is exactly 1000 ms old -> expired (now - t < window)
    const snap = c.snapshot(1000, CREATED_AT, []);
    expect(snap.outboundMsgPerSec).toBe(2);
  });

  it("returns 0 rates when nothing was recorded", () => {
    const c = new MetricsCollector();
    const snap = c.snapshot(5000, CREATED_AT, []);
    expect(snap.inboundMsgPerSec).toBe(0);
    expect(snap.outboundMsgPerSec).toBe(0);
    expect(snap.errorsLastMin).toBe(0);
  });

  it("keeps inbound and outbound rings independent", () => {
    const c = new MetricsCollector();
    c.recordInbound(100);
    c.recordOutbound(200);
    const snap = c.snapshot(300, CREATED_AT, []);
    expect(snap.inboundMsgPerSec).toBe(1);
    expect(snap.outboundMsgPerSec).toBe(1);
  });

  it("documents the window constants used by the rates", () => {
    expect(RATE_WINDOW_MS).toBe(1000);
  });
});

describe("MetricsCollector: 60 s error window", () => {
  it("counts errors sent in the previous 60 s", () => {
    const c = new MetricsCollector();
    c.recordError(0);
    c.recordError(1000);
    c.recordError(2000);
    const snap = c.snapshot(2000, CREATED_AT, []);
    expect(snap.errorsLastMin).toBe(3);
  });

  it("expires errors older than 60 s", () => {
    const c = new MetricsCollector();
    c.recordError(0);
    c.recordError(5000);
    // At 61_000 the t=0 error is 61 s old (expired); t=5000 is 56 s old (kept).
    const snap = c.snapshot(61_000, CREATED_AT, []);
    expect(snap.errorsLastMin).toBe(1);
    expect(ERROR_WINDOW_MS).toBe(60_000);
  });
});

describe("MetricsCollector: snapshot fields", () => {
  it("always reports e2eLatencyMs as null (never fabricated)", () => {
    const c = new MetricsCollector();
    c.recordInbound(0);
    const snap = c.snapshot(1000, CREATED_AT, sessionsOf("ar->en", "live", 0));
    expect(snap.e2eLatencyMs).toBeNull();
  });

  it("computes doActiveSec as floor((now - createdAt)/1000), clamped at 0", () => {
    const c = new MetricsCollector();
    expect(c.snapshot(CREATED_AT + 7_500, CREATED_AT, []).doActiveSec).toBe(7);
    expect(c.snapshot(CREATED_AT, CREATED_AT, []).doActiveSec).toBe(0);
    // A skewed (future) creation timestamp must not go negative.
    expect(c.snapshot(CREATED_AT - 10_000, CREATED_AT, []).doActiveSec).toBe(0);
  });

  it("passes the sessions snapshot through untouched", () => {
    const c = new MetricsCollector();
    const sessions = sessionsOf("ar->en", "live", 2);
    const snap = c.snapshot(1000, CREATED_AT, sessions);
    expect(snap.sessions).toEqual([{ pair: "ar->en", status: "live", reconnects: 2 }]);
  });

  it("returns integer rates (raw counts, no division)", () => {
    const c = new MetricsCollector();
    for (let i = 0; i < 25; i += 1) c.recordInbound(i);
    for (let i = 0; i < 7; i += 1) c.recordOutbound(i);
    const snap = c.snapshot(30, CREATED_AT, []);
    expect(Number.isInteger(snap.inboundMsgPerSec)).toBe(true);
    expect(Number.isInteger(snap.outboundMsgPerSec)).toBe(true);
    expect(snap.inboundMsgPerSec).toBe(25);
    expect(snap.outboundMsgPerSec).toBe(7);
  });
});

describe("MetricsCollector: 2 s emission throttle", () => {
  it("emits immediately the first time", () => {
    const c = new MetricsCollector();
    expect(c.shouldEmit(0, false)).toBe(true);
  });

  it("suppresses a second emission within 2 s", () => {
    const c = new MetricsCollector();
    expect(c.shouldEmit(0, false)).toBe(true);
    expect(c.shouldEmit(1000, false)).toBe(false);
    expect(c.shouldEmit(1999, false)).toBe(false);
  });

  it("allows the next emission once 2 s have elapsed", () => {
    const c = new MetricsCollector();
    expect(c.shouldEmit(0, false)).toBe(true);
    expect(c.shouldEmit(EMIT_THROTTLE_MS, false)).toBe(true);
    expect(c.shouldEmit(EMIT_THROTTLE_MS + 1, false)).toBe(false);
  });

  it("forced bypasses the throttle (session-status pulse)", () => {
    const c = new MetricsCollector();
    expect(c.shouldEmit(0, false)).toBe(true);
    expect(c.shouldEmit(100, true)).toBe(true);
    // The forced emission re-arms the throttle window.
    expect(c.shouldEmit(200, false)).toBe(false);
    expect(c.shouldEmit(2100, false)).toBe(true);
  });

  it("documents the throttle constant", () => {
    expect(EMIT_THROTTLE_MS).toBe(2000);
  });
});

describe("MetricsCollector: reset", () => {
  it("clears all rings and the throttle state", () => {
    const c = new MetricsCollector();
    c.recordInbound(0);
    c.recordOutbound(0);
    c.recordError(0);
    expect(c.shouldEmit(0, false)).toBe(true);
    c.reset();
    const snap = c.snapshot(100, CREATED_AT, []);
    expect(snap.inboundMsgPerSec).toBe(0);
    expect(snap.outboundMsgPerSec).toBe(0);
    expect(snap.errorsLastMin).toBe(0);
    // Throttle state cleared: the next emission is immediate again.
    expect(c.shouldEmit(100, false)).toBe(true);
  });
});
