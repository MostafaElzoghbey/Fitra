// T-021: unit tests for the PURE caption reducer (SPEC FR-034/FR-035,
// docs/PROTOCOL.md §3.1/§3.2).
//
// The wire sends `caption{kind, text, final, speaker}` where `text` is the FULL
// current segment (never a delta). Live slots are keyed by `speaker` (several
// speakers may have their mic open at once), and a caption turn groups one
// input line with its output line: `final:false` replaces that kind's live
// text in place, `final:true` marks the kind final, and the turn commits to
// history once every non-empty live kind is final. These tests pin that
// contract, the `commitTurnOnMicChange` boundary (mic-changed `micOpen:false`
// for THAT speaker only), `commitLiveCaptions` (commit every slot), the
// 50-turn history cap, input/output independence and the byte-identical
// pass-through of Arabic (RTL) text. No React, no DOM.

import { describe, expect, it } from "vitest";

import {
  CAPTIONS_MAX_TURNS,
  commitLiveCaptions,
  commitSpeakerTurn,
  commitTurnOnMicChange,
  emptyCaptions,
  reduceCaption,
  type CaptionKind,
  type CaptionMessage,
  type CaptionsState,
} from "../src/captions.js";

function caption(
  kind: "input" | "output",
  text: string,
  final: boolean,
  speaker: number,
): CaptionMessage {
  return { kind, text, final, speaker };
}

/** Commit `count` numbered turns of one kind, returning the final state. */
function commitSeries(count: number, kind: "input" | "output"): CaptionsState {
  let state = emptyCaptions();
  for (let i = 1; i <= count; i += 1) {
    state = reduceCaption(state, caption(kind, `seg-${i}`, false, 0));
    state = reduceCaption(state, caption(kind, `seg-${i}`, true, 0));
  }
  return state;
}

describe("emptyCaptions", () => {
  it("starts with no live slots, no last speaker and no history", () => {
    const state = emptyCaptions();
    expect(state.slots).toEqual({});
    expect(state.lastSpeaker).toBeNull();
    expect(state.history).toEqual([]);
  });
});

describe("interim (final:false) replaces the live text in place", () => {
  it("replaces only that kind's live text of that speaker, history untouched", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false, 0));
    expect(state.slots["0"]).toEqual({
      input: "",
      output: "Hello",
      finals: { input: false, output: false },
    });
    expect(state.lastSpeaker).toBe(0);
    expect(state.history).toEqual([]);

    state = reduceCaption(state, caption("output", "Hello world", false, 0));
    expect(state.slots["0"]?.output).toBe("Hello world");
    expect(state.history).toEqual([]);
  });

  it("empty interim text clears only its own live line", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false, 0));
    state = reduceCaption(state, caption("output", "Hello", false, 0));

    state = reduceCaption(state, caption("input", "", false, 0));
    expect(state.slots["0"]?.input).toBe("");
    expect(state.slots["0"]?.output).toBe("Hello");
    expect(state.history).toEqual([]);
  });

  it("the same full segment re-emitted by the active speaker is a no-op", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false, 2));
    const before = state;
    state = reduceCaption(state, caption("output", "Hello", false, 2));
    expect(state).toBe(before);
  });

  it("a re-emission from a non-active speaker still marks them active", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "one", false, 0));
    state = reduceCaption(state, caption("output", "two", false, 1));
    expect(state.lastSpeaker).toBe(1);

    // Speaker 0 re-emits their identical interim: content unchanged, but they
    // are the most recently active speaker again.
    state = reduceCaption(state, caption("output", "one", false, 0));
    expect(state.lastSpeaker).toBe(0);
    expect(state.slots["0"]?.output).toBe("one");
    expect(state.slots["1"]?.output).toBe("two");
  });
});

