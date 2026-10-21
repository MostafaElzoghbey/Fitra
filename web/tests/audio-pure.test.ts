// Unit tests for the PURE helpers of the web audio path.
//
// Coordination: shared by T-011 (playback) and T-010 (capture). T-010 APPENDED
// its capture helpers below — do not rewrite either block wholesale.
//
// Only pure functions (plus the transport-agnostic `AudioFrameSender` and the
// synthetic-PCM injection seam) are exercised: no `AudioContext`,
// `getUserMedia` or `AudioWorkletNode` is ever constructed here, so the graph
// itself is proved by E2E (T-016), not by this file.

import { describe, expect, it } from "vitest";
import type { DecodedAudioFrame } from "@fitra/shared";
import {
  FITRA_AUDIO_HEADER_BYTES,
  FITRA_AUDIO_VERSION,
  decodeAudioFrame,
  encodeAudioFrame,
} from "@fitra/shared";
import {
  CAPTURE_BACKPRESSURE_BYTES,
  CAPTURE_FRAME_MS,
  CAPTURE_FRAME_SAMPLES,
  CAPTURE_PCM16_SCALE,
  CAPTURE_SAMPLE_RATE_HZ,
  AudioFrameSender,
  type FrameSocket,
  createAudioInjector,
  createDownsampleState,
  downsampleLinear,
  framePack,
  injectAudioRequested,
  writeSine,
} from "../src/audio/capture.js";
import {
  PLAYBACK_FRAME_MS_NOMINAL,
  PLAYBACK_MAX_BUFFERED_MS,
  PLAYBACK_MAX_PLC_FRAMES,
  PLAYBACK_PRE_ROLL_MS,
  PLAYBACK_SAMPLE_RATE_HZ,
  cappedPlcFrames,
  downlinkPacketFromFrame,
  gapFrameCount,
  isLateOrDuplicate,
  pcm16ToF32,
  seqForwardDistance,
} from "../src/audio/playback.js";

/** Build a PCM16LE mono payload from integer sample values (little-endian). */
function pcm16le(...samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (const [i, sample] of samples.entries()) {
    view.setInt16(i * 2, sample, true);
  }
  return out;
}

/** Byte length of one nominal downlink frame at the documented rate. */
function nominalFrameBytes(): number {
  return (PLAYBACK_FRAME_MS_NOMINAL / 1000) * PLAYBACK_SAMPLE_RATE_HZ * 2;
}

describe("pcm16ToF32 (PROTOCOL.md section 2 PCM16LE mono payload)", () => {
  it("maps 16-bit samples into [-1, 1) with 32768 scaling", () => {
    const out = pcm16ToF32(pcm16le(0, 16384, -16384, 32767, -32768));
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(-0.5, 6);
    // 32767 is the loudest non-clipping sample; -32768 is exactly -1.
    expect(out[3]).toBeCloseTo(32767 / 32768, 6);
    expect(out[3]).toBeLessThan(1);
    expect(out[4]).toBe(-1);
  });

  it("reads little-endian regardless of host byte order", () => {
    // 0x4000 LE on the wire -> bytes 0x00 0x40 -> 16384 -> 0.5.
    const out = pcm16ToF32(new Uint8Array([0x00, 0x40]));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(0.5);
    // Same bytes BE would decode to 64 -> proves LE, not symmetric luck.
    const swapped = pcm16ToF32(new Uint8Array([0x40, 0x00]));
    expect(swapped[0]).toBeCloseTo(64 / 32768, 6);
  });

  it("returns an empty array for an empty payload", () => {
    expect(pcm16ToF32(new Uint8Array(0))).toHaveLength(0);
  });

  it("drops a trailing odd byte (malformed frame tail)", () => {
    const out = pcm16ToF32(new Uint8Array([0x00, 0x40, 0xff]));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(0.5);
  });

  it("honours byteOffset of a subarray over a larger backing buffer", () => {
    // Regression guard: a WS frame handed over as a subarray must not read
    // bytes from before its own start.
    const backing = pcm16le(999, 16384, -16384);
    const view = backing.subarray(2);
    const out = pcm16ToF32(view);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(-0.5, 6);
  });
});

