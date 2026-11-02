import { afterEach, describe, expect, it, vi } from "vitest";
import {
  micConstraints,
  openMicStream,
  readProcessingSettings,
} from "../src/audio/devices.js";

type AudioConstraints = MediaTrackConstraints & { voiceIsolation?: boolean };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("microphone constraints", () => {
  it("requests voice isolation together with EC/NS/AGC", () => {
    const constraints = micConstraints("dev-1", 16000);
    expect(constraints.voiceIsolation).toBe(true);
    expect(constraints.echoCancellation).toBe(true);
    expect(constraints.noiseSuppression).toBe(true);
    expect(constraints.autoGainControl).toBe(true);
    expect(constraints.deviceId).toEqual({ exact: "dev-1" });
  });

  it("falls back without voice isolation when the browser rejects it", async () => {
    const calls: MediaStreamConstraints[] = [];
    const stream = {} as MediaStream;
    const getUserMedia = vi.fn((constraints: MediaStreamConstraints) => {
      calls.push(constraints);
      if (calls.length === 1) {
        return Promise.reject(new DOMException("unsupported", "OverconstrainedError"));
      }
      return Promise.resolve(stream);
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openMicStream(undefined, 16000)).resolves.toBe(stream);
    expect(calls).toHaveLength(2);
    expect((calls[0]?.audio as AudioConstraints).voiceIsolation).toBe(true);
    expect((calls[1]?.audio as AudioConstraints).voiceIsolation).toBeUndefined();
  });
});

describe("readProcessingSettings", () => {
  it("reports voice isolation only when the applied settings say so", () => {
    const withIsolation = {
      getSettings: () => ({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        voiceIsolation: true,
      }),
    } as unknown as MediaStreamTrack;
    expect(readProcessingSettings(withIsolation)).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
    });

    const withoutIsolation = {
      getSettings: () => ({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }),
    } as unknown as MediaStreamTrack;
    expect(readProcessingSettings(withoutIsolation).voiceIsolation).toBe(false);
  });
});
