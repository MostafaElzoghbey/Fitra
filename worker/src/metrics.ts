// T-020: MetricsCollector — pure, timer-free accounting for the DO metrics
// broadcast (PROTOCOL section 3.3, SPEC FR-040..043).
//
// Design rules:
// - NO timers, NO I/O, NO persistence: the DO calls record*() at its single
//   accounting boundaries and snapshot()/shouldEmit() only when a real event
//   (control message, routed audio frame, session-status change) piggybacks a
//   broadcast. An idle room therefore emits nothing and stays hibernatable
//   (FR-043) — nothing here can wake a DO.
// - Rings are plain timestamp arrays pruned on every touch; at the bounded
//   rates this protocol allows (20 audio + 10 control frames/s per socket)
//   the arrays stay tiny, so a ring buffer's fixed allocation would buy
//   nothing.
// - Rates are RAW COUNTS inside the sliding window (integers by
//   construction). We deliberately do NOT divide by elapsed seconds: with a
//   1 s window the count IS the per-second rate, and dividing by a
//   fractional elapsed time would fabricate non-integer "rates" that no
//   counter actually supports (PROTOCOL section 3.3: counts are real, not
//   the 20:1 billing ratio).
import type { RoomMetrics, RoomMetricsSession } from "@fitra/shared";

/** Sliding window for inbound/outbound rate counts (PROTOCOL section 3.3). */
export const RATE_WINDOW_MS = 1000;
/** Sliding window for `errorsLastMin` (PROTOCOL section 3.3). */
export const ERROR_WINDOW_MS = 60_000;
/** Minimum gap between two non-forced metrics broadcasts (FR-042). */
export const EMIT_THROTTLE_MS = 2_000;

/** Keep only timestamps strictly younger than `window` relative to `now`. */
function fresh(stamps: number[], now: number, window: number): number[] {
  const kept = stamps.filter((t) => now - t < window);
  return kept.length === stamps.length ? stamps : kept;
}

function countIn(stamps: number[], now: number, window: number): number {
  let n = 0;
  for (const t of stamps) {
    if (now - t < window) n += 1;
  }
  return n;
}

export class MetricsCollector {
  private inboundStamps: number[] = [];
  private outboundStamps: number[] = [];
  private errorStamps: number[] = [];
  /** Wall-clock time of the last accepted emission; null = never emitted. */
  private lastEmitMs: number | null = null;

  /** One browser→DO frame received (binary or control), at the single
   * inbound boundary in room.ts — before validation/rate limiting. */
  recordInbound(now: number): void {
    this.inboundStamps = fresh(this.inboundStamps, now, RATE_WINDOW_MS);
    this.inboundStamps.push(now);
  }

  /** One DO→browser frame sent, at the single outbound boundary (trySend). */
  recordOutbound(now: number): void {
    this.outboundStamps = fresh(this.outboundStamps, now, RATE_WINDOW_MS);
    this.outboundStamps.push(now);
  }

  /** One `error` frame sent, at the single error boundary (sendError).
   * Pre-membership rejects (upgradeThenReject) never reach this. */
  recordError(now: number): void {
    this.errorStamps = fresh(this.errorStamps, now, ERROR_WINDOW_MS);
    this.errorStamps.push(now);
  }

  /**
   * Whether a metrics frame may go out now. Non-forced emissions respect the
   * 2 s throttle; `forced` (session-status pulse) bypasses it and re-arms the
   * window. Accepting an emission records its time, so callers must only
   * build+send when this returns true.
   */
  shouldEmit(now: number, forced: boolean): boolean {
    if (
      !forced &&
      this.lastEmitMs !== null &&
      now - this.lastEmitMs < EMIT_THROTTLE_MS
    ) {
      return false;
    }
    this.lastEmitMs = now;
    return true;
  }

  /**
   * Build the wire payload. `sessions` comes from the SessionManager snapshot
   * (live pairs only); `e2eLatencyMs` is always null from the DO — the
   * browser's local estimate is authoritative and the server never fabricates
   * one (PROTOCOL section 3.3).
   */
  snapshot(
    now: number,
    roomCreatedAtMs: number,
    sessions: readonly RoomMetricsSession[],
  ): RoomMetrics {
    return {
      e2eLatencyMs: null,
      sessions: [...sessions],
      inboundMsgPerSec: countIn(this.inboundStamps, now, RATE_WINDOW_MS),
      outboundMsgPerSec: countIn(this.outboundStamps, now, RATE_WINDOW_MS),
      errorsLastMin: countIn(this.errorStamps, now, ERROR_WINDOW_MS),
      doActiveSec: Math.max(0, Math.floor((now - roomCreatedAtMs) / 1000)),
    };
  }

  /** Teardown/room-expiry path: drop all counters and throttle state. */
  reset(): void {
    this.inboundStamps = [];
    this.outboundStamps = [];
    this.errorStamps = [];
    this.lastEmitMs = null;
  }
}
