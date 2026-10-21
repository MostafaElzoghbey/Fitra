// Unit tests for the T-012 latency estimator (`src/audio/latency.ts`).
//
// Pure logic only, like the rest of this suite: explicit timestamps instead of
// `performance.now()`, no DOM, no audio graph. The panel rendering and the live
// numbers moving are T-016's E2E job (docs/TEST-PLAN.md §3).

import { describe, expect, it } from "vitest";

import type { CaptureStats } from "../src/audio/capture.js";
import type { PlaybackStats } from "../src/audio/playback.js";
import {
  LATENCY_MAX_SAMPLE_MS,
  LATENCY_WINDOW_SAMPLES,
  LatencyEstimator,
  latencyNow,
} from "../src/audio/latency.js";

function captureStats(framesSent: number): CaptureStats {
  return { framesSent, framesDropped: 0, bufferedBytes: 0, speakerIndex: 0 };
}

function playbackStats(framesPlayed: number): PlaybackStats {
  return { framesPlayed, gaps: 0, overruns: 0, underruns: 0, bufferedMs: 0 };
}

describe("LatencyEstimator.recordChunkSent/recordChunkReceived", () => {
  it("measures the oldest outstanding chunk, not the newest one", () => {
    const latency = new LatencyEstimator();
    latency.recordChunkSent(1, 1_000);
    latency.recordChunkSent(2, 1_040);
    latency.recordChunkSent(3, 1_080);

    expect(latency.recordChunkReceived(1_300)).toBe(300);
    expect(latency.estimate).toEqual({ ms: 300, samples: 1 });
  });

  it("closes a whole burst once so later chunks cannot re-pair it", () => {
    const latency = new LatencyEstimator();
    latency.recordChunkSent(1, 0);
    latency.recordChunkSent(2, 100);
    latency.recordChunkSent(3, 200);

    expect(latency.recordChunkReceived(250)).toBe(250);
    expect(latency.recordChunkReceived(300)).toBeNull();
    expect(latency.estimate?.samples).toBe(1);
  });

  it("returns null when translated audio arrives with nothing outstanding", () => {
    const latency = new LatencyEstimator();
    expect(latency.recordChunkReceived(500)).toBeNull();
    expect(latency.estimate).toBeNull();
  });

  it("ignores a burst that cannot be a live round trip", () => {
    const latency = new LatencyEstimator();
    latency.recordChunkSent(1, 0);
    expect(latency.recordChunkReceived(LATENCY_MAX_SAMPLE_MS + 1)).toBeNull();
    expect(latency.estimate).toBeNull();
  });

  it("keeps only the rolling window, median included", () => {
    const latency = new LatencyEstimator();
    // The 900 ms outlier leaves an 8-slot window before the estimate is read,
    // so the headline must be the middle of [100…130] and not the spike.
    const samples = [900, 120, 100, 110, 130, 105, 115, 125, 108, 112];
    let clock = 0;
    for (const sample of samples) {
      latency.recordChunkSent(clock, clock);
      latency.recordChunkReceived(clock + sample);
      clock += 10_000;
    }

    expect(latency.estimate).toEqual({ ms: 111, samples: LATENCY_WINDOW_SAMPLES });
  });
});

describe("LatencyEstimator.poll", () => {
  it("pairs a framesSent bump with the next framesPlayed bump", () => {
    const latency = new LatencyEstimator();
    expect(latency.poll(captureStats(4), playbackStats(0), 1_000)).toBeNull();

    expect(latency.poll(captureStats(5), playbackStats(0), 1_200)).toBeNull();
    expect(latency.poll(captureStats(5), playbackStats(1), 1_450)).toBe(250);
    expect(latency.estimate).toEqual({ ms: 250, samples: 1 });
  });

  it("never pairs a chunk with itself inside one poll", () => {
    const latency = new LatencyEstimator();
    latency.poll(captureStats(0), playbackStats(0), 0);

    expect(latency.poll(captureStats(1), playbackStats(1), 100)).toBeNull();
    expect(latency.poll(captureStats(1), playbackStats(2), 400)).toBe(300);
  });

  it("keeps polling cleanly when one side is absent", () => {
    const latency = new LatencyEstimator();
    latency.poll(null, null, 0);
    latency.poll(captureStats(1), null, 100);
    expect(latency.recordChunkReceived(300)).toBe(200);
  });

  it("drops unmatchable bursts when a reconnect resets the sender", () => {
    const latency = new LatencyEstimator();
    latency.poll(captureStats(9), playbackStats(0), 0);
    latency.poll(captureStats(10), playbackStats(0), 50);
    // A new sender starts its counter over; the old burst can never come back.
    latency.poll(captureStats(2), playbackStats(0), 60);
    latency.poll(captureStats(3), playbackStats(0), 70);

    expect(latency.recordChunkReceived(500)).toBe(430);
  });

  it("forgets everything on reset", () => {
    const latency = new LatencyEstimator();
    latency.poll(captureStats(1), playbackStats(0), 0);
    latency.poll(captureStats(2), playbackStats(0), 100);
    latency.poll(captureStats(2), playbackStats(1), 400);
    expect(latency.estimate?.samples).toBe(1);

    latency.reset();
    expect(latency.estimate).toBeNull();
    expect(latency.poll(captureStats(3), playbackStats(1), 500)).toBeNull();
  });
});

describe("latencyNow", () => {
  it("returns a finite, non-negative millisecond reading", () => {
    expect(Number.isFinite(latencyNow())).toBe(true);
    expect(latencyNow()).toBeGreaterThanOrEqual(0);
  });
});
