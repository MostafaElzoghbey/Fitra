/**
 * T-011 — Browser playback scheduler (downlink type 0x02, 24 kHz PCM16LE mono).
 *
 * ARCHITECTURE DECISION (binding — supersedes SPEC FR-031 "AudioWorklet" wording):
 * playback uses scheduled `AudioBufferSourceNode`s, NOT a playback AudioWorklet.
 * Each 100 ms downlink packet (4800 B nominal per docs/PROTOCOL.md §2) is tagged
 * with its true rate via `ctx.createBuffer(1, frame.length, 24000)`, so the
 * browser resamples 24 kHz → hardware rate (typically 48 kHz) itself. Feeding
 * raw 24 kHz samples into a 48 kHz graph without that tag plays them back
 * double-speed ("chipmunk bug"); the explicit sample-rate tag avoids it with no
 * hand-rolled resampler and no per-sample worklet cost.
 *
 * Wiring: the WS binary frame is decoded by the caller with
 * `decodeAudioFrame` from `@fitra/shared`, then converted with
 * {@link downlinkPacketFromFrame} and passed to {@link PlaybackScheduler.pushPacket}.
 *
 * Ownership: this module never creates an `AudioContext`. The App owns a
 * dedicated "playback" context (separate from the capture context) and passes
 * it in, so capture/playback graphs stay independent and autoplay-gesture
 * resume is handled in one place.
 *
 * Timing authority is `ctx.currentTime`. A `setTimeout` pump is armed ONLY when
 * the pending queue drains (starvation watchdog); while packets flow, each
 * `pushPacket` schedules directly off the audio clock.
 *
 * Memory-only: no audio or caption data is persisted (see docs/PRIVACY.md).
 */

import type { DecodedAudioFrame } from "@fitra/shared";

/** True sample rate of downlink PCM. Tags every AudioBuffer for HW resampling. */
export const PLAYBACK_SAMPLE_RATE_HZ = 24000;

/** Nominal packet duration at 24 kHz mono (4800 B PCM16LE). */
export const PLAYBACK_FRAME_MS_NOMINAL = 100;

/** Buffered audio required before the first source is scheduled. */
export const PLAYBACK_PRE_ROLL_MS = 400;

/** Max audio kept in the *unscheduled* queue. Audio already scheduled on the
 * audio clock is never shed: providers may deliver a whole turn in one burst,
 * and dropping the horizon cut translations mid-sentence (T-026). */
export const PLAYBACK_MAX_PENDING_MS = 800;

/** Max consecutive PLC silence frames inserted per sequence gap. */
export const PLAYBACK_MAX_PLC_FRAMES = 10;

/** Sequence counter modulus (u16, wraps 65535 -> 0). */
export const PLAYBACK_SEQ_MOD = 65536;

/** Forward distances above this are treated as late/reordered, not future. */
const PLAYBACK_LATE_THRESHOLD = PLAYBACK_SEQ_MOD / 2;

/** Small lead added to `currentTime` when starting after pre-roll. */
const PLAYBACK_START_LEAD_SEC = 0.05;

/** Fallback poll interval while scheduled audio is still playing out. */
const PLAYBACK_EMPTY_POLL_MS = 100;

export interface PlaybackPacket {
  readonly seq: number;
  readonly pcm24k: Uint8Array;
}

export interface PlaybackStats {
  readonly framesPlayed: number;
  readonly gaps: number;
  readonly overruns: number;
  readonly underruns: number;
  readonly bufferedMs: number;
}

/**
 * Convert PCM16LE bytes to Float32 samples in [-1, 1).
 * A trailing odd byte (malformed tail) is dropped.
 */
