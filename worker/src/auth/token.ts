// T-005: HMAC join-token issuance + verification (docs/PROTOCOL.md section 4).
//
// Wire format: base64url(header) "." base64url(claims) "." base64url(sig),
// sig = HMAC_SHA256(secret, "<headerB64>.<claimsB64>").
// claims = { room, pid, role, lang, iat, exp }; exp = join within 10 min,
// the session persists after (the DO owns session lifetime, T-006).
//
// Workers-compatible: WebCrypto only (crypto.subtle), no node:crypto.
// T-006 imports verify() in the DO WebSocket-upgrade path; the signature
// verify(token, secret) -> claims | null stays stable (M2 mints same claims).

export type JoinRole = "teacher" | "student";

export interface JoinClaims {
  readonly room: string;
  readonly pid: string;
  readonly role: JoinRole;
  readonly lang: string;
  /** Issued-at, seconds since epoch. */
  readonly iat: number;
  /** Expiry, seconds since epoch (join must happen before this). */
  readonly exp: number;
}

export interface SignInput {
  readonly room: string;
  readonly pid: string;
  readonly role: JoinRole;
  readonly lang: string;
}

export interface SignOptions {
  /** Override "now" in seconds since epoch (tests). Defaults to Date.now(). */
  readonly nowS?: number;
  /** Token lifetime in seconds. Defaults to JOIN_TOKEN_TTL_S. */
  readonly ttlS?: number;
}

/** Join-token lifetime: 10 minutes (docs/PROTOCOL.md section 4). */
export const JOIN_TOKEN_TTL_S = 600;

const TOKEN_ALG = "HS256";

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  if (s.length === 0 || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  let bin: string;
  try {
    bin = atob(b64 + "=".repeat(pad));
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function importHmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signJoinToken(
  input: SignInput,
  secret: string,
  opts: SignOptions = {},
): Promise<string> {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const ttlS = opts.ttlS ?? JOIN_TOKEN_TTL_S;
  const claims: JoinClaims = {
    room: input.room,
    pid: input.pid,
    role: input.role,
    lang: input.lang,
    iat: nowS,
    exp: nowS + ttlS,
  };
  const headerB64 = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: TOKEN_ALG, typ: "join" })),
  );
  const claimsB64 = b64urlEncode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const key = await importHmacKey(secret, "sign");
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${headerB64}.${claimsB64}`),
  );
  return `${headerB64}.${claimsB64}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify a join token. Returns the claims on success, null on any failure
 * (malformed, bad algorithm, signature mismatch, bad claim shape, expired).
 * `nowS` (seconds since epoch) is overridable for tests; callers in
 * production (T-006 upgrade path) use verify(token, secret).
 */
export async function verify(
  token: string,
  secret: string,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<JoinClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const headerB64 = parts[0];
  const claimsB64 = parts[1];
  const sigB64 = parts[2];
  if (
    headerB64 === undefined ||
    claimsB64 === undefined ||
    sigB64 === undefined
  ) {
    return null;
  }
  const headerBytes = b64urlDecode(headerB64);
  const claimsBytes = b64urlDecode(claimsB64);
  const sigBytes = b64urlDecode(sigB64);
  if (headerBytes === null || claimsBytes === null || sigBytes === null) {
    return null;
  }
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes)) as unknown;
  } catch {
    return null;
  }
  if (
    typeof header !== "object" ||
    header === null ||
    (header as { readonly alg?: unknown }).alg !== TOKEN_ALG
  ) {
    return null;
  }
  const key = await importHmacKey(secret, "verify");
  const data = new TextEncoder().encode(`${headerB64}.${claimsB64}`);
  // Copy into an ArrayBuffer-backed view: b64urlDecode returns
  // Uint8Array<ArrayBufferLike>, which BufferSource rejects under strict TS.
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(sigBytes),
    data,
  );
  if (!ok) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(claimsBytes)) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const room = c["room"];
  const pid = c["pid"];
  const role = c["role"];
  const lang = c["lang"];
  const iat = c["iat"];
  const exp = c["exp"];
  if (typeof room !== "string" || typeof pid !== "string") return null;
  if (typeof lang !== "string") return null;
  if (role !== "teacher" && role !== "student") return null;
  if (
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    !Number.isFinite(iat) ||
    !Number.isFinite(exp)
  ) {
    return null;
  }
  if (exp <= nowS) return null;
  return { room, pid, role, lang, iat, exp };
}
