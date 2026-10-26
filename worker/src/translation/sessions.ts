import type {
  Lang,
  TranslationProvider,
  TranslationSession,
  TranslationSessionEvents,
} from "./provider.js";

// SessionManager (T-008): lazy/shared/refcounted translation sessions.
// Key = src->tgt. Pure logic over TranslationProvider; no socket/DO code.
// T-009 drives acquire/release per floor holder + listener languages and
// consumes onSessionStatus for `session-status` broadcasts (docs/PROTOCOL.md).

/** Status union matches the wire `session-status` message (PROTOCOL.md §3). */
export type SessionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "failed"
  | "degraded";

/** Single status sink: (pair "src->tgt", status, reconnect attempt count). */
export type SessionStatusCallback = (
  pair: string,
  status: SessionStatus,
  attempt: number,
) => void;

/** Audio sink per pair; T-009 fans these chunks out to listeners. */
export type SessionAudioCallback = (pair: string, pcm: ArrayBuffer) => void;

export type SessionTranscriptCallback = (
  pair: string,
  kind: "input" | "output",
  text: string,
  final: boolean,
) => void;

export type SessionGoAwayCallback = (pair: string, timeLeftMs: number) => void;

export interface SessionManagerOptions {
  readonly maxSessions?: number;
  readonly idleCloseMs?: number;
  readonly onSessionStatus?: SessionStatusCallback;
  readonly onAudio?: SessionAudioCallback;
  readonly onTranscript?: SessionTranscriptCallback;
  readonly onGoAway?: SessionGoAwayCallback;
}

export interface AcquireOptions {
  readonly isTeacherLeg?: boolean;
}

export interface AcquireResult {
  readonly session: TranslationSession;
  readonly degraded: boolean;
}

export const DEFAULT_MAX_SESSIONS = 8;
export const DEFAULT_IDLE_CLOSE_MS = 60_000;
export const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 250;
const RECONNECT_CAP_MS = 5_000;
/** Gemini caps connections (~10 min) and random 500s/1006s happen; a session
 * that survives this long counts as proven-stable, so the retry budget resets
 * (rapid-fail exhaustion within 10 s still terminates the pair). */
const STABLE_LIVE_RESET_MS = 10_000;

export function pairKey(sourceLang: Lang, targetLang: Lang): string {
  return `${sourceLang}->${targetLang}`;
}

// DO-alarm-safe discipline (ARCHITECTURE.md §3): one-shot setTimeout chains
// only, never setInterval. unref where available so idle/backoff timers never
// hold a runtime open on their own; the DO uses alarm() for the same purpose.
interface CancellableTimer {
  cancel(): void;
}

type Unrefable = { readonly unref?: () => void };

function armTimer(ms: number, cb: () => void): CancellableTimer {
  const t = setTimeout(cb, ms);
  const maybe = t as unknown as Unrefable;
  if (typeof maybe.unref === "function") {
    maybe.unref();
  }
  return {
    cancel: () => {
      clearTimeout(t);
    },
  };
}

/** Degraded-cap handle: muted, emits nothing, silently drops input. */
class MutedSession implements TranslationSession {
  constructor(
    readonly sourceLang: Lang,
    readonly targetLang: Lang,
  ) {}

  sendInputAudio(_pcm: ArrayBuffer): void {
    // Muted by cap policy (FR-024): drop silently.
  }

  endInput(): void {
    // No-op: no underlying session to keep warm.
  }

  close(): void {
    // No-op: nothing was opened.
  }
}

/**
 * Stable shared handle: survives provider reconnects (the underlying session
 * is swapped transparently). Lifecycle is manager-owned, so close() is a
 * no-op — use release(listenerId) / idle-close / closeAll instead.
 */
class ManagedSession implements TranslationSession {
  private target: TranslationSession | null = null;

  constructor(
    readonly sourceLang: Lang,
    readonly targetLang: Lang,
  ) {}

  attach(session: TranslationSession | null): void {
    this.target = session;
  }

  sendInputAudio(pcm: ArrayBuffer): void {
    // During reconnect/open gaps the target is null: drop (never buffer audio).
    this.target?.sendInputAudio(pcm);
  }

  endInput(): void {
    this.target?.endInput();
  }

  close(): void {
    // Manager-owned: idle-close and closeAll are the only close paths.
  }
}

type ProviderLiveStatus = "connecting" | "live" | "reconnecting";

