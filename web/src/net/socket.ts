// T-013: room WebSocket transport. Real `WebSocket`, no mock — T-010 (capture),
// T-011 (playback) and T-012 (metrics) attach to the callbacks exposed here.
//
// Binary frames are audio (docs/PROTOCOL.md section 2); text frames are JSON
// control messages and are validated with the shared `isServerMsg` guard before
// they ever reach React state (never trust the wire).

import { isServerMsg, type ClientMsg, type ServerMsg } from "@fitra/shared";

export interface SocketCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export type Unsubscribe = () => void;

export interface RoomSocket {
  /** JSON control channel (text frame). */
  send(msg: ClientMsg): void;
  /** Binary audio uplink. Consumed by T-010. */
  sendAudio(frame: ArrayBuffer): void;
  /** Validated inbound control messages. */
  onServer(listener: (msg: ServerMsg) => void): Unsubscribe;
  /** Inbound binary audio frames. Consumed by T-011. */
  onAudio(listener: (frame: ArrayBuffer) => void): Unsubscribe;
  onClose(listener: (info: SocketCloseInfo) => void): Unsubscribe;
  /** Fires once for every text frame that failed `isServerMsg`. */
  onProtocolViolation(listener: (raw: string) => void): Unsubscribe;
  close(): void;
}

export function connectRoom(url: string, token: string, name = ""): RoomSocket {
  const query = `token=${encodeURIComponent(token)}`;
  // PROTOCOL.md section 1: the join token carries no name, so the display name
  // travels next to it and the DO falls back to `pid` when it is absent.
  const named = name === "" ? "" : `&name=${encodeURIComponent(name)}`;
  const socket = new WebSocket(`${url}${url.includes("?") ? "&" : "?"}${query}${named}`);
  socket.binaryType = "arraybuffer";

  const serverListeners = new Set<(msg: ServerMsg) => void>();
  const audioListeners = new Set<(frame: ArrayBuffer) => void>();
  const closeListeners = new Set<(info: SocketCloseInfo) => void>();
  const violationListeners = new Set<(raw: string) => void>();

  function dispatch<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
    for (const listener of listeners) listener(value);
  }

  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        dispatch<string>(violationListeners, event.data);
        return;
      }
      if (!isServerMsg(parsed)) {
        dispatch<string>(violationListeners, event.data);
        return;
      }
      dispatch<ServerMsg>(serverListeners, parsed);
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      dispatch<ArrayBuffer>(audioListeners, event.data);
    }
  });

  socket.addEventListener("close", (event: CloseEvent) => {
    dispatch<SocketCloseInfo>(closeListeners, {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
  });

  return {
    send(msg: ClientMsg): void {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(msg));
    },
    sendAudio(frame: ArrayBuffer): void {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(frame);
    },
    onServer(listener) {
      serverListeners.add(listener);
      return () => serverListeners.delete(listener);
    },
    onAudio(listener) {
      audioListeners.add(listener);
      return () => audioListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onProtocolViolation(listener) {
      violationListeners.add(listener);
      return () => violationListeners.delete(listener);
    },
    close(): void {
      socket.close(1000, "client-leave");
    },
  };
}

export function roomSocketUrl(code: string, origin: string): string {
  return `${origin.replace(/^http/, "ws")}/rooms/${encodeURIComponent(code)}/ws`;
}