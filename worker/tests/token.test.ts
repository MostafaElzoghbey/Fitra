import { describe, expect, it, vi } from "vitest";
import app, { type WorkerEnv } from "../src/index.js";
import { signJoinToken, verify } from "../src/auth/token.js";

// Test-only secret. Never a real credential; also asserted absent from web/dist by CI.
const TEST_SECRET = "t005-test-only-hmac-secret";

const fetchMocks = new WeakMap<object, ReturnType<typeof vi.fn>>();

function mockEnv(
  overrides: Partial<WorkerEnv> = {},
  doFetch?: (req: Request) => Promise<Response>,
): WorkerEnv {
  const fetchImpl =
    doFetch ??
    (async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === "/internal/register") return Response.json({ ok: true });
      return Response.json({ exists: false });
    });
  const fetchFn = vi.fn(fetchImpl);
  const get = vi.fn(() => ({ fetch: fetchFn }));
  const idFromName = vi.fn(() => ({ toString: () => "stub-id" }));
  const env: WorkerEnv = {
    JOIN_TOKEN_HMAC_SECRET: TEST_SECRET,
    SUPPORTED_LANGUAGES: ["ar", "en", "fr", "es"],
    ROOM_CREATION_DISABLED: false,
    CLASSROOM: { get, idFromName } as unknown as DurableObjectNamespace,
    ...overrides,
  };
  fetchMocks.set(env, fetchFn);
  return env;
}

function doFetchStub(env: WorkerEnv): ReturnType<typeof vi.fn> {
  const fetchFn = fetchMocks.get(env);
  if (fetchFn === undefined) throw new Error("mockEnv did not register a fetch mock");
  return fetchFn;
}

function doGetStub(env: WorkerEnv): ReturnType<typeof vi.fn> {
  const ns = env.CLASSROOM as unknown as { get: ReturnType<typeof vi.fn> };
  return ns.get;
}

interface CodeBody {
  readonly code?: unknown;
}

interface TokenBody {
  readonly token?: unknown;
}

interface ErrorBody {
  readonly t?: unknown;
  readonly code?: unknown;
}

async function createRoom(
  env: WorkerEnv,
  payload: unknown = { teacherLang: "ar" },
): Promise<Response> {
  return app.request(
    "/rooms",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    env,
  );
}

async function createRoomCode(
  env: WorkerEnv,
  payload: unknown = { teacherLang: "ar" },
): Promise<string> {
  const res = await createRoom(env, payload);
  expect(res.status).toBe(200);
  const body = (await res.json()) as CodeBody;
  expect(typeof body.code).toBe("string");
  return body.code as string;
}

