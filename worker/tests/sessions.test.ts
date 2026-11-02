import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTranslationProvider } from "../src/translation/fake.js";
import type {
  Lang,
  TranslationProvider,
  TranslationSession,
  TranslationSessionEvents,
} from "../src/translation/provider.js";
import {
  SessionManager,
  pipeKey,
} from "../src/translation/sessions.js";
import type { SessionStatus } from "../src/translation/sessions.js";

interface StatusEvent {
  readonly pair: string;
  readonly status: SessionStatus;
  readonly attempt: number;
}

function statusCollector() {
  const events: StatusEvent[] = [];
  const onSessionStatus = (pair: string, status: SessionStatus, attempt: number): void => {
    events.push({ pair, status, attempt });
  };
  return { events, onSessionStatus };
}

/** FakeTranslationProvider with an openSession call counter (lazy-open proof). */
class CountingFake extends FakeTranslationProvider {
  openCalls = 0;

  override openSession(
    sourceLang: Lang,
    targetLang: Lang,
    ev: TranslationSessionEvents,
  ): Promise<TranslationSession> {
    this.openCalls += 1;
    return super.openSession(sourceLang, targetLang, ev);
  }
}

function makeManager(
  provider: CountingFake,
  opts: { idleCloseMs?: number; maxSessions?: number } = {},
) {
  const { events, onSessionStatus } = statusCollector();
  const audio: Array<{
    pair: string;
    speakerIndex: number;
    epoch: number;
    pcm: ArrayBuffer;
  }> = [];
  const manager = new SessionManager(provider, {
    idleCloseMs: opts.idleCloseMs,
    maxSessions: opts.maxSessions,
    onSessionStatus,
    onAudio: (
      pair: string,
      speakerIndex: number,
      epoch: number,
      pcm: ArrayBuffer,
    ) => {
      audio.push({ pair, speakerIndex, epoch, pcm: pcm.slice(0) });
    },
  });
  return { manager, events, audio };
}

