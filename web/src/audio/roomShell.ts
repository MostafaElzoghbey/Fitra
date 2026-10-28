// T-016: room audio shell — the ONLY place the room socket meets the audio
// path. Wires `RoomSocket.sendAudio`/`onAudio` to `AudioFrameSender` (uplink,
// T-010) and `PlaybackScheduler` (downlink, T-011), registers the latency stats
// reader (T-012), honours `?injectAudio=1` (synthetic sine via the capture seam,
// OQ-10), and calls `interrupt()` when the floor moves away from this tab.
//
// Floor discipline (docs/FLOOR-CONTROL.md, server-authoritative): unmute sends
// `speaking-start` (teacher preempts; a student without a grant gets a
// `not-your-floor` error rendered by Room), mute sends `speaking-stop`. Audio
// frames from a non-holder are dropped server-side, so starting/stopping the
// local source on the same gesture keeps the wire clean. Memory only
// (AGENTS.md rule 2); no persistence, no secrets, no translation-SDK imports.

import { decodeAudioFrame, type FloorHolder } from "@fitra/shared";
import type { RoomSocket } from "../net/socket.js";
import { floorLost } from "./floorGate.js";
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
import {
  downlinkPacketFromFrame,
  PlaybackScheduler,
  type PlaybackPacket,
  type PlaybackStats,
} from "./playback.js";

export interface RoomAudioOptions {
  readonly onMicError?: (notice: CaptureNotice) => void;
}

export interface RoomAudioHandle {
  /** Wire to `RoomProps.onMicToggle`: false = unmuted/speaking, true = muted. */
  setMuted(muted: boolean): void;
  dispose(): void;
}

/** Subset of PlaybackScheduler used here; the null fallback matches it. */
interface PlaybackSink {
  pushPacket(packet: PlaybackPacket): void;
  interrupt(): void;
  dispose(): void;
  readonly stats: PlaybackStats;
}

/** Headless-safe fallback: counts frames so latency/metrics keep working. */
class NullPlayback implements PlaybackSink {
  private framesPlayedCount = 0;

  pushPacket(packet: PlaybackPacket): void {
    if (packet.pcm24k.length > 0) this.framesPlayedCount += 1;
  }

  interrupt(): void {
    return undefined;
  }

  dispose(): void {
    return undefined;
  }

  get stats(): PlaybackStats {
    return {
      framesPlayed: this.framesPlayedCount,
      gaps: 0,
      overruns: 0,
      underruns: 0,
      bufferedMs: 0,
    };
  }
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

function createSink(): PlaybackSink {
  try {
    return new PlaybackScheduler(new AudioContext());
  } catch {
    return new NullPlayback();
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
  const sink = createSink();
  let selfId: string | null = null;
  let lastFloor: FloorHolder | null = null;
  let role: "teacher" | "student" = "student";
  let receivedCount = 0;
  let injector: AudioInjector | null = null;
  let mic: MicCapture | null = null;
  let disposed = false;

  setLatencyStatsReader({
    captureStats: () => sender.stats,
    playbackStats: () => sink.stats,
  });

  window.__fitraAudio = {
    pid: () => selfId,
    sent: () => sender.stats.framesSent,
    received: () => receivedCount,
    played: () => sink.stats.framesPlayed,
  };

  const offServer = socket.onServer((msg) => {
    if (disposed) return;
    if (msg.t === "welcome") {
      selfId = msg.participantId;
      lastFloor = msg.floor;
      sender.setSpeakerIndex(msg.participantIndex);
      return;
    }
    if (msg.t === "floor-changed") {
      if (floorLost(lastFloor, msg.floor, role, selfId)) sink.interrupt();
      lastFloor = msg.floor;
    }
  });
  // Role arrives via the room route, not the wire: infer it from the roster
  // row that matches our own join (welcome carries the full roster).
  const offServerRole = socket.onServer((msg) => {
    if (msg.t !== "welcome") return;
    const self = msg.roster.find((e) => e.participantId === msg.participantId);
    if (self !== undefined) role = self.role;
  });

  const offAudio = socket.onAudio((frame) => {
    receivedCount += 1;
    try {
      sink.pushPacket(downlinkPacketFromFrame(decodeAudioFrame(new Uint8Array(frame))));
    } catch {
      // Malformed downlink: drop it; the gap counter shows the loss.
    }
  });

  function startSource(): void {
    if (injectAudioRequested(window.location.search)) {
      if (injector === null) {
        injector = createAudioInjector({ sender, startDelayMs: 500 });
      }
      injector.start();
      return;
    }
    if (mic === null) {
      mic = new MicCapture({
        sender,
        onNotice: (notice) => options.onMicError?.(notice),
      });
      void mic.start().catch(() => undefined);
    } else {
      sender.setSocket(adapter);
      void mic.resume().catch(() => undefined);
    }
  }

  function stopSource(): void {
    injector?.stop();
    if (mic !== null) sender.setSocket(null);
  }

  return {
    setMuted(muted: boolean): void {
      if (disposed) return;
      if (muted) {
        socket.send({ t: "speaking-stop" });
        stopSource();
      } else {
        socket.send({ t: "speaking-start" });
        startSource();
      }
    },
    dispose(): void {
      disposed = true;
      injector?.stop();
      injector = null;
      if (mic !== null) {
        sender.setSocket(null);
        mic.stop();
        mic = null;
      }
      offServer();
      offServerRole();
      offAudio();
      setLatencyStatsReader(null);
      sink.dispose();
      if (window.__fitraAudio !== undefined) delete window.__fitraAudio;
    },
  };
}
