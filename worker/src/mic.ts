// T-028: Mic control policy per docs/MIC-CONTROL.md — the pure, socket-free
// half of the Zoom/Meet model. The ClassRoom DO calls applyMicEvent from its
// WebSocket handlers, broadcasts the returned `broadcasts`, and translates
// `effects` into SessionManager calls:
//
//   flushSpeaker pid      -> endInput() on that speaker's pipes (tail keeps flowing)
//   closeSpeakerPipes pid -> release that speaker's pipe refs; idle-close arms
//   ensureSession source  -> pre-warm the speaker's pipe set (mic-open)
//
// Scope rules this module enforces (server-authoritative, FR-010..014):
//   - every participant may open/close their own mic;
//   - a teacher force-mute blocks mic-open (`mic-forced-muted`) and cuts an
//     open mic immediately (flush + pipe release, tail still plays out);
//   - unmuting never opens a mic — only the participant does;
//   - audio frames require the sender's mic to be open (`mic-closed`).
// Membership existence checks (mute of an absent pid) stay in the DO: this
// module has no roster.

export interface MicState {
  /** pid -> mic open on the CURRENT socket. Never persisted. */
  readonly micOpen: ReadonlyMap<string, true>;
  /** Student pids the teacher has force-muted (persisted across DO wake). */
  readonly forcedMuted: ReadonlySet<string>;
  /** `mute-all` latch: students joining while set are admitted force-muted. */
  readonly muteAllActive: boolean;
  readonly teacherConnected: boolean;
}

export type MicEvent =
  | { type: "micOpen"; participantId: string; isTeacher: boolean }
  | { type: "micClose"; participantId: string }
  | { type: "mute"; participantId: string }
  | { type: "unmute"; participantId: string }
  | { type: "muteAll"; studentIds: readonly string[] }
  | { type: "unmuteAll"; studentIds: readonly string[] }
  /** Admission hook: runs BEFORE the joiner's welcome so flags apply. */
  | { type: "studentJoin"; participantId: string }
  | { type: "audioFrame"; participantId: string }
  | {
      type: "participantDisconnect";
      participantId: string;
      isTeacher: boolean;
    }
  /** Socket replacement (rejoin): close the live capture, KEEP person flags. */
  | { type: "socketReplaced"; participantId: string }
  | { type: "teacherJoin" }
  | { type: "teacherRejoin" };

export type MicBroadcast =
  | { type: "mic-changed"; participantId: string; micOpen: boolean }
  /** DO re-broadcasts `welcome` rosters (micOpen/forcedMuted are in the roster). */
  | { type: "roster" }
  | { type: "error"; code: string; participantId?: string; to?: string };

export type MicEffect =
  | { kind: "flushSpeaker"; participantId: string }
  | { kind: "closeSpeakerPipes"; participantId: string }
  | { kind: "ensureSession"; source: string };

export interface MicResult {
  state: MicState;
  broadcasts: MicBroadcast[];
  effects: MicEffect[];
}

export function initialMicState(): MicState {
  return {
    micOpen: new Map(),
    forcedMuted: new Set(),
    muteAllActive: false,
    teacherConnected: false,
  };
}

/**
 * SQLite-persisted subset of MicState: the teacher force-mute policy. micOpen
 * stays memory-only (an open mic streams frames continuously, so a DO with an
 * open mic never hibernates) and teacherConnected is re-derived from live
 * sockets at admission. AGENTS.md rule 2 bans per-audio/caption writes — this
 * row is written only on mute-policy changes.
 */
export interface MicControlRow {
  readonly muteAllActive: boolean;
  readonly forcedPids: readonly string[];
}

export function micControlToRow(state: MicState): MicControlRow {
  const forcedPids = [...state.forcedMuted];
  forcedPids.sort();
  return { muteAllActive: state.muteAllActive, forcedPids };
}

/** Apply a persisted row onto a freshly-initialised state. Null = no row yet. */
export function applyMicControlRow(
  state: MicState,
  row: MicControlRow | null,
): MicState {
  if (row === null) return state;
  return {
    ...state,
    muteAllActive: row.muteAllActive,
    forcedMuted: new Set(row.forcedPids),
  };
}

