// T-013: in-room UI. Consumes validated `ServerMsg`s from net/socket.ts through
// an exhaustive switch (docs/PROTOCOL.md section 3) and renders floor state,
// roster and hand queue.
//
// Deliberately no audio: T-010 (capture) and T-011 (playback) attach through the
// `onMicToggle`/`onAudioFrame` seams. T-012 (metrics) injects its panel through
// `renderMetrics` into `#metrics-mount`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClientMsg,
  FloorHolder,
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
import { FloorBar } from "../components/FloorBar.js";
import { Roster } from "../components/Roster.js";
import { connectRoom, roomSocketUrl, type RoomSocket } from "../net/socket.js";
import { rejoinRoom } from "../net/api.js";
import { attachRoomAudio, type RoomAudioHandle } from "../audio/roomShell.js";
import { captureNoticeKey, type CaptureNotice } from "../audio/devices.js";
import { navigate, type RoomRouteParams } from "../router.js";
import { emptyCaptions, reduceCaption, type CaptionsState } from "../captions.js";

export interface RoomProps {
  readonly session: RoomRouteParams;
  /** T-012 injects the metrics panel here. */
  readonly renderMetrics?: (metrics: RoomMetrics | null) => React.ReactNode;
  /** T-010/T-011 inject microphone control here. */
  readonly onMicToggle?: (muted: boolean) => void;
  /** T-011 reports a permission failure so the UI can show the blocking hint. */
  readonly micError?: string | null;
}

interface RoomState {
  readonly selfId: string | null;
  readonly floor: FloorHolder;
  readonly roster: readonly RosterEntry[];
  readonly raised: readonly string[];
  readonly sessions: Readonly<Record<string, SessionStatus>>;
  readonly metrics: RoomMetrics | null;
  readonly captions: CaptionsState;
  readonly errorCode: string | null;
  readonly connected: boolean;
}

const INITIAL_STATE: RoomState = {
  selfId: null,
  floor: { kind: "none" },
  roster: [],
  raised: [],
  sessions: {},
  metrics: null,
  captions: emptyCaptions(),
  errorCode: null,
  connected: false,
};

function reduceServerMsg(state: RoomState, msg: ServerMsg): RoomState {
  switch (msg.t) {
    case "welcome":
      return {
        ...state,
        selfId: msg.participantId,
        floor: msg.floor,
        roster: msg.roster,
        connected: true,
      };
    case "floor-changed":
      return { ...state, floor: msg.floor };
    case "hands":
      return { ...state, raised: [...msg.raised] };
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
      return { ...state, errorCode: msg.code, connected: false };
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
  const [micMuted, setMicMuted] = useState(true);
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
  // reconnects with the fresh token, so membership and floor state survive.
  // Only terminal join-rejection codes stop auto-rejoin for good; routine
  // in-room errors (rate-limited, not-your-floor, session-degraded) must not
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

  const toggleMic = useCallback(() => {
    const next = !micMuted;
    setMicMuted(next);
    audioRef.current?.setMuted(next);
    onMicToggle?.(next);
  }, [micMuted, onMicToggle]);

  const handRaised = useMemo(
    () => state.selfId !== null && state.raised.includes(state.selfId),
    [state.raised, state.selfId],
  );

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
          <FloorBar
            strings={strings}
            roster={state.roster}
            floor={state.floor}
            role={session.role}
            selfId={state.selfId}
            handRaised={handRaised}
            handsUpCount={state.raised.length}
            micMuted={micMuted}
            onRaiseHand={() => send({ t: "raise-hand" })}
            onLowerHand={() => send({ t: "lower-hand" })}
            onRevoke={() => send({ t: "revoke" })}
            onToggleMic={toggleMic}
            micHint={micError ?? (micNotice === null ? null : strings[captureNoticeKey(micNotice)])}
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

          <CaptionPanel strings={strings} captions={state.captions} />

          <SessionPanel strings={strings} sessions={state.sessions} />
        </div>

        <div className="space-y-6">
          <Roster
            strings={strings}
            roster={state.roster}
            raised={state.raised}
            floor={state.floor}
            role={session.role}
            selfId={state.selfId}
            onGrant={(participantId) => send({ t: "grant", participantId })}
            onDeny={(participantId) => send({ t: "deny", participantId })}
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

function CaptionPanel({
  strings,
  captions,
}: {
  readonly strings: UiStrings;
  readonly captions: CaptionsState;
}): React.JSX.Element {
  const { live, history } = captions;
  const empty = live.input === "" && live.output === "" && history.length === 0;
  return (
    <section className="ui-card p-4" aria-label={strings.captionsTitle}>
      <h2 className="ui-section-title">{strings.captionsTitle}</h2>
      {empty ? (
        <p className="ui-hint mt-2" data-testid="captions-empty">
          {strings.captionsEmpty}
        </p>
      ) : (
        <div className="mt-3 space-y-2" data-testid="captions">
          {live.input !== "" && (
            <p
              className="line-clamp-2 rounded-md bg-paper-sunk p-3 text-sm leading-relaxed text-ink-600"
              data-testid="caption-live-input"
            >
              <span className="me-2 text-xs font-semibold text-ink-500">
                {strings.captionsInputLabel}
              </span>
              {live.input}
            </p>
          )}
          {live.output !== "" && (
            <p
              className="line-clamp-2 rounded-md bg-brand-50 p-3 text-sm leading-relaxed text-ink-800"
              data-testid="caption-live-output"
            >
              <span className="me-2 text-xs font-semibold text-ink-500">
                {strings.captionsOutputLabel}
              </span>
              {live.output}
            </p>
          )}
          {history.length > 0 && (
            <div
              className="max-h-48 space-y-2 overflow-y-auto"
              data-testid="caption-history"
              aria-live="polite"
            >
              {history.map((segment, index) => (
                <p
                  key={index}
                  className={
                    segment.kind === "output"
                      ? "text-sm leading-relaxed text-ink-800"
                      : "text-sm leading-relaxed text-ink-500"
                  }
                  data-testid={`caption-history-${index}`}
                  data-kind={segment.kind}
                >
                  <span className="me-2 text-xs font-semibold text-ink-400">
                    {segment.kind === "output"
                      ? strings.captionsOutputLabel
                      : strings.captionsInputLabel}
                  </span>
                  {segment.text}
                </p>
              ))}
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