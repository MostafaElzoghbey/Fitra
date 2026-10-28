// T-021: unit tests for the PURE caption reducer (SPEC FR-034/FR-035,
// docs/PROTOCOL.md §3.1/§3.4).
//
// The wire sends `caption{kind, text, final}` where `text` is the FULL current
// segment (never a delta): `final:false` replaces the live segment for that
// kind, `final:true` commits it to history exactly once. These tests pin that
// contract, the 50-segment history cap, input/output independence and the
// byte-identical pass-through of Arabic (RTL) text. No React, no DOM.

import { describe, expect, it } from "vitest";

import {
  CAPTIONS_MAX_SEGMENTS,
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

/** Commit `count` numbered segments of one kind, returning the final state. */
function commitSeries(count: number, kind: "input" | "output"): CaptionsState {
  let state = emptyCaptions();
  for (let i = 1; i <= count; i += 1) {
    state = reduceCaption(state, caption(kind, `seg-${i}`, false));
    state = reduceCaption(state, caption(kind, `seg-${i}`, true));
  }
  return state;
}

describe("emptyCaptions", () => {
  it("starts with empty live slots and no history", () => {
    const state = emptyCaptions();
    expect(state.live.input).toBe("");
    expect(state.live.output).toBe("");
    expect(state.history).toEqual([]);
  });
});

describe("interim (final:false) replaces the live segment", () => {
  it("replaces only that kind's live slot, history untouched", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false));
    expect(state.live.output).toBe("Hello");
    expect(state.live.input).toBe("");
    expect(state.history).toEqual([]);

    state = reduceCaption(state, caption("output", "Hello world", false));
    expect(state.live.output).toBe("Hello world");
    expect(state.history).toEqual([]);
  });

  it("empty interim text clears only its own live slot", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false));
    state = reduceCaption(state, caption("output", "Hello", false));

    state = reduceCaption(state, caption("input", "", false));
    expect(state.live.input).toBe("");
    expect(state.live.output).toBe("Hello");
    expect(state.history).toEqual([]);
  });
});

describe("final:true commits exactly once", () => {
  it("commits the live segment and clears the live slot", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello world", false));
    state = reduceCaption(state, caption("output", "Hello world", true));

    expect(state.history).toEqual([{ kind: "output", text: "Hello world" }]);
    expect(state.live.output).toBe("");
  });

  it("a second final for the same turn commits nothing more", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false));
    state = reduceCaption(state, caption("output", "Hello", true));
    state = reduceCaption(state, caption("output", "Hello", true));

    expect(state.history).toEqual([{ kind: "output", text: "Hello" }]);
  });

  it("empty final commits nothing and leaves history unchanged", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "Hello", false));
    state = reduceCaption(state, caption("output", "Hello", true));

    state = reduceCaption(state, caption("output", "", true));
    expect(state.history).toEqual([{ kind: "output", text: "Hello" }]);
    expect(state.live.output).toBe("");
  });

  it("a final with no open live turn commits nothing", () => {
    // PROTOCOL §3.1: final:true is emitted exactly once per turn, after the
    // turn's interims built the live segment. A final arriving with no live
    // segment (duplicate or stray) must not invent history.
    let state = reduceCaption(emptyCaptions(), caption("input", "partial", true));
    expect(state.history).toEqual([]);
    expect(state.live.input).toBe("");

    state = reduceCaption(state, caption("input", "real", false));
    state = reduceCaption(state, caption("input", "real", true));
    expect(state.history).toEqual([{ kind: "input", text: "real" }]);
  });
});

describe("next turn never overwrites committed history", () => {
  it("final then next interim leaves history unchanged", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", "turn one", false));
    state = reduceCaption(state, caption("output", "turn one", true));

    state = reduceCaption(state, caption("output", "turn two", false));
    expect(state.history).toEqual([{ kind: "output", text: "turn one" }]);
    expect(state.live.output).toBe("turn two");

    state = reduceCaption(state, caption("output", "turn two", true));
    expect(state.history).toEqual([
      { kind: "output", text: "turn one" },
      { kind: "output", text: "turn two" },
    ]);
  });
});