describe("final:true commits one turn grouping input and output", () => {
  it("input + output finalize into a single committed turn tagged with the speaker", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false, 1));
    state = reduceCaption(state, caption("output", "Hello", false, 1));

    // Only one kind final so far: the turn is not complete yet.
    state = reduceCaption(state, caption("input", "مرحبا", true, 1));
    expect(state.history).toEqual([]);
    expect(state.slots["1"]?.finals).toEqual({ input: true, output: false });

    state = reduceCaption(state, caption("output", "Hello", true, 1));
    expect(state.history).toEqual([
      { speaker: 1, input: "مرحبا", output: "Hello" },
    ]);
    expect(state.slots["1"]).toBeUndefined();
    expect(state.lastSpeaker).toBeNull();
  });

  it("the final text is the authoritative full segment", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false, 0));
    state = reduceCaption(state, caption("output", "Hello world", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "", output: "Hello world" },
    ]);
  });

  it("an input-only turn commits with an empty output line", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false, 0));
    state = reduceCaption(state, caption("input", "مرحبا", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "مرحبا", output: "" },
    ]);
    expect(state.slots).toEqual({});
  });

  it("an output-only turn commits with an empty input line", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false, 0));
    state = reduceCaption(state, caption("output", "Hello", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "", output: "Hello" },
    ]);
  });

  it("a duplicate final for the same turn commits nothing more", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false, 0));
    state = reduceCaption(state, caption("output", "Hello", true, 0));
    state = reduceCaption(state, caption("output", "Hello", true, 0));

    expect(state.history).toEqual([
      { speaker: 0, input: "", output: "Hello" },
    ]);
  });

  it("a final with no live text is a stray and commits nothing", () => {
    // PROTOCOL §3.1: final:true is emitted exactly once per turn, after the
    // turn's interims built the live text. A final arriving with no live text
    // (duplicate or stray) must not invent history.
    let state = reduceCaption(emptyCaptions(), caption("input", "partial", true, 0));
    expect(state.history).toEqual([]);
    expect(state.slots).toEqual({});

    state = reduceCaption(state, caption("input", "real", false, 0));
    state = reduceCaption(state, caption("input", "real", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "real", output: "" },
    ]);
  });
});

describe("slots are keyed by speaker (concurrent speakers never collide)", () => {
  it("two concurrent speakers keep independent live slots", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false, 0));
    state = reduceCaption(state, caption("output", "Hello", false, 0));
    // Speaker 2 starts while speaker 0's turn is still live.
    state = reduceCaption(state, caption("input", "Bonjour", false, 2));

    expect(state.slots["0"]).toEqual({
      input: "مرحبا",
      output: "Hello",
      finals: { input: false, output: false },
    });
    expect(state.slots["2"]).toEqual({
      input: "Bonjour",
      output: "",
      finals: { input: false, output: false },
    });
    expect(state.lastSpeaker).toBe(2);
    expect(state.history).toEqual([]);
  });

  it("one speaker's final commits their turn and leaves the other live", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false, 0));
    state = reduceCaption(state, caption("output", "Hello", false, 0));
    state = reduceCaption(state, caption("input", "Bonjour", false, 2));
    state = reduceCaption(state, caption("output", "Hi", false, 2));

    state = reduceCaption(state, caption("input", "مرحبا", true, 0));
    state = reduceCaption(state, caption("output", "Hello", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "مرحبا", output: "Hello" },
    ]);
    // Speaker 2's slot is untouched and still live.
    expect(state.slots["2"]).toEqual({
      input: "Bonjour",
      output: "Hi",
      finals: { input: false, output: false },
    });
    expect(state.lastSpeaker).toBe(2);
  });

  it("interleaved finals commit in chronological order across speakers", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "one", false, 0));
    state = reduceCaption(state, caption("input", "one", true, 0));
    state = reduceCaption(state, caption("input", "two", false, 2));
    state = reduceCaption(state, caption("input", "two", true, 2));
    expect(state.history).toEqual([
      { speaker: 0, input: "one", output: "" },
      { speaker: 2, input: "two", output: "" },
    ]);
  });
});

