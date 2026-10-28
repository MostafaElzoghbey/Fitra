// T-021: unit tests for the PURE caption reducer (SPEC FR-034/FR-035,
// docs/PROTOCOL.md §3.1/§3.4).
//
// The wire sends `caption{kind, text, final}` where `text` is the FULL current
// segment (never a delta). A caption turn groups one input line with its
// output line: `final:false` replaces that kind's live text in place,
// `final:true` marks the kind final, and the turn commits to history once
// every non-empty live kind is final. These tests pin that contract,
// `commitLiveCaptions` (the floor-change / no-turnComplete safety net), the
// 50-turn history cap, input/output independence and the byte-identical
// pass-through of Arabic (RTL) text. No React, no DOM.

import { describe, expect, it } from "vitest";

import {
  CAPTIONS_MAX_TURNS,
  commitLiveCaptions,
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
): CaptionMessage {
  return { kind, text, final };
}

/** Commit `count` numbered turns of one kind, returning the final state. */
function commitSeries(count: number, kind: "input" | "output"): CaptionsState {
  let state = emptyCaptions();
  for (let i = 1; i <= count; i += 1) {
    state = reduceCaption(state, caption(kind, `seg-${i}`, false));
    state = reduceCaption(state, caption(kind, `seg-${i}`, true));
  }
  return state;
}

describe("emptyCaptions", () => {
  it("starts with an empty live turn, no finals and no history", () => {
    const state = emptyCaptions();
    expect(state.live).toEqual({ input: "", output: "" });
    expect(state.finals).toEqual({ input: false, output: false });
    expect(state.history).toEqual([]);
  });
});

describe("interim (final:false) replaces the live text in place", () => {
  it("replaces only that kind's live text, history untouched", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false));
    expect(state.live.output).toBe("Hello");
    expect(state.live.input).toBe("");
    expect(state.history).toEqual([]);

    state = reduceCaption(state, caption("output", "Hello world", false));
    expect(state.live.output).toBe("Hello world");
    expect(state.history).toEqual([]);
  });

  it("empty interim text clears only its own live line", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false));
    state = reduceCaption(state, caption("output", "Hello", false));

    state = reduceCaption(state, caption("input", "", false));
    expect(state.live.input).toBe("");
    expect(state.live.output).toBe("Hello");
    expect(state.history).toEqual([]);
  });
});

describe("final:true commits one turn grouping input and output", () => {
  it("input + output finalize into a single committed turn", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false));
    state = reduceCaption(state, caption("output", "Hello", false));

    // Only one kind final so far: the turn is not complete yet.
    state = reduceCaption(state, caption("input", "مرحبا", true));
    expect(state.history).toEqual([]);
    expect(state.finals).toEqual({ input: true, output: false });
    expect(state.live).toEqual({ input: "مرحبا", output: "Hello" });

    state = reduceCaption(state, caption("output", "Hello", true));
    expect(state.history).toEqual([{ input: "مرحبا", output: "Hello" }]);
    expect(state.live).toEqual({ input: "", output: "" });
    expect(state.finals).toEqual({ input: false, output: false });
  });

  it("the final text is the authoritative full segment", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false));
    state = reduceCaption(state, caption("output", "Hello world", true));
    expect(state.history).toEqual([{ input: "", output: "Hello world" }]);
  });

  it("an input-only turn commits with an empty output line", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false));
    state = reduceCaption(state, caption("input", "مرحبا", true));
    expect(state.history).toEqual([{ input: "مرحبا", output: "" }]);
    expect(state.live).toEqual({ input: "", output: "" });
  });

  it("an output-only turn commits with an empty input line", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false));
    state = reduceCaption(state, caption("output", "Hello", true));
    expect(state.history).toEqual([{ input: "", output: "Hello" }]);
  });

  it("a duplicate final for the same turn commits nothing more", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false));
    state = reduceCaption(state, caption("output", "Hello", true));
    state = reduceCaption(state, caption("output", "Hello", true));

    expect(state.history).toEqual([{ input: "", output: "Hello" }]);
  });

  it("a final with no live text is a stray and commits nothing", () => {
    // PROTOCOL §3.1: final:true is emitted exactly once per turn, after the
    // turn's interims built the live text. A final arriving with no live text
    // (duplicate or stray) must not invent history.
    let state = reduceCaption(emptyCaptions(), caption("input", "partial", true));
    expect(state.history).toEqual([]);
    expect(state.live.input).toBe("");

    state = reduceCaption(state, caption("input", "real", false));
    state = reduceCaption(state, caption("input", "real", true));
    expect(state.history).toEqual([{ input: "real", output: "" }]);
  });
});

