import { Hono } from "hono";
import type { Context } from "hono";
import { ClassRoom } from "./room.js";
import { signJoinToken, verify, type JoinRole } from "./auth/token.js";

// T-005: room create/join + HMAC join-token issuance (SPEC FR-001..007,
// FR-050/052; docs/PROTOCOL.md sections 3-4).
//
// Validation happens in the Worker BEFORE any DO touch: every reject path
// below returns without reading env.CLASSROOM, so invalid joins cause zero
// DO RPCs. Single-teacher enforcement (FR-004 error{teacher-taken}) lives in
// the ClassRoom DO (T-006), which is authoritative for membership.

export interface WorkerEnv {
  readonly CLASSROOM?: DurableObjectNamespace;
  readonly JOIN_TOKEN_HMAC_SECRET?: string;
  readonly ROOM_CREATION_DISABLED?: boolean | string;
  readonly SUPPORTED_LANGUAGES?: readonly string[] | string;
  readonly MAX_STUDENTS?: number | string;
}

export const DEFAULT_SUPPORTED_LANGUAGES: readonly string[] = [
  "ar",
  "en",
  "fr",
  "es",
];

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const MAX_NAME_LENGTH = 64;

interface RoomRecord {
  readonly code: string;
  readonly teacherLang: string;
  readonly createdAtMs: number;
}

// This registry is isolate-local memory: a fast path only. Room existence is
// owned by the ClassRoom DO (`/internal/register`, `lookupRoom` below), so a
// miss here falls back to the DO instead of 404ing. M2 may replace the map
// with D1; the DO stays authoritative for membership either way.
const rooms = new Map<string, RoomRecord>();

type AppContext = Context<{ Bindings: WorkerEnv }>;

const app = new Hono<{ Bindings: WorkerEnv }>();

function error(
  c: AppContext,
  status: 400 | 403 | 404 | 500,
  code: string,
  message: string,
): Response {
  return c.json({ t: "error", code, message }, status);
}

function parseSupportedLanguages(env: WorkerEnv): string[] {
  const raw = env.SUPPORTED_LANGUAGES;
  if (Array.isArray(raw)) {
    return raw.filter((l): l is string => typeof l === "string");
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((l): l is string => typeof l === "string");
        }
      } catch {
        // Fall through to CSV parsing.
      }
    }
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [...DEFAULT_SUPPORTED_LANGUAGES];
}

function isCreationDisabled(env: WorkerEnv): boolean {
  const v = env.ROOM_CREATION_DISABLED;
  return v === true || v === "true" || v === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** DO fallback for room existence when the isolate-local map misses
 * (T-017 production fix). Returns null when the room truly does not exist;
 * throws only when the lookup itself fails (caller maps to 500). */
async function lookupRoom(env: WorkerEnv, code: string): Promise<RoomRecord | null> {
  const namespace = env.CLASSROOM;
  if (namespace === undefined) return null;
  const res = await namespace.get(namespace.idFromName(code)).fetch(
    new Request("https://classroom/internal/room", { method: "GET" }),
  );
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(body) || body["exists"] !== true) return null;
  const teacherLang = typeof body["teacherLang"] === "string" ? body["teacherLang"] : "";
  const createdAtMs =
    typeof body["createdAtMs"] === "number" ? body["createdAtMs"] : Date.now();
  return { code, teacherLang, createdAtMs };
}

function generateRoomCode(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let code = "";
    for (const b of bytes) {
      const ch = CODE_ALPHABET[b % CODE_ALPHABET.length];
      code += ch ?? "";
    }
    if (!rooms.has(code)) return code;
  }
  // Practically unreachable (32^6 space); fall back to a UUID prefix.
  return crypto.randomUUID().replace(/-/g, "").slice(0, CODE_LENGTH);
}

app.get("/api/health", (c) => {
  return c.json({ ok: true });
});

// T-016: browser WebSocket upgrade path (docs/PROTOCOL.md section 1:
// `GET /rooms/:code/ws?token=<JOIN_TOKEN>`). Pure passthrough to the room's
// DO: auth, membership and floor are decided there, from the raw query string.
app.get("/rooms/:code/ws", (c) => {
  const namespace = c.env.CLASSROOM;
  if (namespace === undefined) {
    return error(
      c,
      500,
      "server-misconfigured",
      "classroom binding is not configured",
    );
  }
  const code = c.req.param("code");
  return namespace.get(namespace.idFromName(code)).fetch(c.req.raw);
});

