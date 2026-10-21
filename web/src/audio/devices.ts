/**
 * T-010 — microphone device plumbing for the capture path.
 *
 * Owns everything that touches `navigator.mediaDevices`:
 *   - `getUserMedia` constraints (mono, 16 kHz ideal, echo cancellation /
 *     noise suppression / AGC all ON, exact `deviceId` when one is chosen),
 *   - `enumerateDevices()` **after** permission, because labels and `deviceId`s
 *     are only populated once the user allowed the microphone,
 *   - `devicechange` handling with fallback to the default input,
 *   - verification through `MediaTrackSettings.getSettings()` (the constraint is
 *     a request; the applied result is what actually runs),
 *   - autoplay-gesture resume of the `AudioContext`.
 *
 * Pure of any UI: T-013 renders notices through {@link captureNoticeKey}, this
 * module only reports them via the `onNotice` callbacks it is handed.
 */

import type { UiStrings } from "../i18n.js";

/** User-facing capture problems, mapped to i18n by {@link captureNoticeKey}. */
export type CaptureNotice = "mic-denied" | "mic-device-lost";

export const CAPTURE_NOTICE_KEYS: Record<CaptureNotice, keyof UiStrings> = {
  "mic-denied": "micDeniedHint",
  "mic-device-lost": "micDeviceLostHint",
};

export function captureNoticeKey(notice: CaptureNotice): keyof UiStrings {
  return CAPTURE_NOTICE_KEYS[notice];
}

export interface MicInputDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface ProcessingSettings {
  readonly echoCancellation: boolean;
  readonly noiseSuppression: boolean;
  readonly autoGainControl: boolean;
}

export interface DeviceSelection {
  /** `undefined` means "let the browser pick the default input". */
  readonly deviceId: string | undefined;
  /** True when the requested device was gone and we fell back. */
  readonly fellBack: boolean;
}

/**
 * Capture constraints. `deviceId` is matched **exactly** (`{ exact }`), never by
 * prefix: `enumerateDevices()` ids are opaque and prefix matching picks the
 * wrong input when a device is renamed or re-plugged.
 */
export function micConstraints(
  deviceId: string | undefined,
  idealSampleRateHz: number,
): MediaTrackConstraints {
  return {
    ...(deviceId === undefined || deviceId === ""
      ? {}
      : { deviceId: { exact: deviceId } }),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: { ideal: idealSampleRateHz },
  };
}

/** True for the "user said no / blocked by policy" family of errors. */
export function isPermissionDenied(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    (error.name === "NotAllowedError" ||
      error.name === "PermissionDeniedError" ||
      error.name === "SecurityError")
  );
}

/** Ask for the microphone. Throws `DOMException` (denied, no device, in use…). */
export async function openMicStream(
  deviceId: string | undefined,
  idealSampleRateHz: number,
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: micConstraints(deviceId, idealSampleRateHz),
    video: false,
  });
}

/**
 * What the browser actually applied. `undefined` in `getSettings()` means the
 * constraint was not honoured, so it reads as `false` here.
 */
export function readProcessingSettings(track: MediaStreamTrack): ProcessingSettings {
  const settings = track.getSettings();
  return {
    echoCancellation: settings.echoCancellation === true,
    noiseSuppression: settings.noiseSuppression === true,
    autoGainControl: settings.autoGainControl === true,
  };
}

/** True when all three voice-processing constraints landed (SPEC FR-012). */
export function processingEnabled(settings: ProcessingSettings): boolean {
  return settings.echoCancellation && settings.noiseSuppression && settings.autoGainControl;
}

/**
 * Microphone inputs, in `enumerateDevices()` order. Call AFTER
 * `getUserMedia` — otherwise every label is `""` and `deviceId`s are useless.
 */
export async function listMicInputs(): Promise<MicInputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs: MicInputDevice[] = [];
  for (const device of devices) {
    if (device.kind !== "audioinput") {
      continue;
    }
    inputs.push({
      deviceId: device.deviceId,
      label: device.label === "" ? "(unlabeled input)" : device.label,
      isDefault: device.deviceId === "default",
    });
  }
  return inputs;
}

/**
 * Exact-match the preferred device, else the default input, else the first one.
 * A device that vanished (`devicechange`) lands here with `fellBack: true`.
 */
export function selectDevice(
  devices: readonly MicInputDevice[],
  preferredDeviceId: string | undefined,
): DeviceSelection {
  const requested = preferredDeviceId ?? "";
  if (requested !== "") {
    const exact = devices.find((device) => device.deviceId === requested);
    if (exact !== undefined) {
      return { deviceId: exact.deviceId, fellBack: false };
    }
  }
  const fallback = devices.find((device) => device.isDefault) ?? devices[0];
  if (fallback === undefined) {
    return { deviceId: undefined, fellBack: requested !== "" };
  }
  return {
    deviceId: fallback.deviceId,
    fellBack: requested !== "" && fallback.deviceId !== requested,
  };
}

/**
 * Subscribe to hot-plug / unplug. Returns an unsubscribe function. List changes
 * are pushed as a fresh snapshot; enumeration errors are swallowed (a revoked
 * permission must not break the room UI).
 */
export function watchDeviceChange(
  onChange: (devices: readonly MicInputDevice[]) => void,
): () => void {
  const mediaDevices: MediaDevices | undefined = navigator.mediaDevices;
  if (mediaDevices === undefined) {
    return (): void => undefined;
  }
  const handler = (): void => {
    void listMicInputs().then(
      (devices) => {
        onChange(devices);
      },
      () => undefined,
    );
  };
  mediaDevices.addEventListener("devicechange", handler);
  return (): void => {
    mediaDevices.removeEventListener("devicechange", handler);
  };
}

/**
 * Resume the capture context on the first user gesture (autoplay policy).
 * Listeners are one-shot and removed on success; a refused resume re-arms them
 * for the next gesture. Returns a disposer.
 */
export function armGestureResume(
  ctx: AudioContext,
  onResumed?: () => void,
): () => void {
  const target: EventTarget | undefined =
    typeof window === "undefined" ? undefined : window;
  if (target === undefined) {
    return (): void => undefined;
  }
  if (ctx.state === "running") {
    onResumed?.();
    return (): void => undefined;
  }
  const eventTypes = ["pointerdown", "keydown", "touchstart"];
  let armed = true;
  let disposed = false;
  const onGesture = (): void => {
    if (!armed || disposed) {
      return;
    }
    armed = false;
    for (const type of eventTypes) {
      target.removeEventListener(type, onGesture);
    }
    void ctx.resume().then(
      () => {
        onResumed?.();
      },
      () => {
        // Autoplay policy can refuse the first gesture; try again next time.
        armed = true;
        for (const type of eventTypes) {
          target.addEventListener(type, onGesture, { passive: true });
        }
      },
    );
  };
  for (const type of eventTypes) {
    target.addEventListener(type, onGesture, { passive: true });
  }
  return (): void => {
    disposed = true;
    armed = false;
    for (const type of eventTypes) {
      target.removeEventListener(type, onGesture);
    }
  };
}

/** Release every track; the mic indicator must go dark when leaving a room. */
export function disposeMediaStream(stream: MediaStream | null): void {
  if (stream === null) {
    return;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}