async function joinRoom(
  env: WorkerEnv,
  code: string,
  payload: unknown,
): Promise<Response> {
  return app.request(
    `/rooms/${code}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    },
    env,
  );
}

describe("POST /rooms (T-005)", () => {
  it("happy path: creates a room and returns {code}", async () => {
    const env = mockEnv();
    const res = await createRoom(env, { teacherLang: "ar" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CodeBody;
    expect(typeof body.code).toBe("string");
    expect((body.code as string).length).toBeGreaterThan(0);
    // Valid creates durably register in the DO (T-017 production fix).
    expect(doGetStub(env)).toHaveBeenCalledTimes(1);
    const registerReq = doFetchStub(env).mock.calls[0]?.[0] as Request | undefined;
    expect(registerReq).toBeDefined();
    expect(new URL(registerReq?.url ?? "").pathname).toBe("/internal/register");
    expect(await registerReq?.json()).toMatchObject({ teacherLang: "ar" });
  });

  it("kill switch: ROOM_CREATION_DISABLED rejects with error{creation-disabled}", async () => {
    const env = mockEnv({ ROOM_CREATION_DISABLED: true });
    const res = await createRoom(env, { teacherLang: "ar" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.t).toBe("error");
    expect(body.code).toBe("creation-disabled");
    expect(doGetStub(env)).not.toHaveBeenCalled();
  });

  it("kill switch accepts the string form \"true\" (wrangler vars)", async () => {
    const env = mockEnv({ ROOM_CREATION_DISABLED: "true" });
    const res = await createRoom(env, { teacherLang: "ar" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("creation-disabled");
  });

  it("unsupported teacherLang rejects with error{unsupported-language}", async () => {
    const env = mockEnv();
    const res = await createRoom(env, { teacherLang: "xx" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.t).toBe("error");
    expect(body.code).toBe("unsupported-language");
    expect(doGetStub(env)).not.toHaveBeenCalled();
  });

  it("missing teacherLang rejects with 4xx", async () => {
    const env = mockEnv();
    const res = await createRoom(env, {});
    expect(res.status).toBe(400);
    expect(doGetStub(env)).not.toHaveBeenCalled();
  });
});

describe("POST /rooms/:code/join (T-005)", () => {
  it("happy path: join returns a token verifiable with the shared secret", async () => {
    const env = mockEnv();
    const code = await createRoomCode(env);
    const res = await joinRoom(env, code, {
      name: "Layla",
      role: "teacher",
      lang: "ar",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TokenBody;
    expect(typeof body.token).toBe("string");
    const claims = await verify(body.token as string, TEST_SECRET);
    expect(claims).not.toBeNull();
    expect(claims?.room).toBe(code);
    expect(claims?.role).toBe("teacher");
    expect(claims?.lang).toBe("ar");
    expect(typeof claims?.pid).toBe("string");
    expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(600);
  });

  it("unknown room queries the DO fallback and still rejects 404", async () => {
    const env = mockEnv();
    const res = await joinRoom(env, "QQQQQ9", {
      name: "Omar",
      role: "student",
      lang: "en",
    });
    expect(res.status).toBe(404);
    // The isolate-local map misses, so the DO is consulted (exists:false).
    expect(doGetStub(env)).toHaveBeenCalledTimes(1);
    const lookupReq = doFetchStub(env).mock.calls[0]?.[0] as Request | undefined;
    expect(new URL(lookupReq?.url ?? "").pathname).toBe("/internal/room");
  });

  it("join succeeds via the DO fallback when the local map misses", async () => {
    const env = mockEnv({}, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/internal/register") return Response.json({ ok: true });
      return Response.json({ exists: true, teacherLang: "ar", createdAtMs: Date.now() });
    });
    // Never-created code: the local map misses, the DO answers exists:true.
    const res = await joinRoom(env, "ZZZZZ9", {
      name: "Omar",
      role: "student",
      lang: "en",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TokenBody;
    expect(typeof body.token).toBe("string");
  });

  it("invalid body (missing name) rejects with 4xx and zero DO RPCs", async () => {
    const env = mockEnv();
    const code = await createRoomCode(env);
    doGetStub(env).mockClear();
    doFetchStub(env).mockClear();
    const res = await joinRoom(env, code, { role: "student", lang: "en" });
    expect(res.status).toBe(400);
    expect(doGetStub(env)).not.toHaveBeenCalled();
  });

  it("invalid body (bad role) rejects with 4xx and zero DO RPCs", async () => {
    const env = mockEnv();
    const code = await createRoomCode(env);
    doGetStub(env).mockClear();
    doFetchStub(env).mockClear();
    const res = await joinRoom(env, code, {
      name: "Omar",
      role: "admin",
      lang: "en",
    });
    expect(res.status).toBe(400);
    expect(doGetStub(env)).not.toHaveBeenCalled();
  });

  it("malformed JSON rejects with 4xx and zero DO RPCs", async () => {
    const env = mockEnv();
    const code = await createRoomCode(env);
    doGetStub(env).mockClear();
    doFetchStub(env).mockClear();
    const res = await joinRoom(env, code, "{not-json");
    expect(res.status).toBe(400);
    expect(doGetStub(env)).not.toHaveBeenCalled();
  });

  it("unsupported join language rejects with error{unsupported-language} and zero DO RPCs", async () => {
    const env = mockEnv();
    const code = await createRoomCode(env);
    doGetStub(env).mockClear();
    doFetchStub(env).mockClear();
    const res = await joinRoom(env, code, {
      name: "Omar",
      role: "student",
      lang: "xx",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.t).toBe("error");
    expect(body.code).toBe("unsupported-language");
    expect(doGetStub(env)).not.toHaveBeenCalled();
  });
});

describe("POST /rooms/:code/rejoin (latency/quality M0.5, PROTOCOL.md section 1)", () => {
  async function rejoin(
    env: WorkerEnv,
    code: string,
    payload: unknown,
  ): Promise<Response> {
    return app.request(
      `/rooms/${code}/rejoin`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
      env,
    );
  }

  it("expired join token re-mints the SAME pid with a fresh token", async () => {
    const env = mockEnv();
    const code = await createRoomCode(env);
    const nowS = Math.floor(Date.now() / 1000);
    const expired = await signJoinToken(
      { room: code, pid: "same-pid-1", role: "student", lang: "en" },
      TEST_SECRET,
      { nowS: nowS - 3600, ttlS: 600 },
    );
    const res = await rejoin(env, code, { token: expired });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TokenBody;
    const claims = await verify(body.token as string, TEST_SECRET);
    expect(claims?.pid).toBe("same-pid-1");
    expect(claims?.room).toBe(code);
    expect(claims?.role).toBe("student");
    expect(claims?.lang).toBe("en");
    expect((claims?.exp ?? 0) + 1 > nowS).toBe(true);
  });

  it("unknown room queries the DO fallback and still rejects 404", async () => {
    const env = mockEnv(undefined, async () => Response.json({ exists: false }));
    const res = await rejoin(env, "ZZZZZZ", { token: "a.b.c" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("unknown-room");
    expect(doFetchStub(env).mock.calls.length).toBe(1);
  });

  it("rejects token for a different room after DO fallback lookup", async () => {
    const env = mockEnv(undefined, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/internal/register") return Response.json({ ok: true });
      return Response.json({ exists: true, teacherLang: "ar" });
    });
    const other = await signJoinToken(
      { room: "OTHER9", pid: "p1", role: "student", lang: "en" },
      TEST_SECRET,
    );
    const res = await rejoin(env, "REALCODE", { token: other });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("invalid-token");
  });

  it("rejects tampered tokens with error{invalid-token}", async () => {
    const env = mockEnv();
    const code = await createRoomCode(env);
    const token = await signJoinToken(
      { room: code, pid: "p1", role: "student", lang: "en" },
      TEST_SECRET,
    );
    const parts = token.split(".");
    const tampered = `${parts[0] as string}.AAAA.${parts[2] as string}`;
    const res = await rejoin(env, code, { token: tampered });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.code).toBe("invalid-token");
  });

  it("rejects missing/malformed body without touching the DO", async () => {
    const env = mockEnv();
    const code = await createRoomCode(env);
    const callsAfterCreate = doFetchStub(env).mock.calls.length;
    const missing = await rejoin(env, code, {});
    expect(missing.status).toBe(400);
    const malformed = await rejoin(env, code, "{not json");
    expect(malformed.status).toBe(400);
    const body = (await missing.json()) as ErrorBody;
    expect(body.code).toBe("invalid-body");
    // Room creation legitimately calls /internal/register; rejoin must not.
    expect(doFetchStub(env).mock.calls.length).toBe(callsAfterCreate);
  });
});

describe("join token sign/verify (T-005, docs/PROTOCOL.md section 4)", () => {
  it("verify() returns claims for a token signed with the same secret", async () => {
    const token = await signJoinToken(
      { room: "ABC123", pid: "p1", role: "student", lang: "fr" },
      TEST_SECRET,
    );
    const claims = await verify(token, TEST_SECRET);
    expect(claims).toEqual({
      room: "ABC123",
      pid: "p1",
      role: "student",
      lang: "fr",
      iat: claims?.iat,
      exp: (claims?.iat ?? 0) + 600,
    });
  });

  it("tampered claims reject (signature mismatch)", async () => {
    const token = await signJoinToken(
      { room: "ABC123", pid: "p1", role: "student", lang: "fr" },
      TEST_SECRET,
    );
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    const claimsPart = parts[1] as string;
    const flipped =
      (claimsPart[0] === "A" ? "B" : "A") + claimsPart.slice(1);
    const tampered = `${parts[0] as string}.${flipped}.${parts[2] as string}`;
    await expect(verify(tampered, TEST_SECRET)).resolves.toBeNull();
  });

  it("tampered signature rejects", async () => {
    const token = await signJoinToken(
      { room: "ABC123", pid: "p1", role: "student", lang: "fr" },
      TEST_SECRET,
    );
    const parts = token.split(".");
    const sigPart = parts[2] as string;
    const flipped = (sigPart[0] === "A" ? "B" : "A") + sigPart.slice(1);
    const tampered = `${parts[0] as string}.${parts[1] as string}.${flipped}`;
    await expect(verify(tampered, TEST_SECRET)).resolves.toBeNull();
  });

  it("wrong secret rejects", async () => {
    const token = await signJoinToken(
      { room: "ABC123", pid: "p1", role: "student", lang: "fr" },
      TEST_SECRET,
    );
    await expect(verify(token, "a-different-secret")).resolves.toBeNull();
  });

  it("expired token rejects", async () => {
    const token = await signJoinToken(
      { room: "ABC123", pid: "p1", role: "student", lang: "fr" },
      TEST_SECRET,
      { ttlS: -1 },
    );
    await expect(verify(token, TEST_SECRET)).resolves.toBeNull();
  });

  it("expired token verifies with ignoreExpiry (rejoin path)", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const token = await signJoinToken(
      { room: "ABC123", pid: "p1", role: "student", lang: "fr" },
      TEST_SECRET,
      { nowS: nowS - 3600, ttlS: 600 },
    );
    await expect(verify(token, TEST_SECRET)).resolves.toBeNull();
    const claims = await verify(token, TEST_SECRET, nowS, { ignoreExpiry: true });
    expect(claims).toEqual({
      room: "ABC123",
      pid: "p1",
      role: "student",
      lang: "fr",
      iat: nowS - 3600,
      exp: nowS - 3600 + 600,
    });
  });

  it("ignorExpiry does not bypass signature or claim-shape checks", async () => {
    const token = await signJoinToken(
      { room: "ABC123", pid: "p1", role: "student", lang: "fr" },
      TEST_SECRET,
      { ttlS: -1 },
    );
    await expect(
      verify(token, "a-different-secret", Math.floor(Date.now() / 1000), {
        ignoreExpiry: true,
      }),
    ).resolves.toBeNull();
  });

  it("malformed token rejects", async () => {
    await expect(verify("not.a.valid.token", TEST_SECRET)).resolves.toBeNull();
    await expect(verify("onlyonepart", TEST_SECRET)).resolves.toBeNull();
    await expect(verify("", TEST_SECRET)).resolves.toBeNull();
  });
});
