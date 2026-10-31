// T-002: JSON control-message guards per docs/PROTOCOL.md section 3.
// Revised 2026-10-28 (T-028): mic model replaces the single-floor model.

export type Role = "teacher" | "student";

export type ClientMsg =
  | { t: "mic-open" }
  | { t: "mic-close" }
  | { t: "mute-all" }
  | { t: "unmute-all" }
  | { t: "mute"; participantId: string }
  | { t: "unmute"; participantId: string }
  | { t: "ping"; id: number };

export type ServerMsg =
  | {
      t: "welcome";
      participantId: string;
      participantIndex: number;
      roster: RosterEntry[];
    }
  | { t: "mic-changed"; participantId: string; micOpen: boolean }
  | {
      t: "session-status";
      pair: string;
      status: "connecting" | "live" | "reconnecting" | "failed" | "degraded";
      attempt?: number;
    }
  | {
      t: "caption";
      kind: "input" | "output";
      text: string;
      final: boolean;
      speaker: number;
    }
  | { t: "metrics"; m: RoomMetrics }
  | { t: "error"; code: string; message: string }
  | { t: "pong"; id: number };

export interface RosterEntry {
  participantId: string;
  /** Stable per-join index (0 = teacher); lets clients attribute `caption` /
   * audio `speaker` indexes to roster names (PROTOCOL §2/§3.2). */
  participantIndex: number;
  name: string;
  role: Role;
  lang: string;
  micOpen: boolean;
  forcedMuted: boolean;
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
    hasOnlyKeys(value, [
      "participantId",
      "participantIndex",
      "name",
      "role",
      "lang",
      "micOpen",
      "forcedMuted",
    ]) &&
    isString(value["participantId"]) &&
    isNumber(value["participantIndex"]) &&
    isString(value["name"]) &&
    isRole(value["role"]) &&
    isString(value["lang"]) &&
    typeof value["micOpen"] === "boolean" &&
    typeof value["forcedMuted"] === "boolean"
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
    case "mic-open":
      return hasOnlyKeys(value, ["t"]);
    case "mic-close":
      return hasOnlyKeys(value, ["t"]);
    case "mute-all":
      return hasOnlyKeys(value, ["t"]);
    case "unmute-all":
      return hasOnlyKeys(value, ["t"]);
    case "mute":
      return hasOnlyKeys(value, ["t", "participantId"]) && isString(value["participantId"]);
    case "unmute":
      return hasOnlyKeys(value, ["t", "participantId"]) && isString(value["participantId"]);
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
        hasOnlyKeys(value, ["t", "participantId", "participantIndex", "roster"]) &&
        isString(value["participantId"]) &&
        isNumber(value["participantIndex"]) &&
        Array.isArray(value["roster"]) &&
        (value["roster"] as unknown[]).every(isRosterEntry)
      );
    case "mic-changed":
      return (
        hasOnlyKeys(value, ["t", "participantId", "micOpen"]) &&
        isString(value["participantId"]) &&
        typeof value["micOpen"] === "boolean"
      );
    case "session-status":
      return (
        hasOnlyKeys(value, ["t", "pair", "status"], ["attempt"]) &&
        isString(value["pair"]) &&
        isSessionStatus(value["status"]) &&
        (value["attempt"] === undefined || isNumber(value["attempt"]))
      );
    case "caption":
      return (
        hasOnlyKeys(value, ["t", "kind", "text", "final", "speaker"]) &&
        (value["kind"] === "input" || value["kind"] === "output") &&
        isString(value["text"]) &&
        typeof value["final"] === "boolean" &&
        isNumber(value["speaker"])
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