describe("commitTurnOnMicChange (mic-change turn boundary, PROTOCOL §3.1)", () => {
  it("a mic close for the speaking speaker commits their unfinished live turn", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false, 0));
    state = reduceCaption(state, caption("output", "Hello", false, 0));

    const committed = commitTurnOnMicChange(state, 0, false);
    expect(committed.history).toEqual([
      { speaker: 0, input: "مرحبا", output: "Hello" },
    ]);
    expect(committed.slots).toEqual({});
    expect(committed.lastSpeaker).toBeNull();
    // The source state is untouched (pure).
    expect(state.slots["0"]?.output).toBe("Hello");
    expect(state.history).toEqual([]);
  });

  it("a mic close for a DIFFERENT speaker keeps the live turn open", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "still talking", false, 1));

    const after = commitTurnOnMicChange(state, 3, false);
    expect(after).toBe(state);
    expect(state.history).toEqual([]);
    expect(state.slots["1"]?.output).toBe("still talking");
  });

  it("mic open is not a boundary", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false, 0));
    expect(commitTurnOnMicChange(state, 0, true)).toBe(state);
  });

  it("a close for a speaker with an empty or unknown slot is a no-op", () => {
    const state = emptyCaptions();
    expect(commitTurnOnMicChange(state, 5, false)).toBe(state);

    const emptySlot = reduceCaption(state, caption("input", "", false, 7));
    expect(commitTurnOnMicChange(emptySlot, 7, false)).toBe(emptySlot);
  });

  it("the next caption appends below the committed turn", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "first", false, 0));
    state = commitTurnOnMicChange(state, 0, false);

    state = reduceCaption(state, caption("input", "second", false, 0));
    state = reduceCaption(state, caption("input", "second", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "first", output: "" },
      { speaker: 0, input: "second", output: "" },
    ]);
  });

  it("respects the injectable cap", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "a", false, 0));
    state = commitTurnOnMicChange(state, 0, false, 2);
    state = reduceCaption(state, caption("input", "b", false, 0));
    state = commitTurnOnMicChange(state, 0, false, 2);
    state = reduceCaption(state, caption("input", "c", false, 0));
    state = commitTurnOnMicChange(state, 0, false, 2);
    expect(state.history).toEqual([
      { speaker: 0, input: "b", output: "" },
      { speaker: 0, input: "c", output: "" },
    ]);
  });
});

describe("commitSpeakerTurn and commitLiveCaptions safety nets", () => {
  it("commitSpeakerTurn commits one slot and leaves the others", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "a", false, 0));
    state = reduceCaption(state, caption("output", "b", false, 2));

    state = commitSpeakerTurn(state, 2);
    expect(state.history).toEqual([{ speaker: 2, input: "", output: "b" }]);
    expect(state.slots["0"]?.output).toBe("a");
    expect(state.lastSpeaker).toBe(0);
  });

  it("commitLiveCaptions commits every slot chronologically", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "one", false, 0));
    state = reduceCaption(state, caption("input", "two", false, 2));
    state = reduceCaption(state, caption("output", "dos", false, 2));

    const committed = commitLiveCaptions(state);
    expect(committed.history).toEqual([
      { speaker: 0, input: "one", output: "" },
      { speaker: 2, input: "two", output: "dos" },
    ]);
    expect(committed.slots).toEqual({});
    expect(committed.lastSpeaker).toBeNull();
    const empty = emptyCaptions();
    expect(commitLiveCaptions(empty)).toBe(empty);
  });
});