describe("a new interim for a finalized kind starts a fresh turn", () => {
  it("commits the completed turn first, then the interim starts below it", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "one", false));
    // The translation for turn one is still streaming when the engine starts
    // the next input turn: the completed turn commits with the pending output
    // text riding along, then the new interim opens a fresh live turn.
    state = reduceCaption(state, caption("output", "uno", false));
    state = reduceCaption(state, caption("input", "one", true));
    expect(state.history).toEqual([]);
    expect(state.finals).toEqual({ input: true, output: false });

    state = reduceCaption(state, caption("input", "two", false));
    expect(state.history).toEqual([{ input: "one", output: "uno" }]);
    expect(state.live).toEqual({ input: "two", output: "" });
    expect(state.finals).toEqual({ input: false, output: false });

    state = reduceCaption(state, caption("output", "dos", false));
    state = reduceCaption(state, caption("input", "two", true));
    state = reduceCaption(state, caption("output", "dos", true));
    expect(state.history).toEqual([
      { input: "one", output: "uno" },
      { input: "two", output: "dos" },
    ]);
  });

  it("an input final with no output yet commits an input-only turn", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "one", false));
    state = reduceCaption(state, caption("input", "one", true));
    expect(state.history).toEqual([{ input: "one", output: "" }]);

    // The translation arrives afterwards as its own turn's output line.
    state = reduceCaption(state, caption("output", "uno", false));
    expect(state.live).toEqual({ input: "", output: "uno" });
    state = reduceCaption(state, caption("output", "uno", true));
    expect(state.history).toEqual([
      { input: "one", output: "" },
      { input: "", output: "uno" },
    ]);
  });
});

describe("committed turns are never overwritten by the next turn", () => {
  it("final then next interim leaves history unchanged", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "turn one", false));
    state = reduceCaption(state, caption("output", "turn one", true));

    state = reduceCaption(state, caption("output", "turn two", false));
    expect(state.history).toEqual([{ input: "", output: "turn one" }]);
    expect(state.live.output).toBe("turn two");

    state = reduceCaption(state, caption("output", "turn two", true));
    expect(state.history).toEqual([
      { input: "", output: "turn one" },
      { input: "", output: "turn two" },
    ]);
  });
});

describe("input and output live lines are independent", () => {
  it("one kind's interim/final never touches the other kind", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false));
    state = reduceCaption(state, caption("output", "Hello", false));

    // The output finalizes while the input line is still open: the turn waits.
    state = reduceCaption(state, caption("output", "Hello!", false));
    state = reduceCaption(state, caption("output", "Hello!", true));
    expect(state.history).toEqual([]);
    expect(state.live).toEqual({ input: "مرحبا", output: "Hello!" });
    expect(state.finals).toEqual({ input: false, output: true });

    state = reduceCaption(state, caption("input", "مرحبا يا", false));
    expect(state.live.output).toBe("Hello!");
    expect(state.history).toEqual([]);

    state = reduceCaption(state, caption("input", "مرحبا يا", true));
    expect(state.history).toEqual([{ input: "مرحبا يا", output: "Hello!" }]);
  });

  it("history preserves the commit order across turns", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "one", false));
    state = reduceCaption(state, caption("output", "uno", false));
    state = reduceCaption(state, caption("input", "one", true));
    state = reduceCaption(state, caption("output", "uno", true));
    expect(state.history).toEqual([{ input: "one", output: "uno" }]);

    state = reduceCaption(state, caption("input", "two", false));
    state = reduceCaption(state, caption("input", "two", true));
    expect(state.history).toEqual([
      { input: "one", output: "uno" },
      { input: "two", output: "" },
    ]);
  });
});

