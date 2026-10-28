// T-021: PURE caption reducer (SPEC FR-034/FR-035, docs/PROTOCOL.md §3.1/§3.4).
//
// The wire sends `caption{kind, text, final}` where `text` is the FULL current
// segment for one turn of one kind — never a delta. `final:false` replaces the
// live segment for that kind; `final:true` commits it to history exactly once
// and clears the live slot, so the next turn's interim can never overwrite a
// committed segment. Input (source speech) and output (translated) live slots
// are independent. History is capped at 50 committed segments, oldest evicted
// first. Memory only — nothing here touches D1, DO SQLite or the DOM (AGENTS.md
// rule 2). No React import: Room.tsx consumes this from its server-msg switch.

export type CaptionKind = "input" | "output";

/** The three caption fields of the shared `caption` ServerMsg (no wire change). */
export interface CaptionMessage {
  readonly kind: CaptionKind;
  readonly text: string;
  readonly final: boolean;
}

/** One committed caption segment, labelled so the UI can tell source from translation. */
export interface CaptionSegment {
  readonly kind: CaptionKind;
  readonly text: string;
}

export interface CaptionsState {
  /** Live (uncommitted) segment per kind; "" when that kind has no live turn. */
  readonly live: Readonly<Record<CaptionKind, string>>;
  /** Committed segments in commit order, oldest first, capped. */
  readonly history: readonly CaptionSegment[];
}

/** Committed-segment cap (SPEC FR-035: at most 50 kept in memory). */
export const CAPTIONS_MAX_SEGMENTS = 50;

export function emptyCaptions(): CaptionsState {
  return { live: { input: "", output: "" }, history: [] };
}

/**
 * Fold one `caption` message into the state. Pure: same state + message always
 * yields a new state; the input is never mutated.
 *
 * - `final:false` replaces ONLY that kind's live slot (empty text clears it).
 * - `final:true` commits that kind's current live segment exactly once, then
 *   clears the slot. An empty final commits nothing. A final with no prior
 *   interim commits the final text itself (PROTOCOL §3.1: an interrupted turn
 *   commits its partial segment as `final:true`).
 * - `maxSegments` is injectable; the default is the documented 50.
 */
export function reduceCaption(
  state: CaptionsState,
  message: CaptionMessage,
  maxSegments: number = CAPTIONS_MAX_SEGMENTS,
): CaptionsState {
  const { kind, text, final } = message;

  if (!final) {
    if (state.live[kind] === text) {
      return state; // same full segment re-emitted: nothing to change
    }
    return { ...state, live: { ...state.live, [kind]: text } };
  }

  // final:true — commit the current live segment of this kind exactly once.
  // The live slot is empty when there is no open turn (e.g. a duplicate final
  // after the commit already happened): nothing commits, history is untouched.
  const liveText = state.live[kind];
  if (liveText === "") {
    return state; // empty final, or no live turn: commits nothing
  }

  const history =
    state.history.length >= maxSegments
      ? [...state.history.slice(state.history.length - maxSegments + 1), { kind, text: liveText }]
      : [...state.history, { kind, text: liveText }];

  return { ...state, live: { ...state.live, [kind]: "" }, history };
}
