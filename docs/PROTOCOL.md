# Fitra — Wire Protocol (browser ↔ ClassRoom DO)

Version `1`. All multi-byte integers little-endian. This protocol is
M0-stable: M2 auth mints the same join token claims without changing it (FR-003).

## 1. Transport

- One `WebSocket` per participant: `GET /rooms/:code/ws?token=<JOIN_TOKEN>`.
- Optional `&name=<display name>` on the same request. The join token carries no
  name (see section 4), so the display name travels next to the token; the DO
  falls back to `pid` when it is absent and truncates it to 64 chars. M2 moves
  the name into the token claims — no message shape changes either way.
- **Binary frames** = audio. **Text frames** = JSON control (type-tagged).
- DO validates the token during upgrade; invalid → HTTP 401, never 101.
- A token that verifies but cannot be admitted (second teacher, room full,
  expired room) still completes the handshake and is answered with one
  `error` frame followed by a normal close, so the client learns the reason.

## 2. Binary audio frame

```
 0      1      2      3      4      5      6      7
+------+------+------+------+------+------+------+------+
| ver  | type |        seq u16        |   speaker u16   |
+------+------+------+------+------+------+------+------+
| payload: PCM16LE mono (no header)                     |
+-------------------------------------------------------+
```

| Field | Bytes | Value |
|---|---|---|
| `ver` | 1 | `0x01` |
| `type` | 1 | `0x01` client→DO (16 kHz input); `0x02` DO→client (24 kHz output) |
| `seq` | 2 | Per-sender monotonic counter, wraps; gap = loss metric |
| `speaker` | 2 | `participantIndex` assigned at join (0 = teacher) |
| payload | N | 3 200 B nominal (100 ms @16 kHz) uplink; downlink is 24 kHz in 100 ms nominal units (4 800 B), but translated turns arrive in arbitrary chunk sizes so the DO splits them into ≤8 KiB frames; same-language relay is resampled 16→24 kHz and re-wrapped as `0x02` |

Rules: max frame 8 KiB (larger → drop + `error`); unknown `ver` → drop +
`error`; sequence gaps tolerated (jitter buffer), never retransmitted.

## 3. JSON control messages

```ts
type Role = "teacher" | "student";
type FloorHolder = { kind: "none" } | { kind: "teacher" } | { kind: "student"; participantId: string };

type ClientMsg =
  | { t: "speaking-start" }            // teacher: takes floor; student: only if granted
  | { t: "speaking-stop" }
  | { t: "raise-hand" }                // student only
  | { t: "lower-hand" }                // student only
  | { t: "grant"; participantId: string }  // teacher only
  | { t: "deny"; participantId: string }   // teacher only
  | { t: "revoke" }                    // teacher only
  | { t: "ping"; id: number };

type ServerMsg =
  | { t: "welcome"; participantId: string; participantIndex: number; floor: FloorHolder; roster: RosterEntry[] }
  | { t: "floor-changed"; floor: FloorHolder; reason: string }
  | { t: "hands"; raised: string[] }   // participantIds, teacher only sees full list; students see count
  | { t: "session-status"; pair: string; status: "connecting" | "live" | "reconnecting" | "failed" | "degraded"; attempt?: number }
  | { t: "caption"; kind: "input" | "output"; text: string; final: boolean } // ONLY if engine yields transcripts
  | { t: "metrics"; m: RoomMetrics }
  | { t: "error"; code: string; message: string }
  | { t: "pong"; id: number };

interface RosterEntry { participantId: string; name: string; role: Role; lang: string; }
interface RoomMetrics {
  e2eLatencyMs: number | null;  // speaker chunk sent -> first translated chunk back (rolling)
  sessions: { pair: string; status: string; reconnects: number }[];
  inboundMsgPerSec: number; outboundMsgPerSec: number;
  errorsLastMin: number; doActiveSec: number;
}
```

Error codes: `unauthorized`, `teacher-taken`, `room-full`,
`unsupported-language`, `not-your-floor`, `rate-limited`, `frame-too-large`,
`session-degraded`, `room-closed`, `creation-disabled`.

Additional codes used by the ClassRoom transport layer:
`bad-message` (control frame that is not JSON or fails `isClientMsg`),
`not-implemented-floor` (M0 scaffolding for floor paths not yet wired; no
longer emitted for the floor messages in section 3 since T-007),
`not-implemented-fanout` (binary frame before T-009 wires audio
fan-out), `grant-absent` (teacher granted a pid that is neither waiting nor
holding the floor; no state change). The `not-implemented-*` codes are M0
scaffolding: they exist so an unimplemented path
reports itself instead of dropping input silently (NFR-001).

## 3.1 Roster synchronisation

`welcome` doubles as the roster-sync frame — there is no separate roster
message. Sent once to a joining participant and again to every *other*
connected client whenever the roster changes (join, leave). A client that
already holds a `welcome` for its own `participantId` treats the frame as a
roster update and re-renders from `roster`; a first frame is the join
confirmation. `participantIndex` is stable for a participant and is never
reused after they leave (0 = teacher, students take 1, 2, 3, …).

A `hands` frame is sent alongside each `welcome`.

## 4. Join token (HMAC, M0; Better Auth mints same claims in M2)

```
base64url(header) "." base64url(claims) "." base64url(HMAC_SHA256(secret, header.claims))
claims = { room, pid, role, lang, iat, exp }  // exp: join within 10 min; session persists after
```

The DO treats `claims.room` as authoritative and rejects (401) a token whose
room differs from the DO instance name, `claims.role` as authoritative for
capacity checks, and `claims.lang` as authoritative against
`SUPPORTED_LANGUAGES` (FR-007).

## 5. Rate limits (defaults, configurable)

≤ 20 audio frames/s and ≤ 10 control msg/s per connection; excess audio
dropped, excess control → `rate-limited` + disconnect on repeat.
