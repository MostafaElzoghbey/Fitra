import { describe, expect, it, vi } from "vitest";

import { FITRA_AUDIO_TYPE_DOWNLINK, FITRA_AUDIO_VERSION } from "@fitra/shared";
import type { DecodedAudioFrame } from "@fitra/shared";

import {
  PlaybackScheduler,
  SpeakerMixer,
  createMixer,
  isNewerEpoch,
} from "../src/audio/playback.js";

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

function frame(seq: number, speaker: number, epoch = 0): DecodedAudioFrame {
  return {
    version: FITRA_AUDIO_VERSION,
    type: FITRA_AUDIO_TYPE_DOWNLINK,
    seq,
    speaker,
    epoch,
    payload: new Uint8Array(4800),
  };
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
});

describe("PlaybackScheduler pre-roll", () => {
  it("plays a short tail instead of stalling when pre-roll is never met", () => {
    vi.useFakeTimers();
    try {
      const ctx = new FakeAudioContext();
      const scheduler = new PlaybackScheduler(ctx as unknown as AudioContext);
      scheduler.pushPacket(packet(0));
      expect(scheduler.stats.framesPlayed).toBe(0);

      vi.advanceTimersByTime(100);
      expect(scheduler.stats.framesPlayed).toBe(1);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("capture epochs (PROTOCOL §2)", () => {
  it("treats a wrapped epoch as newer and a stale one as older", () => {
    expect(isNewerEpoch(0, 1)).toBe(true);
    expect(isNewerEpoch(65535, 0)).toBe(true);
    expect(isNewerEpoch(0, 65535)).toBe(false);
    expect(isNewerEpoch(7, 7)).toBe(false);
  });

  it("drops the old epoch and ignores late frames from it", () => {
    const ctx = new FakeAudioContext();
    const mixer = new SpeakerMixer(ctx as unknown as AudioContext);
    for (let seq = 0; seq < 4; seq += 1) mixer.demux(frame(seq, 0, 0));
    expect(mixer.stats.framesPlayed).toBe(4);

    for (let seq = 0; seq < 4; seq += 1) mixer.demux(frame(seq, 0, 1));
    expect(mixer.stats.framesPlayed).toBe(4);

    mixer.demux(frame(4, 0, 0));
    expect(mixer.stats.framesPlayed).toBe(4);

    mixer.demux(frame(4, 0, 1));
    expect(mixer.stats.framesPlayed).toBe(5);
    mixer.dispose();
  });
});

describe("SpeakerMixer per-speaker pipes (PROTOCOL §2)", () => {
  it("demuxes frames by speaker into independent pipes with their own seq cursors", () => {
    const ctx = new FakeAudioContext();
    const mixer = new SpeakerMixer(ctx as unknown as AudioContext);
    for (let seq = 0; seq < 6; seq += 1) {
      mixer.demux(frame(seq, 0));
      mixer.demux(frame(seq, 1));
    }

    const stats = mixer.stats;
    expect(stats.framesPlayed).toBe(12);
    expect(stats.gaps).toBe(0);
    mixer.dispose();
  });

  it("a sequence gap PLC-fills only the gapped pipe; a late packet never touches the other pipe", () => {
    const ctx = new FakeAudioContext();
    const mixer = new SpeakerMixer(ctx as unknown as AudioContext);
    for (let seq = 0; seq < 5; seq += 1) {
      mixer.demux(frame(seq, 0));
      mixer.demux(frame(seq, 1));
    }
    mixer.demux(frame(7, 0));
    expect(mixer.stats.framesPlayed).toBe(13);
    expect(mixer.stats.gaps).toBe(2);

    mixer.demux(frame(5, 0));
    expect(mixer.stats.framesPlayed).toBe(13);
    expect(mixer.stats.gaps).toBe(2);

    mixer.demux(frame(5, 1));
    expect(mixer.stats.framesPlayed).toBe(14);
    expect(mixer.stats.gaps).toBe(2);
    mixer.dispose();
  });

  it("prune disposes schedulers whose speaker left the roster", () => {
    const ctx = new FakeAudioContext();
    const mixer = new SpeakerMixer(ctx as unknown as AudioContext);
    for (let seq = 0; seq < 6; seq += 1) {
      mixer.demux(frame(seq, 0));
      mixer.demux(frame(seq, 1));
    }
    expect(mixer.stats.framesPlayed).toBe(12);

    mixer.prune(new Set([1]));
    expect(mixer.stats.framesPlayed).toBe(6);

    mixer.demux(frame(6, 0));
    mixer.demux(frame(6, 1));
    expect(mixer.stats.framesPlayed).toBe(7);

    mixer.dispose();
    expect(mixer.stats.framesPlayed).toBe(0);
  });

  it("createMixer falls back to a counting NullMixer without an AudioContext", () => {
    const mixer = createMixer();
    mixer.demux(frame(0, 0));
    mixer.demux(frame(1, 3));
    expect(mixer.stats.framesPlayed).toBe(2);
    expect(mixer.stats.gaps).toBe(0);
    mixer.prune(new Set());
    mixer.dispose();
  });
});
