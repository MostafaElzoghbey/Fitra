// T-002: JSON control-message guards per docs/PROTOCOL.md section 3.

export type Role = "teacher" | "student";

export type FloorHolder =
  | { kind: "none" }
  | { kind: "teacher" }
  | { kind: "student"; participantId: string };

export type ClientMsg =
  | { t: "speaking-start" }
  | { t: "speaking-stop" }
  | { t: "raise-hand" }
  | { t: "lower-hand" }
  | { t: "grant"; participantId: string }
  | { t: "deny"; participantId: string }
  | { t: "revoke" }
  | { t: "ping"; id: number };

export type ServerMsg =
  | {
      t: "welcome";
      participantId: string;
      participantIndex: number;
      floor: FloorHolder;
      roster: RosterEntry[];
    }
  | { t: "floor-changed"; floor: FloorHolder; reason: string }
  | { t: "hands"; raised: string[] }
  | {
      t: "session-status";
      pair: string;
      status: "connecting" | "live" | "reconnecting" | "failed" | "degraded";
      attempt?: number;
    }
  | { t: "caption"; kind: "input" | "output"; text: string; final: boolean }
  | { t: "metrics"; m: RoomMetrics }
  | { t: "error"; code: string; message: string }
  | { t: "pong"; id: number };

export interface RosterEntry {
  participantId: string;
  name: string;
  role: Role;
  lang: string;
}

export interface RoomMetricsSession {
  pair: string;
  status: string;
  reconnects: number;
}

export interface RoomMetrics {
  e2eLatencyMs: number | null;
  sessions: RoomMetricsSession[];
  inboundMsgPerSec: number;
  outboundMsgPerSec: number;
  errorsLastMin: number;
  doActiveSec: number;
}

// --- primitives -----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/** Exact-key check: required keys present, no unexpected keys beyond allowed. */
function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set<string>([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

// --- structural guards ----------------------------------------------------

export function isFloorHolder(value: unknown): value is FloorHolder {
  if (!isRecord(value)) return false;
  const kind = value["kind"];
  switch (kind) {
    case "none":
      return hasOnlyKeys(value, ["kind"]);
    case "teacher":
      return hasOnlyKeys(value, ["kind"]);
    case "student":
      return (
        hasOnlyKeys(value, ["kind", "participantId"]) && isString(value["participantId"])
      );
    default:
      return false;
  }
}

function isRole(value: unknown): value is Role {
  switch (value) {
    case "teacher":
    case "student":
      return true;
    default:
      return false;
  }
}

export function isRosterEntry(value: unknown): value is RosterEntry {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["participantId", "name", "role", "lang"]) &&
    isString(value["participantId"]) &&
    isString(value["name"]) &&
    isRole(value["role"]) &&
    isString(value["lang"])
  );
}

function isRoomMetricsSession(value: unknown): value is RoomMetricsSession {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["pair", "status", "reconnects"]) &&
    isString(value["pair"]) &&
    isString(value["status"]) &&
    isNumber(value["reconnects"])
  );
}

export function isRoomMetrics(value: unknown): value is RoomMetrics {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "e2eLatencyMs",
      "sessions",
      "inboundMsgPerSec",
      "outboundMsgPerSec",
      "errorsLastMin",
      "doActiveSec",
    ])
  ) {
    return false;
  }
  const latency = value["e2eLatencyMs"];
  return (
    (latency === null || isNumber(latency)) &&
    Array.isArray(value["sessions"]) &&
    (value["sessions"] as unknown[]).every(isRoomMetricsSession) &&
    isNumber(value["inboundMsgPerSec"]) &&
    isNumber(value["outboundMsgPerSec"]) &&
    isNumber(value["errorsLastMin"]) &&
    isNumber(value["doActiveSec"])
  );
}

// --- message guards -------------------------------------------------------

export function isClientMsg(value: unknown): value is ClientMsg {
  if (!isRecord(value)) return false;
  const tag = value["t"];
  switch (tag) {
    case "speaking-start":
      return hasOnlyKeys(value, ["t"]);
    case "speaking-stop":
      return hasOnlyKeys(value, ["t"]);
    case "raise-hand":
      return hasOnlyKeys(value, ["t"]);
    case "lower-hand":
      return hasOnlyKeys(value, ["t"]);
    case "grant":
      return hasOnlyKeys(value, ["t", "participantId"]) && isString(value["participantId"]);
    case "deny":
      return hasOnlyKeys(value, ["t", "participantId"]) && isString(value["participantId"]);
    case "revoke":
      return hasOnlyKeys(value, ["t"]);
    case "ping":
      return hasOnlyKeys(value, ["t", "id"]) && isNumber(value["id"]);
    default:
      return false;
  }
}

function isSessionStatus(
  value: unknown,
): value is "connecting" | "live" | "reconnecting" | "failed" | "degraded" {
  switch (value) {
    case "connecting":
    case "live":
    case "reconnecting":
    case "failed":
    case "degraded":
      return true;
    default:
      return false;
  }
}

export function isServerMsg(value: unknown): value is ServerMsg {
  if (!isRecord(value)) return false;
  const tag = value["t"];
  switch (tag) {
    case "welcome":
      return (
        hasOnlyKeys(value, ["t", "participantId", "participantIndex", "floor", "roster"]) &&
        isString(value["participantId"]) &&
        isNumber(value["participantIndex"]) &&
        isFloorHolder(value["floor"]) &&
        Array.isArray(value["roster"]) &&
        (value["roster"] as unknown[]).every(isRosterEntry)
      );
    case "floor-changed":
      return (
        hasOnlyKeys(value, ["t", "floor", "reason"]) &&
        isFloorHolder(value["floor"]) &&
        isString(value["reason"])
      );
    case "hands":
      return hasOnlyKeys(value, ["t", "raised"]) && isStringArray(value["raised"]);
    case "session-status":
      return (
        hasOnlyKeys(value, ["t", "pair", "status"], ["attempt"]) &&
        isString(value["pair"]) &&
        isSessionStatus(value["status"]) &&
        (value["attempt"] === undefined || isNumber(value["attempt"]))
      );
    case "caption":
      return (
        hasOnlyKeys(value, ["t", "kind", "text", "final"]) &&
        (value["kind"] === "input" || value["kind"] === "output") &&
        isString(value["text"]) &&
        typeof value["final"] === "boolean"
      );
    case "metrics":
      return hasOnlyKeys(value, ["t", "m"]) && isRoomMetrics(value["m"]);
    case "error":
      return (
        hasOnlyKeys(value, ["t", "code", "message"]) &&
        isString(value["code"]) &&
        isString(value["message"])
      );
    case "pong":
      return hasOnlyKeys(value, ["t", "id"]) && isNumber(value["id"]);
    default:
      return false;
  }
}