function u8(buf: ArrayBuffer | undefined): number[] {
  if (buf === undefined) throw new Error("expected audio chunk, got none");
  return Array.from(new Uint8Array(buf));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionManager (T-008)", () => {
  it("pipeKey is speaker-scoped: idx:src->tgt", () => {
    expect(pipeKey(0, "ar", "en")).toBe("0:ar->en");
    expect(pipeKey(2, "fr", "es")).toBe("2:fr->es");
  });

  it("lazy-open: opens no provider session until acquire", async () => {
    const provider = new CountingFake({ delayMs: 5 });
    const { manager, events } = makeManager(provider);
    expect(provider.openCalls).toBe(0);
    const got = manager.acquire(0, "ar", "en", "listener-1", { isTeacherLeg: false });
    expect(provider.openCalls).toBe(1);
    expect(got.degraded).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.status)).toContain("live");
  });

  it("shares one session between 2 listeners on the same speaker pipe", async () => {
    const provider = new CountingFake({ delayMs: 5 });
    const { manager, events } = makeManager(provider);
    const a = manager.acquire(0, "ar", "en", "listener-1", { isTeacherLeg: false });
    const b = manager.acquire(0, "ar", "en", "listener-2", { isTeacherLeg: false });
    expect(provider.openCalls).toBe(1);
    expect(b.session).toBe(a.session);
    expect(b.degraded).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(events.filter((e) => e.status === "live")).toHaveLength(1);

    // One release must not close while the other listener remains.
    manager.release("listener-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.openCalls).toBe(1);
    const c = manager.acquire(0, "ar", "en", "listener-3", { isTeacherLeg: false });
    expect(c.session).toBe(a.session);
  });

  it("same langs, different speaker indices -> independent pipes (T-028 core)", async () => {
    const provider = new CountingFake({ delayMs: 5 });
    const { manager, events, audio } = makeManager(provider);
    const t = manager.acquire(0, "ar", "en", "listener-t", { isTeacherLeg: true });
    const s = manager.acquire(1, "ar", "en", "listener-s", { isTeacherLeg: false });
    expect(provider.openCalls).toBe(2);
    expect(s.session).not.toBe(t.session);
    await vi.advanceTimersByTimeAsync(10);
    expect(events.filter((e) => e.status === "live").map((e) => e.pair)).toEqual([
      "0:ar->en",
      "1:ar->en",
    ]);

    // Each pipe carries only its own speaker's audio.
    t.session.sendInputAudio(new Uint8Array([1, 2]).buffer as ArrayBuffer);
    await vi.advanceTimersByTimeAsync(10);
    expect(audio).toHaveLength(1);
    expect(audio[0]?.pair).toBe("0:ar->en");
    expect(audio[0]?.speakerIndex).toBe(0);
    s.session.sendInputAudio(new Uint8Array([3, 4]).buffer as ArrayBuffer);
    await vi.advanceTimersByTimeAsync(10);
    expect(audio).toHaveLength(2);
    expect(audio[1]?.pair).toBe("1:ar->en");
    expect(audio[1]?.speakerIndex).toBe(1);
  });

  it("idle-close: closes the session 60s after the last release", async () => {
    const provider = new CountingFake({ delayMs: 5 });
    const { manager, audio } = makeManager(provider, { idleCloseMs: 60_000 });
    const a = manager.acquire(0, "ar", "en", "listener-1", { isTeacherLeg: false });
    await vi.advanceTimersByTimeAsync(10);

    // Audio flows while referenced.
    a.session.sendInputAudio(new Uint8Array([1, 2]).buffer as ArrayBuffer);
    await vi.advanceTimersByTimeAsync(10);
    expect(audio).toHaveLength(1);
    expect(u8(audio[0]?.pcm)).toEqual([1, 2]);

    manager.release("listener-1");
    // Still warm before the timeout: re-acquire reuses the session.
    await vi.advanceTimersByTimeAsync(59_999);
    const warm = manager.acquire(0, "ar", "en", "listener-2", { isTeacherLeg: false });
    expect(provider.openCalls).toBe(1);
    expect(warm.session).toBe(a.session);
    manager.release("listener-2");

    // Full idle timeout after zero refs closes it: next acquire re-opens.
    await vi.advanceTimersByTimeAsync(60_000);
    const cold = manager.acquire(0, "ar", "en", "listener-3", { isTeacherLeg: false });
    expect(provider.openCalls).toBe(2);
    expect(cold.session).not.toBe(a.session);
    expect(cold.degraded).toBe(false);

    // The closed session emits nothing more.
    a.session.sendInputAudio(new Uint8Array([9]).buffer as ArrayBuffer);
    await vi.advanceTimersByTimeAsync(50);
    expect(audio).toHaveLength(1);
  });

  it("cap overflow keeps the teacher leg + earliest and degrades the newcomer", async () => {
    const provider = new CountingFake({ delayMs: 5 });
    const { manager, events, audio } = makeManager(provider, { maxSessions: 2 });
    const teacher = manager.acquire(0, "ar", "en", "teacher-1", { isTeacherLeg: true });
    const early = manager.acquire(0, "ar", "fr", "student-1", { isTeacherLeg: false });
    expect(teacher.degraded).toBe(false);
    expect(early.degraded).toBe(false);
    expect(provider.openCalls).toBe(2);

    const newcomer = manager.acquire(0, "ar", "es", "student-2", { isTeacherLeg: false });
    expect(newcomer.degraded).toBe(true);
    expect(provider.openCalls).toBe(2);
    // Flush the two live sessions' connecting/live before snapshotting.
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toContainEqual({ pair: "0:ar->es", status: "degraded", attempt: 0 });

    // Degraded handle is muted: emits nothing, silently.
    const audioBefore = audio.length;
    const eventsBefore = events.length;
    newcomer.session.sendInputAudio(new Uint8Array([7]).buffer as ArrayBuffer);
    newcomer.session.endInput();
    await vi.advanceTimersByTimeAsync(100);
    expect(audio).toHaveLength(audioBefore);
    expect(events).toHaveLength(eventsBefore);

    // Existing sessions are unaffected.
    teacher.session.sendInputAudio(new Uint8Array([3, 0]).buffer as ArrayBuffer);
    await vi.advanceTimersByTimeAsync(10);
    expect(audio).toHaveLength(audioBefore + 1);
  });

  it("failed session reconnects with attempt counts then surfaces failed", async () => {
    const provider = new CountingFake({ delayMs: 5, failAfter: 1 });
    const { manager, events } = makeManager(provider);
    const got = manager.acquire(0, "ar", "en", "listener-1", { isTeacherLeg: false });
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toContainEqual({ pair: "0:ar->en", status: "live", attempt: 0 });

    // Every underlying session fails on its first send: drive 6 failures
    // (initial + 5 reconnect attempts) with the specified backoff
    // 250ms*2^n (250, 500, 1000, 2000, 4000).
    const backoffs = [250, 500, 1000, 2000, 4000];
    for (let i = 0; i < backoffs.length + 1; i += 1) {
      got.session.sendInputAudio(new Uint8Array([1]).buffer as ArrayBuffer);
      const backoff = backoffs[i];
      if (backoff !== undefined) {
        await vi.advanceTimersByTimeAsync(backoff + 10);
      }
    }
    expect(provider.openCalls).toBe(6);

    const reconnecting = events.filter((e) => e.status === "reconnecting");
    expect(reconnecting.map((e) => e.attempt)).toEqual([1, 2, 3, 4, 5]);
    for (const e of reconnecting) expect(e.pair).toBe("0:ar->en");
    const last = events[events.length - 1];
    expect(last).toEqual({ pair: "0:ar->en", status: "failed", attempt: 5 });
  });

  it("reconnect recovers: failed session goes live again with attempt count", async () => {
    const provider = new CountingFake({ delayMs: 5, failAfter: 1 });
    const { manager, events, audio } = makeManager(provider);
    const got = manager.acquire(0, "ar", "en", "listener-1", { isTeacherLeg: false });
    await vi.advanceTimersByTimeAsync(10);

    // First send kills the initial session; backoff re-opens one.
    got.session.sendInputAudio(new Uint8Array([1]).buffer as ArrayBuffer);
    await vi.advanceTimersByTimeAsync(250 + 10);
    expect(provider.openCalls).toBe(2);
    expect(events).toContainEqual({ pair: "0:ar->en", status: "reconnecting", attempt: 1 });
    expect(events).toContainEqual({ pair: "0:ar->en", status: "live", attempt: 1 });

    // The same handle now talks to the fresh session: audio flows again.
    // failAfter=1 would kill the fresh session too, so only assert recovery
    // signalling here; the exhaustion test above covers repeated failure.
    expect(got.degraded).toBe(false);
    expect(audio).toHaveLength(0);
  });

  it("keys sessions by epoch so a re-open never reuses the previous microphone", async () => {
    const provider = new CountingFake({ delayMs: 5 });
    const { manager, audio } = makeManager(provider);
    const first = manager.acquire(0, "ar", "en", "listener", { epoch: 1 });
    await vi.advanceTimersByTimeAsync(10);
    const second = manager.acquire(0, "ar", "en", "listener", { epoch: 2 });
    await vi.advanceTimersByTimeAsync(10);

    expect(provider.openCalls).toBe(2);
    expect(second.session).not.toBe(first.session);

    first.session.sendInputAudio(new Uint8Array([1, 0]).buffer as ArrayBuffer);
    second.session.sendInputAudio(new Uint8Array([2, 0]).buffer as ArrayBuffer);
    await vi.advanceTimersByTimeAsync(10);
    expect(audio.map((a) => a.epoch)).toEqual([1, 2]);
  });
});

