import { describe, expect, it } from "vitest";
import {
  applyMicControlRow,
  applyMicEvent,
  initialMicState,
  isForcedMuted,
  isMicOpen,
  micControlToRow,
  type MicState,
} from "../src/mic.js";

// Base state: teacher present unless noted. Students start closed, not forced.
function base(overrides: Partial<MicState> = {}): MicState {
  return { ...initialMicState(), teacherConnected: true, ...overrides };
}

function openMic(state: MicState, pid: string, isTeacher = false): MicState {
  return applyMicEvent(state, {
    type: "micOpen",
    participantId: pid,
    isTeacher,
  }).state;
}

describe("mic control transition table (docs/MIC-CONTROL.md)", () => {
  it("row 1: student mic-open (unforced, closed) -> open + mic-changed{true} + ensureSession", () => {
    const r = applyMicEvent(base(), {
      type: "micOpen",
      participantId: "s1",
      isTeacher: false,
    });
    expect(isMicOpen(r.state, "s1")).toBe(true);
    expect(r.broadcasts).toEqual([
      { type: "mic-changed", participantId: "s1", micOpen: true },
    ]);
    expect(r.effects).toEqual([{ kind: "ensureSession", source: "s1" }]);
  });

  it("row 1b: teacher mic-open is never blocked by force-mute flags", () => {
    // Unreachable via the DO (teachers are never force-muted), but the machine
    // must not gate the teacher leg on the student-only check.
    const r = applyMicEvent(base(), {
      type: "micOpen",
      participantId: "t1",
      isTeacher: true,
    });
    expect(isMicOpen(r.state, "t1")).toBe(true);
    expect(r.effects).toEqual([{ kind: "ensureSession", source: "t1" }]);
  });

  it("row 2: forced student mic-open -> error{mic-forced-muted}, mic stays closed", () => {
    const s = base({ forcedMuted: new Set(["s1"]) });
    const r = applyMicEvent(s, {
      type: "micOpen",
      participantId: "s1",
      isTeacher: false,
    });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
    expect(r.broadcasts).toEqual([
      { type: "error", code: "mic-forced-muted", to: "s1" },
    ]);
  });

  it("row 3: mic-open idempotent when already open -> silent no-op", () => {
    const s = openMic(base(), "s1");
    const r = applyMicEvent(s, {
      type: "micOpen",
      participantId: "s1",
      isTeacher: false,
    });
    expect(r.state).toEqual(s);
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it("row 4: mic-close on open mic -> mic-changed{false} + flush then pipe release", () => {
    const s = openMic(base(), "s1");
    const r = applyMicEvent(s, { type: "micClose", participantId: "s1" });
    expect(isMicOpen(r.state, "s1")).toBe(false);
    expect(r.broadcasts).toEqual([
      { type: "mic-changed", participantId: "s1", micOpen: false },
    ]);
    expect(r.effects).toEqual([
      { kind: "flushSpeaker", participantId: "s1" },
      { kind: "closeSpeakerPipes", participantId: "s1" },
    ]);
  });

  it("row 5: mic-close on already-closed mic -> silent no-op", () => {
    const s = base();
    const r = applyMicEvent(s, { type: "micClose", participantId: "s1" });
    expect(r.state).toEqual(s);
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it("row 6: mute an open-mic student -> force + cut (mic-changed{false}, flush, closePipes) + roster", () => {
    const s = openMic(base(), "s1");
    const r = applyMicEvent(s, { type: "mute", participantId: "s1" });
    expect(isForcedMuted(r.state, "s1")).toBe(true);
    expect(isMicOpen(r.state, "s1")).toBe(false);
    expect(r.broadcasts).toEqual([
      { type: "mic-changed", participantId: "s1", micOpen: false },
      { type: "roster" },
    ]);
    expect(r.effects).toEqual([
      { kind: "flushSpeaker", participantId: "s1" },
      { kind: "closeSpeakerPipes", participantId: "s1" },
    ]);
  });

  it("row 7: mute a closed-mic student -> force + roster, no pipe effects", () => {
    const r = applyMicEvent(base(), { type: "mute", participantId: "s1" });
    expect(isForcedMuted(r.state, "s1")).toBe(true);
    expect(r.broadcasts).toEqual([{ type: "roster" }]);
    expect(r.effects).toEqual([]);
  });

  it("row 8: mute an already-forced student -> silent no-op", () => {
    const s = base({ forcedMuted: new Set(["s1"]) });
    const r = applyMicEvent(s, { type: "mute", participantId: "s1" });
    expect(r.state).toEqual(s);
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it("row 9: unmute clears the flag but never auto-opens the mic", () => {
    const s = base({ forcedMuted: new Set(["s1"]) });
    const r = applyMicEvent(s, { type: "unmute", participantId: "s1" });
    expect(isForcedMuted(r.state, "s1")).toBe(false);
    expect(isMicOpen(r.state, "s1")).toBe(false);
    expect(r.broadcasts).toEqual([{ type: "roster" }]);
    expect(r.effects).toEqual([]);
  });

  it("row 10: unmute of a not-forced student -> silent no-op", () => {
    const r = applyMicEvent(base(), { type: "unmute", participantId: "s1" });
    expect(r.state).toEqual(base());
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it("row 11: mute-all forces every student, cuts open mics, sets the latch, one roster", () => {
    let s = openMic(openMic(base(), "s1"), "s2");
    s = openMic(s, "t1", true);
    const r = applyMicEvent(s, {
      type: "muteAll",
      studentIds: ["s1", "s2", "s3"],
    });
    for (const pid of ["s1", "s2", "s3"]) {
      expect(isForcedMuted(r.state, pid)).toBe(true);
      expect(isMicOpen(r.state, pid)).toBe(false);
    }
    expect(r.state.muteAllActive).toBe(true);
    // Teacher mic untouched.
    expect(isMicOpen(r.state, "t1")).toBe(true);
    expect(r.broadcasts).toEqual([
      { type: "mic-changed", participantId: "s1", micOpen: false },
      { type: "mic-changed", participantId: "s2", micOpen: false },
      { type: "roster" },
    ]);
    expect(r.effects).toEqual([
      { kind: "flushSpeaker", participantId: "s1" },
      { kind: "closeSpeakerPipes", participantId: "s1" },
      { kind: "flushSpeaker", participantId: "s2" },
      { kind: "closeSpeakerPipes", participantId: "s2" },
    ]);
  });

  it("row 12: second mute-all is idempotent apart from the roster ping", () => {
    const first = applyMicEvent(base(), {
      type: "muteAll",
      studentIds: ["s1", "s2"],
    });
    const second = applyMicEvent(first.state, {
      type: "muteAll",
      studentIds: ["s1", "s2"],
    });
    expect(second.state).toEqual(first.state);
    expect(second.broadcasts).toEqual([{ type: "roster" }]);
    expect(second.effects).toEqual([]);
  });

  it("row 13: unmute-all clears flags + latch; mics stay closed", () => {
    const s = base({
      forcedMuted: new Set(["s1", "s2"]),
      muteAllActive: true,
    });
    const r = applyMicEvent(s, { type: "unmuteAll", studentIds: [] });
    expect(r.state.forcedMuted.size).toBe(0);
    expect(r.state.muteAllActive).toBe(false);
    expect(r.broadcasts).toEqual([{ type: "roster" }]);
    expect(r.effects).toEqual([]);
  });

  it("row 14: unmute-all with nothing to clear -> silent no-op", () => {
    const r = applyMicEvent(base(), { type: "unmuteAll", studentIds: [] });
    expect(r.state).toEqual(base());
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it("row 15: studentJoin under an active mute-all is admitted force-muted, silently", () => {
    const s = base({ forcedMuted: new Set(["s1"]), muteAllActive: true });
    const r = applyMicEvent(s, {
      type: "studentJoin",
      participantId: "s9",
    });
    expect(isForcedMuted(r.state, "s9")).toBe(true);
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it("row 16: studentJoin without the latch -> silent no-op", () => {
    const r = applyMicEvent(base(), {
      type: "studentJoin",
      participantId: "s9",
    });
    expect(r.state).toEqual(base());
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it("row 17: audio frame with an open mic passes silently (fan-out lives in the DO)", () => {
    const s = openMic(base(), "s1");
    const r = applyMicEvent(s, { type: "audioFrame", participantId: "s1" });
    expect(r.state).toEqual(s);
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it("row 18: audio frame with a closed mic -> error{mic-closed}, no state change", () => {
    const r = applyMicEvent(base(), { type: "audioFrame", participantId: "s1" });
    expect(r.state).toEqual(base());
    expect(r.effects).toEqual([]);
    expect(r.broadcasts).toEqual([
      { type: "error", code: "mic-closed", to: "s1" },
    ]);
  });

  it("row 19: audio frame from a pid that never opened -> same mic-closed error", () => {
    const s = openMic(base(), "other");
    const r = applyMicEvent(s, { type: "audioFrame", participantId: "s1" });
    expect(r.broadcasts).toEqual([
      { type: "error", code: "mic-closed", to: "s1" },
    ]);
  });

  it("row 20: disconnect of an open-mic student -> cut + force flag cleared", () => {
    let s = base({ forcedMuted: new Set(["s1"]) });
    s = openMic({ ...s, forcedMuted: new Set() }, "s1");
    const r = applyMicEvent(s, {
      type: "participantDisconnect",
      participantId: "s1",
      isTeacher: false,
    });
    expect(isMicOpen(r.state, "s1")).toBe(false);
    expect(isForcedMuted(r.state, "s1")).toBe(false);
    expect(r.broadcasts).toEqual([
      { type: "mic-changed", participantId: "s1", micOpen: false },
    ]);
    expect(r.effects).toEqual([
      { kind: "flushSpeaker", participantId: "s1" },
      { kind: "closeSpeakerPipes", participantId: "s1" },
    ]);
  });

  it("row 21: disconnect of a closed-mic student still releases their listener refs", () => {
    const r = applyMicEvent(base(), {
      type: "participantDisconnect",
      participantId: "s1",
      isTeacher: false,
    });
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([
      { kind: "closeSpeakerPipes", participantId: "s1" },
    ]);
  });

  it("row 22: teacher disconnect toggles the flag + cuts only the teacher's own pipes", () => {
    const s = openMic(openMic(base(), "t1", true), "s1");
    const r = applyMicEvent(s, {
      type: "participantDisconnect",
      participantId: "t1",
      isTeacher: true,
    });
    expect(r.state.teacherConnected).toBe(false);
    expect(isMicOpen(r.state, "t1")).toBe(false);
    // Students are NOT affected by a teacher departure (Zoom/Meet semantics).
    expect(isMicOpen(r.state, "s1")).toBe(true);
    expect(r.broadcasts).toEqual([
      { type: "mic-changed", participantId: "t1", micOpen: false },
    ]);
    expect(r.effects).toEqual([
      { kind: "flushSpeaker", participantId: "t1" },
      { kind: "closeSpeakerPipes", participantId: "t1" },
    ]);
  });

  it("row 23: student disconnect does not touch teacherConnected", () => {
    const r = applyMicEvent(base(), {
      type: "participantDisconnect",
      participantId: "s1",
      isTeacher: false,
    });
    expect(r.state.teacherConnected).toBe(true);
  });

  it("row 24: teacherJoin on a fresh room -> flag set, silent", () => {
    const r = applyMicEvent(initialMicState(), { type: "teacherJoin" });
    expect(r.state.teacherConnected).toBe(true);
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it("row 25: second live teacherJoin -> error{teacher-taken}, no state change", () => {
    const r = applyMicEvent(base(), { type: "teacherJoin" });
    expect(r.state).toEqual(base());
    expect(r.broadcasts).toEqual([{ type: "error", code: "teacher-taken" }]);
  });

  it("row 26: teacherRejoin after a disconnect -> flag restored, state kept", () => {
    const gone = applyMicEvent(base(), {
      type: "participantDisconnect",
      participantId: "t1",
      isTeacher: true,
    });
    const back = applyMicEvent(gone.state, { type: "teacherRejoin" });
    expect(back.state.teacherConnected).toBe(true);
    expect(back.broadcasts).toEqual([]);
    expect(back.effects).toEqual([]);
  });

  it("row 27: socketReplaced cuts an open mic but KEEPS the force flag", () => {
    const s = openMic(base(), "s1");
    const r = applyMicEvent(s, {
      type: "socketReplaced",
      participantId: "s1",
    });
    expect(isMicOpen(r.state, "s1")).toBe(false);
    expect(r.broadcasts).toEqual([
      { type: "mic-changed", participantId: "s1", micOpen: false },
    ]);
    expect(r.effects).toEqual([
      { kind: "flushSpeaker", participantId: "s1" },
      { kind: "closeSpeakerPipes", participantId: "s1" },
    ]);
  });

  it("row 28: socketReplaced with a closed mic -> silent no-op", () => {
    const r = applyMicEvent(base(), {
      type: "socketReplaced",
      participantId: "s1",
    });
    expect(r.state).toEqual(base());
    expect(r.broadcasts).toEqual([]);
    expect(r.effects).toEqual([]);
  });
});

describe("mic control edge cases (normative)", () => {
  it("multiple simultaneous open mics are independent (Zoom/Meet core)", () => {
    let s = base();
    s = openMic(s, "t1", true);
    s = openMic(s, "s1");
    s = openMic(s, "s2");
    expect(isMicOpen(s, "t1")).toBe(true);
    expect(isMicOpen(s, "s1")).toBe(true);
    expect(isMicOpen(s, "s2")).toBe(true);
    // Closing one does not disturb the others.
    const closed = applyMicEvent(s, { type: "micClose", participantId: "s1" });
    expect(isMicOpen(closed.state, "t1")).toBe(true);
    expect(isMicOpen(closed.state, "s2")).toBe(true);
  });

  it("unmute-all only un-forces students force-muted via the latch or singles", () => {
    const s = base({
      forcedMuted: new Set(["s1", "s2"]),
      muteAllActive: false,
    });
    const r = applyMicEvent(s, { type: "unmuteAll", studentIds: [] });
    expect(r.state.forcedMuted.size).toBe(0);
  });

  it("a student joining while the latch is on cannot bypass with mic-open", () => {
    const latched = base({
      forcedMuted: new Set(["late"]),
      muteAllActive: true,
    });
    const r = applyMicEvent(latched, {
      type: "micOpen",
      participantId: "late",
      isTeacher: false,
    });
    expect(isMicOpen(r.state, "late")).toBe(false);
    expect(r.broadcasts).toEqual([
      { type: "error", code: "mic-forced-muted", to: "late" },
    ]);
  });

  it("state immutability: events never mutate the input state", () => {
    const s = openMic(base(), "s1");
    applyMicEvent(s, { type: "mute", participantId: "s1" });
    expect(isMicOpen(s, "s1")).toBe(true);
    expect(isForcedMuted(s, "s1")).toBe(false);
    const fresh = base();
    applyMicEvent(fresh, { type: "muteAll", studentIds: ["s1"] });
    expect(fresh.forcedMuted.size).toBe(0);
    expect(fresh.muteAllActive).toBe(false);
  });

  it("micControlToRow sorts forced pids and captures the latch", () => {
    const row = micControlToRow(
      base({ forcedMuted: new Set(["s2", "s1"]), muteAllActive: true }),
    );
    expect(row).toEqual({ muteAllActive: true, forcedPids: ["s1", "s2"] });
  });

  it("applyMicControlRow restores the policy onto a fresh state; null is a no-op", () => {
    const stored = micControlToRow(
      base({ forcedMuted: new Set(["s1"]), muteAllActive: true }),
    );
    const loaded = applyMicControlRow(initialMicState(), stored);
    expect(loaded.muteAllActive).toBe(true);
    expect(isForcedMuted(loaded, "s1")).toBe(true);
    expect(applyMicControlRow(initialMicState(), null)).toEqual(
      initialMicState(),
    );
  });
});
