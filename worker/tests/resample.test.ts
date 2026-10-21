// Unit tests for the same-language relay upsampler (16 kHz -> 24 kHz).
import { describe, expect, it } from "vitest";
import {
  upsample16kTo24kMono,
  upsampledSampleCount,
} from "../src/resample.js";

function pack(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => {
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(s))), true);
  });
  return out;
}

function unpack(pcm: Uint8Array): number[] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out: number[] = [];
  for (let i = 0; i < pcm.length / 2; i += 1) out.push(view.getInt16(i * 2, true));
  return out;
}

describe("upsample16kTo24kMono", () => {
  it("maps a 100 ms frame of 1600 samples to 2400 samples", () => {
    expect(upsampledSampleCount(1600)).toBe(2400);
    const out = upsample16kTo24kMono(new Uint8Array(3200));
    expect(out.length).toBe(4800);
  });

  it("preserves a constant signal exactly", () => {
    const out = unpack(upsample16kTo24kMono(pack(new Array(80).fill(0x5a5a))));
    expect(out.length).toBe(120);
    for (const v of out) expect(v).toBe(0x5a5a);
  });

  it("preserves silence", () => {
    const out = unpack(upsample16kTo24kMono(new Uint8Array(320)));
    expect(out.length).toBe(240);
    for (const v of out) expect(v).toBe(0);
  });

  it("interpolates a linear ramp (endpoints pinned)", () => {
    const ramp = Array.from({ length: 160 }, (_, i) => i * 100);
    const out = unpack(upsample16kTo24kMono(pack(ramp)));
    expect(out.length).toBe(240);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(15900);
  });

  it("drops a trailing odd byte and maps empty input to empty output", () => {
    expect(upsample16kTo24kMono(new Uint8Array(0)).length).toBe(0);
    expect(upsample16kTo24kMono(new Uint8Array([0x01])).length).toBe(0);
  });

  it("clamps to the int16 range", () => {
    const out = unpack(upsample16kTo24kMono(pack([32767, 32767])));
    for (const v of out) {
      expect(v).toBeLessThanOrEqual(32767);
      expect(v).toBeGreaterThanOrEqual(-32768);
    }
  });
});
