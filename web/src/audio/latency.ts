/**
 * T-012 — local end-to-end latency estimate (speaker chunk sent → first
 * translated chunk back), the number the metrics panel shows while the server
 * has not produced a `RoomMetrics.e2eLatencyMs` of its own yet.
 *
 * Definition (docs/PROTOCOL.md §3 `RoomMetrics.e2eLatencyMs`): a burst of
 * speech goes out, and the *first* translated chunk that comes back closes the
 * round trip. Every later chunk of the same burst is stream-ahead, not latency,
 * so only the oldest unmatched send is paired with an incoming chunk. Samples
 * are kept in a small rolling window and reported as its **median** — a single
 * reconnect spike must not move the headline number.
 *
 * Two ways to feed it:
 *
 * 1. Explicitly, from the audio path: {@link LatencyEstimator.recordChunkSent}
 *    when a frame goes up the socket and
 *    {@link LatencyEstimator.recordChunkReceived} when translated audio arrives.
 * 2. By polling counters, which is what the panel does: {@link LatencyEstimator.poll}
 *    diffs `AudioFrameSender.stats.framesSent` (T-010) against
 *    `PlaybackScheduler.stats.framesPlayed` (T-011). Both are already exposed for
 *    metrics, so no audio-graph change is needed to measure anything.
 *
 * Memory only, like every other per-chunk structure in this app (AGENTS.md
 * rule 2): the window holds a handful of numbers, and nothing here touches D1,
 * DO storage or any persistence API. A reload simply starts a new estimate.
 *
 * Clocks: all timestamps are {@link latencyNow} values (milliseconds,
 * monotonic). Tests pass explicit numbers, which is why the public methods take
 * `t0`/`now` instead of reading the clock themselves.
 */

import { useEffect, useState } from "react";

import type { CaptureStats } from "./capture.js";
import type { PlaybackStats } from "./playback.js";

/** Rolling window length — the last N round trips feed the median. */
export const LATENCY_WINDOW_SAMPLES = 8;

/**
 * Upper bound for one round trip. Anything above this is a tab that was
 * backgrounded or a clock that jumped, not speech latency, so it is dropped.
 */
export const LATENCY_MAX_SAMPLE_MS = 30_000;

/**
 * How often the panel samples the audio counters. Polled send times are only as
 * precise as this interval, so the polled estimate carries up to one interval of
 * quantisation; feeding {@link LatencyEstimator.recordChunkSent} per chunk is
 * the exact path.
 */
export const LATENCY_POLL_MS = 250;

/**
 * Monotonic milliseconds. `performance.now()` where available (it never jumps
 * with the wall clock, which would poison a difference), `Date.now()` otherwise
 * so the module stays importable in a plain Node test runner.
 */
export function latencyNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export interface LatencyEstimate {
  /** Median of the rolling window, in milliseconds. */
  readonly ms: number;
  /** Samples currently inside the window (the panel shows this next to `ms`). */
  readonly samples: number;
}

/** One outstanding uplink frame: its sequence key and the clock at send time. */
interface PendingChunk {
  readonly seq: number;
  readonly t0: number;
}

/**
 * Rolling first-chunk-back estimator. Small enough to read in one sitting, and
 * deliberately instance-based so a test can own its own clock; the panel uses
 * the singleton exported by {@link latencyEstimator}.
 */
export class LatencyEstimator {
  private readonly window: number[] = [];
  private pending: PendingChunk[] = [];
  private framesSent = 0;
  private framesPlayed = 0;
  private primed = false;

  /**
   * An uplink chunk left this browser at `t0`. `seq` keys the outstanding
   * chunk; when the audio path only has a counter, that counter is monotonic
   * and used as the key (see {@link poll}).
   */
  recordChunkSent(seq: number, t0: number): void {
    this.pending.push({ seq, t0 });
  }

  /**
   * A translated chunk came back at `now`: close the round trip opened by the
   * oldest outstanding chunk and return that round trip in milliseconds, or
   * `null` when nothing was outstanding (translated audio for someone else's
   * speech, a late chunk after the floor moved, or audio arriving first).
   */
  recordChunkReceived(now: number = latencyNow()): number | null {
    if (this.pending.length === 0) {
      return null;
    }
    let oldestIndex = 0;
    for (let i = 1; i < this.pending.length; i += 1) {
      const candidate = this.pending[i];
      const oldest = this.pending[oldestIndex];
      if (candidate !== undefined && oldest !== undefined && candidate.t0 < oldest.t0) {
        oldestIndex = i;
      }
    }
    const oldest = this.pending[oldestIndex];
    if (oldest === undefined) {
      return null;
    }
    // Everything still outstanding went up before this chunk came back, so it
    // all belongs to the burst that just closed and must not pair again.
    this.pending = [];
    const sample = now - oldest.t0;
    if (sample < 0 || sample > LATENCY_MAX_SAMPLE_MS) {
      return null;
    }
    this.window.push(sample);
    if (this.window.length > LATENCY_WINDOW_SAMPLES) {
      this.window.shift();
    }
    return sample;
  }