interface SessionEntry {
  readonly key: string;
  readonly sourceLang: Lang;
  readonly targetLang: Lang;
  readonly listeners: Map<string, boolean>;
  teacherLeg: boolean;
  readonly createdSeq: number;
  attempts: number;
  terminallyFailed: boolean;
  opening: boolean;
  /** Wall-clock time of the latest "live" status; null while not live. */
  liveSinceMs: number | null;
  readonly handle: ManagedSession;
  underlying: TranslationSession | null;
  /** Bumped per open so stale event callbacks / late resolves are ignored. */
  generation: number;
  idleTimer: CancellableTimer | null;
  reconnectTimer: CancellableTimer | null;
}

function anyTeacherLeg(listeners: Map<string, boolean>): boolean {
  for (const flag of listeners.values()) {
    if (flag) return true;
  }
  return false;
}

export class SessionManager {
  private readonly provider: TranslationProvider;
  private readonly maxSessions: number;
  private readonly idleCloseMs: number;
  private readonly onSessionStatus: SessionStatusCallback | undefined;
  private readonly onAudio: SessionAudioCallback | undefined;
  private readonly onTranscript: SessionTranscriptCallback | undefined;
  private readonly onGoAway: SessionGoAwayCallback | undefined;
  private readonly entries = new Map<string, SessionEntry>();
  private createdCounter = 0;

