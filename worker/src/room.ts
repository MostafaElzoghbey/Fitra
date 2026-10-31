// T-006: ClassRoom DO — membership, upgrade auth, roster and the Hibernation
// WebSocket API (SPEC FR-001..007 / FR-050 / FR-052, docs/PROTOCOL.md sections
// 1/3/4, ARCHITECTURE.md section 3).
//
// One DO instance per room, routed by `env.CLASSROOM.idFromName(roomCode)`, so
// the room code in `state.id.name` is the authoritative room identity. SQLite
// (`new_sqlite_classes`) holds room config + membership ONLY: no per-message and
// never per-audio-chunk writes (AGENTS.md rule 2, docs/LIMITS.md).
//
// Sockets use the Hibernation API (`acceptWebSocket` + `serializeAttachment` +
// `webSocketMessage` / `webSocketClose`), so an idle room costs no duration and
// everything needed to resume a socket lives in the attachment plus SQLite,
// never in a live instance.
//
// NOT in this task: translation sessions and metrics (T-008 owns the
// SessionManager module, T-012 the metrics panel). Mic control (T-007/T-028)
// is wired below: `routeControl` dispatches through the pure machine in
// `mic.ts`, and the binary gate in `routeBinary` drops closed-mic frames
// (FR-012). Audio fan-out (T-009) lives in `routeBinary`/`fanoutAudio` below:
// open-mic frames fan out through the per-room SessionManager as per-speaker
// pipes, with `applyMicEffects` flushing/releasing refs on mic changes and
// `webSocketClose` releasing them on leave.
import {
  CodecError,
  decodeAudioFrame,
  encodeAudioFrame,
  FITRA_AUDIO_HEADER_BYTES,
  FITRA_AUDIO_MAX_PAYLOAD_BYTES,
  FITRA_AUDIO_TYPE_DOWNLINK,
  isClientMsg,
  nextAudioSeq,
  splitPayloadForWire,
  type DecodedAudioFrame,
  type Role,
  type RosterEntry,
  type ServerMsg,
} from "@fitra/shared";
import { verify, type JoinClaims } from "./auth/token.js";
import {
  applyMicControlRow,
  applyMicEvent,
  initialMicState,
  isMicOpen,
  micControlToRow,
  type MicControlRow,
  type MicEffect,
  type MicEvent,
  type MicResult,
  type MicState,
} from "./mic.js";
import { FakeTranslationProvider } from "./translation/fake.js";
import { GeminiTranslationProvider } from "./translation/gemini.js";
import {
  DEFAULT_IDLE_CLOSE_MS,
  DEFAULT_MAX_SESSIONS,
  pipeKey,
  SessionManager,
  type SessionStatus,
} from "./translation/sessions.js";
import { upsample16kTo24kMono } from "./resample.js";
import { MetricsCollector } from "./metrics.js";
import type {
  TranslationProvider,
  TranslationSession,
} from "./translation/provider.js";

export interface RoomEnv {
  readonly JOIN_TOKEN_HMAC_SECRET?: string;
  readonly MAX_STUDENTS?: number | string;
  readonly MAX_ROOM_MINUTES?: number | string;
  readonly SUPPORTED_LANGUAGES?: readonly string[] | string;
  readonly TRANSLATION_PROVIDER?: string;
  readonly GEMINI_API_KEY?: string;
  readonly MAX_TRANSLATION_SESSIONS?: number | string;
  readonly SESSION_IDLE_CLOSE_S?: number | string;
  readonly FAKE_EMIT_TRANSCRIPTS?: boolean | string;
}

/** FR-006 default allowlist; mirrors `DEFAULT_SUPPORTED_LANGUAGES` in index.ts. */
const DEFAULT_SUPPORTED_LANGUAGES: readonly string[] = ["ar", "en", "fr", "es"];
const DEFAULT_MAX_STUDENTS = 30;
const DEFAULT_MAX_ROOM_MINUTES = 120;
/** FR-052 idle-room shutdown, when the room sits empty. */
const DEFAULT_IDLE_ROOM_MINUTES = 15;
const MAX_NAME_LENGTH = 64;
const TEACHER_INDEX = 0;
const CLOSE_NORMAL = 1000;
/** FR-052: per-connection audio ingest ceiling (sliding 1 s window). */
const AUDIO_FRAMES_PER_SECOND = 20;
/** FR-052: per-connection control-message ceiling (sliding 1 s window). */
const CONTROL_MSG_PER_SECOND = 10;
const RATE_WINDOW_MS = 1000;
/** PROTOCOL section 2: max inbound binary frame (8-byte header + payload). */
const MAX_AUDIO_FRAME_BYTES =
  FITRA_AUDIO_HEADER_BYTES + FITRA_AUDIO_MAX_PAYLOAD_BYTES;

type RejectCode =
  | "unauthorized"
  | "unsupported-language"
  | "teacher-taken"
  | "room-full"
  | "room-closed"
  | "not-implemented-fanout"
  | "mic-closed"
  | "mic-forced-muted"
  | "mute-absent"
  | "rate-limited"
  | "frame-too-large"
  | "session-degraded"
  | "bad-message";

/** Exactly what `serializeAttachment` carries for one live socket. */
interface SocketMember {
  readonly pid: string;
  readonly role: Role;
  readonly index: number;
  /** Monotonic per-join counter: a stale socket's close must not evict a rejoin. */
  readonly session: number;
}

interface MemberRow extends Record<string, SqlStorageValue> {
  readonly participant_id: string;
  readonly participant_index: number;
  readonly role: string;
  readonly name: string;
  readonly lang: string;
}

interface RoomRow extends Record<string, SqlStorageValue> {
  readonly created_at_ms: number;
  readonly next_index: number;
  readonly next_session: number;
  readonly teacher_lang: string | null;
  readonly expired_at_ms: number | null;
}

interface IndexRow extends Record<string, SqlStorageValue> {
  readonly participant_index: number;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  readonly session: number;
}

interface MicControlSqlRow extends Record<string, SqlStorageValue> {
  readonly mute_all_active: number;
  readonly forced_muted: string;
}

interface LiveSocket {
  readonly ws: WebSocket;
  readonly member: SocketMember;
}

type Admission =
  | { ok: true; member: SocketMember; replaces: WebSocket | null }
  | { ok: false; code: RejectCode; message: string };

