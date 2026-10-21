// T-013: HTTP create/join calls (SPEC FR-002 / FR-005, worker/src/index.ts).
// Response shapes are validated with local guards so the UI never renders an
// untyped `unknown` as a room code or join token.

import { errorMessageKey, type ParticipantLang, type UiStrings } from "../i18n.js";

export interface CreateRoomRequest {
  readonly teacherName: string;
  readonly teacherLang: ParticipantLang;
  readonly autoGrant: boolean;
  readonly classmatesHearStudent: boolean;
  readonly consentConfirmed: boolean;
}

export interface JoinRoomRequest {
  readonly name: string;
  readonly role: "teacher" | "student";
  readonly lang: ParticipantLang;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly messageKey: keyof UiStrings };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body["code"] === "string") return body["code"];
  } catch {
    // Non-JSON error body: fall through to the status-derived code.
  }
  return "network";
}

export async function createRoom(
  request: CreateRoomRequest,
): Promise<ApiResult<string>> {
  let response: Response;
  try {
    response = await fetch("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, messageKey: "errNetwork" };
  }
  if (!response.ok) {
    return { ok: false, messageKey: errorMessageKey(await readErrorCode(response)) };
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body["code"] !== "string" || body["code"] === "") {
    return { ok: false, messageKey: "errServer" };
  }
  return { ok: true, value: body["code"] };
}

export async function joinRoom(
  code: string,
  request: JoinRoomRequest,
): Promise<ApiResult<string>> {
  let response: Response;
  try {
    response = await fetch(`/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, messageKey: "errNetwork" };
  }
  if (!response.ok) {
    return { ok: false, messageKey: errorMessageKey(await readErrorCode(response)) };
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body["token"] !== "string" || body["token"] === "") {
    return { ok: false, messageKey: "errServer" };
  }
  return { ok: true, value: body["token"] };
}