describe("a new interim for a finalized kind starts a fresh turn", () => {
  it("commits the completed turn first, then the interim starts below it", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "one", false, 0));
    // The translation for turn one is still streaming when the engine starts
    // the next input turn: the completed turn commits with the pending output
    // text riding along, then the new interim opens a fresh live turn.
    state = reduceCaption(state, caption("output", "uno", false, 0));
    state = reduceCaption(state, caption("input", "one", true, 0));
    expect(state.history).toEqual([]);
    expect(state.slots["0"]?.finals).toEqual({ input: true, output: false });

    state = reduceCaption(state, caption("input", "two", false, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "one", output: "uno" },
    ]);
    expect(state.slots["0"]).toEqual({
      input: "two",
      output: "",
      finals: { input: false, output: false },
    });

    state = reduceCaption(state, caption("output", "dos", false, 0));
    state = reduceCaption(state, caption("input", "two", true, 0));
    state = reduceCaption(state, caption("output", "dos", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "one", output: "uno" },
      { speaker: 0, input: "two", output: "dos" },
    ]);
  });

  it("an input final with no output yet commits an input-only turn", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "one", false, 0));
    state = reduceCaption(state, caption("input", "one", true, 0));
    expect(state.history).toEqual([{ speaker: 0, input: "one", output: "" }]);

    // The translation arrives afterwards as its own turn's output line.
    state = reduceCaption(state, caption("output", "uno", false, 0));
    expect(state.slots["0"]).toEqual({
      input: "",
      output: "uno",
      finals: { input: false, output: false },
    });
    state = reduceCaption(state, caption("output", "uno", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "one", output: "" },
      { speaker: 0, input: "", output: "uno" },
    ]);
  });
});

describe("committed turns are never overwritten by the next turn", () => {
  it("final then next interim leaves history unchanged", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "turn one", false, 0));
    state = reduceCaption(state, caption("output", "turn one", true, 0));

    state = reduceCaption(state, caption("output", "turn two", false, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "", output: "turn one" },
    ]);
    expect(state.slots["0"]?.output).toBe("turn two");

    state = reduceCaption(state, caption("output", "turn two", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "", output: "turn one" },
      { speaker: 0, input: "", output: "turn two" },
    ]);
  });
});

describe("input and output live lines are independent", () => {
  it("one kind's interim/final never touches the other kind", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false, 0));
    state = reduceCaption(state, caption("output", "Hello", false, 0));

    // The output finalizes while the input line is still open: the turn waits.
    state = reduceCaption(state, caption("output", "Hello!", false, 0));
    state = reduceCaption(state, caption("output", "Hello!", true, 0));
    expect(state.history).toEqual([]);
    expect(state.slots["0"]?.output).toBe("Hello!");
    expect(state.slots["0"]?.finals).toEqual({ input: false, output: true });

    state = reduceCaption(state, caption("input", "مرحبا يا", false, 0));
    expect(state.slots["0"]?.output).toBe("Hello!");
    expect(state.history).toEqual([]);

    state = reduceCaption(state, caption("input", "مرحبا يا", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "مرحبا يا", output: "Hello!" },
    ]);
  });

  it("history preserves the commit order across turns", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "one", false, 0));
    state = reduceCaption(state, caption("output", "uno", false, 0));
    state = reduceCaption(state, caption("input", "one", true, 0));
    state = reduceCaption(state, caption("output", "uno", true, 0));
    expect(state.history).toEqual([{ speaker: 0, input: "one", output: "uno" }]);

    state = reduceCaption(state, caption("input", "two", false, 0));
    state = reduceCaption(state, caption("input", "two", true, 0));
    expect(state.history).toEqual([
      { speaker: 0, input: "one", output: "uno" },
      { speaker: 0, input: "two", output: "" },
    ]);
  });
});

