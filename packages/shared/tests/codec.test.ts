import { describe, expect, it } from "vitest";
import {
  CodecError,
  FITRA_AUDIO_HEADER_BYTES,
  FITRA_AUDIO_MAX_PAYLOAD_BYTES,
  decodeAudioFrame,
  encodeAudioFrame,
  nextAudioSeq,
  splitPayloadForWire,
} from "../src/index.js";

function payloadOf(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

describe("audio frame codec (PROTOCOL.md section 2)", () => {
  it("exposes an 8-byte header", () => {
    expect(FITRA_AUDIO_HEADER_BYTES).toBe(8);
  });

  it("round-trips uplink frames (type 0x01) with exact header bytes", () => {
    const payload = payloadOf(1, 2, 3, 4, 5);
    const encoded = encodeAudioFrame({
      type: 0x01,
      seq: 42,
      speaker: 0,
      payload,
    });
    expect(encoded.length).toBe(8 + payload.length);
    // Bit-exact LE header: ver | type | seq u16 LE | speaker u16 LE | reserved u16 LE
    expect(Array.from(encoded.subarray(0, 8))).toEqual([0x01, 0x01, 42, 0, 0, 0, 0, 0]);
    const decoded = decodeAudioFrame(encoded);
    expect(decoded.version).toBe(0x01);
    expect(decoded.type).toBe(0x01);
    expect(decoded.seq).toBe(42);
    expect(decoded.speaker).toBe(0);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it("round-trips downlink frames (type 0x02) with LE seq/speaker", () => {
    const payload = payloadOf(9, 8, 7);
    const encoded = encodeAudioFrame({
      type: 0x02,
      seq: 0x0201,
      speaker: 0x0403,
      payload,
    });
    expect(Array.from(encoded.subarray(0, 8))).toEqual([
      0x01, 0x02, 0x01, 0x02, 0x03, 0x04, 0x00, 0x00,
    ]);
    const decoded = decodeAudioFrame(encoded);
    expect(decoded).toMatchObject({ version: 0x01, type: 0x02, seq: 0x0201, speaker: 0x0403 });
    expect(Array.from(decoded.payload)).toEqual([9, 8, 7]);
  });

  it("round-trips empty payloads", () => {
    const encoded = encodeAudioFrame({ type: 0x01, seq: 1, speaker: 1, payload: new Uint8Array(0) });
    expect(encoded.length).toBe(8);
    const decoded = decodeAudioFrame(encoded);
    expect(decoded.payload.length).toBe(0);
    expect(decoded.seq).toBe(1);
  });

  it("round-trips boundary seq values and wraps at 65535", () => {
    for (const seq of [0, 1, 255, 256, 65534, 65535]) {
      const encoded = encodeAudioFrame({
        type: 0x01,
        seq,
        speaker: 7,
        payload: payloadOf(0xff),
      });
      expect(decodeAudioFrame(encoded).seq).toBe(seq);
    }
    expect(nextAudioSeq(65535)).toBe(0);
    expect(nextAudioSeq(0)).toBe(1);
    expect(nextAudioSeq(65534)).toBe(65535);
    // Wrapped seq still round-trips.
    const wrapped = encodeAudioFrame({
      type: 0x01,
      seq: nextAudioSeq(65535),
      speaker: 0,
      payload: payloadOf(1),
    });
    expect(decodeAudioFrame(wrapped).seq).toBe(0);
  });

  it("defaults version to 0x01 when omitted", () => {
    const encoded = encodeAudioFrame({ type: 0x01, seq: 0, speaker: 0, payload: payloadOf(1) });
    expect(encoded[0]).toBe(0x01);
  });

  it("rejects unknown versions with bad-version", () => {
    const good = encodeAudioFrame({ type: 0x01, seq: 0, speaker: 0, payload: payloadOf(1, 2) });
    const bad = new Uint8Array(good);
    bad[0] = 0x02;
    try {
      decodeAudioFrame(bad);
      expect.unreachable("expected bad-version CodecError");
    } catch (err) {
      expect(err).toBeInstanceOf(CodecError);
      expect((err as CodecError).code).toBe("bad-version");
    }
  });

  it("rejects oversize payloads (>8KiB) with frame-too-large", () => {
    // Decode path: header claims a payload larger than 8 KiB.
    const big = new Uint8Array(8 + 8193);
    big[0] = 0x01;
    big[1] = 0x01;
    try {
      decodeAudioFrame(big);
      expect.unreachable("expected frame-too-large CodecError");
    } catch (err) {
      expect(err).toBeInstanceOf(CodecError);
      expect((err as CodecError).code).toBe("frame-too-large");
    }
    // Encode path guards the same limit.
    try {
      encodeAudioFrame({ type: 0x01, seq: 0, speaker: 0, payload: new Uint8Array(8193) });
      expect.unreachable("expected frame-too-large CodecError");
    } catch (err) {
      expect(err).toBeInstanceOf(CodecError);
      expect((err as CodecError).code).toBe("frame-too-large");
    }
  });

  it("accepts exactly 8 KiB payloads", () => {
    const payload = new Uint8Array(8192);
    payload[0] = 1;
    payload[8191] = 2;
    const encoded = encodeAudioFrame({ type: 0x01, seq: 9, speaker: 2, payload });
    expect(encoded.length).toBe(8 + 8192);
    const decoded = decodeAudioFrame(encoded);
    expect(decoded.payload.length).toBe(8192);
    expect(decoded.payload[0]).toBe(1);
    expect(decoded.payload[8191]).toBe(2);
  });

  it("rejects truncated buffers with truncated", () => {
    for (const len of [0, 1, 7]) {
      try {
        decodeAudioFrame(new Uint8Array(len));
        expect.unreachable(`expected truncated CodecError for len ${len}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CodecError);
        expect((err as CodecError).code).toBe("truncated");
      }
    }
  });

  it("does not alias caller payload or input buffer", () => {
    const payload = payloadOf(1, 2, 3);
    const encoded = encodeAudioFrame({ type: 0x01, seq: 3, speaker: 0, payload });
    payload[0] = 99;
    expect(encoded[8]).toBe(1);
    const decoded = decodeAudioFrame(encoded);
    encoded[8] = 77;
    expect(decoded.payload[0]).toBe(1);
  });

  it("splitPayloadForWire keeps small payloads in one piece", () => {
    const payload = new Uint8Array(4800).fill(0x7f);
    const pieces = splitPayloadForWire(payload);
    expect(pieces.length).toBe(1);
    expect(pieces[0]?.length).toBe(4800);
  });

  it("splitPayloadForWire splits a Gemini-sized turn into fittable even pieces", () => {
    const payload = new Uint8Array(30000);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff;
    const pieces = splitPayloadForWire(payload);
    expect(pieces.length).toBe(4);
    let total = 0;
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(FITRA_AUDIO_MAX_PAYLOAD_BYTES);
      expect(piece.length % 2).toBe(0);
      total += piece.length;
    }
    expect(total).toBe(30000);
    const joined = new Uint8Array(total);
    let off = 0;
    for (const piece of pieces) {
      joined.set(piece, off);
      off += piece.length;
    }
    expect(joined).toEqual(payload);
  });

  it("splitPayloadForWire drops a trailing odd byte", () => {
    const pieces = splitPayloadForWire(new Uint8Array([1, 2, 3]));
    expect(pieces.length).toBe(1);
    expect(pieces[0]?.length).toBe(2);
    expect(splitPayloadForWire(new Uint8Array(0)).length).toBe(0);
  });
});
