/**
 * T-010 — browser mic capture: AudioWorklet @ 16 kHz mono → 100 ms PCM16LE
 * frames → binary uplink frames (docs/PROTOCOL.md §2, type `0x01`).
 *
 * Pipeline:
 *   getUserStream (devices.ts, mono + EC/NS/AGC, exact deviceId)
 *     → MediaStreamAudioSourceNode
 *     → AudioWorkletNode("fitra-capture")   [public/worklets/capture.worklet.js]
 *     → 100 ms PCM16LE ArrayBuffer per frame
 *     → AudioFrameSender → WebSocket binary send
 *
 * Hard rules honoured here (AGENTS.md):
 *   - the mic is NEVER connected to `ctx.destination`: no feedback loop, and no
 *     playback code exists in this module (T-011 owns playback),
 *   - `encodeAudioFrame` from `@fitra/shared` is the only thing that builds wire
 *     bytes; the speaker index comes from the server `welcome` message and is
 *     pushed in through {@link MicCapture.setSpeakerIndex},
 *   - nothing per-chunk is persisted; audio lives in memory only,
 *   - audio never leaves the browser except as those WS frames.
 *
 * Rate discipline: the context is requested at 16 kHz. If the browser refuses,
 * the worklet resamples to 16 kHz itself, so the wire format is 16 kHz either
 * way (see `public/worklets/capture.worklet.js`).
 *
 * Backpressure: audio is live, so a frame is dropped (never queued) when
 * `ws.bufferedAmount` is above {@link CAPTURE_BACKPRESSURE_BYTES}. ~10 frames/s
 * at 3 208 B/frame means 64 KiB ≈ 2 s of stall — dropping is the only correct
 * answer there; buffering would only add latency (SPEC FR-030, LIMITS §2).
 *
 * Test seam (OQ-10 / T-016): `?injectAudio=1` skips the microphone and feeds
 * synthetic 16 kHz PCM straight to the sender, so E2E never depends on
 * Chromium fake-audio flags. `window.__fitraCapture` exposes the counters.
 */

import {
  FITRA_AUDIO_TYPE_UPLINK,
  encodeAudioFrame,
  nextAudioSeq,
} from "@fitra/shared";
import {
  type CaptureNotice,
  armGestureResume,
  disposeMediaStream,
  isPermissionDenied,
  listMicInputs,
  openMicStream,
  processingEnabled,
  readProcessingSettings,
  selectDevice,
  watchDeviceChange,
  type MicInputDevice,
} from "./devices.js";

/** True uplink rate required by Gemini (docs/LIMITS.md §2). */
export const CAPTURE_SAMPLE_RATE_HZ = 16000;

/** Nominal frame duration (PROTOCOL §2, Gemini's recommended chunk). */
export const CAPTURE_FRAME_MS = 100;

/** Samples per frame: 16 000 × 0.1 s = 1 600. */
export const CAPTURE_FRAME_SAMPLES = (CAPTURE_SAMPLE_RATE_HZ * CAPTURE_FRAME_MS) / 1000;

/** PCM16LE bytes per frame: 3 200 B (3 208 B on the wire with the header). */
export const CAPTURE_PAYLOAD_BYTES = CAPTURE_FRAME_SAMPLES * 2;

/** Full-scale multiplier. 32768 would overflow int16 and wrap to -32768. */
export const CAPTURE_PCM16_SCALE = 32767;

/** Drop the frame instead of queueing once the socket holds this much audio. */
export const CAPTURE_BACKPRESSURE_BYTES = 64 * 1024;

/** Must match `registerProcessor` in `public/worklets/capture.worklet.js`. */
export const CAPTURE_WORKLET_PROCESSOR = "fitra-capture";

/**
 * The worklet is a separate module graph served as a static asset (never part
 * of the Vite bundle), so it is fetched by URL at runtime.
 */
export const CAPTURE_WORKLET_URL = "/worklets/capture.worklet.js";

/** Query flag that swaps the microphone for synthetic PCM (T-016). */
export const INJECT_AUDIO_PARAM = "injectAudio";

/* -------------------------------------------------------------------------- */
/* Pure helpers (unit-tested in web/tests/audio-pure.test.ts)                 */
/* -------------------------------------------------------------------------- */

export interface DownsampleState {
  readonly fromRate: number;
  readonly toRate: number;
  /** Input samples consumed per output sample (`fromRate / toRate`). */
  step: number;
  /** Next output read position, in absolute input samples. */
  position: number;
  /** Absolute index of the first sample of the next block. */
  offset: number;
  previous: number;
  hasPrevious: boolean;
}