describe("history cap", () => {
  it("default cap is 50 committed turns", () => {
    expect(CAPTIONS_MAX_TURNS).toBe(50);
  });

  it("52 commits leave 50 turns with the two oldest evicted", () => {
    const state = commitSeries(52, "output");
    expect(state.history.length).toBe(50);
    expect(state.history[0]).toEqual({ speaker: 0, input: "", output: "seg-3" });
    expect(state.history[49]).toEqual({ speaker: 0, input: "", output: "seg-52" });
  });

  it("eviction is oldest-first across speakers and kinds", () => {
    let state = emptyCaptions();
    for (let i = 1; i <= 51; i += 1) {
      const kind: CaptionKind = i % 2 === 0 ? "output" : "input";
      const speaker = i % 3;
      state = reduceCaption(state, caption(kind, `s${i}`, false, speaker));
      state = reduceCaption(state, caption(kind, `s${i}`, true, speaker));
    }
    expect(state.history.length).toBe(50);
    expect(state.history[0]).toEqual({ speaker: 2, input: "", output: "s2" });
    expect(state.history[49]).toEqual({ speaker: 0, input: "s51", output: "" });
  });

  it("cap is injectable for tests", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "a", false, 0), 2);
    state = reduceCaption(state, caption("output", "a", true, 0), 2);
    state = reduceCaption(state, caption("output", "b", false, 0), 2);
    state = reduceCaption(state, caption("output", "b", true, 0), 2);
    state = reduceCaption(state, caption("output", "c", false, 0), 2);
    state = reduceCaption(state, caption("output", "c", true, 0), 2);
    expect(state.history).toEqual([
      { speaker: 0, input: "", output: "b" },
      { speaker: 0, input: "", output: "c" },
    ]);
  });
});

describe("purity", () => {
  it("reduceCaption returns a new state and never mutates the input", () => {
    const before: CaptionsState = {
      slots: {
        "1": { input: "مرحبا", output: "Hello", finals: { input: false, output: false } },
      },
      lastSpeaker: 1,
      history: [{ speaker: 0, input: "old", output: "viejo" }],
    };
    const frozen = Object.freeze({
      slots: Object.freeze({ "1": Object.freeze({ ...before.slots["1"] }) }),
      lastSpeaker: before.lastSpeaker,
      history: Object.freeze([...before.history]),
    });

    const after = reduceCaption(frozen, caption("output", "Hi", false, 1));
    expect(after).not.toBe(frozen);
    expect(frozen.slots["1"]?.output).toBe("Hello");
    expect(frozen.history).toEqual([{ speaker: 0, input: "old", output: "viejo" }]);
    expect(after.slots["1"]?.output).toBe("Hi");
    expect(after.lastSpeaker).toBe(1);
  });

  it("commitSpeakerTurn never mutates the input", () => {
    const before: CaptionsState = {
      slots: {
        "1": { input: "مرحبا", output: "Hello", finals: { input: true, output: false } },
      },
      lastSpeaker: 1,
      history: [],
    };
    const frozen = Object.freeze({
      slots: Object.freeze({ "1": Object.freeze({ ...before.slots["1"] }) }),
      lastSpeaker: before.lastSpeaker,
      history: Object.freeze([...before.history]),
    });

    const after = commitSpeakerTurn(frozen, 1);
    expect(after).not.toBe(frozen);
    expect(frozen.slots["1"]?.input).toBe("مرحبا");
    expect(frozen.history).toEqual([]);
    expect(after.history).toEqual([
      { speaker: 1, input: "مرحبا", output: "Hello" },
    ]);
    expect(after.slots).toEqual({});
  });
});

describe("Arabic text round-trips byte-identically", () => {
  it("interim and committed Arabic text is preserved exactly", () => {
    const arabic = "السَّلامُ عَلَيْكُم — تشكيل، شرطة، وأرقام ١٢٣";
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", arabic, false, 2));
    expect(state.slots["2"]?.output).toBe(arabic);

    state = reduceCaption(state, caption("output", arabic, true, 2));
    expect(state.history[0]?.output === arabic).toBe(true);
    // Byte-identical, not just equal-by-value under some normalization.
    expect(Buffer.from(state.history[0]?.output ?? "", "utf8")).toEqual(
      Buffer.from(arabic, "utf8"),
    );
  });
});
