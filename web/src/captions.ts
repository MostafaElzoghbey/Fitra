// T-021: PURE caption reducer (SPEC FR-034/FR-035, docs/PROTOCOL.md §3.1/§3.2).
//
// The wire sends `caption{kind, text, final, speaker}` where `text` is the FULL
// current segment for one turn of one kind of one speaker — never a delta.
// Several speakers may have their mic open at once, so live caption slots are
// keyed by `speaker` (PROTOCOL §3.1 "caption slots are keyed by speaker"):
// two concurrent speakers each own their live slot and commit independently.
//
// A caption *turn* groups one source line (`input`) with its translation
// (`output`): `final:false` replaces only that kind's live text in place;
// `final:true` marks that kind final and the turn commits to history once
// every non-empty live kind is final, so the next turn's interim can never
// overwrite a committed turn. A final with no live text is a duplicate/stray
// and commits nothing. A `mic-changed{micOpen:false}` for speaker S is a turn
// boundary ONLY for S's slot (`commitTurnOnMicChange`): the safety commit
// keeps S's text on screen when engines never emit turn-complete, while other
// speakers' mic changes keep their turns live. History is chronological
// across speakers and capped at 50 committed turns, oldest evicted first.
// Memory only — nothing here touches D1, DO SQLite or the DOM (AGENTS.md
// rule 2). No React import: Room.tsx consumes this from its server-msg switch.

export type CaptionKind = "input" | "output";

/** The four caption fields of the shared `caption` ServerMsg (PROTOCOL §3). */
export interface CaptionMessage {
  readonly kind: CaptionKind;
  readonly text: string;
  readonly final: boolean;
  readonly speaker: number;
}

/** One committed caption turn: who spoke, the source line, the translation. */
export interface CaptionTurn {
  readonly speaker: number;
  readonly input: string;
  readonly output: string;
}

/** One speaker's live (uncommitted) turn: two text lines + their finals. */
export interface LiveTurn {
  readonly input: string;
  readonly output: string;
  readonly finals: Readonly<Record<CaptionKind, boolean>>;
}

export interface CaptionsState {
  /** Live slots keyed by speaker index (as decimal string). */
  readonly slots: Readonly<Record<string, LiveTurn>>;
  /**
   * Most recently active speaker. Invariant: names a live slot or is null —
   * after a commit of the active speaker it falls back to the lowest-indexed
   * remaining live slot, or null when none remains.
   */
  readonly lastSpeaker: number | null;
  /** Committed turns in commit order, oldest first, capped. */
  readonly history: readonly CaptionTurn[];
}

/** Committed-turn cap (SPEC FR-035: at most 50 kept in memory). */
export const CAPTIONS_MAX_TURNS = 50;

const NO_FINALS: Readonly<Record<CaptionKind, boolean>> = {
  input: false,
  output: false,
};

const EMPTY_LIVE: LiveTurn = { input: "", output: "", finals: NO_FINALS };

export function emptyCaptions(): CaptionsState {
  return { slots: {}, lastSpeaker: null, history: [] };
}

function appendTurn(
  history: readonly CaptionTurn[],
  turn: CaptionTurn,
  maxTurns: number,
): readonly CaptionTurn[] {
  return history.length >= maxTurns
    ? [...history.slice(history.length - maxTurns + 1), turn]
    : [...history, turn];
}

function setSlot(
  state: CaptionsState,
  speaker: number,
  live: LiveTurn,
): CaptionsState {
  return {
    ...state,
    slots: { ...state.slots, [String(speaker)]: live },
    lastSpeaker: speaker,
  };
}

/**
 * Commit ONE speaker's live slot, finalized or not, then clear it. Safety net
 * for engines that never emit `final:true` (turnComplete) and for turn
 * boundaries: Room.tsx calls `commitTurnOnMicChange` on `mic-changed` so the
 * previous speaker's text stays on screen when the next person talks. A slot
 * with no text (or an unknown speaker) is a no-op returning the same state.
 * Pure.
 */