export function pcm16ToF32(pcm: Uint8Array): Float32Array {
  const count = Math.floor(pcm.length / 2);
  const out = new Float32Array(count);
  const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2);
  for (let i = 0; i < count; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

/** Forward (mod-2^16) distance from expected to received sequence number. */
export function seqForwardDistance(expectedSeq: number, receivedSeq: number): number {
  const mod = PLAYBACK_SEQ_MOD;
  const e = ((expectedSeq % mod) + mod) % mod;
  const r = ((receivedSeq % mod) + mod) % mod;
  return (r - e + mod) % mod;
}

/**
 * True when the packet is late/reordered (behind the expected cursor) rather
 * than in-order or ahead. Late packets are dropped, never rescheduled.
 */
export function isLateOrDuplicate(expectedSeq: number, receivedSeq: number): boolean {
  const distance = seqForwardDistance(expectedSeq, receivedSeq);
  return distance !== 0 && distance > PLAYBACK_LATE_THRESHOLD;
}

/**
 * Number of missing frames before `receivedSeq` given the expected cursor:
 * 0 when in-order or late, otherwise the forward distance (caller caps PLC).
 */
export function gapFrameCount(expectedSeq: number, receivedSeq: number): number {
  const distance = seqForwardDistance(expectedSeq, receivedSeq);
  if (distance === 0 || distance > PLAYBACK_LATE_THRESHOLD) {
    return 0;
  }
  return distance;
}

/** Cap raw missing-frame count to the PLC silence budget. */
export function cappedPlcFrames(missing: number): number {
  if (!Number.isFinite(missing) || missing <= 0) {
    return 0;
  }
  return Math.min(Math.floor(missing), PLAYBACK_MAX_PLC_FRAMES);
}

/**
 * Adapt a decoded WS downlink frame (type 0x02) to a scheduler packet.
 * Callers decode with `decodeAudioFrame` first; this keeps the scheduler
 * transport-agnostic and unit-testable without sockets.
 */
export function downlinkPacketFromFrame(frame: DecodedAudioFrame): PlaybackPacket {
  return { seq: frame.seq, pcm24k: frame.payload };
}

export class PlaybackScheduler {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly pending: Float32Array[] = [];
  private readonly liveNodes = new Set<AudioBufferSourceNode>();
  private expectedSeq: number | null = null;
  private nextTime: number | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;
  private framesPlayedCount = 0;
  private gapsCount = 0;
  private overrunsCount = 0;
  private underrunsCount = 0;
  private disposed = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
  }

  /**
   * Enqueue one decoded 24 kHz packet for scheduled playback.
   * - In-order (`seq === expected`): appended.
   * - Ahead: inserts up to MAX_PLC_FRAMES of silence, counts `gaps`.
   * - Late/reordered (`seq` behind cursor): dropped silently.
   * - Unscheduled queue past 800 ms: oldest pending frames shed, counts `overruns`.
   *   Already-scheduled audio is never shed (a provider burst is a whole turn).
   */
  pushPacket(packet: PlaybackPacket): void {
    if (this.disposed) {
      return;
    }
    if (!Number.isInteger(packet.seq) || packet.seq < 0 || packet.seq > 0xffff) {
      throw new RangeError(`seq must be an integer in [0, 65535], got ${packet.seq}`);
    }
    const frame = pcm16ToF32(packet.pcm24k);
    if (frame.length === 0) {
      return;
    }

    if (this.expectedSeq === null) {
      this.expectedSeq = (packet.seq + 1) % PLAYBACK_SEQ_MOD;
      this.pending.push(frame);
    } else {
      const distance = seqForwardDistance(this.expectedSeq, packet.seq);
      if (distance === 0) {
        this.expectedSeq = (packet.seq + 1) % PLAYBACK_SEQ_MOD;
        this.pending.push(frame);
      } else if (distance <= PLAYBACK_LATE_THRESHOLD) {
        const plc = cappedPlcFrames(distance);
        if (plc > 0) {
          const silence = new Float32Array(frame.length);
          for (let i = 0; i < plc; i++) {
            this.pending.push(silence);
          }
          this.gapsCount += plc;
        }
        this.expectedSeq = (packet.seq + 1) % PLAYBACK_SEQ_MOD;
        this.pending.push(frame);
      } else {
        return;
      }
    }

    this.trimOverrun();
    this.pump();
  }

  /**
   * Floor-revoke path: drop everything pending, silence scheduled sources,
   * and reset cursors so the next spurt re-prerolls cleanly.
   */
  interrupt(): void {
    this.pending.length = 0;
    this.expectedSeq = null;
    this.nextTime = null;
    this.clearEmptyTimer();
    if (this.disposed) {
      return;
    }
    const now = this.ctx.currentTime;
    for (const node of this.liveNodes) {
      try {
        node.stop(now);
      } catch {
        // Already ended/never started; the onended hook cleans the set.
      }
    }
    this.liveNodes.clear();
    try {
      const gain = this.master.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0.0001, now + 0.02);
      gain.setValueAtTime(0.0001, now + 0.03);
      gain.linearRampToValueAtTime(1, now + 0.08);
    } catch {
      // Context closed mid-revoke; nothing audible left to ramp.
    }
  }

  /** Live counters for the T-012 latency/metrics panel. */
  get stats(): PlaybackStats {
    return {
      framesPlayed: this.framesPlayedCount,
      gaps: this.gapsCount,
      overruns: this.overrunsCount,
      underruns: this.underrunsCount,
      bufferedMs: this.bufferedMs(),
    };
  }

  /** Stop timers/sources and detach the master gain. Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearEmptyTimer();
    for (const node of this.liveNodes) {
      try {
        node.stop();
      } catch {
        // Already finished; ignore.
      }
      node.disconnect();
    }
    this.liveNodes.clear();
    this.pending.length = 0;
    this.master.disconnect();
  }

  private pendingSamples(): number {
    let total = 0;
    for (const frame of this.pending) {
      total += frame.length;
    }
    return total;
  }

  private bufferedMs(): number {
    let horizonMs = 0;
    if (this.nextTime !== null && !this.disposed) {
      horizonMs = Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000);
    }
    const pendingMs = (this.pendingSamples() / PLAYBACK_SAMPLE_RATE_HZ) * 1000;
    return pendingMs + horizonMs;
  }

  /** Shed oldest *unscheduled* frames while the queue exceeds the cap.
   * Scheduled audio is left alone: it is already committed to the graph, and
   * dropping it truncated provider bursts at the 800 ms horizon. */
  private trimOverrun(): void {
    const maxSamples = (PLAYBACK_MAX_PENDING_MS / 1000) * PLAYBACK_SAMPLE_RATE_HZ;
    let pending = this.pendingSamples();
    while (pending > maxSamples && this.pending.length > 0) {
      const dropped = this.pending.shift();
      if (dropped === undefined) {
        break;
      }
      pending -= dropped.length;
      this.overrunsCount += 1;
    }
  }

  private pump(): void {
    if (this.disposed) {
      return;
    }
    this.clearEmptyTimer();
    const now = this.ctx.currentTime;
    if (this.nextTime === null) {
      const preRollSamples = (PLAYBACK_PRE_ROLL_MS / 1000) * PLAYBACK_SAMPLE_RATE_HZ;
      if (this.pendingSamples() < preRollSamples) {
        return;
      }
      this.nextTime = now + PLAYBACK_START_LEAD_SEC;
    }
    let cursor = this.nextTime < now ? now : this.nextTime;
    while (this.pending.length > 0) {
      const frame = this.pending.shift();
      if (frame === undefined || frame.length === 0) {
        continue;
      }
      this.scheduleAt(frame, cursor);
      cursor += frame.length / PLAYBACK_SAMPLE_RATE_HZ;
    }
    this.nextTime = cursor;
    this.armEmptyTimer();
  }

  private scheduleAt(frame: Float32Array, at: number): void {
    const buffer = this.ctx.createBuffer(1, frame.length, PLAYBACK_SAMPLE_RATE_HZ);
    buffer.getChannelData(0).set(frame);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master);
    this.liveNodes.add(source);
    source.onended = (): void => {
      this.liveNodes.delete(source);
    };
    source.start(at);
    this.framesPlayedCount += 1;
  }

  private clearEmptyTimer(): void {
    if (this.emptyTimer !== null) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
  }

  /**
   * Starvation watchdog: armed only when the pending queue has drained.
   * Clock authority stays with `ctx.currentTime`; the timer just re-checks it.
   */
  private armEmptyTimer(): void {
    if (this.disposed) {
      return;
    }
    this.clearEmptyTimer();
    let delayMs = PLAYBACK_EMPTY_POLL_MS;
    if (this.nextTime !== null) {
      const remainingMs = (this.nextTime - this.ctx.currentTime) * 1000;
      if (remainingMs > 0) {
        delayMs = Math.min(Math.max(remainingMs + 20, 20), 1000);
      }
    }
    this.emptyTimer = setTimeout(() => {
      this.onEmptyTimeout();
    }, delayMs);
  }

  private onEmptyTimeout(): void {
    this.emptyTimer = null;
    if (this.disposed || this.nextTime === null) {
      return;
    }
    if (this.pending.length > 0) {
      this.pump();
      return;
    }
    if (this.ctx.currentTime >= this.nextTime) {
      this.underrunsCount += 1;
      this.nextTime = null;
      // Fresh sync on the next spurt: avoids a PLC silence balloon
      // after natural speech pauses (floor idle -> no packets).
      this.expectedSeq = null;
      return;
    }
    this.armEmptyTimer();
  }
}
