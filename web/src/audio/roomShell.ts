// T-016: room audio shell — the ONLY place the room socket meets the audio
// path. Wires `RoomSocket.sendAudio`/`onAudio` to `AudioFrameSender` (uplink,
// T-010) and the per-speaker `SpeakerMixer` (downlink, T-011), registers the
// latency stats reader (T-012), honours `?injectAudio=1` (synthetic sine via
// the capture seam, OQ-10), and applies mic semantics (docs/MIC-CONTROL.md).
//
// Mic control is server-authoritative: `openMic`/`closeMic` send
// `mic-open`/`mic-close` and start/stop the local capture on the same gesture.
// A server `mic-changed` with `micOpen:false` for THIS participant stops the
// source without echoing a control frame. Playback is NEVER interrupted on mic
// or roster changes (PROTOCOL §3.1) — each pipe drains on the audio clock;
// mixer streams whose speaker left the roster are pruned by stable index.
// Memory only (AGENTS.md rule 2); no persistence, no secrets, no
// translation-SDK imports.

import { decodeAudioFrame } from "@fitra/shared";
import type { RoomSocket } from "../net/socket.js";
import {
  AudioFrameSender,
  createAudioInjector,
  injectAudioRequested,
  MicCapture,
  type AudioInjector,
  type FrameSocket,
} from "./capture.js";
import type { CaptureNotice } from "./devices.js";
import { setLatencyStatsReader } from "./latency.js";
import { createMixer } from "./playback.js";

export interface RoomAudioOptions {
  readonly onMicError?: (notice: CaptureNotice) => void;
}

export interface RoomAudioHandle {
  openMic(): void;
  closeMic(): void;
  dispose(): void;
}

/** E2E surface: live counters polled by `e2e/m0-flow.spec.ts` (T-016). */
export interface RoomAudioTestHooks {
  pid(): string | null;
  sent(): number;
  received(): number;
  played(): number;
}

declare global {
  interface Window {
    __fitraAudio?: RoomAudioTestHooks;
  }
}

export function attachRoomAudio(
  socket: RoomSocket,
  options: RoomAudioOptions = {},
): RoomAudioHandle {
  const adapter: FrameSocket = {
    get readyState(): number {
      // RoomSocket already guards closed sockets in sendAudio; report open so
      // the sender encodes (a pre-open frame is dropped, never queued).
      return 1;
    },
    get bufferedAmount(): number {
      return 0;
    },
    send(data: ArrayBufferView): void {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      socket.sendAudio(bytes.buffer.slice(0) as ArrayBuffer);
    },
  };
  const sender = new AudioFrameSender(adapter);
  const mixer = createMixer();
  let selfId: string | null = null;
  let receivedCount = 0;
  let injector: AudioInjector | null = null;
  let mic: MicCapture | null = null;
  let micEpoch = 0;
  let controlGen = 0;
  let controlQueue: Promise<void> = Promise.resolve();
  let disposed = false;

  setLatencyStatsReader({
    captureStats: () => sender.stats,
    playbackStats: () => mixer.stats,
  });

  window.__fitraAudio = {
    pid: () => selfId,
    sent: () => sender.stats.framesSent,
    received: () => receivedCount,
    played: () => mixer.stats.framesPlayed,
  };

  const offServer = socket.onServer((msg) => {
    if (disposed) return;
    if (msg.t === "welcome") {
      selfId = msg.participantId;
      sender.setSpeakerIndex(msg.participantIndex);
      // Roster indexes are stable and never reused (PROTOCOL §3.2): dropping
      // streams whose speaker is gone keeps rejoin churn from accumulating.
      mixer.prune(new Set(msg.roster.map((entry) => entry.participantIndex)));
      return;
    }
    if (msg.t === "mic-changed" && msg.participantId === selfId && !msg.micOpen) {
      // Server-authoritative cut (teacher mute / mute-all): stop the local
      // source; the wire already knows, so no control frame is echoed.
      controlGen += 1;
      stopSource();
    }
  });

  const offAudio = socket.onAudio((frame) => {
    receivedCount += 1;
    try {
      mixer.demux(decodeAudioFrame(new Uint8Array(frame)));
    } catch {
      // Malformed downlink: drop it; the gap counter shows the loss.
    }
  });

  function enqueue(gen: number, task: () => Promise<void>): void {
    controlQueue = controlQueue
      .then(() => {
        if (gen !== controlGen || disposed) return;
        return task();
      })
      .catch(() => undefined);
  }

  async function startSource(): Promise<void> {
    sender.setSocket(adapter);
    if (mic !== null) {
      mic.stop();
      mic = null;
    }
    if (injectAudioRequested(window.location.search)) {
      if (injector === null) {
        injector = createAudioInjector({ sender, startDelayMs: 500 });
      }
      injector.start();
      return;
    }
    const capture = new MicCapture({
      sender,
      onNotice: (notice) => options.onMicError?.(notice),
    });
    mic = capture;
    try {
      await capture.start();
    } catch (error) {
      if (mic === capture) mic = null;
      capture.stop();
      throw error;
    }
  }

  function stopSource(): void {
    injector?.stop();
    sender.setSocket(null);
    if (mic !== null) {
      mic.stop();
      mic = null;
    }
  }

  async function flushAndStopSource(): Promise<void> {
    injector?.stop();
    const capture = mic;
    mic = null;
    if (capture === null) {
      sender.setSocket(null);
      return;
    }
    await capture.flush().catch(() => undefined);
    sender.setSocket(null);
    capture.stop();
  }

  return {
    openMic(): void {
      if (disposed) return;
      const gen = ++controlGen;
      micEpoch = (micEpoch + 1) % 65536;
      const epoch = micEpoch;
      enqueue(gen, async () => {
        sender.setEpoch(epoch);
        socket.send({ t: "mic-open", epoch });
        await startSource();
      });
    },
    closeMic(): void {
      if (disposed) return;
      const gen = ++controlGen;
      const epoch = micEpoch;
      enqueue(gen, async () => {
        await flushAndStopSource();
        if (!disposed) socket.send({ t: "mic-close", epoch });
      });
    },
    dispose(): void {
      disposed = true;
      controlGen += 1;
      injector?.stop();
      injector = null;
      if (mic !== null) {
        sender.setSocket(null);
        mic.stop();
        mic = null;
      }
      offServer();
      offAudio();
      setLatencyStatsReader(null);
      mixer.dispose();
      if (window.__fitraAudio !== undefined) delete window.__fitraAudio;
    },
  };
}