export function commitSpeakerTurn(
  state: CaptionsState,
  speaker: number,
  maxTurns: number = CAPTIONS_MAX_TURNS,
): CaptionsState {
  const slot = state.slots[String(speaker)];
  if (slot === undefined || (slot.input === "" && slot.output === "")) {
    return state;
  }
  const slots = { ...state.slots };
  delete slots[String(speaker)];
  // Keep the invariant: lastSpeaker names a live slot or is null. Committing
  // the active speaker hands the pointer to the lowest remaining live slot
  // (numeric sort — Object.keys order is insertion order, which drifts from
  // index order as slots are deleted and recreated).
  const remaining = Object.keys(slots)
    .map(Number)
    .sort((a, b) => a - b);
  return {
    ...state,
    slots,
    lastSpeaker:
      state.lastSpeaker === speaker
        ? remaining.length > 0
          ? Number(remaining[0])
          : null
        : state.lastSpeaker,
    history: appendTurn(
      state.history,
      { speaker, input: slot.input, output: slot.output },
      maxTurns,
    ),
  };
}

/** Commit every live slot (reconnect/unmount safety net). Pure. */
export function commitLiveCaptions(
  state: CaptionsState,
  maxTurns: number = CAPTIONS_MAX_TURNS,
): CaptionsState {
  let next = state;
  for (const key of Object.keys(state.slots)) {
    next = commitSpeakerTurn(next, Number(key), maxTurns);
  }
  return next;
}

/**
 * Apply a `mic-changed{micOpen}` for `speaker` (PROTOCOL §3.1): a close is a
 * turn boundary ONLY for that speaker — it commits their live slot even when
 * `final:true` never arrives, so their text stays visible. Mic OPEN, and mic
 * changes naming any other speaker, are not boundaries. Pure.
 */
export function commitTurnOnMicChange(
  state: CaptionsState,
  speaker: number,
  micOpen: boolean,
  maxTurns: number = CAPTIONS_MAX_TURNS,
): CaptionsState {
  return micOpen ? state : commitSpeakerTurn(state, speaker, maxTurns);
}

/**
 * Fold one `caption` message into the state. Pure: same state + message always
 * yields a new state; the input is never mutated.
 *
 * - `final:false` replaces ONLY that kind's live text of THAT speaker (empty
 *   text clears it). A new interim for a kind that is already final means the
 *   engine started a new turn: the completed turn is committed first, then the
 *   interim starts fresh (the other kind's still-pending text rides along into
 *   the committed turn — its later final is then a stray no-op).
 * - `final:true` marks that kind final (the final text is the authoritative
 *   full segment) and commits the turn as soon as every non-empty live kind is
 *   final. A final with no live text is a duplicate/stray: nothing commits.
 * - `maxTurns` is injectable; the default is the documented 50.
 */
export function reduceCaption(
  state: CaptionsState,
  message: CaptionMessage,
  maxTurns: number = CAPTIONS_MAX_TURNS,
): CaptionsState {
  const { kind, text, final, speaker } = message;
  const slot = state.slots[String(speaker)] ?? EMPTY_LIVE;

  if (!final) {
    if (slot.finals[kind]) {
      const committed = commitSpeakerTurn(state, speaker, maxTurns);
      return setSlot(committed, speaker, { ...EMPTY_LIVE, [kind]: text });
    }
    if (slot[kind] === text && state.lastSpeaker === speaker) {
      return state; // same full segment re-emitted by the active speaker
    }
    return setSlot(state, speaker, { ...slot, [kind]: text });
  }

  // final:true — a duplicate/stray final with no live text commits nothing.
  if (slot[kind] === "") {
    return state;
  }

  const live: LiveTurn = {
    ...slot,
    [kind]: text,
    finals: { ...slot.finals, [kind]: true },
  };

  // Commit exactly once the turn is complete: every non-empty live kind final.
  const inputReady = live.input === "" || live.finals.input;
  const outputReady = live.output === "" || live.finals.output;
  if (inputReady && outputReady) {
    return commitSpeakerTurn(setSlot(state, speaker, live), speaker, maxTurns);
  }
  return setSlot(state, speaker, live);
}
