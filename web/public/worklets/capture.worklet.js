/**
 * T-010 — uplink capture processor. Plain JS, loaded at runtime with
 * `ctx.audioWorklet.addModule('/worklets/capture.worklet.js')`.
 *
 * It lives in `public/` on purpose: it is a separate module graph, never part
 * of the Vite bundle (no TS import graph, no minification of the audio thread
 * code), and it is fetched once per session and cached by the browser.
 *
 * Contract with the main thread (`web/src/audio/capture.ts`):
 *   in : inputs[0][0] only — mono float samples in [-1, 1].
 *        The render quantum is whatever the browser picks (128 is common but
 *        NOT guaranteed), so this processor only ever counts samples and never
 *        assumes a quantum size.
 *   out: `{ type: "frame", pcm: ArrayBuffer }` messages, one per full frame,
 *        1600 samples (100 ms @ 16 kHz) of PCM16LE mono, transferred (not
 *        copied) to the main thread. No message when a frame is incomplete.
 *
 * DSP rules (see docs/LIMITS.md §2 — Gemini wants raw PCM16LE 16 kHz mono in
 * 100 ms chunks):
 *   - NaN/Inf guard: a single non-finite sample becomes 0 instead of poisoning
 *     the whole 100 ms chunk (NaN survives int16 conversion as garbage).
 *   - clamp to [-1, 1] THEN *32767 (never 32768: 32768 does not fit in int16
 *     and wraps to -32768, i.e. a full-scale click).
 *   - no allocation and no await inside process(): the frame buffer is
 *     preallocated and handed over (detached) each time a new one is allocated
 *     lazily at most once per frame, i.e. 10 tiny arrays per second.
 *   - resampling: the main thread asks for `new AudioContext({sampleRate:
 *     16000})`. Browsers honour that on desktop, but not everywhere; when the
 *     real rate differs, a linear-interpolating decimator with a phase
 *     accumulator that survives across process() calls runs first, so the wire
 *     stays 16 kHz either way.
 *
 * The same clamp/scale/resample contract is mirrored by the pure helpers in
 * `web/src/audio/capture.ts` (`framePack`, `downsampleLinear`) and pinned by
 * `web/tests/audio-pure.test.ts` — keep the two in sync.
 */

const PROCESSOR_NAME = "fitra-capture";
const TARGET_SAMPLE_RATE_HZ = 16000;
const FRAME_SAMPLES = 1600; // 100 ms @ 16 kHz
const PCM16_SCALE = 32767; // NOT 32768 (int16 overflow at full scale)

/** Non-finite -> 0, clamped to [-1, 1]. */
function sanitize(sample) {
  if (typeof sample !== "number" || !isFinite(sample)) {
    return 0;
  }
  if (sample > 1) {
    return 1;
  }
  if (sample < -1) {
    return -1;
  }
  return sample;
}

class FitraCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions =
      options && options.processorOptions ? options.processorOptions : {};
    const requestedFrameSamples = processorOptions.frameSamples;
    this.frameSamples =
      typeof requestedFrameSamples === "number" && requestedFrameSamples > 0
        ? Math.floor(requestedFrameSamples)
        : FRAME_SAMPLES;

    // Rate ratio is a per-processor constant: `sampleRate` is the AudioContext
    // rate and is fixed for the lifetime of the node.
    this.ratio = sampleRate / TARGET_SAMPLE_RATE_HZ;
    this.resampling = Math.abs(this.ratio - 1) > 1e-9;

    this.frame = new Int16Array(this.frameSamples);
    this.frameIndex = 0;
    this.framesEmitted = 0;

    // Resampler state, carried across process() calls.
    this.position = 0; // next output read position, absolute input samples
    this.offset = 0; // absolute index of the first sample of this quantum
    this.previous = 0; // last input sample of the previous quantum
    this.hasPrevious = false;

    this.port.onmessage = (event) => {
      if (event && event.data && event.data.type === "reset") {
        // Floor revoke / reconnect: drop the partial frame, keep buffers.
        this.frameIndex = 0;
      }
    };
  }

  /** Append one float sample (already sanitized) to the pending frame. */
  writeSample(sample) {
    const scaled = sample * PCM16_SCALE;
    // Round half away from zero (Math.round is asymmetric at -0.5 LSB).
    const value = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
    this.frame[this.frameIndex] = value;
    this.frameIndex += 1;
    if (this.frameIndex >= this.frameSamples) {
      const payload = this.frame;
      this.frame = new Int16Array(this.frameSamples);
      this.frameIndex = 0;
      this.framesEmitted += 1;
      // Transfer the buffer: zero-copy to the main thread.
      this.port.postMessage({ type: "frame", pcm: payload.buffer }, [payload.buffer]);
    }
  }

  /** Straight path: context already runs at 16 kHz. */
  accumulate(input) {
    for (let i = 0; i < input.length; i += 1) {
      this.writeSample(sanitize(input[i]));
    }
  }

  /**
   * Fallback path: linear interpolation at the fractional `position`.
   * For every input sample we emit every output position that falls inside
   * [prev, cur], so a 48 kHz stream yields exactly one output per 3 samples and
   * a 44.1 kHz stream alternates 2/3-sample gaps without drift. `position` and
   * `offset` are absolute input-sample counters, so splitting or growing the
   * input buffer across process() calls cannot introduce a phase jump.
   */
  accumulateResampled(input) {
    const step = this.ratio;
    for (let i = 0; i < input.length; i += 1) {
      const index = this.offset + i;
      const current = sanitize(input[i]);
      const previous = this.hasPrevious ? this.previous : current;
      while (this.position <= index) {
        const fraction = this.position - (index - 1);
        const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
        this.writeSample(previous + (current - previous) * clamped);
        this.position += step;
      }
      this.previous = current;
      this.hasPrevious = true;
    }
    this.offset += input.length;
  }

  process(inputs) {
    const channel = inputs[0] ? inputs[0][0] : undefined;
    if (channel === undefined || channel.length === 0) {
      return true; // no input wired yet (or muted): stay alive
    }
    if (this.resampling) {
      this.accumulateResampled(channel);
    } else {
      this.accumulate(channel);
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, FitraCaptureProcessor);