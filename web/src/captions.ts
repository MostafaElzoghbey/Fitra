// T-021: PURE caption reducer (SPEC FR-034/FR-035, docs/PROTOCOL.md §3.1/§3.4).
//
// The wire sends `caption{kind, text, final}` where `text` is the FULL current
// segment for one turn of one kind — never a delta. A caption *turn* groups one
// source line (`input`) with its translation (`output`): `final:false` replaces
// only that kind's live text in place; `final:true` marks that kind final and
// the turn commits to history once every non-empty live kind is final, so the
// next turn's interim can never overwrite a committed turn. A final with no
// live text is a duplicate/stray and commits nothing. History is capped at 50
// committed turns, oldest evicted first. Memory only — nothing here touches
// D1, DO SQLite or the DOM (AGENTS.md rule 2). No React import: Room.tsx
// consumes this from its server-msg switch.

import type { FloorHolder } from "@fitra/shared";

export type CaptionKind = "input" | "output";

/** The three caption fields of the shared `caption` ServerMsg (no wire change). */
export interface CaptionMessage {
  readonly kind: CaptionKind;
  readonly text: string;
  readonly final: boolean;
}

/** One caption turn: the source line and its translation, shown as one bubble. */
export interface CaptionTurn {
  readonly input: string;
  readonly output: string;
}

export interface CaptionsState {
  /** Live (uncommitted) turn; a kind's text is "" while that line is not open. */
  readonly live: CaptionTurn;
  /** Which kinds of the live turn have already received their `final:true`. */
  readonly finals: Readonly<Record<CaptionKind, boolean>>;
  /** Committed turns in commit order, oldest first, capped. */
  readonly history: readonly CaptionTurn[];
}

/** Committed-turn cap (SPEC FR-035: at most 50 kept in memory). */
export const CAPTIONS_MAX_TURNS = 50;

const NO_FINALS: Readonly<Record<CaptionKind, boolean>> = {
  input: false,
  output: false,
};

export function emptyCaptions(): CaptionsState {
  return { live: { input: "", output: "" }, finals: NO_FINALS, history: [] };
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

/**
 * Commit whatever the live turn currently holds, finalized or not, then clear
 * it. Safety net for engines that never emit `final:true` (turnComplete) and
 * for turn boundaries: Room.tsx calls this on `floor-changed` so the previous
 * speaker's text stays on screen when the next person talks. Pure.
 */
export function commitLiveCaptions(
  state: CaptionsState,
  maxTurns: number = CAPTIONS_MAX_TURNS,
): CaptionsState {
  if (state.live.input === "" && state.live.output === "") return state;
  return {
    live: { input: "", output: "" },
    finals: NO_FINALS,
    history: appendTurn(state.history, state.live, maxTurns),
  };
}

/**
 * Fold one `caption` message into the state. Pure: same state + message always
 * yields a new state; the input is never mutated.
 *
 * - `final:false` replaces ONLY that kind's live text (empty text clears it).
 *   A new interim for a kind that is already final means the engine started a
 *   new turn: the completed turn is committed first, then the interim starts
 *   fresh (the other kind's still-pending text rides along into the committed
 *   turn — its later final is then a stray no-op).
 * - `final:true` marks that kind final (the final text is the authoritative
 *   full segment) and commits the turn as soon as every non-empty live kind is
 *   final. A final with no live text is a duplicate/stray: nothing commits.
 * - `maxTurns` is injectable; the default is the documented 50.
 */
/** Commit the live turn only when a *new holder* takes the floor. Going idle
 * is not a boundary: the provider may still stream the translated tail after
 * `speaking-stop`, and committing there would split one utterance in two. */
export function commitTurnOnFloorChange(
  state: CaptionsState,
  floor: FloorHolder,
  maxTurns: number = CAPTIONS_MAX_TURNS,
): CaptionsState {
  return floor.kind === "none" ? state : commitLiveCaptions(state, maxTurns);
}

export function reduceCaption(
  state: CaptionsState,
  message: CaptionMessage,
  maxTurns: number = CAPTIONS_MAX_TURNS,
): CaptionsState {
  const { kind, text, final } = message;

  if (!final) {
    if (state.finals[kind]) {
      const committed = commitLiveCaptions(state, maxTurns);
      return { ...committed, live: { ...committed.live, [kind]: text } };
    }
    if (state.live[kind] === text) {
      return state; // same full segment re-emitted: nothing to change
    }
    return { ...state, live: { ...state.live, [kind]: text } };
  }

  // final:true — a duplicate/stray final with no live text commits nothing.
  if (state.live[kind] === "") {
    return state;
  }

  const live: CaptionTurn =
    text === "" ? state.live : { ...state.live, [kind]: text };
  const finals = { ...state.finals, [kind]: true };

  // Commit exactly once the turn is complete: every non-empty live kind final.
  const inputReady = live.input === "" || finals.input;
  const outputReady = live.output === "" || finals.output;
  if (inputReady && outputReady) {
    return {
      live: { input: "", output: "" },
      finals: NO_FINALS,
      history: appendTurn(state.history, live, maxTurns),
    };
  }
  return { ...state, live, finals };
}
