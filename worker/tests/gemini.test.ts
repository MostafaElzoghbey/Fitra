import { describe, expect, it } from "vitest";
import {
  buildGeminiSetup,
  encodeGeminiAudioFrame,
  GeminiTranslationProvider,
  handleGeminiServerText,
} from "../src/translation/gemini.js";
import type { GeminiSocket } from "../src/translation/gemini.js";
import type { TranslationSessionEvents } from "../src/translation/provider.js";

class FakeGeminiSocket implements GeminiSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code: 1000 });
  }

  addEventListener(
    type: "message" | "close" | "error" | "open",
    listener: (ev: unknown) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(
    type: "message" | "close" | "error" | "open",
    listener: (ev: unknown) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((candidate) => candidate !== listener),
    );
  }

  serverOpen(): void {
    this.emit("open", {});
  }

  serverText(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  serverBinaryText(payload: unknown): void {
    this.emit("message", { data: new TextEncoder().encode(JSON.stringify(payload)).buffer });
  }

  serverClose(code: number): void {
    this.closed = true;
    this.emit("close", { code });
  }

  private emit(type: string, ev: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(ev);
  }
}

function collect() {
  const audio: ArrayBuffer[] = [];
  const status: Array<{ s: string; detail?: string }> = [];
  const transcripts: Array<{ kind: string; text: string }> = [];
  const ev: TranslationSessionEvents = {
    onAudio: (pcm) => {
      audio.push(pcm.slice(0));
    },
    onTranscript: (kind, text) => {
      transcripts.push({ kind, text });
    },
    onStatus: (s, detail) => {
      status.push({ s, detail });
    },
  };
  return { audio, status, transcripts, ev };
}