export function createDownsampleState(
  fromRate: number,
  toRate: number,
): DownsampleState {
  if (!(fromRate > 0) || !(toRate > 0)) {
    throw new RangeError(`sample rates must be positive, got ${fromRate} → ${toRate}`);
  }
  return {
    fromRate,
    toRate,
    step: fromRate / toRate,
    position: 0,
    offset: 0,
    previous: 0,
    hasPrevious: false,
  };
}

/**
 * Linear-interpolating decimator with a phase accumulator that lives in
 * `state`, so a block boundary cannot introduce a phase jump. Mirrors the
 * worklet's fallback path; writes into `out` at `offset` and returns how many
 * samples were written (output is truncated, never wrapped, if `out` is full).
 */
export function downsampleLinear(
  input: Float32Array,
  state: DownsampleState,
  out: Float32Array,
  offset = 0,
): number {
  let written = 0;
  for (let i = 0; i < input.length; i += 1) {
    const index = state.offset + i;
    const raw = input[i];
    const current = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    const previous = state.hasPrevious ? state.previous : current;
    while (state.position <= index) {
      if (offset + written >= out.length) {
        state.offset += input.length;
        return written;
      }
      const fraction = state.position - (index - 1);
      const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
      out[offset + written] = previous + (current - previous) * clamped;
      written += 1;
      state.position += state.step;
    }
    state.previous = current;
    state.hasPrevious = true;
  }
  state.offset += input.length;
  return written;
}

/**
 * Float samples in [-1, 1] → PCM16LE mono bytes. Clamps **before** scaling,
 * rounds to nearest, maps non-finite samples to 0, and scales by
 * {@link CAPTURE_PCM16_SCALE}. Pass `out` to reuse a buffer (zero-alloc loops).
 */
export function framePack(samples: Float32Array, out?: Uint8Array): Uint8Array {
  const needed = samples.length * 2;
  const target = out ?? new Uint8Array(needed);
  if (target.length < needed) {
    throw new RangeError(`output buffer holds ${target.length} bytes, need ${needed}`);
  }
  const view = new DataView(target.buffer, target.byteOffset, needed);
  for (let i = 0; i < samples.length; i += 1) {
    const raw = samples[i];
    let sample = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (sample > 1) {
      sample = 1;
    } else if (sample < -1) {
      sample = -1;
    }
    const scaled = sample * CAPTURE_PCM16_SCALE;
    // Round half away from zero, not Math.round: the latter maps +0.5 LSB to
    // +8192 and -0.5 LSB to -8191, a 1-LSB asymmetry (a small DC offset).
    const value = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
    view.setInt16(i * 2, value, true);
  }
  return needed === target.length ? target : target.subarray(0, needed);
}

/** Fill `out` with a sine starting at absolute sample `startSample`. */
export function writeSine(
  out: Float32Array,
  startSample: number,
  frequencyHz: number,
  amplitude: number,
  sampleRateHz: number,
): void {
  for (let i = 0; i < out.length; i += 1) {
    const phase = (2 * Math.PI * frequencyHz * (startSample + i)) / sampleRateHz;
    out[i] = amplitude * Math.sin(phase);
  }
}

/* -------------------------------------------------------------------------- */
/* Uplink sender                                                               */
/* -------------------------------------------------------------------------- */

/** The slice of `WebSocket` this module needs (also satisfied by test fakes). */
export interface FrameSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: ArrayBufferView): void;
}

const SOCKET_OPEN = 1;

export interface CaptureStats {
  readonly framesSent: number;
  readonly framesDropped: number;
  readonly bufferedBytes: number;
  readonly speakerIndex: number;
}

/**
 * Turns PCM16LE payloads into wire frames: header (ver `0x01`, type `0x01`,
 * per-sender `seq`, server-assigned `speaker`) + payload, and applies
 * backpressure. Transport-agnostic on purpose — a fake object with
 * `readyState`/`bufferedAmount`/`send` is enough to unit-test it.
 */
export class AudioFrameSender {
  private socket: FrameSocket | null;
  private speaker = 0;
  private seq = 0;
  private framesSentCount = 0;
  private framesDroppedCount = 0;

  constructor(socket: FrameSocket | null) {
    this.socket = socket;
  }