describe("per-speaker flush + teardown (T-028 mic model)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Provider whose session emits nothing on its own; the test drives
   * `events.onTranscript` / `events.onGoAway` / `events.onStatus` directly. */
  class ScriptedProvider implements TranslationProvider {
    readonly name = "fake" as const;
    events: TranslationSessionEvents | null = null;
    closedAll = false;
    endInputCalls = 0;
    readonly calls: Array<{
      sourceLang: Lang;
      targetLang: Lang;
      resumeHandle: string | undefined;
    }> = [];

    openSession(
      sourceLang: Lang,
      targetLang: Lang,
      ev: TranslationSessionEvents,
      resumeHandle?: string,
    ): Promise<TranslationSession> {
      this.calls.push({ sourceLang, targetLang, resumeHandle });
      this.events = ev;
      const session: TranslationSession = {
        sourceLang,
        targetLang,
        sendInputAudio: (): void => undefined,
        endInput: (): void => {
          this.endInputCalls += 1;
        },
        close: (): void => undefined,
      };
      return Promise.resolve(session);
    }

    closeAll(): Promise<void> {
      this.closedAll = true;
      return Promise.resolve();
    }
  }

  it("flushSpeaker ends input on that speaker's pipes only", async () => {
    const provider = new ScriptedProvider();
    const manager = new SessionManager(provider, {});
    manager.acquire(0, "ar", "en", "l-t");
    manager.acquire(1, "ar", "en", "l-s1");
    manager.acquire(1, "ar", "fr", "l-s1b");
    manager.acquire(2, "ar", "en", "l-s2");
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.endInputCalls).toBe(0);
    manager.flushSpeaker(1);
    expect(provider.endInputCalls).toBe(2);
    manager.flushSpeaker(0);
    expect(provider.endInputCalls).toBe(3);
    manager.flushSpeaker(9);
    expect(provider.endInputCalls).toBe(3);
  });

  it("closeSpeakerPipes releases that speaker's refs and arms idle-close; others unaffected", async () => {
    const provider = new CountingFake({ delayMs: 5 });
    const { manager } = makeManager(provider, { idleCloseMs: 60_000 });
    const a = manager.acquire(0, "ar", "en", "listener-t");
    const b = manager.acquire(1, "ar", "en", "listener-s");
    await vi.advanceTimersByTimeAsync(10);

    manager.closeSpeakerPipes(1);
    // Speaker 1's pipe drains and retires; speaker 0 stays untouched.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.openCalls).toBe(2);
    const reborn = manager.acquire(1, "ar", "en", "listener-s2");
    expect(provider.openCalls).toBe(3);
    expect(reborn.session).not.toBe(b.session);
    // Speaker 0's pipe stayed warm the whole time.
    const again = manager.acquire(0, "ar", "en", "listener-t2");
    expect(again.session).toBe(a.session);
    expect(provider.openCalls).toBe(3);
  });

  it("closeSpeakerPipes drains the pipe, then a later acquire reopens it", async () => {
    const provider = new ScriptedProvider();
    const manager = new SessionManager(provider, { idleCloseMs: 60_000 });
    const b = manager.acquire(1, "ar", "en", "listener-s");
    await vi.advanceTimersByTimeAsync(0);
    provider.events?.onStatus("live");
    manager.closeSpeakerPipes(1);
    expect(provider.endInputCalls).toBe(1);

    // During the drain window the tail still reaches a new listener.
    const warm = manager.acquire(1, "ar", "en", "listener-s2");
    expect(warm.session).toBe(b.session);
    expect(provider.calls.length).toBe(1);

    // Quiet for the drain window retires the epoch; a later acquire reopens.
    await vi.advanceTimersByTimeAsync(1_200);
    const fresh = manager.acquire(1, "ar", "en", "listener-s3");
    expect(provider.calls.length).toBe(2);
    expect(fresh.session).not.toBe(b.session);
  });

  it("does not retire an epoch whose provider is still opening", async () => {
    const control: { resolve: (() => void) | null } = { resolve: null };
    let openCalls = 0;
    const provider: TranslationProvider = {
      name: "fake",
      openSession: (sourceLang, targetLang, ev) => {
        openCalls += 1;
        const session: TranslationSession = {
          sourceLang,
          targetLang,
          sendInputAudio: () => undefined,
          endInput: () => undefined,
          close: () => undefined,
        };
        return new Promise((resolve) => {
          control.resolve = () => {
            ev.onStatus("live");
            resolve(session);
          };
        });
      },
      closeAll: () => Promise.resolve(),
    };

    const manager = new SessionManager(provider, {});
    const acquired = manager.acquire(1, "ar", "en", "l");
    manager.closeSpeakerPipes(1);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(manager.acquire(1, "ar", "en", "l2").session).toBe(acquired.session);
    expect(openCalls).toBe(1);

    control.resolve?.();
    await vi.advanceTimersByTimeAsync(1_300);
    const fresh = manager.acquire(1, "ar", "en", "l3");
    expect(openCalls).toBe(2);
    expect(fresh.session).not.toBe(acquired.session);
  });

  it("release() still works per listener alongside closeSpeakerPipes", async () => {
    const provider = new CountingFake({ delayMs: 5 });
    const { manager } = makeManager(provider, { idleCloseMs: 60_000 });
    manager.acquire(1, "ar", "en", "listener-a");
    manager.acquire(1, "ar", "en", "listener-b");
    await vi.advanceTimersByTimeAsync(10);
    manager.release("listener-a");
    manager.release("listener-b");
    await vi.advanceTimersByTimeAsync(60_000);
    const fresh = manager.acquire(1, "ar", "en", "listener-c");
    expect(provider.openCalls).toBe(2);
    expect(fresh.degraded).toBe(false);
  });
});

