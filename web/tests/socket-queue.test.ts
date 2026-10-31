// Regression (Oracle S5): control frames sent while the handshake was still
// connecting were silently dropped — the mic-open right after `connectRoom`
// would lose that race and the user stays unheard until they toggle again.
// Control frames must queue until open; binary audio must never queue.
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectRoom } from "../src/net/socket.js";

type Listener = (ev: unknown) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  binaryType = "";
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: Array<string | ArrayBuffer> = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("send on a non-open fake socket");
    }
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {}

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners.get("open") ?? []) listener(null);
  }
}

function installSocket(): {
  readonly ws: FakeWebSocket;
  readonly sock: ReturnType<typeof connectRoom>;
} {
  const sockets: FakeWebSocket[] = [];
  class Tracked extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Tracked);
  const sock = connectRoom("ws://example.invalid/rooms/r1/ws", "tok");
  const ws = sockets[0];
  if (ws === undefined) throw new Error("socket was not constructed");
  return { ws, sock };
}

describe("RoomSocket: control queue on the connecting socket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("control sent while CONNECTING is queued, then flushed in order on open", () => {
    const { ws, sock } = installSocket();

    sock.send({ t: "ping", id: 1 });
    sock.send({ t: "mic-open" });
    expect(ws.sent).toEqual([]);

    ws.fireOpen();
    expect(JSON.parse(String(ws.sent[0]))).toEqual({ t: "ping", id: 1 });
    expect(JSON.parse(String(ws.sent[1]))).toEqual({ t: "mic-open" });
    expect(ws.sent).toHaveLength(2);
  });

  it("audio frames are not queued pre-open, and closed-socket control is dropped", () => {
    const { ws, sock } = installSocket();

    sock.sendAudio(new ArrayBuffer(8));
    expect(ws.sent).toEqual([]);

    ws.fireOpen();
    sock.sendAudio(new ArrayBuffer(8));
    expect(ws.sent).toHaveLength(1);

    ws.readyState = FakeWebSocket.CLOSED;
    sock.send({ t: "ping", id: 2 });
    expect(ws.sent).toHaveLength(1);
  });
});