function withMic(
  state: MicState,
  participantId: string,
  open: boolean,
): MicState {
  const micOpen = new Map(state.micOpen);
  if (open) micOpen.set(participantId, true);
  else micOpen.delete(participantId);
  return { ...state, micOpen };
}

function micChanged(
  participantId: string,
  micOpen: boolean,
): MicBroadcast {
  return { type: "mic-changed", participantId, micOpen };
}

/** Shared cut path: close the mic, tell everyone, flush + tear the pipes. */
function cutMic(state: MicState, participantId: string): MicResult {
  const next = withMic(state, participantId, false);
  return {
    state: next,
    broadcasts: [micChanged(participantId, false)],
    effects: [
      { kind: "flushSpeaker", participantId },
      { kind: "closeSpeakerPipes", participantId },
    ],
  };
}

export function isMicOpen(state: MicState, participantId: string): boolean {
  return state.micOpen.get(participantId) === true;
}

export function isForcedMuted(state: MicState, participantId: string): boolean {
  return state.forcedMuted.has(participantId);
}

export function applyMicEvent(
  state: MicState,
  event: MicEvent,
): MicResult {
  switch (event.type) {
    case "micOpen": {
      const pid = event.participantId;
      if (isMicOpen(state, pid)) {
        // Idempotent: a duplicate mic-open is not an error, not a broadcast.
        return { state, broadcasts: [], effects: [] };
      }
      if (!event.isTeacher && state.forcedMuted.has(pid)) {
        return {
          state,
          broadcasts: [{ type: "error", code: "mic-forced-muted", to: pid }],
          effects: [],
        };
      }
      const next = withMic(state, pid, true);
      return {
        state: next,
        broadcasts: [micChanged(pid, true)],
        // mic-open pre-warms this speaker's pipe set eagerly so the first
        // spoken frame does not pay the session-opening gap (PROTOCOL §4.1).
        effects: [{ kind: "ensureSession", source: pid }],
      };
    }

    case "micClose": {
      const pid = event.participantId;
      if (!isMicOpen(state, pid)) {
        return { state, broadcasts: [], effects: [] };
      }
      // Voluntary close per docs/MIC-CONTROL.md: flush the provider input
      // (audioStreamEnd) so the captured tail still translates, then release
      // the speaker's pipe refs — a closed mic owns no pipe set; idle-close
      // drains the tail and frees the sessions. A re-open pre-warms again.
      const next = withMic(state, pid, false);
      return {
        state: next,
        broadcasts: [micChanged(pid, false)],
        effects: [
          { kind: "flushSpeaker", participantId: pid },
          { kind: "closeSpeakerPipes", participantId: pid },
        ],
      };
    }

    case "mute": {
      const pid = event.participantId;
      if (state.forcedMuted.has(pid)) {
        return { state, broadcasts: [], effects: [] };
      }
      const forcedMuted = new Set(state.forcedMuted);
      forcedMuted.add(pid);
      const next: MicState = { ...state, forcedMuted };
      if (isMicOpen(state, pid)) {
        // Teacher intent is a pipe cut: flush + release refs (idle-close arms,
        // the already-translating tail drains inside the idle window).
        const cut = cutMic(next, pid);
        return {
          state: cut.state,
          broadcasts: [...cut.broadcasts, { type: "roster" }],
          effects: cut.effects,
        };
      }
      return {
        state: next,
        broadcasts: [{ type: "roster" }],
        effects: [],
      };
    }

    case "unmute": {
      const pid = event.participantId;
      if (!state.forcedMuted.has(pid)) {
        return { state, broadcasts: [], effects: [] };
      }
      const forcedMuted = new Set(state.forcedMuted);
      forcedMuted.delete(pid);
      // Never auto-opens the mic (MIC-CONTROL normative rule).
      return {
        state: { ...state, forcedMuted },
        broadcasts: [{ type: "roster" }],
        effects: [],
      };
    }

    case "muteAll": {
      const forcedMuted = new Set(state.forcedMuted);
      for (const pid of event.studentIds) forcedMuted.add(pid);
      let working: MicState = {
        ...state,
        forcedMuted,
        muteAllActive: true,
      };
      const broadcasts: MicBroadcast[] = [];
      const effects: MicEffect[] = [];
      // Invariant: a forced student's mic is never open, so every open mic in
      // the target set belongs to a student being force-muted right now.
      for (const pid of event.studentIds) {
        if (!isMicOpen(working, pid)) continue;
        const cut = cutMic(working, pid);
        working = cut.state;
        broadcasts.push(...cut.broadcasts);
        effects.push(...cut.effects);
      }
      broadcasts.push({ type: "roster" });
      return { state: working, broadcasts, effects };
    }

    case "unmuteAll": {
      if (!state.muteAllActive && state.forcedMuted.size === 0) {
        return { state, broadcasts: [], effects: [] };
      }
      return {
        state: {
          ...state,
          forcedMuted: new Set(),
          muteAllActive: false,
        },
        broadcasts: [{ type: "roster" }],
        effects: [],
      };
    }

    case "studentJoin": {
      // A join under an active mute-all is admitted already force-muted; the
      // joiner's welcome carries the flag, so no broadcast is needed.
      if (!state.muteAllActive || state.forcedMuted.has(event.participantId)) {
        return { state, broadcasts: [], effects: [] };
      }
      const forcedMuted = new Set(state.forcedMuted);
      forcedMuted.add(event.participantId);
      return { state: { ...state, forcedMuted }, broadcasts: [], effects: [] };
    }

    case "audioFrame": {
      // The only wire gate: frames require an open mic. Violations are dropped
      // and answered so a stuck client learns immediately.
      if (isMicOpen(state, event.participantId)) {
        return { state, broadcasts: [], effects: [] };
      }
      return {
        state,
        broadcasts: [
          { type: "error", code: "mic-closed", to: event.participantId },
        ],
        effects: [],
      };
    }

    case "participantDisconnect": {
      const pid = event.participantId;
      const forcedMuted = new Set(state.forcedMuted);
      forcedMuted.delete(pid);
      let working: MicState = {
        ...state,
        forcedMuted,
        teacherConnected: event.isTeacher ? false : state.teacherConnected,
      };
      const broadcasts: MicBroadcast[] = [];
      const effects: MicEffect[] = [];
      if (isMicOpen(state, pid)) {
        const cut = cutMic(working, pid);
        working = cut.state;
        broadcasts.push(...cut.broadcasts);
        effects.push(...cut.effects);
      } else {
        // Even a closed-mic departure must release their pipe refs so the
        // pipes they were listening to can idle-close.
        effects.push({ kind: "closeSpeakerPipes", participantId: pid });
      }
      return { state: working, broadcasts, effects };
    }

    case "socketReplaced": {
      // A rejoining participant gets a fresh closed mic; force-mute and every
      // other person-level flag survive because the person never left. The
      // DO's acceptJoin roster re-sync carries the refreshed micOpen.
      const pid = event.participantId;
      if (!isMicOpen(state, pid)) {
        return { state, broadcasts: [], effects: [] };
      }
      const cut = cutMic(state, pid);
      return cut;
    }

    case "teacherJoin": {
      // FR-004 belt-and-braces: the DO admission gate already rejects a second
      // live teacher; the machine answers with the wire error if it ever sees
      // one anyway.
      if (state.teacherConnected) {
        return {
          state,
          broadcasts: [{ type: "error", code: "teacher-taken" }],
          effects: [],
        };
      }
      return {
        state: { ...state, teacherConnected: true },
        broadcasts: [],
        effects: [],
      };
    }

    case "teacherRejoin": {
      // Socket replacement keeps every mic/force-mute state (the person never
      // left); the DO's roster re-sync tells clients nothing changed.
      return {
        state: { ...state, teacherConnected: true },
        broadcasts: [],
        effects: [],
      };
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