describe("commitLiveCaptions (floor-change / no-turnComplete safety net)", () => {
  it("commits an unfinished live turn and clears it", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false));
    state = reduceCaption(state, caption("output", "Hello", false));

    const committed = commitLiveCaptions(state);
    expect(committed.history).toEqual([{ input: "مرحبا", output: "Hello" }]);
    expect(committed.live).toEqual({ input: "", output: "" });
    expect(committed.finals).toEqual({ input: false, output: false });
    // The source state is untouched (pure).
    expect(state.live).toEqual({ input: "مرحبا", output: "Hello" });
    expect(state.history).toEqual([]);
  });

  it("a live turn with only one open line commits as a one-line turn", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "partial translation", false));
    state = commitLiveCaptions(state);
    expect(state.history).toEqual([
      { input: "", output: "partial translation" },
    ]);
  });

  it("an empty live turn is a no-op", () => {
    const state = emptyCaptions();
    expect(commitLiveCaptions(state)).toBe(state);
  });

  it("the next caption appends below the committed turn", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "first", false));
    state = commitLiveCaptions(state);

    state = reduceCaption(state, caption("input", "second", false));
    state = reduceCaption(state, caption("input", "second", true));
    expect(state.history).toEqual([
      { input: "first", output: "" },
      { input: "second", output: "" },
    ]);
  });

  it("respects the injectable cap", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "a", false));
    state = commitLiveCaptions(state, 2);
    state = reduceCaption(state, caption("input", "b", false));
    state = commitLiveCaptions(state, 2);
    state = reduceCaption(state, caption("input", "c", false));
    state = commitLiveCaptions(state, 2);
    expect(state.history).toEqual([
      { input: "b", output: "" },
      { input: "c", output: "" },
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
    expect(state.history[0]).toEqual({ input: "", output: "seg-3" });
    expect(state.history[49]).toEqual({ input: "", output: "seg-52" });
  });

  it("eviction is oldest-first across both kinds", () => {
    let state = emptyCaptions();
    for (let i = 1; i <= 51; i += 1) {
      const kind: CaptionKind = i % 2 === 0 ? "output" : "input";
      state = reduceCaption(state, caption(kind, `s${i}`, false));
      state = reduceCaption(state, caption(kind, `s${i}`, true));
    }
    expect(state.history.length).toBe(50);
    expect(state.history[0]).toEqual({ input: "", output: "s2" });
    expect(state.history[49]).toEqual({ input: "s51", output: "" });
  });

  it("cap is injectable for tests", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "a", false), 2);
    state = reduceCaption(state, caption("output", "a", true), 2);
    state = reduceCaption(state, caption("output", "b", false), 2);
    state = reduceCaption(state, caption("output", "b", true), 2);
    state = reduceCaption(state, caption("output", "c", false), 2);
    state = reduceCaption(state, caption("output", "c", true), 2);
    expect(state.history).toEqual([
      { input: "", output: "b" },
      { input: "", output: "c" },
    ]);
  });
});

describe("purity", () => {
  it("reduceCaption returns a new state and never mutates the input", () => {
    const before: CaptionsState = {
      live: { input: "مرحبا", output: "Hello" },
      finals: { input: false, output: false },
      history: [{ input: "old", output: "viejo" }],
    };
    const frozen = Object.freeze({
      live: Object.freeze({ ...before.live }),
      finals: Object.freeze({ ...before.finals }),
      history: Object.freeze([...before.history]),
    });

    const after = reduceCaption(frozen, caption("output", "Hi", false));
    expect(after).not.toBe(frozen);
    expect(frozen.live.output).toBe("Hello");
    expect(frozen.finals).toEqual({ input: false, output: false });
    expect(frozen.history).toEqual([{ input: "old", output: "viejo" }]);
    expect(after.live.output).toBe("Hi");
  });

  it("commitLiveCaptions never mutates the input", () => {
    const before: CaptionsState = {
      live: { input: "مرحبا", output: "Hello" },
      finals: { input: true, output: false },
      history: [],
    };
    const frozen = Object.freeze({
      live: Object.freeze({ ...before.live }),
      finals: Object.freeze({ ...before.finals }),
      history: Object.freeze([...before.history]),
    });

    const after = commitLiveCaptions(frozen);
    expect(after).not.toBe(frozen);
    expect(frozen.live).toEqual({ input: "مرحبا", output: "Hello" });
    expect(frozen.history).toEqual([]);
    expect(after.history).toEqual([{ input: "مرحبا", output: "Hello" }]);
  });
});

describe("Arabic text round-trips byte-identically", () => {
  it("interim and committed Arabic text is preserved exactly", () => {
    const arabic = "السَّلامُ عَلَيْكُم — تشكيل، شرطة، وأرقام ١٢٣";
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", arabic, false));
    expect(state.live.output).toBe(arabic);

    state = reduceCaption(state, caption("output", arabic, true));
    expect(state.history[0]?.output === arabic).toBe(true);
    // Byte-identical, not just equal-by-value under some normalization.
    expect(Buffer.from(state.history[0]?.output ?? "", "utf8")).toEqual(
      Buffer.from(arabic, "utf8"),
    );
  });
});