function parseList(raw: RoomEnv["SUPPORTED_LANGUAGES"]): readonly string[] {
  if (Array.isArray(raw)) {
    const list = raw.filter((l): l is string => typeof l === "string");
    return list.length > 0 ? list : DEFAULT_SUPPORTED_LANGUAGES;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const list = parsed.filter((l): l is string => typeof l === "string");
          if (list.length > 0) return list;
        }
      } catch {
        // Not JSON: fall through to CSV parsing.
      }
    }
    const list = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return list.length > 0 ? list : DEFAULT_SUPPORTED_LANGUAGES;
  }
  return DEFAULT_SUPPORTED_LANGUAGES;
}

function parseCount(
  raw: number | string | undefined,
  fallback: number,
  min: number,
): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
}

function normalizeName(raw: string | null, pid: string): string {
  if (raw === null) return pid;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return pid;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

function isRole(value: unknown): value is Role {
  return value === "teacher" || value === "student";
}

function asRejectCode(code: string): RejectCode {
  switch (code) {
    case "mic-closed":
    case "mic-forced-muted":
    case "mute-absent":
    case "teacher-taken":
      return code;
    default:
      return "bad-message";
  }
}

function micErrorMessage(
  code: string,
  participantId: string | undefined,
): string {
  switch (code) {
    case "mic-forced-muted":
      return "the teacher has muted you; you cannot open your mic";
    case "mic-closed":
      return `audio from ${participantId ?? "sender"} dropped: the mic is closed`;
    case "mute-absent":
      return `cannot mute ${participantId ?? "unknown"}: not a connected student`;
    case "teacher-taken":
      return "the room already has a teacher";
    default:
      return `mic control rejected: ${code}`;
  }
}

export class ClassRoom {
  private readonly state: DurableObjectState;
  private readonly env: RoomEnv;
  /**
   * Mic state (micOpen/forcedMuted per pid), owned by the pure machine in
   * mic.ts. The force-mute policy (forcedMuted + muteAllActive) is persisted
   * to the `mic_control` row so a hibernation wake reloads the teacher's mute
   * latch; micOpen stays memory-only because an open mic streams frames
   * continuously, which prevents hibernation. Still no per-audio/caption
   * writes (AGENTS.md rule 2).
   */
  private micState: MicState = initialMicState();
  /** mic_control row applied to this wake; load-once per isolate. */
  private micControlLoaded = false;
  /** Last persisted mic_control signature; skips no-op SQLite writes. */
  private persistedMicControl: string | null = null;
  /** Mic-gate violation counter: binary frames dropped from closed mics. */
  private micViolations = 0;
  /**
   * Lazily created on the first holder frame: one SessionManager per room
   * (FR-020), shared across all `(source -> target)` pairs. Null means no
   * provider is available (gemini selected before T-015 lands): same-language
   * relay still works, translation legs report `session-degraded`.
   */
  private sessions: SessionManager | null = null;
  /** Sliding-1s audio/control ingest timestamps per pid (FR-052). */
  private readonly audioStamps = new Map<string, number[]>();
  private readonly controlStamps = new Map<string, number[]>();
  /** Consecutive over-rate audio drops per pid; an accepted frame resets it. */
  private readonly audioOverRuns = new Map<string, number>();
  /** Audio drops outside the mic gate (decode errors, rate/size rejects). */
  private audioDrops = 0;
  /**
   * Per (listener pid, source speaker index) outgoing sequence counters for
   * type-0x02 frames: parallel speaker pipes keep independent cursors so a
   * client can demux by the downlink `speaker` field without fake loss.
   */
  private readonly outSeq = new Map<string, Map<number, number>>();
  /** T-020 counters: pure, timer-free; pulses ride real events only. */
  private readonly collector = new MetricsCollector();
  /** Re-entrancy guard: the metrics send's own recordOutbound must not pulse. */
  private pulsing = false;
  /** room_config.created_at_ms, cached after the first successful read. */
  private roomCreatedAtMs: number | null = null;

  constructor(state: DurableObjectState, env: RoomEnv) {
    this.state = state;
    this.env = env;
    void state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          code TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          next_index INTEGER NOT NULL,
          next_session INTEGER NOT NULL,
          teacher_lang TEXT,
          expired_at_ms INTEGER
        );
      `);
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS mic_control (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          mute_all_active INTEGER NOT NULL,
          forced_muted TEXT NOT NULL
        );
      `);
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS membership (
          participant_id TEXT PRIMARY KEY,
          participant_index INTEGER NOT NULL UNIQUE,
          session INTEGER NOT NULL,
          role TEXT NOT NULL,
          name TEXT NOT NULL,
          lang TEXT NOT NULL
        );
      `);
    });
  }

  // --- upgrade -------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Internal Worker<->DO control plane (T-017 production fix). index.ts
    // routes ONLY /rooms/:code/ws to the DO, so these paths are unreachable
    // from browsers. They let room creation survive Worker isolate eviction:
    // the isolate-local map in index.ts is a fast path, DO SQLite is truth.
    if (url.pathname === "/internal/register" && request.method === "POST") {
      return this.handleRegister(request);
    }
    if (url.pathname === "/internal/room" && request.method === "GET") {
      const room = this.loadRoom();
      if (room === null) return Response.json({ exists: false });
      return Response.json({
        exists: true,
        code: this.roomCode(),
        teacherLang: room.teacher_lang,
        createdAtMs: room.created_at_ms,
      });
    }
    if (!url.pathname.endsWith("/ws")) {
      return this.rejectUpgrade(404, "not-found", "expected the /ws endpoint");
    }
    if (request.method !== "GET") {
      return this.rejectUpgrade(405, "method-not-allowed", "expected GET");
    }

    const secret = this.env.JOIN_TOKEN_HMAC_SECRET;
    if (secret === undefined || secret.length === 0) {
      return this.rejectUpgrade(401, "unauthorized", "join token secret unset");
    }
    const token = url.searchParams.get("token");
    if (token === null || token.length === 0) {
      return this.rejectUpgrade(401, "unauthorized", "missing join token");
    }
    const claims = await verify(token, secret);
    if (claims === null) {
      return this.rejectUpgrade(401, "unauthorized", "invalid join token");
    }
    if (claims.room !== this.roomCode()) {
      return this.rejectUpgrade(401, "unauthorized", "token is for another room");
    }
    if (!parseList(this.env.SUPPORTED_LANGUAGES).includes(claims.lang)) {
      return this.rejectUpgrade(
        401,
        "unsupported-language",
        `unsupported language: ${claims.lang}`,
      );
    }

    const admission = this.admit(
      claims,
      normalizeName(url.searchParams.get("name"), claims.pid),
    );
    if (!admission.ok) {
      return this.upgradeThenReject(admission.code, admission.message);
    }
    return this.acceptJoin(admission.member, admission.replaces);
  }

  // --- hibernation handlers ----------------------------------------------

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const member = this.memberOf(ws);
    if (member === null) return;
    // T-020 single inbound boundary: every received frame (binary + control)
    // counts before validation/rate limiting, because it counts frames
    // received, not frames accepted.
    this.collector.recordInbound(Date.now());
    if (typeof message === "string") {
      this.routeControl(ws, member, message);
    } else {
      this.routeBinary(ws, member, message);
    }
    // Event-driven cadence (FR-042/043): the broadcast piggybacks on this
    // real event; the 2 s throttle inside the collector suppresses excess.
    this.pulseMetrics(false);
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const member = this.memberOf(ws);
    if (member === null) return;
    this.ensureMicControlLoaded();
    // Only the socket that owns the current membership row may evict it: a
    // rejoin bumps `session`, so the replaced socket's close is a no-op here.
    const row = this.state.storage.sql
      .exec<SessionRow>(
        "SELECT session FROM membership WHERE participant_id = ?",
        member.pid,
      )
      .toArray()[0];
    if (row !== undefined && row.session === member.session) {
      this.state.storage.sql.exec(
        "DELETE FROM membership WHERE participant_id = ?",
        member.pid,
      );
      this.invalidateMemberLangs();
      this.sessions?.release(member.pid);
      this.audioStamps.delete(member.pid);
      this.controlStamps.delete(member.pid);
      this.audioOverRuns.delete(member.pid);
      this.outSeq.delete(member.pid);
      // A departure that was speaking broadcasts mic-changed{false}; the
      // machine also clears their force-mute flag with the roster row.
      this.publishMic(
        applyMicEvent(this.micState, {
          type: "participantDisconnect",
          participantId: member.pid,
          isTeacher: member.role === "teacher",
        }),
        null,
        member.index,
      );
    }
    this.syncRoster();
    await this.scheduleCleanup();
  }

  // --- control / binary routing (extension seams) -------------------------

  /**
   * JSON control frames (docs/PROTOCOL.md section 3). Anything that is not a
   * valid `ClientMsg` gets `error{bad-message}` — never a silent drop.
   * Mic frames are role-checked (mute/unmute/mute-all/unmute-all are
   * teacher-only) and then dispatched through the pure machine in mic.ts.
   */
  private routeControl(ws: WebSocket, member: SocketMember, raw: string): void {
    this.ensureMicControlLoaded();
    if (!this.checkControlRate(ws, member)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.sendError(ws, "bad-message", "control frame is not JSON");
      return;
    }
    if (!isClientMsg(parsed)) {
      this.sendError(ws, "bad-message", "control frame rejected by isClientMsg");
      return;
    }
    switch (parsed.t) {
      case "ping":
        this.trySend(
          ws,
          JSON.stringify({ t: "pong", id: parsed.id } satisfies ServerMsg),
        );
        return;
      case "mic-open":
        this.dispatchMic(ws, {
          type: "micOpen",
          participantId: member.pid,
          isTeacher: member.role === "teacher",
        });
        return;
      case "mic-close":
        this.dispatchMic(ws, { type: "micClose", participantId: member.pid });
        return;
      case "mute":
      case "unmute": {
        if (member.role !== "teacher") {
          this.sendError(
            ws,
            "bad-message",
            `${parsed.t} from ${member.pid}: only the teacher controls mutes`,
          );
          return;
        }
        if (!this.studentExists(parsed.participantId)) {
          this.sendError(
            ws,
            "mute-absent",
            micErrorMessage("mute-absent", parsed.participantId),
          );
          return;
        }
        this.dispatchMic(ws, {
          type: parsed.t === "mute" ? "mute" : "unmute",
          participantId: parsed.participantId,
        });
        return;
      }
      case "mute-all":
      case "unmute-all": {
        if (member.role !== "teacher") {
          this.sendError(
            ws,
            "bad-message",
            `${parsed.t} from ${member.pid}: only the teacher controls mutes`,
          );
          return;
        }
        this.dispatchMic(ws, {
          type: parsed.t === "mute-all" ? "muteAll" : "unmuteAll",
          studentIds: this.studentIds(),
        });
        return;
      }
      default: {
        const _exhaustive: never = parsed;
        return _exhaustive;
      }
    }
  }

  /** FR-052: at most 10 control frames/s per connection; excess is dropped. */
  private checkControlRate(ws: WebSocket, member: SocketMember): boolean {
    const now = Date.now();
    const fresh = (this.controlStamps.get(member.pid) ?? []).filter(
      (t) => now - t < RATE_WINDOW_MS,
    );
    if (fresh.length >= CONTROL_MSG_PER_SECOND) {
      this.controlStamps.set(member.pid, fresh);
      this.sendError(
        ws,
        "rate-limited",
        `control rate exceeded (${CONTROL_MSG_PER_SECOND}/s): frame dropped`,
      );
      return false;
    }
    fresh.push(now);
    this.controlStamps.set(member.pid, fresh);
    return true;
  }

  /** Feed one role-checked control event into the mic machine and publish. */
  private dispatchMic(requester: WebSocket, event: MicEvent): void {
    this.publishMic(applyMicEvent(this.micState, event), requester);
  }

  /**
   * Apply a machine result: adopt its state, translate session effects, and
   * broadcast. `mic-changed` and `roster` go to every live socket (roster as a
   * per-socket `welcome` re-render); a machine `error` answers the requester
   * only. A null requester (disconnect path) drops machine errors — that path
   * never produces them.
   */
  private publishMic(
    result: MicResult,
    requester: WebSocket | null,
    disconnectIndex?: number,
  ): void {
    this.micState = result.state;
    this.applyMicEffects(result.effects, disconnectIndex);
    this.persistMicControl();
    for (const broadcast of result.broadcasts) {
      switch (broadcast.type) {
        case "mic-changed": {
          const msg = JSON.stringify({
            t: "mic-changed",
            participantId: broadcast.participantId,
            micOpen: broadcast.micOpen,
          } satisfies ServerMsg);
          for (const { ws } of this.liveSockets()) this.trySend(ws, msg);
          break;
        }
        case "roster":
          this.syncRoster();
          break;
        case "error": {
          if (requester !== null) {
            this.sendError(
              requester,
              asRejectCode(broadcast.code),
              micErrorMessage(
                broadcast.code,
                broadcast.participantId ?? broadcast.to,
              ),
            );
          }
          break;
        }
        default: {
          const _exhaustive: never = broadcast;
          return _exhaustive;
        }
      }
    }
  }

  /**
   * Translate machine session effects into SessionManager calls. Pipe refs
   * are per-(speaker, listener), so a forced cut releases the speaker's whole
   * pipe set and a voluntary close releases it right after the flush (the
   * already-translating tail drains through the idle window).
   *
   * `forcedIndex` overrides pid→index resolution for every effect in the
   * batch: on disconnect the membership row is already deleted, and a lookup
   * would fall back to the teacher's index 0 — releasing the teacher's pipes
   * instead of the departed speaker's.
   */
  private applyMicEffects(
    effects: readonly MicEffect[],
    forcedIndex?: number,
  ): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case "flushSpeaker":
          this.sessions?.flushSpeaker(
            forcedIndex ?? this.memberIndexOf(effect.participantId),
          );
          break;
        case "closeSpeakerPipes":
          this.sessions?.closeSpeakerPipes(
            forcedIndex ?? this.memberIndexOf(effect.participantId),
          );
          break;
        case "ensureSession":
          // Mic-open opens the speaker's pipe set eagerly so the first
          // spoken frame does not pay the session-opening gap (PROTOCOL 4.1).
          this.prewarmSessions(effect.source);
          break;
        default: {
          const _exhaustive: never = effect;
          return _exhaustive;
        }
      }
    }
  }

  /**
   * Reload the persisted force-mute policy after a hibernation wake.
   * Load-once per isolate and idempotent; called before the first mic
   * mutation on every public entry (join, control, disconnect).
   */
  private ensureMicControlLoaded(): void {
    if (this.micControlLoaded) return;
    this.micControlLoaded = true;
    const row = this.state.storage.sql
      .exec<MicControlSqlRow>(
        "SELECT mute_all_active, forced_muted FROM mic_control WHERE id = 1",
      )
      .toArray()[0];
    if (row === undefined) {
      this.persistedMicControl = "0:[]";
      return;
    }
    let forced: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row.forced_muted));
      if (Array.isArray(parsed)) {
        forced = parsed.filter((p): p is string => typeof p === "string");
      }
    } catch {
      // corrupt persisted row: fall back to the empty policy
    }
    const control: MicControlRow = {
      muteAllActive: row.mute_all_active !== 0,
      forcedPids: forced,
    };
    this.micState = applyMicControlRow(this.micState, control);
    this.persistedMicControl = `${control.muteAllActive ? 1 : 0}:${
      JSON.stringify(control.forcedPids)
    }`;
  }

  /** Persist the force-mute policy; skips the write when nothing changed. */
  private persistMicControl(): void {
    const row = micControlToRow(this.micState);
    const sig = `${row.muteAllActive ? 1 : 0}:${JSON.stringify(row.forcedPids)}`;
    if (this.persistedMicControl === sig) return;
    this.state.storage.sql.exec(
      `INSERT INTO mic_control (id, mute_all_active, forced_muted)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         mute_all_active = excluded.mute_all_active,
         forced_muted = excluded.forced_muted`,
      row.muteAllActive ? 1 : 0,
      JSON.stringify(row.forcedPids),
    );
    this.persistedMicControl = sig;
  }

  /** Student pid -> join-language rows are the roster; these helpers read the
   * live membership table (cached until any row changes). */
  private studentIds(): string[] {
    const ids: string[] = [];
    for (const [pid, role] of this.memberRoles()) {
      if (role === "student") ids.push(pid);
    }
    return ids;
  }

  private studentExists(pid: string): boolean {
    return this.memberRoles().get(pid) === "student";
  }

  private memberRolesCache: Map<string, Role> | null = null;

  private invalidateMemberLangs(): void {
    this.memberLangsCache = null;
    this.memberRolesCache = null;
  }

  private memberRoles(): Map<string, Role> {
    const cached = this.memberRolesCache;
    if (cached !== null) return cached;
    const roles = new Map<string, Role>();
    for (const row of this.state.storage.sql
      .exec<MemberRow>("SELECT participant_id, role FROM membership")
      .toArray()) {
      if (isRole(row.role)) roles.set(row.participant_id, row.role);
    }
    this.memberRolesCache = roles;
    return roles;
  }

  /** participantIndex for a membership row; 0 (teacher) when unknown. */
  private memberIndexOf(pid: string): number {
    const row = this.state.storage.sql
      .exec<IndexRow & { participant_id: string }>(
        "SELECT participant_index, participant_id FROM membership WHERE participant_id = ?",
        pid,
      )
      .toArray()[0];
    return row?.participant_index ?? TEACHER_INDEX;
  }

  /**
   * Binary frames are audio (docs/PROTOCOL.md section 2). The mic gate
   * (FR-012) requires an open mic: frames from a closed mic are dropped,
   * counted, and answered with `error{mic-closed}`. Open-mic frames are
   * rate/size checked, decoded (header only — payload is never parsed), and
   * fanned out: same-language listeners get a 24 kHz type-0x02 re-wrap of the
   * frame (FR-021, no session — the 16 kHz uplink payload is linearly
   * upsampled so the PROTOCOL section 2 "24 kHz output" contract holds for
   * every listener frame), every other language group shares one
   * SessionManager pipe (FR-020/022/023), and the speaker is always excluded
   * (FR-015).
   */
  private routeBinary(
    ws: WebSocket,
    member: SocketMember,
    frame: ArrayBuffer,
  ): void {
    const gate = applyMicEvent(this.micState, {
      type: "audioFrame",
      participantId: member.pid,
    });
    const rejection = gate.broadcasts[0];
    if (rejection !== undefined && rejection.type === "error") {
      this.micViolations += 1;
      const code = asRejectCode(rejection.code);
      // The machine answers the truthful reason (a force-muted sender gets
      // `mic-forced-muted`, not "open your mic"); the DO only appends the
      // violation counter.
      this.sendError(
        ws,
        code,
        `${micErrorMessage(code, member.pid)} (violation ${this.micViolations})`,
      );
      return;
    }
    if (rejection !== undefined) {
      // The audioFrame arm never emits non-error broadcasts; kept for the
      // exhaustive MicBroadcast shape.
      return;
    }
    if (!this.checkAudioRate(ws, member)) return;
    const bytes = new Uint8Array(frame);
    if (bytes.length > MAX_AUDIO_FRAME_BYTES) {
      this.audioDrops += 1;
      this.sendError(
        ws,
        "frame-too-large",
        `audio frame ${bytes.length} exceeds ${MAX_AUDIO_FRAME_BYTES} bytes`,
      );
      return;
    }
    let decoded: DecodedAudioFrame;
    try {
      decoded = decodeAudioFrame(bytes);
    } catch (err) {
      this.audioDrops += 1;
      if (err instanceof CodecError && err.code === "frame-too-large") {
        this.sendError(ws, "frame-too-large", err.message);
      }
      return;
    }
    this.fanoutAudio(member, decoded);
  }

  /** FR-052: at most 20 audio frames/s per connection; the first over-rate frame
   * in a burst is dropped silently, repeated bursts answer `rate-limited`. */
  private checkAudioRate(ws: WebSocket, member: SocketMember): boolean {
    const now = Date.now();
    const fresh = (this.audioStamps.get(member.pid) ?? []).filter(
      (t) => now - t < RATE_WINDOW_MS,
    );
    if (fresh.length >= AUDIO_FRAMES_PER_SECOND) {
      this.audioStamps.set(member.pid, fresh);
      this.audioDrops += 1;
      const over = (this.audioOverRuns.get(member.pid) ?? 0) + 1;
      this.audioOverRuns.set(member.pid, over);
      if (over >= 2) {
        this.sendError(
          ws,
          "rate-limited",
          `audio rate exceeded (${AUDIO_FRAMES_PER_SECOND}/s): frame dropped`,
        );
      }
      return false;
    }
    fresh.push(now);
    this.audioStamps.set(member.pid, fresh);
    this.audioOverRuns.set(member.pid, 0);
    return true;
  }

  // --- fan-out (T-009) ----------------------------------------------------

  /** One SessionManager per room; provider from env (default fake, M0). */
  private ensureSessions(): SessionManager | null {
    if (this.sessions !== null) return this.sessions;
    let provider: TranslationProvider;
    if (this.env.TRANSLATION_PROVIDER === "gemini") {
      try {
        provider = new GeminiTranslationProvider(this.env.GEMINI_API_KEY ?? "");
      } catch {
        return null;
      }
    } else {
      provider = new FakeTranslationProvider({
        emitTranscripts:
          this.env.FAKE_EMIT_TRANSCRIPTS === true ||
          this.env.FAKE_EMIT_TRANSCRIPTS === "1",
      });
    }
    this.sessions = new SessionManager(provider, {
      maxSessions: parseCount(
        this.env.MAX_TRANSLATION_SESSIONS,
        DEFAULT_MAX_SESSIONS,
        1,
      ),
      idleCloseMs:
        parseCount(
          this.env.SESSION_IDLE_CLOSE_S,
          DEFAULT_IDLE_CLOSE_MS / 1000,
          0,
        ) * 1000,
      onSessionStatus: (pair, status, attempt) => {
        this.broadcastSessionStatus(pair, status, attempt);
      },
      onAudio: (pair, speakerIndex, pcm) => {
        this.forwardTranslated(pair, speakerIndex, pcm);
      },
      onTranscript: (pair, speakerIndex, kind, text, final) => {
        this.broadcastCaption(pair, speakerIndex, kind, text, final);
      },
    });
    return this.sessions;
  }

  private memberLangsCache: Map<string, string> | null = null;

  /** pid -> join language for every membership row (read-only, no writes). */
  private memberLangs(): Map<string, string> {
    const cached = this.memberLangsCache;
    if (cached !== null) return cached;
    const langs = new Map<string, string>();
    const rows = this.state.storage.sql
      .exec<MemberRow>("SELECT participant_id, role, name, lang FROM membership")
      .toArray();
    for (const row of rows) langs.set(row.participant_id, row.lang);
    this.memberLangsCache = langs;
    return langs;
  }

  private fanoutAudio(
    speaker: SocketMember,
    decoded: DecodedAudioFrame,
  ): void {
    const langs = this.memberLangs();
    const sourceLang = langs.get(speaker.pid);
    if (sourceLang === undefined) {
      this.audioDrops += 1;
      return;
    }
    const manager = this.ensureSessions();
    const payload = decoded.payload;
    const payloadBuf = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength,
    ) as ArrayBuffer;
    // Group translation listeners per pipe: a pipe's uplink must be fed ONCE
    // per frame regardless of listener count — feeding it once per listener
    // garbles streaming transcription and multiplies speaker turns.
    const membersByLang = new Map<string, LiveSocket[]>();
    for (const entry of this.liveSockets()) {
      if (entry.member.pid === speaker.pid) continue;
      const targetLang = langs.get(entry.member.pid);
      if (targetLang === undefined) continue;
      if (targetLang === sourceLang) {
        this.relayAudio(entry, speaker, payload);
        continue;
      }
      const group = membersByLang.get(targetLang);
      if (group === undefined) membersByLang.set(targetLang, [entry]);
      else group.push(entry);
    }
    if (membersByLang.size === 0) return;
    if (manager === null) {
      for (const [targetLang, group] of membersByLang) {
        for (const { ws } of group) {
          this.sendError(
            ws,
            "session-degraded",
            `translation unavailable for ${sourceLang}->${targetLang}: audio muted`,
          );
        }
      }
      return;
    }
    for (const [targetLang, group] of membersByLang) {
      const pair = pipeKey(speaker.index, sourceLang, targetLang);
      let feed: TranslationSession | null = null;
      for (const { ws, member } of group) {
        const acquired = manager.acquire(
          speaker.index,
          sourceLang,
          targetLang,
          member.pid,
          { isTeacherLeg: member.role === "teacher" },
        );
        if (acquired.degraded) {
          this.sendError(
            ws,
            "session-degraded",
            `translation capped for ${pair}: audio muted`,
          );
        } else if (feed === null) {
          feed = acquired.session;
        }
      }
      if (feed !== null) feed.sendInputAudio(payloadBuf);
    }
  }

  private relayAudio(
    { ws, member }: Pick<LiveSocket, "ws" | "member">,
    speaker: SocketMember,
    payload: Uint8Array,
  ): void {
    // Same-language relay (FR-021, no translation session): the uplink
    // payload is 16 kHz, but DO->client frames are 24 kHz (PROTOCOL
    // section 2), so resample and re-wrap as type-0x02 with this
    // listener's own per-pipe downlink sequence. Relaying the raw uplink
    // bytes played 16 kHz samples at 24 kHz on the listener (1.5x speed,
    // raised pitch, choppy buffering).
    const upsampled = upsample16kTo24kMono(payload);
    if (upsampled.length === 0) return;
    // A legal 8192-byte uplink becomes 12288 bytes after upsampling, which
    // the codec rejects as frame-too-large. Split exactly like translated
    // audio so large same-language frames are not silently dropped.
    const pieces = splitPayloadForWire(upsampled);
    let seq = this.outSeqFor(member.pid, speaker.index);
    for (const piece of pieces) {
      let relay: Uint8Array;
      try {
        relay = encodeAudioFrame({
          type: FITRA_AUDIO_TYPE_DOWNLINK,
          seq,
          speaker: speaker.index,
          payload: piece,
        });
      } catch {
        this.audioDrops += 1;
        continue;
      }
      seq = nextAudioSeq(seq);
      this.trySend(ws, relay);
    }
    this.storeOutSeq(member.pid, speaker.index, seq);
  }

  private outSeqFor(listenerPid: string, speakerIndex: number): number {
    return this.outSeq.get(listenerPid)?.get(speakerIndex) ?? 0;
  }

  private storeOutSeq(
    listenerPid: string,
    speakerIndex: number,
    seq: number,
  ): void {
    const perSpeaker = this.outSeq.get(listenerPid) ?? new Map<number, number>();
    perSpeaker.set(speakerIndex, seq);
    this.outSeq.set(listenerPid, perSpeaker);
  }

  /** Mic-open pre-warms the speaker's pipe set eagerly (ensureSession effect)
   * so the first spoken frame does not pay the session-opening gap. Acquire
   * is idempotent per listener pid, so refs here match the per-frame path. */
  private prewarmSessions(sourcePid: string): void {
    const manager = this.ensureSessions();
    if (manager === null) return;
    const langs = this.memberLangs();
    const sourceLang = langs.get(sourcePid);
    if (sourceLang === undefined) return;
    const speakerIndex = this.memberIndexOf(sourcePid);
    for (const { member } of this.liveSockets()) {
      if (member.pid === sourcePid) continue;
      const targetLang = langs.get(member.pid);
      if (targetLang === undefined || targetLang === sourceLang) continue;
      manager.acquire(speakerIndex, sourceLang, targetLang, member.pid, {
        isTeacherLeg: member.role === "teacher",
      });
    }
  }

  /** Wrap provider output in type-0x02 frames, one sequence per (listener,
   * speaker) pipe. Provider chunks are arbitrarily sized (a Gemini turn
   * dwarfs one 100 ms frame), so split them first: oversize payloads used to
   * die silently in the codec's `frame-too-large` rejection, muting
   * translation entirely. */
  private forwardTranslated(
    pair: string,
    speakerIndex: number,
    pcm: ArrayBuffer,
  ): void {
    const sep = pair.indexOf("->");
    if (sep < 0) return;
    const targetLang = pair.slice(sep + 2);
    const langs = this.memberLangs();
    const pieces = splitPayloadForWire(new Uint8Array(pcm));
    if (pieces.length === 0) return;
    for (const { ws, member } of this.liveSockets()) {
      if (langs.get(member.pid) !== targetLang) continue;
      let seq = this.outSeqFor(member.pid, speakerIndex);
      for (const piece of pieces) {
        let frame: Uint8Array;
        try {
          frame = encodeAudioFrame({
            type: FITRA_AUDIO_TYPE_DOWNLINK,
            seq,
            speaker: speakerIndex,
            payload: piece,
          });
        } catch {
          this.audioDrops += 1;
          continue;
        }
        seq = nextAudioSeq(seq);
        this.trySend(ws, frame);
      }
      this.storeOutSeq(member.pid, speakerIndex, seq);
    }
  }

  private broadcastSessionStatus(
    pair: string,
    status: SessionStatus,
    attempt: number,
  ): void {
    const msg = JSON.stringify({
      t: "session-status",
      pair,
      status,
      attempt,
    } satisfies ServerMsg);
    for (const { ws } of this.liveSockets()) this.trySend(ws, msg);
    // A status transition is the one thing the panel must see immediately
    // (PROTOCOL section 3.3): forced bypasses the 2 s throttle.
    this.pulseMetrics(true);
  }

  /**
   * PROTOCOL section 3.1 caption routing: both caption kinds go to the pipe's
   * target-language members and to the pipe's source speaker, so the sender
   * sees their own original and translated text. Same-language non-speakers
   * stay excluded because a pipe's target always differs from its source.
   */
  private broadcastCaption(
    pair: string,
    speakerIndex: number,
    kind: "input" | "output",
    text: string,
    final: boolean,
  ): void {
    const sep = pair.indexOf("->");
    if (sep < 0) return;
    const targetLang = pair.slice(sep + 2);
    const langs = this.memberLangs();
    const msg = JSON.stringify({
      t: "caption",
      kind,
      text,
      final,
      speaker: speakerIndex,
    } satisfies ServerMsg);
    for (const { ws, member } of this.liveSockets()) {
      const lang = langs.get(member.pid);
      if (lang === undefined) continue;
      if (lang === targetLang || member.index === speakerIndex) {
        this.trySend(ws, msg);
      }
    }
  }

  /** Best-effort send: a socket that raced us to close must not kill fan-out.
   * T-020: the single outbound accounting boundary — every DO→browser frame
   * (audio pieces, control, metrics, errors) passes through here exactly once. */
  private trySend(ws: WebSocket, data: string | ArrayBuffer | Uint8Array): void {
    try {
      ws.send(data);
      this.collector.recordOutbound(Date.now());
    } catch {
      return;
    }
  }

  /**
   * T-020/FR-042: emit one `metrics` frame when a real event piggybacks it.
   * Never scheduled: an idle room has no events, so it emits nothing and
   * stays hibernatable (FR-043). Forced pulses (session-status) bypass the
   * 2 s throttle; `pulsing` prevents the metrics send's own recordOutbound
   * from recursively entering this method.
   */
  private pulseMetrics(forced: boolean): void {
    if (this.pulsing) return;
    const sockets = this.liveSockets();
    if (sockets.length === 0) return;
    const now = Date.now();
    if (!this.collector.shouldEmit(now, forced)) return;
    if (this.roomCreatedAtMs === null) {
      const room = this.loadRoom() ?? this.ensureRoom(this.roomCode());
      this.roomCreatedAtMs = room.created_at_ms;
    }
    const m = this.collector.snapshot(
      now,
      this.roomCreatedAtMs,
      this.sessions?.snapshotSessions() ?? [],
    );
    const msg = JSON.stringify({ t: "metrics", m } satisfies ServerMsg);
    this.pulsing = true;
    try {
      for (const { ws } of sockets) this.trySend(ws, msg);
    } finally {
      this.pulsing = false;
    }
  }

  // --- mic seams for T-007/T-028 ------------------------------------------

  /** Observability hook for T-012 metrics: mic-gate drops so far. */
  getMicViolations(): number {
    return this.micViolations;
  }

  /** Observability hook for T-012 metrics: audio drops outside the mic gate. */
  getAudioDrops(): number {
    return this.audioDrops;
  }

  // --- membership ---------------------------------------------------------

  private async handleRegister(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = (await request.json()) as unknown;
    } catch {
      return Response.json({ t: "error", code: "invalid-body" }, { status: 400 });
    }
    if (
      typeof body !== "object" ||
      body === null ||
      (body as { code?: unknown }).code !== this.roomCode()
    ) {
      return Response.json({ t: "error", code: "invalid-body" }, { status: 400 });
    }
    const lang = (body as { teacherLang?: unknown }).teacherLang;
    const room = this.ensureRoom(this.roomCode());
    if (typeof lang === "string" && lang.length > 0 && room.teacher_lang === null) {
      this.state.storage.sql.exec("UPDATE room_config SET teacher_lang = ? WHERE id = 1", lang);
    }
    return Response.json({ ok: true, code: this.roomCode() });
  }

  private roomCode(): string {
    return this.state.id.name ?? "";
  }

  private maxStudents(): number {
    return parseCount(this.env.MAX_STUDENTS, DEFAULT_MAX_STUDENTS, 1);
  }

  private maxRoomMs(): number {
    return (
      parseCount(this.env.MAX_ROOM_MINUTES, DEFAULT_MAX_ROOM_MINUTES, 1) * 60_000
    );
  }

  private loadRoom(): RoomRow | null {
    return (
      this.state.storage.sql
        .exec<RoomRow>(
          "SELECT created_at_ms, next_index, next_session, teacher_lang, expired_at_ms FROM room_config WHERE id = 1",
        )
        .toArray()[0] ?? null
    );
  }

  private ensureRoom(code: string): RoomRow {
    const existing = this.loadRoom();
    if (existing !== null) return existing;
    this.state.storage.sql.exec(
      `INSERT INTO room_config
         (id, code, created_at_ms, next_index, next_session, teacher_lang, expired_at_ms)
       VALUES (1, ?, ?, 1, 1, NULL, NULL)`,
      code,
      Date.now(),
    );
    const created = this.loadRoom();
    if (created === null) throw new Error("room_config insert failed");
    return created;
  }

  /** Teacher keeps index 0; students take a never-reused index (PROTOCOL section 2). */
  private allocateIndex(room: RoomRow, pid: string): number {
    const taken = this.state.storage.sql
      .exec<IndexRow>(
        "SELECT participant_index FROM membership WHERE participant_id = ?",
        pid,
      )
      .toArray()[0];
    if (taken !== undefined) return taken.participant_index;
    const index = room.next_index;
    this.state.storage.sql.exec(
      "UPDATE room_config SET next_index = ? WHERE id = 1",
      index + 1,
    );
    return index;
  }

  private allocateSession(room: RoomRow): number {
    const session = room.next_session;
    this.state.storage.sql.exec(
      "UPDATE room_config SET next_session = ? WHERE id = 1",
      session + 1,
    );
    return session;
  }

  private upsertMembership(member: SocketMember, name: string, lang: string): void {
    this.state.storage.sql.exec(
      `INSERT INTO membership
         (participant_id, participant_index, session, role, name, lang)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(participant_id) DO UPDATE SET
         participant_index = excluded.participant_index,
         session = excluded.session,
         role = excluded.role,
         name = excluded.name,
         lang = excluded.lang`,
      member.pid,
      member.index,
      member.session,
      member.role,
      name,
      lang,
    );
    this.invalidateMemberLangs();
  }

  private loadRoster(): RosterEntry[] {
    const rows = this.state.storage.sql
      .exec<MemberRow>(
        `SELECT participant_id, participant_index, role, name, lang
         FROM membership ORDER BY participant_index ASC`,
      )
      .toArray();
    const roster: RosterEntry[] = [];
    for (const row of rows) {
      if (!isRole(row.role)) continue;
      roster.push({
        participantId: row.participant_id,
        participantIndex: row.participant_index,
        name: row.name,
        role: row.role,
        lang: row.lang,
        micOpen: isMicOpen(this.micState, row.participant_id),
        forcedMuted: this.micState.forcedMuted.has(row.participant_id),
      });
    }
    return roster;
  }

  private liveSockets(): LiveSocket[] {
    const live: LiveSocket[] = [];
    for (const ws of this.state.getWebSockets()) {
      const member = this.memberOf(ws);
      if (member !== null) live.push({ ws, member });
    }
    return live;
  }

  /**
   * Decide whether a verified token may join. Capacity is measured against LIVE
   * sockets, so a stale membership row can never lock a seat, while the roster
   * itself is read from SQLite so it survives hibernation.
   */
  private admit(claims: JoinClaims, name: string): Admission {
    const room = this.ensureRoom(this.roomCode());
    if (room.expired_at_ms !== null) {
      return { ok: false, code: "room-closed", message: "room already shut down" };
    }
    if (Date.now() - room.created_at_ms > this.maxRoomMs()) {
      this.expireRoom();
      return {
        ok: false,
        code: "room-closed",
        message: "room exceeded its maximum duration",
      };
    }

    const live = this.liveSockets();
    const prior = live.find((entry) => entry.member.pid === claims.pid);
    if (prior !== undefined) {
      // Same participant, second socket: keep the seat, hand over the socket.
      // Bump the membership row's session id first, so the replaced socket's
      // close event fails the row-guard in webSocketClose and cannot evict
      // the live member.
      const replacement: SocketMember = {
        pid: claims.pid,
        role: prior.member.role,
        index: prior.member.index,
        session: this.allocateSession(room),
      };
      this.upsertMembership(replacement, name, claims.lang);
      return { ok: true, member: replacement, replaces: prior.ws };
    }
    if (
      claims.role === "teacher" &&
      live.some((entry) => entry.member.role === "teacher")
    ) {
      return {
        ok: false,
        code: "teacher-taken",
        message: "the room already has a teacher",
      };
    }
    if (
      claims.role === "student" &&
      live.filter((entry) => entry.member.role === "student").length >=
        this.maxStudents()
    ) {
      return {
        ok: false,
        code: "room-full",
        message: "the room is at its student capacity",
      };
    }

    const member: SocketMember = {
      pid: claims.pid,
      role: claims.role,
      index:
        claims.role === "teacher"
          ? TEACHER_INDEX
          : this.allocateIndex(room, claims.pid),
      session: this.allocateSession(room),
    };
    this.upsertMembership(member, name, claims.lang);
    if (claims.role === "teacher" && room.teacher_lang === null) {
      this.state.storage.sql.exec(
        "UPDATE room_config SET teacher_lang = ? WHERE id = 1",
        claims.lang,
      );
    }
    return { ok: true, member, replaces: null };
  }

  // --- socket wiring ------------------------------------------------------

  private acceptJoin(member: SocketMember, replaces: WebSocket | null): Response {
    this.ensureMicControlLoaded();
    if (replaces !== null) {
      // Socket replacement: the person never left, so force-mute flags stay,
      // but the live capture belonged to the replaced socket — its pipes flush
      // and idle-close while the new socket starts with the mic closed.
      this.publishMic(
        applyMicEvent(this.micState, {
          type: "socketReplaced",
          participantId: member.pid,
        }),
        null,
      );
      replaces.close(CLOSE_NORMAL, "rejoined");
    }
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ ...member });
    if (member.role === "teacher") {
      this.publishMic(
        applyMicEvent(this.micState, {
          type: replaces !== null ? "teacherRejoin" : "teacherJoin",
        }),
        server,
      );
    } else {
      // Admission hook first: a mute-all latch force-mutes the newcomer
      // before their welcome renders the roster flags.
      this.publishMic(
        applyMicEvent(this.micState, {
          type: "studentJoin",
          participantId: member.pid,
        }),
        server,
      );
    }

    this.trySend(
      server,
      JSON.stringify({
        t: "welcome",
        participantId: member.pid,
        participantIndex: member.index,
        roster: this.loadRoster(),
      } satisfies ServerMsg),
    );
    // The newcomer already has the freshest roster; only the existing members
    // need the re-sync that a roster change means.
    this.syncRoster(server);

    // A populated room must not carry the idle-shutdown alarm: alarms prevent
    // hibernation (ARCHITECTURE.md section 3).
    void this.scheduleCleanup();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Upgrades, then answers with a single `error` frame and closes, so the client
   * learns why the join failed instead of holding a socket that never speaks.
   * Deliberately NOT `acceptWebSocket`: a rejected join must never become a
   * hibernating member nor fire `webSocketClose`.
   */
  private upgradeThenReject(code: RejectCode, message: string): Response {
    const [client, server] = Object.values(new WebSocketPair()) as [
      WebSocket,
      WebSocket,
    ];
    server.accept();
    this.trySend(
      server,
      JSON.stringify({ t: "error", code, message } satisfies ServerMsg),
    );
    server.close(CLOSE_NORMAL, code);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Re-send every connected client (except `except`) its identity plus the roster. */
  private syncRoster(except?: WebSocket): void {
    const roster = this.loadRoster();
    for (const { ws, member } of this.liveSockets()) {
      if (except !== undefined && ws === except) continue;
      // A replaced socket can still enumerate as live until its close event
      // lands; sending to it must not throw inside acceptJoin's roster sync.
      this.trySend(
        ws,
        JSON.stringify({
          t: "welcome",
          participantId: member.pid,
          participantIndex: member.index,
          roster,
        } satisfies ServerMsg),
      );
    }
  }

  private sendError(ws: WebSocket, code: RejectCode, message: string): void {
    this.collector.recordError(Date.now());
    this.trySend(
      ws,
      JSON.stringify({ t: "error", code, message } satisfies ServerMsg),
    );
  }

  private rejectUpgrade(status: number, code: string, message: string): Response {
    return Response.json({ t: "error", code, message }, { status });
  }

  private memberOf(ws: WebSocket): SocketMember | null {
    const raw: unknown = ws.deserializeAttachment();
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const pid = record["pid"];
    const role = record["role"];
    const index = record["index"];
    const session = record["session"];
    if (typeof pid !== "string" || pid.length === 0) return null;
    if (!isRole(role)) return null;
    if (typeof index !== "number" || !Number.isFinite(index)) return null;
    if (typeof session !== "number" || !Number.isFinite(session)) return null;
    return { pid, role, index, session };
  }

  // --- alarms (no setInterval: alarms keep the DO billed, so schedule one) --

  private expireRoom(): void {
    this.state.storage.sql.exec(
      "UPDATE room_config SET expired_at_ms = ? WHERE id = 1 AND expired_at_ms IS NULL",
      Date.now(),
    );
    this.state.storage.sql.exec("DELETE FROM membership");
    this.invalidateMemberLangs();
    this.teardownSessions();
    for (const ws of this.state.getWebSockets()) {
      this.sendError(ws, "room-closed", "room exceeded its maximum duration");
      ws.close(CLOSE_NORMAL, "room-closed");
    }
  }

  /** Earliest deadline worth an alarm, or null when none applies. */
  private nextDeadlineMs(): number | null {
    const room = this.loadRoom();
    if (room === null || room.expired_at_ms !== null) return null;
    const durationDeadline = room.created_at_ms + this.maxRoomMs();
    if (this.state.getWebSockets().length === 0) {
      return Math.min(
        durationDeadline,
        Date.now() + DEFAULT_IDLE_ROOM_MINUTES * 60_000,
      );
    }
    return durationDeadline;
  }

  private async scheduleCleanup(): Promise<void> {
    const deadline = this.nextDeadlineMs();
    const pending = await this.state.storage.getAlarm();
    if (deadline === null) {
      if (pending !== null) await this.state.storage.deleteAlarm();
      return;
    }
    if (pending !== null && pending <= deadline) return;
    await this.state.storage.setAlarm(deadline);
  }

  /** Drop the per-room SessionManager (room teardown paths). */
  private teardownSessions(): void {
    const torn = this.sessions;
    this.sessions = null;
    void torn?.closeAll();
  }

  /**
   * FR-052 idle-room shutdown. The alarm is deliberately set 15 minutes out
   * after the last participant leaves: firing it marks the room expired, so the
   * DO can hibernate/evict and the dead room code cannot be reused.
   */
  async alarm(): Promise<void> {
    if (this.state.getWebSockets().length > 0) {
      await this.scheduleCleanup();
      return;
    }
    if (this.loadRoom() === null) return;
    this.state.storage.sql.exec("DELETE FROM membership");
    this.invalidateMemberLangs();
    this.teardownSessions();
    this.state.storage.sql.exec(
      "UPDATE room_config SET expired_at_ms = ? WHERE id = 1 AND expired_at_ms IS NULL",
      Date.now(),
    );
    await this.state.storage.deleteAlarm();
  }
}