  /**
   * Advance from the live counters instead of per-chunk callbacks: any increase
   * in `framesSent` means chunks went up, any increase in `framesPlayed` means
   * translated chunks came back. Returns the sample that closed a round trip,
   * or `null` when this poll produced none.
   */
  poll(
    capture: CaptureStats | null,
    playback: PlaybackStats | null,
    now: number = latencyNow(),
  ): number | null {
    const sent = capture?.framesSent ?? 0;
    const played = playback?.framesPlayed ?? 0;
    if (!this.primed) {
      // First poll of a session: adopt the counters instead of back-dating a
      // round trip to frames that were already in flight.
      this.primed = true;
      this.framesSent = sent;
      this.framesPlayed = played;
      return null;
    }
    if (sent < this.framesSent) {
      // New sender (reconnect / page re-entry): the old burst is unmatchable.
      this.pending = [];
    }
    let sample: number | null = null;
    // Receive first: a chunk that went up *this* interval cannot be the chunk
    // that came back in it, and pairing them would report a 0 ms round trip.
    if (played > this.framesPlayed) {
      sample = this.recordChunkReceived(now);
    }
    if (sent > this.framesSent) {
      // One entry per poll keeps the estimate honest when a poll interval
      // covers several frames; the counter stands in for the wire `seq`.
      this.recordChunkSent(sent, now);
    }
    this.framesSent = sent;
    this.framesPlayed = played;
    return sample;
  }

  /** Current rolling estimate, or `null` before the first round trip. */
  get estimate(): LatencyEstimate | null {
    if (this.window.length === 0) {
      return null;
    }
    const sorted = [...this.window].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const upper = sorted[middle];
    const lower = sorted[middle - 1];
    if (upper === undefined) {
      return null;
    }
    const median =
      sorted.length % 2 === 0 && lower !== undefined
        ? (lower + upper) / 2
        : upper;
    return { ms: median, samples: this.window.length };
  }

  /** Drop the window and every outstanding chunk (floor revoke / new session). */
  reset(): void {
    this.window.length = 0;
    this.pending = [];
    this.framesSent = 0;
    this.framesPlayed = 0;
    this.primed = false;
  }
}

/**
 * Where the panel reads the audio counters from. The owner of the
 * `MicCapture`/`AudioFrameSender` and `PlaybackScheduler` pair registers it once
 * with {@link setLatencyStatsReader}; without a reader the panel shows "waiting"
 * instead of a fabricated number.
 */
export interface LatencyStatsReader {
  captureStats(): CaptureStats | null;
  playbackStats(): PlaybackStats | null;
}

const estimator = new LatencyEstimator();
let statsReader: LatencyStatsReader | null = null;

/** Panel-wide estimator (one per tab: there is exactly one room per tab). */
export function latencyEstimator(): LatencyEstimator {
  return estimator;
}

/** Register the audio counters to poll, or `null` to detach them. */
export function setLatencyStatsReader(reader: LatencyStatsReader | null): void {
  statsReader = reader;
}

/** One poll of the registered reader. Returns the new sample, if any. */
export function pollLatency(now: number = latencyNow()): number | null {
  if (statsReader === null) {
    return null;
  }
  return estimator.poll(statsReader.captureStats(), statsReader.playbackStats(), now);
}

export interface LatencyReading {
  readonly ms: number | null;
  readonly samples: number;
}

const NO_READING: LatencyReading = { ms: null, samples: 0 };

/**
 * React seam for the panel: polls the registered reader on an interval and
 * re-renders with the rolling estimate. Pure presentation glue — the math lives
 * in {@link LatencyEstimator} so it stays unit-testable without a DOM.
 */
export function useLatencyMs(intervalMs: number = LATENCY_POLL_MS): LatencyReading {
  const [reading, setReading] = useState<LatencyReading>(NO_READING);

  useEffect(() => {
    // Polls even with no reader registered yet: registration happens outside
    // React, so the interval has to be running to notice it.
    const tick = (): void => {
      pollLatency();
      const estimate = estimator.estimate;
      setReading(
        estimate === null
          ? { ms: null, samples: 0 }
          : { ms: estimate.ms, samples: estimate.samples },
      );
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);

  return reading;
}