  /** Speaker index from the server `welcome` message (participantIndex). */
  setSpeakerIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 0xffff) {
      throw new RangeError(`speaker index must be an integer in [0, 65535], got ${index}`);
    }
    this.speaker = index;
  }

  get speakerIndex(): number {
    return this.speaker;
  }

  /** Swap the socket on reconnect (T-012 owns the reconnect policy). */
  setSocket(socket: FrameSocket | null): void {
    this.socket = socket;
  }

  /** Returns false when the frame was dropped instead of sent. */
  sendPcm16le(payload: Uint8Array): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      this.framesDroppedCount += 1;
      return false;
    }
    if (socket.bufferedAmount > CAPTURE_BACKPRESSURE_BYTES) {
      this.framesDroppedCount += 1;
      return false;
    }
    try {
      socket.send(
        encodeAudioFrame({
          type: FITRA_AUDIO_TYPE_UPLINK,
          seq: this.seq,
          speaker: this.speaker,
          payload,
        }),
      );
    } catch {
      // Oversized payload (codec rejection) or a socket error mid-send: audio
      // is disposable, the frame goes away and the counter shows the gap.
      this.framesDroppedCount += 1;
      return false;
    }
    this.seq = nextAudioSeq(this.seq);
    this.framesSentCount += 1;
    return true;
  }

  get stats(): CaptureStats {
    return {
      framesSent: this.framesSentCount,
      framesDropped: this.framesDroppedCount,
      bufferedBytes: this.socket?.bufferedAmount ?? 0,
      speakerIndex: this.speaker,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Microphone capture                                                          */
/* -------------------------------------------------------------------------- */

export interface MicCaptureOptions {
  readonly sender: AudioFrameSender;
  /** Exact `deviceId`; omit for the browser default. */
  readonly deviceId?: string;
  readonly workletUrl?: string;
  readonly onNotice?: (notice: CaptureNotice) => void;
}

/**
 * Owns the mic stream, the capture `AudioContext` and the worklet node. The
 * caller (room shell, T-012/T-013) owns the socket and pushes the speaker index.
 */
export class MicCapture {
  private readonly sender: AudioFrameSender;
  private readonly workletUrl: string;
  private readonly onNotice: (notice: CaptureNotice) => void;
  private preferredDeviceId: string | undefined;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private inputs: MicInputDevice[] = [];
  private unwatchDevices: (() => void) | null = null;
  private releaseGesture: (() => void) | null = null;
  private stopped = false;

  constructor(options: MicCaptureOptions) {
    this.sender = options.sender;
    this.workletUrl = options.workletUrl ?? CAPTURE_WORKLET_URL;
    this.onNotice = options.onNotice ?? ((): void => undefined);
    this.preferredDeviceId = options.deviceId;
  }

  get stats(): CaptureStats {
    return this.sender.stats;
  }

  /** Real rate of the capture context; differs from 16 kHz only if the browser
   * refused the hint, in which case the worklet resamples. */
  get contextSampleRate(): number | null {
    return this.ctx?.sampleRate ?? null;
  }

  get inputDevices(): readonly MicInputDevice[] {
    return this.inputs;
  }

  get isRunning(): boolean {
    return this.ctx !== null && !this.stopped;
  }

  /** Delegate to the sender; kept here so the room shell has one handle. */
  setSpeakerIndex(index: number): void {
    this.sender.setSpeakerIndex(index);
  }

  /**
   * Open the mic and start producing frames. Must run inside a user gesture
   * (the `getUserMedia` permission prompt is one), otherwise the context stays
   * suspended until {@link armGestureResume} sees a gesture.
   */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error("MicCapture was stopped; create a new instance");
    }
    if (this.ctx !== null) {
      return;
    }
    const stream = await this.openStream();
    const ctx = new AudioContext({
      sampleRate: CAPTURE_SAMPLE_RATE_HZ,
      latencyHint: "interactive",
    });
    this.ctx = ctx;
    this.stream = stream;
    await ctx.audioWorklet.addModule(this.workletUrl);
    const node = new AudioWorkletNode(ctx, CAPTURE_WORKLET_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { frameSamples: CAPTURE_FRAME_SAMPLES },
    });
    node.port.onmessage = (event: MessageEvent<unknown>): void => {
      const payload = workletFramePayload(event);
      if (payload !== null) {
        this.sender.sendPcm16le(payload);
      }
    };
    const source = ctx.createMediaStreamSource(stream);
    // Deliberately no connection to ctx.destination: capture is never audible.
    source.connect(node);
    this.node = node;
    this.source = source;

    if (ctx.sampleRate !== CAPTURE_SAMPLE_RATE_HZ) {
      console.warn(
        `[fitra] capture context runs at ${ctx.sampleRate} Hz; the worklet resamples to ${CAPTURE_SAMPLE_RATE_HZ} Hz`,
      );
    }
    this.reportProcessing(stream);
    this.inputs = await listMicInputs().catch(() => this.inputs);
    this.unwatchDevices = watchDeviceChange((devices) => {
      void this.onDevicesChanged(devices);
    });
    this.releaseGesture = armGestureResume(ctx);
  }

  /** Resume the context from a click handler when the gesture policy requires it. */
  async resume(): Promise<boolean> {
    const ctx = this.ctx;
    if (ctx === null || contextRunning(ctx)) {
      return ctx !== null;
    }
    await ctx.resume();
    return contextRunning(ctx);
  }

  /** Refreshed input list (labels appear only after permission was granted). */
  async listInputs(): Promise<readonly MicInputDevice[]> {
    this.inputs = await listMicInputs().catch(() => this.inputs);
    return this.inputs;
  }

  /** Switch to another input by exact `deviceId`, reopening the stream only. */
  async selectDevice(deviceId: string | undefined): Promise<void> {
    this.preferredDeviceId = deviceId;
    if (this.ctx === null) {
      return;
    }
    await this.reopenStream();
  }

  /** Stop everything. Idempotent; the instance cannot be restarted. */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.unwatchDevices?.();
    this.unwatchDevices = null;
    this.releaseGesture?.();
    this.releaseGesture = null;
    this.node?.disconnect();
    this.node = null;
    this.source?.disconnect();
    this.source = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx !== null) {
      void ctx.close().catch(() => undefined);
    }
    disposeMediaStream(this.stream);
    this.stream = null;
  }

  private async openStream(): Promise<MediaStream> {
    try {
      return await openMicStream(this.preferredDeviceId, CAPTURE_SAMPLE_RATE_HZ);
    } catch (error) {
      if (isPermissionDenied(error)) {
        this.onNotice("mic-denied");
      }
      throw error;
    }
  }

  /** Reopen the stream for `preferredDeviceId`, keeping context and worklet. */
  private async reopenStream(): Promise<void> {
    const ctx = this.ctx;
    const node = this.node;
    if (ctx === null || node === null) {
      return;
    }
    const stream = await this.openStream();
    const source = ctx.createMediaStreamSource(stream);
    this.source?.disconnect();
    source.connect(node);
    this.source = source;
    disposeMediaStream(this.stream);
    this.stream = stream;
    this.reportProcessing(stream);
  }

  private onDevicesChanged(devices: readonly MicInputDevice[]): Promise<void> {
    this.inputs = [...devices];
    const activeTrack = this.stream?.getAudioTracks()[0];
    const activeDeviceId = activeTrack?.getSettings().deviceId;
    if (activeDeviceId === undefined || activeDeviceId === "") {
      return Promise.resolve();
    }
    if (devices.some((device) => device.deviceId === activeDeviceId)) {
      return Promise.resolve();
    }
    // The chosen input vanished (unplug / OS switch): keep the room live on the
    // default input and tell the UI why the label changed.
    const selection = selectDevice(devices, undefined);
    this.preferredDeviceId = selection.deviceId;
    this.onNotice("mic-device-lost");
    return this.reopenStream().catch(() => {
      this.stop();
    });
  }

  private reportProcessing(stream: MediaStream): void {
    const track = stream.getAudioTracks()[0];
    if (track === undefined) {
      return;
    }
    if (!processingEnabled(readProcessingSettings(track))) {
      console.warn(
        "[fitra] echo cancellation / noise suppression / AGC not all applied; check browser settings",
      );
    }
  }
}

