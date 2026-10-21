import { describe, expect, it } from "vitest";
import {
  applyFloorEvent,
  initialFloorState,
  type FloorState,
} from "../src/floor.js";

// Helpers: idle/teacher/student base states. teacherConnected:true unless noted.
function idle(overrides: Partial<FloorState> = {}): FloorState {
  return { ...initialFloorState(), teacherConnected: true, ...overrides };
}
function teacherFloor(overrides: Partial<FloorState> = {}): FloorState {
  return {
    ...initialFloorState(),
    teacherConnected: true,
    holder: { kind: "teacher" },
    ...overrides,
  };
}
function studentFloor(pid: string, raised: string[] = []): FloorState {
  return {
    ...initialFloorState(),
    teacherConnected: true,
    holder: { kind: "student", participantId: pid },
    raised: [...raised],
  };
}

describe("floor control transition table (docs/FLOOR-CONTROL.md)", () => {
  it("row 1: IDLE + teacher speaking-start -> TEACHER_SPEAKING", () => {
    const r = applyFloorEvent(idle(), { type: "teacherStart" });
    expect(r.state.holder).toEqual({ kind: "teacher" });
    expect(r.broadcasts).toEqual([
      { type: "floor-changed", floor: { kind: "teacher" }, reason: "teacher-start" },
    ]);
  });

  it("row 2: IDLE + grant(pid) -> STUDENT_SPEAKING(pid), dequeues pid", () => {
    const r = applyFloorEvent(idle({ raised: ["a", "b"] }), {
      type: "grant",
      participantId: "a",
    });
    expect(r.state.holder).toEqual({ kind: "student", participantId: "a" });
    expect(r.state.raised).toEqual(["b"]);
    expect(r.broadcasts).toEqual([
      {
        type: "floor-changed",
        floor: { kind: "student", participantId: "a" },
        reason: "grant",
      },
    ]);
  });

  it("row 3: TEACHER_SPEAKING + teacher speaking-stop -> IDLE, sessions idle-close", () => {
    const r = applyFloorEvent(teacherFloor(), { type: "teacherStop" });
    expect(r.state.holder).toEqual({ kind: "none" });
    expect(r.broadcasts).toEqual([
      { type: "floor-changed", floor: { kind: "none" }, reason: "teacher-stop" },
    ]);
    expect(r.effects).toContainEqual({
      kind: "releaseSessionsFor",
      participantId: "teacher",
    });
  });

  it("row 4: STUDENT_SPEAKING(p) + speaking-stop / revoke / disconnect -> IDLE", () => {
    const viaStop = applyFloorEvent(studentFloor("p"), {
      type: "speakingStop",
      participantId: "p",
    });
    expect(viaStop.state.holder).toEqual({ kind: "none" });
    expect(viaStop.broadcasts).toEqual([
      { type: "floor-changed", floor: { kind: "none" }, reason: "speaker-stop" },
    ]);
    expect(viaStop.effects).toContainEqual({
      kind: "releaseSessionsFor",
      participantId: "p",
    });

    const viaRevoke = applyFloorEvent(studentFloor("p"), { type: "revoke" });
    expect(viaRevoke.state.holder).toEqual({ kind: "none" });
    expect(viaRevoke.broadcasts[0]).toMatchObject({
      type: "floor-changed",
      reason: "revoke",
    });

    const viaDisc = applyFloorEvent(studentFloor("p", ["x"]), {
      type: "participantDisconnect",
      participantId: "p",
      isTeacher: false,
    });
    expect(viaDisc.state.holder).toEqual({ kind: "none" });
    expect(viaDisc.broadcasts[0]).toMatchObject({ type: "floor-changed" });
  });

  it("row 5: STUDENT_SPEAKING(p) + teacher speaking-start -> TEACHER, emits preempted:p", () => {
    const r = applyFloorEvent(studentFloor("p"), { type: "teacherStart" });
    expect(r.state.holder).toEqual({ kind: "teacher" });
    expect(r.broadcasts).toEqual([
      {
        type: "floor-changed",
        floor: { kind: "teacher" },
        reason: "preempted:p",
      },
    ]);
    expect(r.effects).toContainEqual({
      kind: "releaseSessionsFor",
      participantId: "p",
    });
    // p must re-raise: not re-queued automatically
    expect(r.state.raised).toEqual([]);
  });

  it("row 6: student audio without floor -> no state change + error{not-your-floor}", () => {
    const s = studentFloor("p");
    const r = applyFloorEvent(s, {
      type: "audioFrame",
      participantId: "q",
      isTeacher: false,
    });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
    expect(r.broadcasts).toEqual([
      { type: "error", code: "not-your-floor", to: "q" },
    ]);

    // IDLE + audio is also a violation
    const idleR = applyFloorEvent(idle(), {
      type: "audioFrame",
      participantId: "q",
      isTeacher: false,
    });
    expect(idleR.state).toEqual(idle());
    expect(idleR.broadcasts).toEqual([
      { type: "error", code: "not-your-floor", to: "q" },
    ]);

    // holder audio passes silently (fan-out is T-009, not this module)
    const ok = applyFloorEvent(s, {
      type: "audioFrame",
      participantId: "p",
      isTeacher: false,
    });
    expect(ok.state).toEqual(s);
    expect(ok.broadcasts).toEqual([]);
  });

  it("row 7: raise-hand on IDLE -> hands update; autoGrant+IDLE grants immediately (rule 2)", () => {
    const r = applyFloorEvent(idle(), {
      type: "raiseHand",
      participantId: "q",
    });
    expect(r.state.holder).toEqual({ kind: "none" });
    expect(r.state.raised).toEqual(["q"]);
    expect(r.broadcasts).toEqual([{ type: "hands", raised: ["q"] }]);

    const auto = applyFloorEvent(idle({ autoGrant: true }), {
      type: "raiseHand",
      participantId: "q",
    });
    expect(auto.state.holder).toEqual({ kind: "student", participantId: "q" });
    expect(auto.state.raised).toEqual([]);
    expect(auto.broadcasts[0]).toMatchObject({
      type: "floor-changed",
      reason: "grant",
    });
  });

  it("row 8: STUDENT_SPEAKING(p) + raise-hand(q), q!=p -> queued, no interruption", () => {
    const r = applyFloorEvent(studentFloor("p"), {
      type: "raiseHand",
      participantId: "q",
    });
    expect(r.state.holder).toEqual({ kind: "student", participantId: "p" });
    expect(r.state.raised).toEqual(["q"]);
    expect(r.broadcasts).toEqual([{ type: "hands", raised: ["q"] }]);
  });

  it("row 9: STUDENT_SPEAKING(p) + grant(q) -> STUDENT_SPEAKING(q), implicit revoke of p", () => {
    const r = applyFloorEvent(studentFloor("p", ["q"]), {
      type: "grant",
      participantId: "q",
    });
    expect(r.state.holder).toEqual({ kind: "student", participantId: "q" });
    expect(r.state.raised).toEqual([]);
    expect(r.broadcasts[0]).toMatchObject({
      type: "floor-changed",
      reason: "handover",
    });
    expect(r.effects).toContainEqual({
      kind: "releaseSessionsFor",
      participantId: "p",
    });
  });

  it("row 10: ANY + teacher disconnect -> IDLE + teacher-gone, pauses translation", () => {
    const r = applyFloorEvent(studentFloor("p", ["x"]), {
      type: "participantDisconnect",
      participantId: "teacher",
      isTeacher: true,
    });
    expect(r.state.holder).toEqual({ kind: "none" });
    expect(r.state.teacherConnected).toBe(false);
    expect(r.broadcasts).toEqual([
      {
        type: "floor-changed",
        floor: { kind: "none" },
        reason: "teacher-gone",
      },
    ]);
    expect(r.effects).toContainEqual({ kind: "pauseTranslation" });
    expect(r.effects).toContainEqual({ kind: "releaseAllSessions" });
  });

  it("row 11: STUDENT_SPEAKING(p) + p disconnects -> IDLE, hands queue otherwise unchanged", () => {
    const r = applyFloorEvent(studentFloor("p", ["x"]), {
      type: "participantDisconnect",
      participantId: "p",
      isTeacher: false,
    });
    expect(r.state.holder).toEqual({ kind: "none" });
    expect(r.state.raised).toEqual(["x"]);
    expect(r.broadcasts[0]).toMatchObject({ type: "floor-changed" });
  });

  it("row 12: second teacher join -> no change + error{teacher-taken}", () => {
    const s = teacherFloor();
    const r = applyFloorEvent(s, { type: "teacherJoin" });
    expect(r.state).toEqual(s);
    expect(r.broadcasts).toEqual([{ type: "error", code: "teacher-taken" }]);
  });
});