describe("seqForwardDistance (u16 sequence arithmetic)", () => {
  it("is 0 for the expected sequence number", () => {
    expect(seqForwardDistance(7, 7)).toBe(0);
    expect(seqForwardDistance(0, 0)).toBe(0);
  });

  it("counts forward steps", () => {
    expect(seqForwardDistance(7, 8)).toBe(1);
    expect(seqForwardDistance(0, 10)).toBe(10);
  });

  it("wraps 65535 -> 0 as a single forward step", () => {
    expect(seqForwardDistance(65535, 0)).toBe(1);
    expect(seqForwardDistance(65534, 1)).toBe(3);
  });

  it("reports backward packets as a near-full-modulus distance", () => {
    expect(seqForwardDistance(5, 3)).toBe(65534);
    expect(seqForwardDistance(0, 65535)).toBe(65535);
  });

  it("returns half the modulus for the ambiguous half-circle value", () => {
    expect(seqForwardDistance(0, 32768)).toBe(32768);
  });

  it("normalises out-of-range inputs modulo 2^16", () => {
    expect(seqForwardDistance(-1, 0)).toBe(1);
    expect(seqForwardDistance(65536, 1)).toBe(1);
    expect(seqForwardDistance(0, 65536)).toBe(0);
  });
});

describe("isLateOrDuplicate (late/reordered packets are dropped, never rescheduled)", () => {
  it("accepts the in-order packet", () => {
    expect(isLateOrDuplicate(10, 10)).toBe(false);
  });

  it("accepts a packet ahead of the cursor", () => {
    expect(isLateOrDuplicate(10, 11)).toBe(false);
    expect(isLateOrDuplicate(10, 4000)).toBe(false);
  });

  it("flags a packet behind the cursor", () => {
    expect(isLateOrDuplicate(10, 9)).toBe(true);
    expect(isLateOrDuplicate(10, 0)).toBe(true);
  });

  it("flags a re-delivery of an already-played frame", () => {
    // After playing seq 9 the cursor is 10; a duplicate 9 must be dropped.
    expect(isLateOrDuplicate(10, 9)).toBe(true);
  });

  it("keeps wrap-around traffic in order", () => {
    expect(isLateOrDuplicate(0, 1)).toBe(false);
    // Cursor wrapped to 0, so 65535 is genuinely behind -> drop.
    expect(isLateOrDuplicate(0, 65535)).toBe(true);
  });

  it("treats the exact half-modulus as ahead, not late", () => {
    // Ambiguous by construction; the split is `> 32768` = late.
    expect(isLateOrDuplicate(0, 32768)).toBe(false);
    expect(isLateOrDuplicate(0, 32769)).toBe(true);
  });
});

describe("gapFrameCount (missing frames before the received sequence)", () => {
  it("is 0 when the packet is in order", () => {
    expect(gapFrameCount(10, 10)).toBe(0);
  });

  it("is 0 for a late/reordered packet (no PLC for stale audio)", () => {
    expect(gapFrameCount(10, 9)).toBe(0);
    expect(gapFrameCount(0, 65535)).toBe(0);
  });

  it("counts exactly the missing frames", () => {
    expect(gapFrameCount(10, 13)).toBe(3);
    expect(gapFrameCount(0, 1)).toBe(1);
  });

  it("counts across the u16 wrap boundary", () => {
    expect(gapFrameCount(65535, 2)).toBe(3);
    expect(gapFrameCount(65533, 65535)).toBe(2);
  });
});

