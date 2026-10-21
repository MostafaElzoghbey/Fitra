// Linear 16 kHz -> 24 kHz mono upsampler for the same-language relay path.
//
// Why this exists: uplink frames are 16 kHz PCM16LE (docs/PROTOCOL.md section
// 2), but every DO->client frame MUST be 24 kHz (same table: type 0x02 is "24
// kHz output"). Relaying the raw uplink bytes to same-language listeners made
// the browser play 16 kHz samples at 24 kHz — 1.5x speed, pitch up ~7
// semitones ("another human tone") plus choppy buffering, because the
// playback scheduler's pre-roll math also assumes 24 kHz. The relay path
// resamples here so the wire contract holds for every listener frame.
//
// Method: exact rational 2->3 linear interpolation (no phase accumulator
// needed — each 100 ms frame upsamples independently and linear interpolation
// of a continuous signal is boundary-exact). Pure function, no I/O, safe to
// run per frame per listener in the DO: ~2.4k multiply-adds per 100 ms frame.
export const RESAMPLE_FROM_HZ = 16000;
export const RESAMPLE_TO_HZ = 24000;

/** Samples out per 100 ms frame of 16 kHz input (1600 -> 2400). */
export function upsampledSampleCount(inSamples: number): number {
  if (!Number.isInteger(inSamples) || inSamples < 0) return 0;
  return Math.floor((inSamples * RESAMPLE_TO_HZ) / RESAMPLE_FROM_HZ);
}

/**
 * Upsample 16 kHz PCM16LE mono bytes to 24 kHz PCM16LE mono bytes.
 * A trailing odd byte (malformed tail) is dropped; empty input yields empty
 * output. Output values are rounded to nearest int16 and clamped.
 */
export function upsample16kTo24kMono(pcm16k: Uint8Array): Uint8Array {
  const inSamples = Math.floor(pcm16k.length / 2);
  const outSamples = upsampledSampleCount(inSamples);
  const out = new Uint8Array(outSamples * 2);
  if (outSamples === 0) return out;
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const get = (i: number): number => {
    const clamped = i >= inSamples ? inSamples - 1 : i;
    const lo = pcm16k[clamped * 2] ?? 0;
    const hi = pcm16k[clamped * 2 + 1] ?? 0;
    let v = (hi << 8) | lo;
    if (v >= 0x8000) v -= 0x10000;
    return v;
  };
  for (let j = 0; j < outSamples; j += 1) {
    const pos = (j * inSamples) / outSamples;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = get(i0);
    const b = get(i0 + 1);
    let v = Math.round(a + (b - a) * frac);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    outView.setInt16(j * 2, v, true);
  }
  return out;
}