describe("SessionManager transcript + goAway forwarding (latency/quality M0.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Provider whose session emits nothing on its own; the test drives
   * `events.onTranscript` / `events.onGoAway` / `events.onStatus` directly. */
  class ScriptedProvider2 implements TranslationProvider {
    readonly name = "fake" as const;
    events: TranslationSessionEvents | null = null;
    closedAll = false;
    endInputCalls = 0;
    readonly calls: Array<{
      sourceLang: Lang;
      targetLang: Lang;
      resumeHandle: string | undefined;
    }> = [];

    openSession(
      sourceLang: Lang,
      targetLang: Lang,
      ev: TranslationSessionEvents,
      resumeHandle?: string,
    ): Promise<TranslationSession> {
      this.calls.push({ sourceLang, targetLang, resumeHandle });
      this.events = ev;
      const session: TranslationSession = {
        sourceLang,
        targetLang,
        sendInputAudio: (): void => undefined,
        endInput: (): void => {
          this.endInputCalls += 1;
        },
        close: (): void => undefined,
      };
      return Promise.resolve(session);
    }

    closeAll(): Promise<void> {
      this.closedAll = true;
      return Promise.resolve();
    }
  }

  it("forwards provider transcripts with pair, speaker, kind, full-segment text and final flag", async () => {
    const provider = new ScriptedProvider2();
    const transcripts: Array<{
      pair: string;
      speakerIndex: number;
      kind: "input" | "output";
      text: string;
      final: boolean;
    }> = [];
    const manager = new SessionManager(provider, {
      onTranscript: (pair, speakerIndex, kind, text, final) => {
        transcripts.push({ pair, speakerIndex, kind, text, final });
      },
    });
    manager.acquire(3, "ar", "en", "listener-1", { isTeacherLeg: false });
    const ev = provider.events;
    if (ev === null) throw new Error("provider never got events");
    ev.onTranscript?.("output", "hello world", false);
    ev.onTranscript?.("input", "مرحبا", true);
    expect(transcripts).toEqual([
      { pair: "3:ar->en", speakerIndex: 3, kind: "output", text: "hello world", final: false },
      { pair: "3:ar->en", speakerIndex: 3, kind: "input", text: "مرحبا", final: true },
    ]);
  });

  it("drops transcript/goAway events after the entry is torn down (stale generation)", async () => {
    const provider = new ScriptedProvider2();
    const transcripts: unknown[] = [];
    const goAways: unknown[] = [];
    const manager = new SessionManager(provider, {
      onTranscript: (pair) => {
        transcripts.push(pair);
      },
      onGoAway: (pair) => {
        goAways.push(pair);
      },
    });
    manager.acquire(0, "ar", "en", "listener-1", { isTeacherLeg: false });
    const ev = provider.events;
    if (ev === null) throw new Error("provider never got events");
    await manager.closeAll();
    ev.onTranscript?.("output", "late", false);
    ev.onGoAway?.(45_000);
    expect(transcripts).toEqual([]);
    expect(goAways).toEqual([]);
  });

  it("forwards goAway with pair, speaker and remaining time", async () => {
    const provider = new ScriptedProvider2();
    const goAways: Array<{ pair: string; speakerIndex: number; ms: number }> = [];
    const statuses: string[] = [];
    const manager = new SessionManager(provider, {
      onSessionStatus: (_pair, status) => {
        statuses.push(status);
      },
      onGoAway: (pair, speakerIndex, ms) => {
        goAways.push({ pair, speakerIndex, ms });
      },
    });
    manager.acquire(2, "ar", "fr", "listener-1", { isTeacherLeg: false });
    const ev = provider.events;
    if (ev === null) throw new Error("provider never got events");
    ev.onGoAway?.(60_000);
    expect(goAways).toEqual([{ pair: "2:ar->fr", speakerIndex: 2, ms: 60_000 }]);
    expect(statuses).toEqual(["reconnecting"]);
  });

  it("endInputAll flushes every open pipe across speakers", async () => {
    const provider = new ScriptedProvider2();
    const manager = new SessionManager(provider, {});
    manager.acquire(0, "ar", "en", "listener-1");
    manager.acquire(1, "ar", "fr", "listener-2");
    await vi.advanceTimersByTimeAsync(0);
    manager.endInputAll();
    expect(provider.endInputCalls).toBe(2);
  });

  it("replays the latest resumption handle when it reopens after a failure", async () => {
    const provider = new ScriptedProvider2();
    const manager = new SessionManager(provider, {});
    manager.acquire(0, "ar", "en", "listener-1", { isTeacherLeg: false });
    const ev = provider.events;
    if (ev === null) throw new Error("provider never got events");
    ev.onResumption?.("h1");
    ev.onStatus("failed");
    await vi.advanceTimersByTimeAsync(250);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.resumeHandle).toBe("h1");
  });

  it("drops resumption handles from a torn-down entry", async () => {
    const provider = new ScriptedProvider2();
    const manager = new SessionManager(provider, {});
    manager.acquire(0, "ar", "en", "listener-1", { isTeacherLeg: false });
    const ev = provider.events;
    if (ev === null) throw new Error("provider never got events");
    await manager.closeAll();
    ev.onResumption?.("late");
    manager.acquire(0, "ar", "en", "listener-2", { isTeacherLeg: false });
    expect(provider.calls.at(-1)?.resumeHandle).toBeUndefined();
  });

  it("resets retry attempts once a live session proves stable (>10s), keeping rapid-fail exhaustion", async () => {
    // failAfter=1: every underlying session dies on its first send.
    const provider = new CountingFake({ delayMs: 5, failAfter: 1 });
    const { manager, events } = makeManager(provider);
    const got = manager.acquire(0, "ar", "en", "listener-1", { isTeacherLeg: false });
    await vi.advanceTimersByTimeAsync(10);

    // Drop #1 happens 10ms after live: NOT stable, attempt counter keeps
    // climbing (rapid-fail exhaustion is preserved).
    got.session.sendInputAudio(new Uint8Array([1]).buffer as ArrayBuffer);
    await vi.advanceTimersByTimeAsync(250 + 10); // backoff 1 -> open #2, live
    got.session.sendInputAudio(new Uint8Array([2]).buffer as ArrayBuffer);
    await vi.advanceTimersByTimeAsync(500 + 10); // backoff 2 -> open #3, live
    expect(events.filter((e) => e.status === "reconnecting").map((e) => e.attempt)).toEqual([1, 2]);

    // Now let the third session live for >10s (it cannot fail on its own:
    // failAfter only fires on send), then fail it: the counter resets.
    await vi.advanceTimersByTimeAsync(11_000);
    got.session.sendInputAudio(new Uint8Array([3]).buffer as ArrayBuffer);
    await vi.advanceTimersByTimeAsync(250 + 10); // backoff restarts at 1
    expect(events.filter((e) => e.status === "reconnecting").map((e) => e.attempt)).toEqual([
      1, 2, 1,
    ]);
    expect(provider.openCalls).toBe(4);
  });
});
