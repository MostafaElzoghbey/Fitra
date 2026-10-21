import { describe, expect, it } from "vitest";
import { FakeTranslationProvider } from "../src/translation/fake.js";
import type {
  TranslationSession,
  TranslationSessionEvents,
} from "../src/translation/provider.js";
import type { FakeTranslationSession } from "../src/translation/fake.js";

function collect() {
  const audio: ArrayBuffer[] = [];
  const status: string[] = [];
  const ev: TranslationSessionEvents = {
    onAudio: (pcm: ArrayBuffer) => {
      audio.push(pcm.slice(0));
    },
    onStatus: (s: string) => {
      status.push(s);
    },
  };
  return { audio, status, ev };
}

function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function u8(buf: ArrayBuffer | undefined): number[] {
  if (buf === undefined) throw new Error("expected audio chunk, got none");
  return Array.from(new Uint8Array(buf));
}

describe("FakeTranslationProvider (T-004)", () => {
  it("emits connecting→live on open", async () => {
    const provider = new FakeTranslationProvider({ delayMs: 10 });
    const c = collect();
    const session = await provider.openSession("ar", "en", c.ev);
    await waitFor(() => c.status.includes("live"));
    expect(c.status[0]).toBe("connecting");
    expect(c.status).toContain("live");
    session.close();
    await provider.closeAll();
  });

  it("echoes the same bytes back after delayMs", async () => {
    const delayMs = 30;
    const provider = new FakeTranslationProvider({ delayMs });
    const c = collect();
    const session: TranslationSession = await provider.openSession("ar", "en", c.ev);
    await waitFor(() => c.status.includes("live"));
    const input = new Uint8Array([1, 2, 3, 4, 250]).buffer as ArrayBuffer;
    const t0 = Date.now();
    session.sendInputAudio(input.slice(0));
    await waitFor(() => c.audio.length === 1, delayMs + 2000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(delayMs - 5);
    expect(u8(c.audio[0])).toEqual([1, 2, 3, 4, 250]);
    session.close();
    await provider.closeAll();
  });

  it("failure injection fires onStatus('failed') after failAfter sends", async () => {
    const provider = new FakeTranslationProvider({ delayMs: 5, failAfter: 2 });
    const c = collect();
    const session = await provider.openSession("ar", "en", c.ev);
    await waitFor(() => c.status.includes("live"));
    session.sendInputAudio(new Uint8Array([9]).buffer as ArrayBuffer);
    session.sendInputAudio(new Uint8Array([10]).buffer as ArrayBuffer);
    await waitFor(() => c.status.includes("failed"));
    expect(c.status).toContain("failed");
    // After failure the session is dead: further sends produce no audio.
    const audioBefore = c.audio.length;
    session.sendInputAudio(new Uint8Array([11]).buffer as ArrayBuffer);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.audio.length).toBe(audioBefore);
    session.close();
    await provider.closeAll();
  });

  it("close() silences pending echoes", async () => {
    const provider = new FakeTranslationProvider({ delayMs: 60 });
    const c = collect();
    const session = await provider.openSession("ar", "en", c.ev);
    await waitFor(() => c.status.includes("live"));
    session.sendInputAudio(new Uint8Array([7, 8]).buffer as ArrayBuffer);
    session.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(c.audio.length).toBe(0);
    await provider.closeAll();
  });

  it("simulateDrop() drives reconnecting→live and the session stays usable", async () => {
    const provider = new FakeTranslationProvider({ delayMs: 10 });
    const c = collect();
    const session = await provider.openSession("ar", "en", c.ev);
    await waitFor(() => c.status.includes("live"));
    (session as FakeTranslationSession).simulateDrop();
    await waitFor(() => c.status.includes("reconnecting"));
    await waitFor(
      () => c.status.filter((s) => s === "live").length >= 2,
    );
    session.sendInputAudio(new Uint8Array([42]).buffer as ArrayBuffer);
    await waitFor(() => c.audio.length === 1);
    expect(u8(c.audio[0])).toEqual([42]);
    session.close();
    await provider.closeAll();
  });

  it("endInput() keeps the session warm", async () => {
    const provider = new FakeTranslationProvider({ delayMs: 10 });
    const c = collect();
    const session = await provider.openSession("ar", "en", c.ev);
    await waitFor(() => c.status.includes("live"));
    session.sendInputAudio(new Uint8Array([1]).buffer as ArrayBuffer);
    session.endInput();
    session.sendInputAudio(new Uint8Array([2]).buffer as ArrayBuffer);
    await waitFor(() => c.audio.length === 2);
    expect(u8(c.audio[0])).toEqual([1]);
    expect(u8(c.audio[1])).toEqual([2]);
    session.close();
    await provider.closeAll();
  });

  it("closeAll() silences every open session", async () => {
    const provider = new FakeTranslationProvider({ delayMs: 60 });
    const c1 = collect();
    const c2 = collect();
    const s1 = await provider.openSession("ar", "en", c1.ev);
    const s2 = await provider.openSession("ar", "fr", c2.ev);
    await provider.closeAll();
    s1.sendInputAudio(new Uint8Array([1]).buffer as ArrayBuffer);
    s2.sendInputAudio(new Uint8Array([2]).buffer as ArrayBuffer);
    await new Promise((r) => setTimeout(r, 150));
    expect(c1.audio.length).toBe(0);
    expect(c2.audio.length).toBe(0);
  });

  it("tagLanguage=true prefixes a 2-byte language tag", async () => {
    const provider = new FakeTranslationProvider({ delayMs: 5, tagLanguage: true });
    const c = collect();
    const session = await provider.openSession("ar", "en", c.ev);
    await waitFor(() => c.status.includes("live"));
    session.sendInputAudio(new Uint8Array([0x01, 0x02]).buffer as ArrayBuffer);
    await waitFor(() => c.audio.length === 1);
    // 2-byte tag = first two char codes of the target BCP-47 code ("en").
    expect(u8(c.audio[0])).toEqual([0x65, 0x6e, 0x01, 0x02]);
    session.close();
    await provider.closeAll();
  });

  it("dropRate=1 drops all echoes", async () => {
    const provider = new FakeTranslationProvider({ delayMs: 5, dropRate: 1 });
    const c = collect();
    const session = await provider.openSession("ar", "en", c.ev);
    await waitFor(() => c.status.includes("live"));
    session.sendInputAudio(new Uint8Array([3]).buffer as ArrayBuffer);
    await new Promise((r) => setTimeout(r, 80));
    expect(c.audio.length).toBe(0);
    session.close();
    await provider.closeAll();
  });
});
