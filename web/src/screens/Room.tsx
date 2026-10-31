// T-013: in-room UI. Consumes validated `ServerMsg`s from net/socket.ts through
// an exhaustive switch (docs/PROTOCOL.md section 3) and renders mic state,
// roster and captions per docs/MIC-CONTROL.md.
//
// Room attaches its own audio: the mic gesture drives `RoomAudioHandle`
// (capture/playback) directly; `onMicToggle` and `micError` stay optional
// observer hooks for consumers. T-012 injects its metrics panel through
// `renderMetrics` into `#metrics-mount`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClientMsg,
  RoomMetrics,
  RosterEntry,
  ServerMsg,
} from "@fitra/shared";

import {
  assertNever,
  errorMessageKey,
  getStrings,
  sessionStatusKey,
  type SessionStatus,
  type UiStrings,
} from "../i18n.js";
import { useUiLang } from "../uiLang.js";
import { MicBar } from "../components/MicBar.js";
import { Roster } from "../components/Roster.js";
import { connectRoom, roomSocketUrl, type RoomSocket } from "../net/socket.js";
import { rejoinRoom } from "../net/api.js";
import { attachRoomAudio, type RoomAudioHandle } from "../audio/roomShell.js";
import { captureNoticeKey, type CaptureNotice } from "../audio/devices.js";
import { navigate, type RoomRouteParams } from "../router.js";
import {
  commitSpeakerTurn,
  commitTurnOnMicChange,
  emptyCaptions,
  reduceCaption,
  type CaptionTurn,
  type CaptionsState,
} from "../captions.js";

export interface RoomProps {
  readonly session: RoomRouteParams;
  /** T-012 injects the metrics panel here. */
  readonly renderMetrics?: (metrics: RoomMetrics | null) => React.ReactNode;
  /** Optional observer notification of the mic gesture. */
  readonly onMicToggle?: (open: boolean) => void;
  /** T-010 reports a permission failure so the UI can show the blocking hint. */
  readonly micError?: string | null;
}

interface RoomState {
  readonly selfId: string | null;
  readonly roster: readonly RosterEntry[];
  readonly sessions: Readonly<Record<string, SessionStatus>>;
  readonly metrics: RoomMetrics | null;
  readonly captions: CaptionsState;
  readonly errorCode: string | null;
  readonly connected: boolean;
}

const INITIAL_STATE: RoomState = {
  selfId: null,
  roster: [],
  sessions: {},
  metrics: null,
  captions: emptyCaptions(),
  errorCode: null,
  connected: false,
};

function reduceServerMsg(state: RoomState, msg: ServerMsg): RoomState {
  switch (msg.t) {
    case "welcome": {
      // A welcome is a full authoritative roster snapshot. Any caption slot
      // whose participantIndex is no longer seated gets committed so a
      // departed speaker's partial text stays visible and never bleeds into a
      // later joiner (PROTOCOL §3.1 turn boundaries). Keyed by index, not a
      // pid diff: indexes are never reused, so an absent index always means
      // the speaker is gone.
      const seated = new Set(msg.roster.map((e) => e.participantIndex));
      let captions = state.captions;
      for (const key of Object.keys(state.captions.slots)) {
        const index = Number(key);
        if (!seated.has(index)) {
          captions = commitSpeakerTurn(captions, index);
        }
      }
      // A fresh snapshot supersedes any stale in-room error banner (e.g. the
      // forced-mute notice after the teacher unmuted everyone).
      return {
        ...state,
        selfId: msg.participantId,
        roster: msg.roster,
        captions,
        errorCode: null,
        connected: true,
      };
    }
    case "mic-changed": {
      // Mic state lives in the roster snapshot; a mic-changed patches that one
      // entry between snapshots. A close is a turn boundary ONLY for that
      // speaker (PROTOCOL §3.1).
      const roster = state.roster.map((entry) =>
        entry.participantId === msg.participantId
          ? { ...entry, micOpen: msg.micOpen }
          : entry,
      );
      const speaker = state.roster.find(
        (entry) => entry.participantId === msg.participantId,
      );
      const captions =
        speaker === undefined
          ? state.captions
          : commitTurnOnMicChange(
              state.captions,
              speaker.participantIndex,
              msg.micOpen,
            );
      return { ...state, roster, captions };
    }
    case "session-status":
      return {
        ...state,
        sessions: { ...state.sessions, [msg.pair]: msg.status },
      };
    case "caption":
      return { ...state, captions: reduceCaption(state.captions, msg) };
    case "metrics":
      return { ...state, metrics: msg.m };
    case "error":
      // In-room errors do not drop the connection (only onClose does); the
      // banner stays until the next welcome snapshot.
      return { ...state, errorCode: msg.code };
    case "pong":
      return state;
    default:
      return assertNever(msg);
  }
}

