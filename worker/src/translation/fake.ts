import type {
  Lang,
  TranslationProvider,
  TranslationSession,
  TranslationSessionEvents,
} from "./provider.js";

// Inline copy of the onStatus union from provider.ts (kept in sync by hand;
// provider.ts itself stays VERBATIM per ARCHITECTURE.md section 4).
type FakeStatus = "connecting" | "live" | "reconnecting" | "failed";

// Fake is the default provider in dev/test (zero Gemini quota). No network,
// no Gemini imports (AGENTS.md rule 3). T-008 SessionManager will refcount
// TranslationSession objects; T-009 DO fan-out calls sendInputAudio/onAudio,
// so the TranslationSessionEvents callback contract below must stay exact.
export interface FakeProviderOptions {
  readonly delayMs?: number;
  readonly failAfter?: number;
  readonly dropRate?: number;
  readonly tagLanguage?: boolean;
}

type Timer = ReturnType<typeof setTimeout>;

// Design choices (documented per T-004):
// - Echo prepends NOTHING by default so byte-equality holds for loopback
//   tests. With tagLanguage=true we prefix a 2-byte tag = the first two
//   char codes of the target BCP-47 code (e.g. "en" -> [0x65, 0x6e]) so fan-out
//   tests (T-009) can tell which target leg an echo belongs to. Padding with
//   0x00 when the code is shorter than 2 chars.
// - Status lifecycle: onStatus("connecting") fires synchronously inside
//   openSession, onStatus("live") follows on the next macrotask. This keeps
//   "connecting" observable even when callers await openSession.
// - Failure injection: the failAfter-th sendInputAudio call fires
//   onStatus("failed") INSTEAD of echoing that chunk; the session is then
//   dead (later sends are ignored). failAfter counts sends starting at 1.
// - dropRate in [0,1] drops each echo independently via Math.random().
// - simulateDrop() is a TEST-ONLY hook (not on the TranslationSession
//   interface): it fires onStatus("reconnecting") then onStatus("live") after
//   delayMs; the session stays usable throughout.
export class FakeTranslationSession implements TranslationSession {
  readonly sourceLang: Lang;
  readonly targetLang: Lang;

  private readonly ev: TranslationSessionEvents;
  private readonly delayMs: number;
  private readonly failAfter: number | undefined;
  private readonly dropRate: number;
  private readonly tagLanguage: boolean;
  private readonly onSessionClosed: (s: FakeTranslationSession) => void;

  private sendCount = 0;
  private closed = false;
  private failed = false;
  private readonly pending: Set<Timer> = new Set();

  constructor(
    sourceLang: Lang,
    targetLang: Lang,
    ev: TranslationSessionEvents,
    options: {
      readonly delayMs: number;
      readonly failAfter: number | undefined;
      readonly dropRate: number;
      readonly tagLanguage: boolean;
    },
    onSessionClosed: (s: FakeTranslationSession) => void,
  ) {
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;
    this.ev = ev;
    this.delayMs = options.delayMs;
    this.failAfter = options.failAfter;
    this.dropRate = options.dropRate;
    this.tagLanguage = options.tagLanguage;
    this.onSessionClosed = onSessionClosed;
  }

  /** Called by the provider right after construction to start the lifecycle. */
  start(): void {
    this.emitStatus("connecting");
    const t = setTimeout(() => {
      this.pending.delete(t);
      if (this.closed || this.failed) return;
      this.emitStatus("live");
    }, 0);
    this.pending.add(t);
  }

  sendInputAudio(pcm16kMono: ArrayBuffer): void {
    if (this.closed || this.failed) return;
    this.sendCount += 1;
    if (this.failAfter !== undefined && this.sendCount >= this.failAfter) {
      this.failed = true;
      this.clearPending();
      this.emitStatus("failed", `injected failure after ${this.sendCount} sends`);
      return;
    }
    if (Math.random() < this.dropRate) return;
    // Copy at send time so later caller mutation cannot corrupt the echo.
    const snapshot: ArrayBuffer = pcm16kMono.slice(0);
    const out: ArrayBuffer = this.tagLanguage ? withTag(snapshot, this.targetLang) : snapshot;
    const t = setTimeout(() => {
      this.pending.delete(t);
      if (this.closed || this.failed) return;
      this.ev.onAudio(out.slice(0));
    }, this.delayMs);
    this.pending.add(t);
  }

  endInput(): void {
    // Speaker paused: keep the session warm. No status change, no teardown;
    // idle-close stays the SessionManager's (T-008) job.
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearPending();
    this.onSessionClosed(this);
  }

  /** Test-only hook: drive reconnecting→live while staying usable. */
  simulateDrop(detail?: string): void {
    if (this.closed || this.failed) return;
    this.emitStatus("reconnecting", detail);
    const t = setTimeout(() => {
      this.pending.delete(t);
      if (this.closed || this.failed) return;
      this.emitStatus("live");
    }, this.delayMs);
    this.pending.add(t);
  }

  private emitStatus(s: FakeStatus, detail?: string): void {
    this.ev.onStatus(s, detail);
  }

  private clearPending(): void {
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
  }
}

function withTag(input: ArrayBuffer, targetLang: string): ArrayBuffer {
  const src = new Uint8Array(input);
  const out = new Uint8Array(2 + src.length);
  out[0] = targetLang.length > 0 ? targetLang.charCodeAt(0) & 0xff : 0x00;
  out[1] = targetLang.length > 1 ? targetLang.charCodeAt(1) & 0xff : 0x00;
  out.set(src, 2);
  return out.buffer as ArrayBuffer;
}

export class FakeTranslationProvider implements TranslationProvider {
  readonly name = "fake" as const;

  private readonly delayMs: number;
  private readonly failAfter: number | undefined;
  private readonly dropRate: number;
  private readonly tagLanguage: boolean;
  private readonly sessions: Set<FakeTranslationSession> = new Set();

  constructor(options: FakeProviderOptions = {}) {
    const delayMs: number = options.delayMs ?? 50;
    const dropRate: number = options.dropRate ?? 0;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError(`FakeTranslationProvider: delayMs must be >= 0, got ${delayMs}`);
    }
    if (!Number.isFinite(dropRate) || dropRate < 0 || dropRate > 1) {
      throw new RangeError(`FakeTranslationProvider: dropRate must be in [0,1], got ${dropRate}`);
    }
    if (
      options.failAfter !== undefined &&
      (!Number.isInteger(options.failAfter) || options.failAfter < 1)
    ) {
      throw new RangeError(
        `FakeTranslationProvider: failAfter must be a positive integer, got ${options.failAfter}`,
      );
    }
    this.delayMs = delayMs;
    this.failAfter = options.failAfter;
    this.dropRate = dropRate;
    this.tagLanguage = options.tagLanguage ?? false;
  }

  openSession(
    sourceLang: Lang,
    targetLang: Lang,
    ev: TranslationSessionEvents,
  ): Promise<TranslationSession> {
    const session = new FakeTranslationSession(
      sourceLang,
      targetLang,
      ev,
      {
        delayMs: this.delayMs,
        failAfter: this.failAfter,
        dropRate: this.dropRate,
        tagLanguage: this.tagLanguage,
      },
      (s: FakeTranslationSession) => {
        this.sessions.delete(s);
      },
    );
    this.sessions.add(session);
    session.start();
    return Promise.resolve(session);
  }

  closeAll(): Promise<void> {
    const open: FakeTranslationSession[] = Array.from(this.sessions);
    this.sessions.clear();
    for (const s of open) s.close();
    return Promise.resolve();
  }
}
