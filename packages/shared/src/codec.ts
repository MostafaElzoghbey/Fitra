// T-002: binary audio frame codec per docs/PROTOCOL.md section 2.
//
// Layout (all multi-byte integers little-endian):
//   byte 0:    ver (0x01)
//   byte 1:    type (0x01 client->DO @16kHz, 0x02 DO->client @24kHz)
//   bytes 2-3: seq u16 LE (per-sender monotonic, wraps at 65535)
//   bytes 4-5: speaker u16 LE (participantIndex assigned at join)
//   bytes 6-7: reserved u16 LE (always zero)
//   bytes 8+:  payload (PCM16LE mono, no header)

export const FITRA_AUDIO_HEADER_BYTES = 8;
export const FITRA_AUDIO_VERSION = 0x01;
export const FITRA_AUDIO_MAX_PAYLOAD_BYTES = 8192;
export const FITRA_AUDIO_SEQ_MOD = 65536;

export const FITRA_AUDIO_TYPE_UPLINK = 0x01;
export const FITRA_AUDIO_TYPE_DOWNLINK = 0x02;

export type AudioFrameType = 0x01 | 0x02;

export type CodecErrorCode = "bad-version" | "frame-too-large" | "truncated";

export class CodecError extends Error {
  readonly code: CodecErrorCode;

  constructor(code: CodecErrorCode, message?: string) {
    super(message ?? code);
    this.name = "CodecError";
    this.code = code;
  }
}

export interface EncodeAudioFrameParams {
  readonly version?: number;
  readonly type: AudioFrameType;
  readonly seq: number;
  readonly speaker: number;
  readonly payload: Uint8Array;
}

export interface DecodedAudioFrame {
  readonly version: number;
  readonly type: AudioFrameType;
  readonly seq: number;
  readonly speaker: number;
  readonly payload: Uint8Array;
}

function assertU16(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be an integer in [0, 65535], got ${value}`);
  }
}

function assertFrameType(value: number): asserts value is AudioFrameType {
  if (value !== FITRA_AUDIO_TYPE_UPLINK && value !== FITRA_AUDIO_TYPE_DOWNLINK) {
    throw new RangeError(`type must be 0x01 or 0x02, got ${value}`);
  }
}

/** Advance a per-sender sequence counter, wrapping at 65535 -> 0. */
export function nextAudioSeq(seq: number): number {
  assertU16("seq", seq);
  return (seq + 1) % FITRA_AUDIO_SEQ_MOD;
}

export function encodeAudioFrame(params: EncodeAudioFrameParams): Uint8Array {
  const version = params.version ?? FITRA_AUDIO_VERSION;
  if (version !== FITRA_AUDIO_VERSION) {
    throw new CodecError("bad-version", `unsupported audio version ${version}`);
  }
  assertFrameType(params.type);
  assertU16("seq", params.seq);
  assertU16("speaker", params.speaker);
  if (params.payload.length > FITRA_AUDIO_MAX_PAYLOAD_BYTES) {
    throw new CodecError(
      "frame-too-large",
      `payload ${params.payload.length} exceeds ${FITRA_AUDIO_MAX_PAYLOAD_BYTES}`,
    );
  }

  const out = new Uint8Array(FITRA_AUDIO_HEADER_BYTES + params.payload.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, version);
  view.setUint8(1, params.type);
  view.setUint16(2, params.seq, true);
  view.setUint16(4, params.speaker, true);
  view.setUint16(6, 0, true);
  out.set(params.payload, FITRA_AUDIO_HEADER_BYTES);
  return out;
}

/**
 * Split an arbitrary PCM payload into even-length pieces that each fit one
 * wire frame (`<= maxBytes`, default `FITRA_AUDIO_MAX_PAYLOAD_BYTES`).
 * Provider output chunks (e.g. Gemini turns) are far bigger than one 100 ms
 * frame — without this, `encodeAudioFrame` rejects them and the whole chunk
 * is silently lost. Splitting raw PCM mid-stream is safe: the listener
 * concatenates by sequence. A trailing odd byte is dropped (malformed tail).
 */
export function splitPayloadForWire(
  payload: Uint8Array,
  maxBytes: number = FITRA_AUDIO_MAX_PAYLOAD_BYTES,
): Uint8Array[] {
  const cap = Math.max(2, Math.floor(maxBytes / 2) * 2);
  const usable = Math.floor(payload.length / 2) * 2;
  const pieces: Uint8Array[] = [];
  for (let off = 0; off < usable; off += cap) {
    const end = Math.min(off + cap, usable);
    pieces.push(payload.slice(off, end));
  }
  return pieces;
}

export function decodeAudioFrame(bytes: Uint8Array): DecodedAudioFrame {
  if (bytes.length < FITRA_AUDIO_HEADER_BYTES) {
    throw new CodecError(
      "truncated",
      `frame ${bytes.length} shorter than ${FITRA_AUDIO_HEADER_BYTES}-byte header`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== FITRA_AUDIO_VERSION) {
    throw new CodecError("bad-version", `unsupported audio version ${version}`);
  }
  const rawType = view.getUint8(1);
  assertFrameType(rawType);
  const payloadLength = bytes.length - FITRA_AUDIO_HEADER_BYTES;
  if (payloadLength > FITRA_AUDIO_MAX_PAYLOAD_BYTES) {
    throw new CodecError(
      "frame-too-large",
      `payload ${payloadLength} exceeds ${FITRA_AUDIO_MAX_PAYLOAD_BYTES}`,
    );
  }
  const seq = view.getUint16(2, true);
  const speaker = view.getUint16(4, true);
  return {
    version,
    type: rawType,
    seq,
    speaker,
    payload: bytes.slice(FITRA_AUDIO_HEADER_BYTES),
  };
}
