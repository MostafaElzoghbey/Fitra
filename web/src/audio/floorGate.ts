import type { FloorHolder } from "@fitra/shared";

export function floorLost(
  previous: FloorHolder | null,
  next: FloorHolder,
  role: "teacher" | "student",
  selfId: string | null,
): boolean {
  if (previous === null || selfId === null) return false;
  const heldBefore =
    role === "teacher"
      ? previous.kind === "teacher"
      : previous.kind === "student" && previous.participantId === selfId;
  if (!heldBefore) return false;
  if (next.kind === "none") return false;
  return role === "teacher"
    ? next.kind !== "teacher"
    : !(next.kind === "student" && next.participantId === selfId);
}