describe("cappedPlcFrames (PLC silence budget, max 10 frames = 1 s)", () => {
  it("returns 0 for nothing missing", () => {
    expect(cappedPlcFrames(0)).toBe(0);
  });

  it("returns 0 for negative, NaN and non-finite counts", () => {
    expect(cappedPlcFrames(-1)).toBe(0);
    expect(cappedPlcFrames(-100)).toBe(0);
    expect(cappedPlcFrames(Number.NaN)).toBe(0);
    expect(cappedPlcFrames(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("passes through gaps within budget", () => {
    expect(cappedPlcFrames(1)).toBe(1);
    expect(cappedPlcFrames(9)).toBe(9);
    expect(cappedPlcFrames(PLAYBACK_MAX_PLC_FRAMES)).toBe(PLAYBACK_MAX_PLC_FRAMES);
  });

  it("caps anything past the budget so a stall cannot balloon into silence", () => {
    expect(cappedPlcFrames(11)).toBe(10);
    expect(cappedPlcFrames(32768)).toBe(10);
    expect(cappedPlcFrames(65535)).toBe(PLAYBACK_MAX_PLC_FRAMES);
  });

  it("floors fractional counts", () => {
    expect(cappedPlcFrames(3.7)).toBe(3);
    expect(cappedPlcFrames(0.9)).toBe(0);
  });
});

describe("downlinkPacketFromFrame (WS binary type 0x02 -> scheduler packet)", () => {
  it("maps seq and payload straight through", () => {
    const frame: DecodedAudioFrame = {
      version: 0x01,
      type: 0x02,
      seq: 42,
      speaker: 3,
      payload: pcm16le(1, 2, 3),
    };
    const packet = downlinkPacketFromFrame(frame);
    expect(packet.seq).toBe(42);
    // Reference equality: no copy, the scheduler reads the buffer as given.
    expect(packet.pcm24k).toBe(frame.payload);
    expect(pcm16ToF32(packet.pcm24k)).toHaveLength(3);
  });

  it("survives the real codec round-trip (header stripped, payload ready)", () => {
    const payload = pcm16le(16384, -16384, 0);
    const decoded = decodeAudioFrame(
      encodeAudioFrame({ type: 0x02, seq: 0x0102, speaker: 0, payload }),
    );
    const packet = downlinkPacketFromFrame(decoded);
    expect(packet.seq).toBe(0x0102);
    expect(packet.pcm24k).toHaveLength(6);
    expect(Array.from(pcm16ToF32(packet.pcm24k))).toEqual([0.5, -0.5, 0]);
  });
});

describe("T-011 playback constants (docs/PROTOCOL.md section 2 + LIMITS.md section 2)", () => {
  it("tags buffers at the true 24 kHz downlink rate", () => {
    // createBuffer(1, len, 24000) is what stops the chipmunk bug: the browser
    // resamples to the hardware rate instead of playing 24k as 48k.
    expect(PLAYBACK_SAMPLE_RATE_HZ).toBe(24000);
  });

  it("matches the documented 100 ms / 4800 B nominal frame", () => {
    expect(PLAYBACK_FRAME_MS_NOMINAL).toBe(100);
    expect(nominalFrameBytes()).toBe(4800);
  });

  it("keeps a 400 ms pre-roll before the first schedule", () => {
    expect(PLAYBACK_PRE_ROLL_MS).toBe(400);
    // 400 ms of 24 kHz mono = 4 nominal frames buffered before starting.
    expect((PLAYBACK_PRE_ROLL_MS / 1000) * PLAYBACK_SAMPLE_RATE_HZ).toBe(9600);
  });

  it("keeps the buffered-audio cap above the pre-roll (headroom for jitter)", () => {
    expect(PLAYBACK_MAX_BUFFERED_MS).toBe(800);
    expect(PLAYBACK_MAX_BUFFERED_MS).toBeGreaterThan(PLAYBACK_PRE_ROLL_MS);
  });

  it("caps PLC at 10 frames = 1 s of silence", () => {
    expect(PLAYBACK_MAX_PLC_FRAMES).toBe(10);
    expect((PLAYBACK_MAX_PLC_FRAMES * PLAYBACK_FRAME_MS_NOMINAL)).toBe(1000);
  });
});

/* ========================================================================== */
/* T-010 — capture (web/src/audio/capture.ts)                                 */
/* ========================================================================== */

/** Minimal WebSocket stand-in: records what the sender would put on the wire. */
class FakeSocket implements FrameSocket {
  readonly sent: Uint8Array[] = [];
  readyState = 1;
  bufferedAmount = 0;

  send(data: ArrayBufferView): void {
    this.sent.push(data instanceof Uint8Array ? data.slice() : new Uint8Array(data.buffer));
  }
}

/** Decode a PCM16LE payload to integer sample values. */
function int16Of(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
    out.push(view.getInt16(i, true));
  }
  return out;
}

describe("T-010 capture constants (docs/PROTOCOL.md section 2 + LIMITS.md section 2)", () => {
  it("frames 100 ms at 16 kHz mono", () => {
    expect(CAPTURE_SAMPLE_RATE_HZ).toBe(16000);
    expect(CAPTURE_FRAME_MS).toBe(100);
    expect(CAPTURE_FRAME_SAMPLES).toBe(1600);
    // 3 200 B payload + 8 B header = 3 208 B, comfortably under the 8 KiB cap.
    expect(CAPTURE_FRAME_SAMPLES * 2 + FITRA_AUDIO_HEADER_BYTES).toBe(3208);
    expect(CAPTURE_FRAME_SAMPLES * 2 + FITRA_AUDIO_HEADER_BYTES).toBeLessThan(8192);
  });
});

describe("framePack (float -> PCM16LE, mirrors the worklet math)", () => {
  it("writes 2 bytes per sample, little-endian", () => {
    const packed = framePack(new Float32Array([0, 1]));
    expect(packed.length).toBe(4);
    expect(int16Of(packed)).toEqual([0, CAPTURE_PCM16_SCALE]);
    expect(packed[2]).toBe(0xff);
    expect(packed[3]).toBe(0x7f);
  });

  it("scales by 32767, never 32768 (int16 overflow)", () => {
    expect(int16Of(framePack(new Float32Array([1, -1])))).toEqual([32767, -32767]);
  });

  it("clamps before scaling instead of wrapping around", () => {
    expect(int16Of(framePack(new Float32Array([4, -4])))).toEqual([32767, -32767]);
  });

  it("maps non-finite samples to silence (one NaN must not poison the frame)", () => {
    expect(int16Of(framePack(new Float32Array([Number.NaN, Infinity, -Infinity])))).toEqual([
      0, 0, 0,
    ]);
  });

  it("rounds half away from zero, symmetrically", () => {
    expect(int16Of(framePack(new Float32Array([0.25, -0.25])))).toEqual([8192, -8192]);
    expect(int16Of(framePack(new Float32Array([0.5, -0.5])))).toEqual([16384, -16384]);
  });

  it("reuses the output buffer and truncates a partial write", () => {
    const out = new Uint8Array(16);
    const packed = framePack(new Float32Array([1, -1, 1, -1]), out);
    expect(packed.buffer).toBe(out.buffer);
    expect(packed.length).toBe(8);
    expect(int16Of(packed)).toEqual([32767, -32767, 32767, -32767]);
  });

  it("rejects an undersized buffer", () => {
    expect(() => framePack(new Float32Array([0, 0]), new Uint8Array(2))).toThrow(RangeError);
  });
});

describe("downsampleLinear (fallback resampler when the context is not 16 kHz)", () => {
  it("passes 16 kHz through untouched (step 1)", () => {
    const state = createDownsampleState(16000, 16000);
    const out = new Float32Array(4);
    const written = downsampleLinear(new Float32Array([0.25, 0.5, 0.75, 1]), state, out);
    expect(written).toBe(4);
    expect(Array.from(out)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it("emits one output per 3 samples at 48 kHz", () => {
    const state = createDownsampleState(48000, 16000);
    const out = new Float32Array(320);
    expect(downsampleLinear(new Float32Array(960), state, out)).toBe(320);
  });

  it("is phase-continuous across blocks (quantum size is never assumed)", () => {
    const whole = createDownsampleState(44100, 16000);
    const reference = new Float32Array(441);
    const referenceCount = downsampleLinear(
      new Float32Array(441),
      whole,
      reference,
      0,
    );

    const split = createDownsampleState(44100, 16000);
    const parts = new Float32Array(441);
    const first = downsampleLinear(new Float32Array(200), split, parts, 0);
    const second = downsampleLinear(new Float32Array(241), split, parts, first);
    expect(first + second).toBe(referenceCount);
    expect(Array.from(parts)).toEqual(Array.from(reference));
  });

  it("interpolates a ramp exactly at the sampled positions", () => {
    const state = createDownsampleState(48000, 16000);
    const out = new Float32Array(320);
    const input = new Float32Array(960);
    for (let i = 0; i < input.length; i += 1) {
      input[i] = i / 959;
    }
    downsampleLinear(input, state, out);
    for (let k = 0; k < 320; k += 1) {
      expect(out[k]).toBeCloseTo((3 * k) / 959, 6);
    }
  });

  it("sanitizes non-finite input and never writes past `out`", () => {
    const state = createDownsampleState(48000, 16000);
    const out = new Float32Array(4);
    const written = downsampleLinear(new Float32Array([Number.NaN, 0.5, -0.5, 1]), state, out);
    expect(written).toBe(2);
    for (const sample of out) {
      expect(Number.isFinite(sample)).toBe(true);
    }
  });

  it("rejects non-positive rates", () => {
    expect(() => createDownsampleState(0, 16000)).toThrow(RangeError);
    expect(() => createDownsampleState(48000, -1)).toThrow(RangeError);
  });
});

describe("writeSine (synthetic PCM for the ?injectAudio=1 seam)", () => {
  it("stays inside the requested amplitude", () => {
    const out = new Float32Array(160);
    writeSine(out, 0, 1000, 0.5, 16000);
    for (const sample of out) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(0.5 + 1e-6);
    }
    expect(out[4]).toBeCloseTo(0.5, 6);
  });

  it("is phase-continuous for a non-zero start sample", () => {
    const whole = new Float32Array(32);
    writeSine(whole, 0, 440, 1, 16000);
    const shifted = new Float32Array(16);
    writeSine(shifted, 16, 440, 1, 16000);
    expect(Array.from(shifted)).toEqual(Array.from(whole.slice(16)));
  });
});

describe("AudioFrameSender (uplink type 0x01 framing + backpressure)", () => {
  it("sends ver 0x01 / type 0x01 with a monotonic seq and the speaker index", () => {
    const socket = new FakeSocket();
    const sender = new AudioFrameSender(socket);
    sender.setSpeakerIndex(3);
    expect(sender.sendPcm16le(framePack(new Float32Array([0.5, -0.5])))).toBe(true);
    expect(sender.sendPcm16le(framePack(new Float32Array([0.25, 0.25])))).toBe(true);

    expect(socket.sent.length).toBe(2);
    const first = decodeAudioFrame(socket.sent[0] as Uint8Array);
    expect(first.version).toBe(FITRA_AUDIO_VERSION);
    expect(first.type).toBe(0x01);
    expect(first.seq).toBe(0);
    expect(first.speaker).toBe(3);
    expect(first.payload.length).toBe(4);
    expect(int16Of(first.payload)).toEqual([16384, -16384]);
    expect(decodeAudioFrame(socket.sent[1] as Uint8Array).seq).toBe(1);
  });

  it("wraps seq at 65535", () => {
    const socket = new FakeSocket();
    const sender = new AudioFrameSender(socket);
    const silence = framePack(new Float32Array([0, 0]));
    for (let i = 0; i <= 65536; i += 1) {
      sender.sendPcm16le(silence);
    }
    expect(decodeAudioFrame(socket.sent[65535] as Uint8Array).seq).toBe(65535);
    expect(decodeAudioFrame(socket.sent[65536] as Uint8Array).seq).toBe(0);
  });

  it("drops instead of queueing above the backpressure threshold", () => {
    const socket = new FakeSocket();
    const sender = new AudioFrameSender(socket);
    const payload = framePack(new Float32Array(CAPTURE_FRAME_SAMPLES));

    socket.bufferedAmount = CAPTURE_BACKPRESSURE_BYTES;
    expect(sender.sendPcm16le(payload)).toBe(true);

    socket.bufferedAmount = CAPTURE_BACKPRESSURE_BYTES + 1;
    expect(sender.sendPcm16le(payload)).toBe(false);
    expect(socket.sent.length).toBe(1);
    expect(sender.stats.framesSent).toBe(1);
    expect(sender.stats.framesDropped).toBe(1);
  });

  it("drops while the socket is not open", () => {
    const socket = new FakeSocket();
    const sender = new AudioFrameSender(socket);
    socket.readyState = 0;
    expect(sender.sendPcm16le(new Uint8Array(2))).toBe(false);
    expect(sender.stats.framesDropped).toBe(1);
  });

  it("drops an oversize payload instead of throwing into the audio path", () => {
    const socket = new FakeSocket();
    const sender = new AudioFrameSender(socket);
    expect(sender.sendPcm16le(new Uint8Array(8193))).toBe(false);
    expect(socket.sent.length).toBe(0);
    expect(sender.stats.framesDropped).toBe(1);
  });

  it("rejects an out-of-range speaker index", () => {
    const sender = new AudioFrameSender(new FakeSocket());
    expect(() => sender.setSpeakerIndex(-1)).toThrow(RangeError);
    expect(() => sender.setSpeakerIndex(65536)).toThrow(RangeError);
  });
});

describe("injection seam (?injectAudio=1, T-016 / OQ-10)", () => {
  it("reads the query flag", () => {
    expect(injectAudioRequested("?injectAudio=1")).toBe(true);
    expect(injectAudioRequested("?foo=1")).toBe(false);
    expect(injectAudioRequested("")).toBe(false);
  });

  it("feeds the sender 100 ms frames without any browser audio API", async () => {
    const socket = new FakeSocket();
    const injector = createAudioInjector({
      sender: new AudioFrameSender(socket),
      startDelayMs: 0,
      frameMs: 20,
    });
    injector.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    injector.stop();

    expect(socket.sent.length).toBeGreaterThanOrEqual(2);
    const first = decodeAudioFrame(socket.sent[0] as Uint8Array);
    expect(first.type).toBe(0x01);
    expect(first.payload.length).toBe((20 / 1000) * CAPTURE_SAMPLE_RATE_HZ * 2);
    expect(socket.sent[0]?.length).toBe(FITRA_AUDIO_HEADER_BYTES + first.payload.length);

    const afterStop = socket.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(socket.sent.length).toBe(afterStop);
  });

  it("resamples a 48 kHz synthetic source down to the 16 kHz frame size", async () => {
    const socket = new FakeSocket();
    const injector = createAudioInjector({
      sender: new AudioFrameSender(socket),
      startDelayMs: 0,
      sourceRateHz: 48000,
    });
    injector.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    injector.stop();
    expect(socket.sent[0]?.length).toBe(FITRA_AUDIO_HEADER_BYTES + CAPTURE_FRAME_SAMPLES * 2);
  });
});
