import { describe, expect, it } from "vitest";

import { PlaybackScheduler } from "../src/audio/playback.js";

class FakeParam {
  value = 1;
  cancelScheduledValues(): void {
    return undefined;
  }
  setValueAtTime(value: number): void {
    this.value = value;
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
}

class FakeGain {
  readonly gain = new FakeParam();
  connect(): void {
    return undefined;
  }
  disconnect(): void {
    return undefined;
  }
}

class FakeBuffer {
  constructor(readonly length: number) {}
  getChannelData(): Float32Array {
    return new Float32Array(this.length);
  }
}

class FakeSource {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  connect(): void {
    return undefined;
  }
  start(): void {
    return undefined;
  }
  stop(): void {
    return undefined;
  }
  disconnect(): void {
    return undefined;
  }
}

class FakeAudioContext {
  currentTime = 0;
  readonly destination = {};
  createGain(): FakeGain {
    return new FakeGain();
  }
  createBuffer(_channels: number, length: number): FakeBuffer {
    return new FakeBuffer(length);
  }
  createBufferSource(): FakeSource {
    return new FakeSource();
  }
}

function packet(seq: number): { seq: number; pcm24k: Uint8Array } {
  return { seq, pcm24k: new Uint8Array(4800) };
}

describe("PlaybackScheduler burst handling", () => {
  it("schedules a 3 s burst without dropping its tail", () => {
    const ctx = new FakeAudioContext();
    const scheduler = new PlaybackScheduler(ctx as unknown as AudioContext);
    for (let seq = 0; seq < 30; seq += 1) {
      scheduler.pushPacket(packet(seq));
    }

    expect(scheduler.stats.framesPlayed).toBe(30);
    expect(scheduler.stats.overruns).toBe(0);
    scheduler.dispose();
  });

  it("still resets its sequence cursor after an interrupt", () => {
    const ctx = new FakeAudioContext();
    const scheduler = new PlaybackScheduler(ctx as unknown as AudioContext);
    for (let seq = 0; seq < 8; seq += 1) {
      scheduler.pushPacket(packet(seq));
    }
    scheduler.interrupt();
    for (let seq = 40; seq < 44; seq += 1) {
      scheduler.pushPacket(packet(seq));
    }

    expect(scheduler.stats.framesPlayed).toBe(12);
    scheduler.dispose();
  });
});
