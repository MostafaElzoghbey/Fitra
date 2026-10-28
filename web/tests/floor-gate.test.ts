import { describe, expect, it } from "vitest";
import { floorLost } from "../src/audio/floorGate.js";

const none = { kind: "none" } as const;
const teacher = { kind: "teacher" } as const;
const student = (participantId: string) =>
  ({ kind: "student", participantId }) as const;

describe("floorLost (playback interrupt gate)", () => {
  it("interrupts the teacher only when a new holder takes the floor", () => {
    expect(floorLost(teacher, none, "teacher", "t")).toBe(false);
    expect(floorLost(teacher, student("s1"), "teacher", "t")).toBe(true);
    expect(floorLost(teacher, teacher, "teacher", "t")).toBe(false);
    expect(floorLost(none, none, "teacher", "t")).toBe(false);
  });

  it("interrupts a student only when a new holder takes the floor", () => {
    expect(floorLost(student("s1"), none, "student", "s1")).toBe(false);
    expect(floorLost(student("s1"), teacher, "student", "s1")).toBe(true);
    expect(floorLost(student("s1"), student("s2"), "student", "s1")).toBe(true);
    expect(floorLost(student("s1"), student("s1"), "student", "s1")).toBe(false);
    expect(floorLost(student("s2"), none, "student", "s1")).toBe(false);
    expect(floorLost(student("s2"), teacher, "student", "s1")).toBe(false);
  });

  it("never interrupts a listener that did not hold the floor", () => {
    expect(floorLost(teacher, none, "student", "s1")).toBe(false);
    expect(floorLost(student("s2"), student("s1"), "student", "s1")).toBe(false);
  });

  it("does not interrupt before the first known floor or self id", () => {
    expect(floorLost(null, none, "teacher", "t")).toBe(false);
    expect(floorLost(teacher, none, "teacher", null)).toBe(false);
  });
});