describe("input and output live slots are independent", () => {
  it("one kind's interim/final never touches the other kind", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "مرحبا", false));
    state = reduceCaption(state, caption("output", "Hello", false));

    state = reduceCaption(state, caption("output", "Hello!", false));
    state = reduceCaption(state, caption("output", "Hello!", true));
    expect(state.live.input).toBe("مرحبا");
    expect(state.history).toEqual([{ kind: "output", text: "Hello!" }]);

    state = reduceCaption(state, caption("input", "مرحبا يا", false));
    expect(state.live.output).toBe("");
    expect(state.history).toEqual([{ kind: "output", text: "Hello!" }]);
  });

  it("history preserves the commit order across kinds", () => {
    let state = emptyCaptions();
    state = reduceCaption(state, caption("input", "one", false));
    state = reduceCaption(state, caption("output", "uno", false));
    state = reduceCaption(state, caption("input", "one", true));
    state = reduceCaption(state, caption("output", "uno", true));

    expect(state.history).toEqual([
      { kind: "input", text: "one" },
      { kind: "output", text: "uno" },
    ]);
  });
});

describe("history cap", () => {
  it("default cap is 50 committed segments", () => {
    expect(CAPTIONS_MAX_SEGMENTS).toBe(50);
  });

  it("52 commits leave 50 segments with the two oldest evicted", () => {
    const state = commitSeries(52, "output");
    expect(state.history.length).toBe(50);
    expect(state.history[0]).toEqual({ kind: "output", text: "seg-3" });
    expect(state.history[49]).toEqual({ kind: "output", text: "seg-52" });
  });

  it("eviction is oldest-first across both kinds", () => {
    let state = emptyCaptions();
    for (let i = 1; i <= 51; i += 1) {
      const kind: CaptionKind = i % 2 === 0 ? "output" : "input";
      state = reduceCaption(state, caption(kind, `s${i}`, false));
      state = reduceCaption(state, caption(kind, `s${i}`, true));
    }
    expect(state.history.length).toBe(50);
    expect(state.history[0]).toEqual({ kind: "output", text: "s2" });
    expect(state.history[49]).toEqual({ kind: "input", text: "s51" });
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
      { kind: "output", text: "b" },
      { kind: "output", text: "c" },
    ]);
  });
});

describe("purity", () => {
  it("returns a new state and never mutates the input", () => {
    const before: CaptionsState = {
      live: { input: "مرحبا", output: "Hello" },
      history: [{ kind: "input", text: "old" }],
    };
    const frozen = Object.freeze({
      live: Object.freeze({ ...before.live }),
      history: Object.freeze([...before.history]),
    });

    const after = reduceCaption(frozen, caption("output", "Hi", false));
    expect(after).not.toBe(frozen);
    expect(frozen.live.output).toBe("Hello");
    expect(frozen.history).toEqual([{ kind: "input", text: "old" }]);
    expect(after.live.output).toBe("Hi");
  });
});

describe("Arabic text round-trips byte-identically", () => {
  it("interim and committed Arabic text is preserved exactly", () => {
    const arabic = "السَّلامُ عَلَيْكُم — تشكيل، شرطة، وأرقام ١٢٣";
    let state = emptyCaptions();
    state = reduceCaption(state, caption("output", arabic, false));
    expect(state.live.output).toBe(arabic);

    state = reduceCaption(state, caption("output", arabic, true));
    expect(state.history[0]?.text === arabic).toBe(true);
    // Byte-identical, not just equal-by-value under some normalization.
    expect(Buffer.from(state.history[0]?.text ?? "", "utf8")).toEqual(
      Buffer.from(arabic, "utf8"),
    );
  });
});