describe("floor control edge cases (normative)", () => {
  it("two students raising at once queue FIFO by arrival order", () => {
    let s = idle();
    for (const pid of ["a", "b", "c"]) {
      s = applyFloorEvent(s, { type: "raiseHand", participantId: pid }).state;
    }
    expect(s.raised).toEqual(["a", "b", "c"]);
  });

  it("duplicate raise-hand is ignored (idempotent, silent)", () => {
    const first = applyFloorEvent(idle(), {
      type: "raiseHand",
      participantId: "a",
    });
    expect(first.broadcasts).toEqual([{ type: "hands", raised: ["a"] }]);
    const dup = applyFloorEvent(first.state, {
      type: "raiseHand",
      participantId: "a",
    });
    expect(dup.state).toEqual(first.state);
    expect(dup.broadcasts).toEqual([]);
    expect(dup.effects).toEqual([]);
  });

  it("grant to absent pid -> error, no state change", () => {
    const s = idle({ raised: ["a"] });
    const r = applyFloorEvent(s, { type: "grant", participantId: "ghost" });
    expect(r.state).toEqual(s);
    expect(r.broadcasts).toEqual([
      { type: "error", code: "grant-absent", participantId: "ghost" },
    ]);
    expect(r.effects).toEqual([]);
  });

  it("revoke on IDLE floor -> no-op state, still broadcasts floor-changed", () => {
    const s = idle();
    const r = applyFloorEvent(s, { type: "revoke" });
    expect(r.state).toEqual(s);
    expect(r.broadcasts).toEqual([
      { type: "floor-changed", floor: { kind: "none" }, reason: "revoke-noop" },
    ]);
  });

  it("teacher disconnect pauses; teacherRejoin resumes at IDLE", () => {
    const gone = applyFloorEvent(teacherFloor(), {
      type: "participantDisconnect",
      participantId: "teacher",
      isTeacher: true,
    });
    expect(gone.state.teacherConnected).toBe(false);
    expect(gone.state.holder).toEqual({ kind: "none" });

    const back = applyFloorEvent(gone.state, { type: "teacherRejoin" });
    expect(back.state.teacherConnected).toBe(true);
    expect(back.state.holder).toEqual({ kind: "none" });
    expect(back.broadcasts[0]).toMatchObject({
      type: "floor-changed",
      reason: "teacher-rejoin",
    });
    expect(back.effects).toContainEqual({ kind: "resumeTranslation" });
  });

  it("deny removes pid from hands; lowerHand removes self from queue", () => {
    const denied = applyFloorEvent(idle({ raised: ["a", "b"] }), {
      type: "deny",
      participantId: "a",
    });
    expect(denied.state.raised).toEqual(["b"]);
    expect(denied.broadcasts).toEqual([{ type: "hands", raised: ["b"] }]);

    const lowered = applyFloorEvent(denied.state, {
      type: "lowerHand",
      participantId: "b",
    });
    expect(lowered.state.raised).toEqual([]);
    expect(lowered.broadcasts).toEqual([{ type: "hands", raised: [] }]);
  });
});