/**
 * `ctx.state` read through a call, because TS keeps the pre-`await` narrowing
 * of a property across the `resume()` await.
 */
function contextRunning(ctx: AudioContext): boolean {
  return ctx.state === "running";
}

/** Narrow a worklet `MessageEvent` to PCM bytes, or null when malformed. */
function workletFramePayload(event: MessageEvent<unknown>): Uint8Array | null {
  const data = event.data;
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const message = data as { readonly type?: unknown; readonly pcm?: unknown };
  if (message.type !== "frame" || !(message.pcm instanceof ArrayBuffer)) {
    return null;
  }
  return new Uint8Array(message.pcm);
}

/* -------------------------------------------------------------------------- */
/* Test seam: synthetic PCM straight to the sender (T-016 / OQ-10)             */
/* -------------------------------------------------------------------------- */

export interface AudioInjectorOptions {
  readonly sender: AudioFrameSender;
  readonly frequencyHz?: number;
  readonly amplitude?: number;
  /** Synthetic input rate; anything but 16 kHz exercises the resampler. */
  readonly sourceRateHz?: number;
  readonly frameMs?: number;
  /** Delay before the first frame, so the socket can finish opening. */
  readonly startDelayMs?: number;
}

export interface AudioInjector {
  readonly isRunning: boolean;
  readonly framesSent: number;
  start(): void;
  stop(): void;
}