function setupOf(socket: FakeGeminiSocket, index = 0): Record<string, unknown> {
  const text = socket.sent[index];
  if (text === undefined) throw new Error("expected a setup frame");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("GeminiTranslationProvider (T-015)", () => {
  it("rejects an empty API key without opening a socket", () => {
    expect(() => new GeminiTranslationProvider("")).toThrow("API key must not be empty");
  });

  it("builds the documented setup shape by default", () => {
    const setup = buildGeminiSetup("en") as {
      setup: { generationConfig: Record<string, unknown> };
    };
    expect(setup.setup.generationConfig).toMatchObject({
      responseModalities: ["AUDIO"],
      translationConfig: { targetLanguageCode: "en", echoTargetLanguage: false },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    });
    expect("inputAudioTranscription" in setup.setup).toBe(false);
  });

  it("builds the top-level transcription placement on request", () => {
    const setup = buildGeminiSetup("fr", { placement: "toplevel" }) as {
      setup: { generationConfig: Record<string, unknown>; inputAudioTranscription: unknown };
    };
    expect(setup.setup.inputAudioTranscription).toEqual({});
    expect("inputAudioTranscription" in setup.setup.generationConfig).toBe(false);
  });

  it("round-trips a 16 kHz frame through the realtimeInput envelope", () => {
    const input = new Uint8Array([0, 1, 2, 250, 255]).buffer as ArrayBuffer;
    const parsed = JSON.parse(encodeGeminiAudioFrame(input)) as {
      realtimeInput: { audio: { data: string; mimeType: string } };
    };
    expect(parsed.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    const binary = atob(parsed.realtimeInput.audio.data);
    expect(Array.from(binary, (ch) => ch.charCodeAt(0))).toEqual([0, 1, 2, 250, 255]);
  });

  it("parses setup audio transcripts goAway and resumption frames", () => {
    const seen: string[] = [];
    const audio: number[][] = [];
    handleGeminiServerText(JSON.stringify({ setupComplete: {} }), {
      onAudio: () => {
        throw new Error("unexpected audio");
      },
      onSetupComplete: () => {
        seen.push("setup");
      },
    });
    handleGeminiServerText(
      JSON.stringify({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: btoa("AB") } }] },
          inputTranscription: { text: "marhaba" },
          outputTranscription: { text: "hello" },
        },
      }),
      {
        onAudio: (buf) => {
          audio.push(Array.from(new Uint8Array(buf)));
        },
        onTranscript: (kind, text) => {
          seen.push(`${kind}:${text}`);
        },
        onSetupComplete: () => {
          throw new Error("unexpected setupComplete");
        },
        onGoAway: (ms) => {
          seen.push(`goaway:${ms}`);
        },
        onResumption: (handle) => {
          seen.push(`resume:${handle}`);
        },
      },
    );
    handleGeminiServerText(JSON.stringify({ goAway: { timeLeft: "45s" } }), {
      onAudio: () => {
        throw new Error("unexpected audio");
      },
      onSetupComplete: () => {
        throw new Error("unexpected setupComplete");
      },
      onGoAway: (ms) => {
        seen.push(`goaway:${ms}`);
      },
    });
    handleGeminiServerText(
      JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: "h1" } }),
      {
        onAudio: () => {
          throw new Error("unexpected audio");
        },
        onSetupComplete: () => {
          throw new Error("unexpected setupComplete");
        },
        onResumption: (handle) => {
          seen.push(`resume:${handle}`);
        },
      },
    );
    handleGeminiServerText("not json", {
      onAudio: () => {
        throw new Error("unexpected audio");
      },
      onSetupComplete: () => {
        throw new Error("unexpected setupComplete");
      },
    });
    expect(seen).toEqual(["setup", "input:marhaba", "output:hello", "goaway:45000", "resume:h1"]);
    expect(audio).toEqual([[65, 66]]);
  });

  it("connects then goes live and forwards translated audio", async () => {
    const sockets: FakeGeminiSocket[] = [];
    const provider = new GeminiTranslationProvider("test-key", {
      createSocket: (url) => {
        const socket = new FakeGeminiSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const c = collect();
    const session = await provider.openSession("ar", "en", c.ev);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toContain("key=test-key");
    expect(c.status.map((entry) => entry.s)).toEqual(["connecting"]);
    expect(sockets[0]?.sent).toHaveLength(0);
    sockets[0]?.serverOpen();
    sockets[0]?.serverText({ setupComplete: {} });
    expect(c.status.map((entry) => entry.s)).toEqual(["connecting", "live"]);
    session.sendInputAudio(new Uint8Array([3, 4]).buffer as ArrayBuffer);
    const frame = JSON.parse(sockets[0]?.sent[1] ?? "") as {
      realtimeInput: { audio: { mimeType: string } };
    };
    expect(frame.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    sockets[0]?.serverText({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: btoa("CD") } }] } },
    });
    expect(Array.from(new Uint8Array(c.audio[0] ?? new ArrayBuffer(0)))).toEqual([67, 68]);
    session.close();
    await provider.closeAll();
  });

  it("opens top-level first and retries documented placement after a pre-setup close", async () => {
    const sockets: FakeGeminiSocket[] = [];
    const provider = new GeminiTranslationProvider("test-key", {
      createSocket: (url) => {
        const socket = new FakeGeminiSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const c = collect();
    const session = await provider.openSession("ar", "en", c.ev);
    sockets[0]?.serverOpen();
    expect(setupOf(sockets[0] as FakeGeminiSocket)).toMatchObject({
      setup: { inputAudioTranscription: {}, outputAudioTranscription: {} },
    });
    sockets[0]?.serverClose(1007);
    expect(sockets).toHaveLength(2);
    expect(c.status.map((entry) => entry.s)).toEqual([
      "connecting",
      "reconnecting",
      "connecting",
    ]);
    sockets[1]?.serverOpen();
    expect(
      (setupOf(sockets[1] as FakeGeminiSocket).setup as { generationConfig: object })
        .generationConfig,
    ).toMatchObject({ inputAudioTranscription: {}, outputAudioTranscription: {} });
    sockets[1]?.serverText({ setupComplete: {} });
    expect(c.status.map((entry) => entry.s)).toContain("live");
    session.close();
    await provider.closeAll();
  });

  it("accepts setupComplete wrapped in a binary frame (T-017 production shape)", async () => {
    const sockets: FakeGeminiSocket[] = [];
    const provider = new GeminiTranslationProvider("test-key", {
      createSocket: (url) => {
        const socket = new FakeGeminiSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const c = collect();
    const session = await provider.openSession("ar", "en", c.ev);
    sockets[0]?.serverOpen();
    sockets[0]?.serverBinaryText({ setupComplete: {} });
    expect(c.status.map((entry) => entry.s)).toEqual(["connecting", "live"]);
    session.close();
    await provider.closeAll();
  });
});