export function Room({
  session,
  renderMetrics,
  onMicToggle,
  micError = null,
}: RoomProps): React.JSX.Element {
  const { lang } = useUiLang();
  const strings = getStrings(lang);
  const [state, setState] = useState<RoomState>(INITIAL_STATE);
  const [micNotice, setMicNotice] = useState<CaptureNotice | null>(null);
  const [token, setToken] = useState(session.token);
  const socketRef = useRef<RoomSocket | null>(null);
  const audioRef = useRef<RoomAudioHandle | null>(null);
  const tokenRef = useRef(session.token);
  const rejoinBudgetRef = useRef(3);
  const rejoiningRef = useRef(false);
  const lastErrorRef = useRef<string | null>(null);

  // PROTOCOL.md section 1 rejoin: an abnormal socket drop replays the original
  // token to POST /rooms/:code/rejoin (expiry waived, same pid re-minted) and
  // reconnects with the fresh token, so membership and mic state survive.
  // Only terminal join-rejection codes stop auto-rejoin for good; routine
  // in-room errors (rate-limited, mic-*, mute-*, session-degraded) must not
  // poison recovery from a later genuine network drop.
  const terminalErrorCodes: ReadonlySet<string> = new Set([
    "room-closed",
    "teacher-taken",
    "room-full",
    "unsupported-language",
    "unauthorized",
  ]);
  // Bounded retries with backoff absorb slow-network flaps; the budget resets
  // on each welcome. The finally clears the in-flight flag even if a retry
  // throws (unparseable rejoin response), so a later drop can still retry.
  const attemptRejoin = useCallback(() => {
    if (rejoiningRef.current || rejoinBudgetRef.current <= 0) return;
    if (lastErrorRef.current !== null) return;
    rejoiningRef.current = true;
    void (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          rejoinBudgetRef.current -= 1;
          await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
          const result = await rejoinRoom(session.code, tokenRef.current);
          if (result.ok) {
            tokenRef.current = result.value;
            setToken(result.value);
            return;
          }
          if (result.messageKey !== "errNetwork") {
            break; // server rejected this membership; reconnecting cannot fix it
          }
        }
      } finally {
        rejoiningRef.current = false;
      }
    })();
  }, [session.code]);

  useEffect(() => {
    const socket = connectRoom(
      roomSocketUrl(session.code, window.location.origin),
      token,
      session.name,
    );
    socketRef.current = socket;
    // T-016: the room shell owns sender/playback/latency wiring on this socket.
    const audio = attachRoomAudio(socket, {
      onMicError: (notice) => setMicNotice(notice),
    });
    audioRef.current = audio;
    const offServer = socket.onServer((msg) => {
      if (msg.t === "welcome") {
        rejoinBudgetRef.current = 3;
        lastErrorRef.current = null;
      } else if (msg.t === "error") {
        if (terminalErrorCodes.has(msg.code)) {
          lastErrorRef.current = msg.code;
        }
        rejoiningRef.current = false;
        if (msg.code === "mic-forced-muted") {
          // Server-authoritative cut while we believed the mic open: stop the
          // capture and let the roster snapshot sync the UI (MIC-CONTROL.md).
          audioRef.current?.closeMic();
        }
      }
      setState((previous) => reduceServerMsg(previous, msg));
    });
    const offClose = socket.onClose((info) => {
      setState((previous) => ({ ...previous, connected: false }));
      // Clean closes are intentional leaves or server-rejected joins (the DO
      // answers with an error frame first); only abnormal drops rejoin.
      if (info.wasClean) return;
      attemptRejoin();
    });
    return () => {
      offServer();
      offClose();
      audio.dispose();
      audioRef.current = null;
      socket.close();
      socketRef.current = null;
    };
  }, [session.code, token, session.name, attemptRejoin]);

  const send = useCallback((msg: ClientMsg) => {
    socketRef.current?.send(msg);
  }, []);

  const self = useMemo(
    () =>
      state.selfId === null
        ? undefined
        : state.roster.find((e) => e.participantId === state.selfId),
    [state.roster, state.selfId],
  );
  const selfMicOpen = self?.micOpen ?? false;

  const toggleMic = useCallback(() => {
    const open = !selfMicOpen;
    if (open) audioRef.current?.openMic();
    else audioRef.current?.closeMic();
    onMicToggle?.(open);
  }, [selfMicOpen, onMicToggle]);

  return (
    <main className="ui-page">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="ui-section-title">{strings.roomTitle}</p>
          <h1 className="ui-code mt-1 text-xl" data-testid="room-code-banner">
            {session.code}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="ui-chip-live" data-testid="test-deployment-badge">
            {strings.testDeploymentBadge}
          </p>
          <button
            type="button"
            className="ui-btn-secondary ui-btn-sm"
            data-testid="leave-room"
            onClick={() => navigate("#/")}
          >
            {strings.roomLeave}
          </button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <MicBar
            strings={strings}
            roster={state.roster}
            role={session.role}
            selfId={state.selfId}
            micHint={micError ?? (micNotice === null ? null : strings[captureNoticeKey(micNotice)])}
            onToggleMic={toggleMic}
            onMuteAll={() => send({ t: "mute-all" })}
            onUnmuteAll={() => send({ t: "unmute-all" })}
          />

          <p className="ui-banner-info" data-testid="headphones-hint">
            <span aria-hidden="true">🎧</span>
            <span>
              {strings.headphonesHint}
              <span className="mt-1 block text-ink-600">{strings.micHint}</span>
              <span
                className="mt-1 block text-ink-600"
                data-testid="generated-voice-note"
              >
                {strings.generatedVoiceNote}
              </span>
            </span>
          </p>

          {state.errorCode !== null && (
            <p className="ui-banner-danger" role="alert" data-testid="room-error">
              <strong className="font-semibold">{strings.errorTitle}: </strong>
              {strings[errorMessageKey(state.errorCode)]}
            </p>
          )}

          {!state.connected && state.errorCode === null && (
            <p className="ui-banner-warn" role="status" data-testid="room-disconnected">
              {strings.connectionLost}
            </p>
          )}

          <CaptionPanel
            strings={strings}
            roster={state.roster}
            captions={state.captions}
          />

          <SessionPanel strings={strings} sessions={state.sessions} />
        </div>

        <div className="space-y-6">
          <Roster
            strings={strings}
            roster={state.roster}
            role={session.role}
            selfId={state.selfId}
            onMute={(participantId) => send({ t: "mute", participantId })}
            onUnmute={(participantId) => send({ t: "unmute", participantId })}
          />
          <section
            id="metrics-mount"
            data-testid="metrics-mount"
            className="ui-card p-4"
            aria-label={strings.metricsPlaceholder}
          >
            {renderMetrics === undefined ? (
              <p className="ui-hint">{strings.metricsPlaceholder}</p>
            ) : (
              renderMetrics(state.metrics)
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

/** One committed turn: who spoke, the source line, the translation. */
function TurnBubble({
  strings,
  turn,
  index,
  speakerLabel,
}: {
  readonly strings: UiStrings;
  readonly turn: CaptionTurn;
  readonly index: number;
  readonly speakerLabel: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1 rounded-lg bg-paper-sunk p-3" data-testid={`caption-history-${index}`}>
      <p className="text-xs font-semibold text-ink-400">{speakerLabel}</p>
      {turn.input !== "" && (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-600">
          <span className="me-2 text-xs font-semibold text-ink-400">
            {strings.captionsInputLabel}
          </span>
          {turn.input}
        </p>
      )}
      {turn.output !== "" && (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-800">
          <span className="me-2 text-xs font-semibold text-ink-400">
            {strings.captionsOutputLabel}
          </span>
          {turn.output}
        </p>
      )}
    </div>
  );
}

function CaptionPanel({
  strings,
  roster,
  captions,
}: {
  readonly strings: UiStrings;
  readonly roster: readonly RosterEntry[];
  readonly captions: CaptionsState;
}): React.JSX.Element {
  const { slots, lastSpeaker, history } = captions;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Chat transcript follows new content only while the reader is already near
  // the bottom; scrolling up to read long text must not be yanked back down.
  const nearBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 64;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [captions]);

  const speakerLabel = (index: number): string =>
    roster.find((e) => e.participantIndex === index)?.name ??
    strings.captionsSpeakerFallback;

  // Text-less slots (a stray empty interim) render nothing and count as empty.
  const visibleKeys = Object.keys(slots).filter((key) => {
    const live = slots[key];
    return live !== undefined && (live.input !== "" || live.output !== "");
  });
  // The canonical live bubble (the one carrying the E2E testids) belongs to the
  // most recent speaker; when their slot is gone it falls to the next live one.
  const canonicalKey =
    lastSpeaker !== null && visibleKeys.includes(String(lastSpeaker))
      ? String(lastSpeaker)
      : visibleKeys[0] ?? null;
  const empty = visibleKeys.length === 0 && history.length === 0;
  return (
    <section className="ui-card p-4" aria-label={strings.captionsTitle}>
      <h2 className="ui-section-title">{strings.captionsTitle}</h2>
      {empty ? (
        <p className="ui-hint mt-2" data-testid="captions-empty">
          {strings.captionsEmpty}
        </p>
      ) : (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="mt-3 max-h-[60vh] space-y-3 overflow-y-auto pe-1"
          data-testid="captions"
        >
          {history.length > 0 && (
            <div className="space-y-3" data-testid="caption-history">
              {history.map((turn, index) => (
                <TurnBubble
                  key={index}
                  strings={strings}
                  turn={turn}
                  index={index}
                  speakerLabel={speakerLabel(turn.speaker)}
                />
              ))}
            </div>
          )}
          {visibleKeys.length > 0 && (
            <div className="space-y-3">
              {visibleKeys.map((key) => {
                const live = slots[key];
                if (live === undefined) return null;
                const canonical = key === canonicalKey;
                return (
                  <div key={key} className="space-y-1 rounded-lg bg-brand-50 p-3">
                    <p className="text-xs font-semibold text-ink-500">
                      {speakerLabel(Number(key))}
                    </p>
                    {live.input !== "" && (
                      <p
                        className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-600"
                        data-testid={canonical ? "caption-live-input" : undefined}
                        aria-live="polite"
                      >
                        <span className="me-2 text-xs font-semibold text-ink-500">
                          {strings.captionsInputLabel}
                        </span>
                        {live.input}
                      </p>
                    )}
                    {live.output !== "" && (
                      <p
                        className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-800"
                        data-testid={canonical ? "caption-live-output" : undefined}
                        aria-live="polite"
                      >
                        <span className="me-2 text-xs font-semibold text-ink-500">
                          {strings.captionsOutputLabel}
                        </span>
                        {live.output}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SessionPanel({
  strings,
  sessions,
}: {
  readonly strings: UiStrings;
  readonly sessions: Readonly<Record<string, SessionStatus>>;
}): React.JSX.Element {
  const entries = Object.entries(sessions);
  return (
    <section className="ui-card p-4" aria-label={strings.sessionsTitle}>
      <h2 className="ui-section-title">{strings.sessionsTitle}</h2>
      {entries.length === 0 ? (
        <p className="ui-hint mt-2" data-testid="sessions-empty">
          {strings.sessionsEmpty}
        </p>
      ) : (
        <ul className="mt-3 space-y-2" data-testid="sessions">
          {entries.map(([pair, status]) => (
            <li
              key={pair}
              className="flex items-center justify-between gap-3 text-sm"
              data-testid={`session-${pair}`}
            >
              <span className="font-mono text-xs text-ink-600">{pair}</span>
              <span
                className={status === "live" ? "ui-chip-live" : "ui-chip-neutral"}
                data-status={status}
              >
                {strings[sessionStatusKey(status)]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