/** True when the URL asks for injected audio (`?injectAudio=1`). */
export function injectAudioRequested(search: string): boolean {
  return new URLSearchParams(search).get(INJECT_AUDIO_PARAM) === "1";
}

/**
 * Synthetic 100 ms sine frames on a timer, fed straight to the sender — no
 * `getUserMedia`, no `AudioContext`, so E2E works headless with no fake device.
 * Buffers are allocated once and reused; only `framePack` re-runs per frame.
 */
export function createAudioInjector(options: AudioInjectorOptions): AudioInjector {
  const frequencyHz = options.frequencyHz ?? 440;
  const amplitude = options.amplitude ?? 0.2;
  const sourceRateHz = options.sourceRateHz ?? CAPTURE_SAMPLE_RATE_HZ;
  const frameMs = options.frameMs ?? CAPTURE_FRAME_MS;
  const startDelayMs = options.startDelayMs ?? 1000;
  const sourceSamples = Math.max(1, Math.round((sourceRateHz * frameMs) / 1000));
  const targetSamples = Math.max(
    1,
    Math.round((CAPTURE_SAMPLE_RATE_HZ * frameMs) / 1000),
  );
  const needsResample = sourceRateHz !== CAPTURE_SAMPLE_RATE_HZ;
  const raw = new Float32Array(sourceSamples);
  const resampled = new Float32Array(needsResample ? targetSamples + 2 : 0);
  const state = needsResample
    ? createDownsampleState(sourceRateHz, CAPTURE_SAMPLE_RATE_HZ)
    : null;
  const pcm = new Uint8Array(targetSamples * 2);

  let timer: ReturnType<typeof setInterval> | null = null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let sampleCursor = 0;
  let framesSent = 0;

  const tick = (): void => {
    writeSine(raw, sampleCursor, frequencyHz, amplitude, sourceRateHz);
    sampleCursor += sourceSamples;
    if (state !== null) {
      downsampleLinear(raw, state, resampled, 0);
    }
    // `subarray`: the resampler may overshoot the target count by a sample or two.
    const samples = state === null ? raw : resampled.subarray(0, targetSamples);
    if (options.sender.sendPcm16le(framePack(samples, pcm))) {
      framesSent += 1;
    }
  };

  return {
    get isRunning(): boolean {
      return timer !== null || startTimer !== null;
    },
    get framesSent(): number {
      return framesSent;
    },
    start(): void {
      if (this.isRunning) {
        return;
      }
      startTimer = setTimeout(() => {
        startTimer = null;
        timer = setInterval(tick, frameMs);
        tick();
      }, startDelayMs);
    },
    stop(): void {
      if (startTimer !== null) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** Test/E2E surface published on `window` while injected audio is active. */
export interface CaptureTestHooks {
  readonly mode: "injected";
  readonly stats: CaptureStats;
  setSpeakerIndex(index: number): void;
  stop(): void;
}

declare global {
  interface Window {
    __fitraCapture?: CaptureTestHooks;
  }
}

/**
 * Start the injection seam when the URL asks for it, and publish
 * `window.__fitraCapture`. Returns `null` when injection was not requested, so
 * the caller falls through to the real microphone.
 */
export function maybeStartInjectedCapture(
  sender: AudioFrameSender,
  search: string = window.location.search,
  injectorOptions: Omit<AudioInjectorOptions, "sender"> = {},
): AudioInjector | null {
  if (!injectAudioRequested(search)) {
    return null;
  }
  const injector = createAudioInjector({ ...injectorOptions, sender });
  const hooks: CaptureTestHooks = {
    mode: "injected",
    get stats(): CaptureStats {
      return sender.stats;
    },
    setSpeakerIndex: (index: number): void => {
      sender.setSpeakerIndex(index);
    },
    stop: (): void => {
      injector.stop();
    },
  };
  window.__fitraCapture = hooks;
  injector.start();
  return injector;
}