app.post("/rooms", async (c) => {
  const env = c.env;
  if (isCreationDisabled(env)) {
    return error(c, 403, "creation-disabled", "room creation is disabled");
  }
  let body: unknown;
  try {
    body = (await c.req.json()) as unknown;
  } catch {
    return error(c, 400, "invalid-body", "request body must be JSON");
  }
  if (!isRecord(body)) {
    return error(c, 400, "invalid-body", "request body must be an object");
  }
  const teacherLang = body["teacherLang"];
  if (typeof teacherLang !== "string" || teacherLang.length === 0) {
    return error(c, 400, "invalid-body", "teacherLang must be set");
  }
  if (!parseSupportedLanguages(env).includes(teacherLang)) {
    return error(
      c,
      400,
      "unsupported-language",
      `unsupported language: ${teacherLang}`,
    );
  }
  const code = generateRoomCode();
  // Durable registration (T-017 production fix): the map below is a fast
  // path only — Worker isolates evict, so the DO owns room existence.
  const namespace = env.CLASSROOM;
  if (namespace === undefined) {
    return error(c, 500, "server-misconfigured", "classroom binding is not configured");
  }
  try {
    const reg = await namespace.get(namespace.idFromName(code)).fetch(
      new Request("https://classroom/internal/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, teacherLang }),
      }),
    );
    if (!reg.ok) {
      return error(c, 500, "server-error", "room registration failed");
    }
  } catch {
    return error(c, 500, "server-error", "room registration failed");
  }
  rooms.set(code, { code, teacherLang, createdAtMs: Date.now() });
  return c.json({ code }, 200);
});

app.post("/rooms/:code/join", async (c) => {
  const env = c.env;
  const code = c.req.param("code");

  // --- All validation first: no DO touch on any reject path. ---
  let body: unknown;
  try {
    body = (await c.req.json()) as unknown;
  } catch {
    return error(c, 400, "invalid-body", "request body must be JSON");
  }
  if (!isRecord(body)) {
    return error(c, 400, "invalid-body", "request body must be an object");
  }
  const name = body["name"];
  const role = body["role"];
  const lang = body["lang"];
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.length > MAX_NAME_LENGTH
  ) {
    return error(c, 400, "invalid-body", "name must be a non-empty string");
  }
  if (role !== "teacher" && role !== "student") {
    return error(c, 400, "invalid-body", "role must be teacher or student");
  }
  const joinRole: JoinRole = role;
  if (typeof lang !== "string" || lang.length === 0) {
    return error(c, 400, "invalid-body", "lang must be set");
  }
  if (!parseSupportedLanguages(env).includes(lang)) {
    return error(
      c,
      400,
      "unsupported-language",
      `unsupported language: ${lang}`,
    );
  }
  const room = rooms.get(code) ?? (await lookupRoom(env, code));
  if (room === null) {
    return error(c, 404, "unknown-room", `unknown room: ${code}`);
  }
  const secret = env.JOIN_TOKEN_HMAC_SECRET;
  if (secret === undefined || secret.length === 0) {
    return error(
      c,
      500,
      "server-misconfigured",
      "join token secret is not configured",
    );
  }

  // Valid join: mint the token. (M0 performs no DO RPC here; T-006 makes the
  // DO authoritative for membership on the WS upgrade path.)
  const pid = crypto.randomUUID();
  const token = await signJoinToken(
    { room: code, pid, role: joinRole, lang },
    secret,
  );
  return c.json({ token }, 200);
});

// Rejoin (latency/quality M0.5, PROTOCOL.md section 1): a dropped socket
// replays its ORIGINAL token; the endpoint waives expiry but re-verifies
// signature + claims, then re-mints the SAME pid with a fresh iat/exp so the
// DO upgrade path and floor state keep the member identity stable.
app.post("/rooms/:code/rejoin", async (c) => {
  const env = c.env;
  const code = c.req.param("code");

  let body: unknown;
  try {
    body = (await c.req.json()) as unknown;
  } catch {
    return error(c, 400, "invalid-body", "request body must be JSON");
  }
  if (!isRecord(body)) {
    return error(c, 400, "invalid-body", "request body must be an object");
  }
  const token = body["token"];
  if (typeof token !== "string" || token.length === 0) {
    return error(c, 400, "invalid-body", "token must be a non-empty string");
  }
  const room = rooms.get(code) ?? (await lookupRoom(env, code));
  if (room === null) {
    return error(c, 404, "unknown-room", `unknown room: ${code}`);
  }
  const secret = env.JOIN_TOKEN_HMAC_SECRET;
  if (secret === undefined || secret.length === 0) {
    return error(
      c,
      500,
      "server-misconfigured",
      "join token secret is not configured",
    );
  }
  const claims = await verify(
    token,
    secret,
    Math.floor(Date.now() / 1000),
    { ignoreExpiry: true },
  );
  if (
    claims === null ||
    claims.room !== code ||
    !parseSupportedLanguages(env).includes(claims.lang)
  ) {
    return error(c, 400, "invalid-token", "rejoin token rejected");
  }
  const freshToken = await signJoinToken(
    { room: claims.room, pid: claims.pid, role: claims.role, lang: claims.lang },
    secret,
  );
  return c.json({ token: freshToken }, 200);
});

export { ClassRoom };
export default app;