  constructor(provider: TranslationProvider, options: SessionManagerOptions = {}) {
    const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new RangeError(
        `SessionManager: maxSessions must be an integer >= 1, got ${maxSessions}`,
      );
    }
    if (!Number.isFinite(idleCloseMs) || idleCloseMs < 0) {
      throw new RangeError(
        `SessionManager: idleCloseMs must be >= 0, got ${idleCloseMs}`,
      );
    }
    this.provider = provider;
    this.maxSessions = maxSessions;
    this.idleCloseMs = idleCloseMs;
    this.onSessionStatus = options.onSessionStatus;
    this.onAudio = options.onAudio;
    this.onTranscript = options.onTranscript;
    this.onGoAway = options.onGoAway;
  }

  /** Live (non-degraded) pair count — for the metrics panel (FR-040). */
  get size(): number {
    return this.entries.size;
  }

  acquire(
    sourceLang: Lang,
    targetLang: Lang,
    listenerId: string,
    opts: AcquireOptions = {},
  ): AcquireResult {
    const key = pairKey(sourceLang, targetLang);
    const isTeacherLeg = opts.isTeacherLeg ?? false;
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.listeners.set(listenerId, isTeacherLeg);
      existing.teacherLeg = anyTeacherLeg(existing.listeners);
      this.clearIdle(existing);
      if (existing.terminallyFailed) {
        existing.terminallyFailed = false;
        existing.attempts = 0;
        this.openUnderlying(existing);
      } else if (
        existing.underlying === null &&
        existing.reconnectTimer === null
      ) {
        // Dead with no retry pending (e.g. backoff was cancelled by an
        // idle arm that a re-acquire just cleared): reopen now.
        this.openUnderlying(existing);
      }
      return { session: existing.handle, degraded: false };
    }
    // Cap (FR-024): existing pairs are all kept — teacher-leg sessions are
    // never preempted and earliest-created hold their slots; the newcomer is
    // degraded with a muted handle. Degraded acquires are stateless (no slot
    // held) so a later acquire retries for a live session.
    if (this.entries.size >= this.maxSessions) {
      this.emit(key, "degraded", 0);
      return { session: new MutedSession(sourceLang, targetLang), degraded: true };
    }
    const entry: SessionEntry = {
      key,
      sourceLang,
      targetLang,
      listeners: new Map<string, boolean>([[listenerId, isTeacherLeg]]),
      teacherLeg: isTeacherLeg,
      createdSeq: this.createdCounter,
      attempts: 0,
      terminallyFailed: false,
      opening: false,
      liveSinceMs: null,
      handle: new ManagedSession(sourceLang, targetLang),
      underlying: null,
      generation: 0,
      idleTimer: null,
      reconnectTimer: null,
    };
    this.createdCounter += 1;
    this.entries.set(key, entry);
    this.openUnderlying(entry);
    return { session: entry.handle, degraded: false };
  }

  release(listenerId: string): void {
    for (const entry of this.entries.values()) {
      if (!entry.listeners.delete(listenerId)) continue;
      entry.teacherLeg = anyTeacherLeg(entry.listeners);
      if (entry.listeners.size === 0) {
        this.armIdle(entry);
      }
    }
  }

  /** Shutdown path for room teardown: clears timers, closes all sessions. */
  closeAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      this.clearIdle(entry);
      this.clearReconnect(entry);
      entry.generation += 1;
      entry.underlying?.close();
      entry.handle.attach(null);
    }
    this.entries.clear();
    return this.provider.closeAll();
  }

  private openUnderlying(entry: SessionEntry): void {
    if (entry.opening) return;
    entry.opening = true;
    entry.generation += 1;
    const gen = entry.generation;
    const ev = this.makeEvents(entry, gen);
    let opened: Promise<TranslationSession>;
    try {
      opened = this.provider.openSession(entry.sourceLang, entry.targetLang, ev);
    } catch {
      this.onOpenSettled(entry, gen, null);
      return;
    }
    void opened.then(
      (session: TranslationSession) => {
        this.onOpenSettled(entry, gen, session);
      },
      () => {
        this.onOpenSettled(entry, gen, null);
      },
    );
  }

  private onOpenSettled(
    entry: SessionEntry,
    gen: number,
    session: TranslationSession | null,
  ): void {
    entry.opening = false;
    if (!this.isCurrent(entry, gen)) {
      // Idle-closed (or torn down) while opening: close the orphan, no leak.
      session?.close();
      return;
    }
    if (session === null) {
      this.scheduleRetry(entry);
      return;
    }
    entry.underlying = session;
    entry.handle.attach(session);
    // connecting/live statuses arrive via ev.onStatus with attempt counts.
  }

  private makeEvents(entry: SessionEntry, gen: number): TranslationSessionEvents {
    return {
      onAudio: (pcm: ArrayBuffer) => {
        if (!this.isCurrent(entry, gen)) return;
        this.onAudio?.(entry.key, pcm);
      },
      onTranscript: (kind, text, final) => {
        if (!this.isCurrent(entry, gen)) return;
        this.onTranscript?.(entry.key, kind, text, final);
      },
      onGoAway: (timeLeftMs) => {
        if (!this.isCurrent(entry, gen)) return;
        this.onGoAway?.(entry.key, timeLeftMs);
      },
      onStatus: (s: ProviderLiveStatus | "failed") => {
        if (!this.isCurrent(entry, gen)) return;
        if (s === "failed") {
          this.scheduleRetry(entry);
          return;
        }
        if (s === "live") {
          entry.liveSinceMs = Date.now();
        }
        this.emit(entry.key, s, entry.attempts);
      },
    };
  }

  private scheduleRetry(entry: SessionEntry): void {
    if (entry.liveSinceMs !== null && Date.now() - entry.liveSinceMs >= STABLE_LIVE_RESET_MS) {
      entry.attempts = 0;
    }
    entry.liveSinceMs = null;
    if (entry.attempts >= MAX_RECONNECT_ATTEMPTS) {
      entry.terminallyFailed = true;
      entry.underlying = null;
      entry.handle.attach(null);
      this.emit(entry.key, "failed", entry.attempts);
      return;
    }
    entry.attempts += 1;
    entry.underlying = null;
    entry.handle.attach(null);
    this.emit(entry.key, "reconnecting", entry.attempts);
    // Backoff 250ms*2^(n-1) capped at 5s (ARCHITECTURE.md §2.4).
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** (entry.attempts - 1),
      RECONNECT_CAP_MS,
    );
    this.clearReconnect(entry);
    const gen = entry.generation;
    entry.reconnectTimer = armTimer(delay, () => {
      entry.reconnectTimer = null;
      if (!this.isCurrent(entry, gen)) return;
      this.openUnderlying(entry);
    });
  }

  private armIdle(entry: SessionEntry): void {
    this.clearIdle(entry);
    // Zero refs but a reconnect in flight: cancel it — no provider sessions
    // while nobody listens. A later acquire reopens on demand.
    this.clearReconnect(entry);
    entry.idleTimer = armTimer(this.idleCloseMs, () => {
      entry.idleTimer = null;
      if (this.entries.get(entry.key) !== entry) return;
      this.clearReconnect(entry);
      entry.generation += 1;
      entry.underlying?.close();
      entry.handle.attach(null);
      this.entries.delete(entry.key);
    });
  }

  private clearIdle(entry: SessionEntry): void {
    entry.idleTimer?.cancel();
    entry.idleTimer = null;
  }

  private clearReconnect(entry: SessionEntry): void {
    entry.reconnectTimer?.cancel();
    entry.reconnectTimer = null;
  }

  private isCurrent(entry: SessionEntry, gen: number): boolean {
    return this.entries.get(entry.key) === entry && entry.generation === gen;
  }

  private emit(pair: string, status: SessionStatus, attempt: number): void {
    this.onSessionStatus?.(pair, status, attempt);
  }
}
