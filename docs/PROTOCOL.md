# Fitra — Wire Protocol (browser ↔ ClassRoom DO)

Version `1`. All multi-byte integers little-endian. This protocol is
M0-stable: M2 auth mints the same join token claims without changing it (FR-003).

## 1. Transport

- One `WebSocket` per participant: `GET /rooms/:code/ws?token=<JOIN_TOKEN>`.
- Optional `&name=<display name>` on the same request. The join token carries no
  name (see section 4), so the display name travels next to the token; the DO
  falls back to `pid` when it is absent and truncates it to 64 chars. M2 moves
  the name into the token claims — no message shape changes either way.
- **Rejoin**: `POST /rooms/:code/rejoin { token }` re-signs the SAME claims
  (same `pid`/`role`/`lang`) with a fresh `iat`/`exp`, so a client can rebuild
  its socket after a drop without changing identity (a stale socket that
  lingers is closed by the DO as `rejoined`). The old token's signature must
  verify — expiry is waived, but room match, role and language are not, and
  the token must still be signed by the same secret. Normal `/join` keeps its
  strict 10-minute expiry and mints a fresh `pid`.
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
| `speaker` | 2 | `participantIndex` assigned at join (0 = teacher). Uplink: the sender's own index. Downlink: the **source** speaker the translated audio belongs to (clients demultiplex parallel pipes by this field) |
| payload | N | 3 200 B nominal (100 ms @16 kHz) uplink; downlink is 24 kHz in 100 ms nominal units (4 800 B), but translated turns arrive in arbitrary chunk sizes so the DO splits them into ≤8 KiB frames; same-language relay is resampled 16→24 kHz and re-wrapped as `0x02` |

Rules: max frame 8 KiB (larger → drop + `error`); unknown `ver` → drop +
`error`; sequence gaps tolerated (jitter buffer), never retransmitted. Downlink
`seq` is per (listener, speaker-pipe): each source speaker's stream keeps an
independent monotonic cursor at the client, because multiple speakers may fan
out concurrently into the same socket.

## 3. JSON control messages

> Revised 2026-10-28: the raise-hand / grant / single-floor model was replaced
> by Zoom/Meet-style mic control (**`docs/MIC-CONTROL.md`**, renamed from the
> half-duplex FLOOR-CONTROL doc). Multiple participants may have their mic open
> at once; each open mic is one independent translation source with its own
> provider sessions per target language. Wire history: `speaking-start/stop` →
> `mic-open/close`; `floor-changed`/`hands` → `mic-changed` + `welcome` roster
> re-broadcast; `raise-hand`/`lower-hand`/`grant`/`deny`/`revoke` removed;
> `mute`/`unmute`/`mute-all`/`unmute-all` added; `caption` carries a `speaker`
> index; `session-status.pair` is speaker-scoped.

```ts
type Role = "teacher" | "student";

interface RosterEntry {
  participantId: string; participantIndex: number;
  name: string; role: Role; lang: string;
  micOpen: boolean;        // live mic state on the CURRENT socket (never persisted)
  forcedMuted: boolean;    // teacher force-mute; students only (teacher is never forced)
}

type ClientMsg =
  | { t: "mic-open" }                       // any role; a force-muted student gets an error
  | { t: "mic-close" }                      // any role
  | { t: "mute-all" }                       // teacher only: force-mute EVERY student
  | { t: "unmute-all" }                     // teacher only: clear every student force-mute
  | { t: "mute"; participantId: string }    // teacher only: force-mute one student
  | { t: "unmute"; participantId: string }  // teacher only: clear one student force-mute
  | { t: "ping"; id: number };

type ServerMsg =
  | { t: "welcome"; participantId: string; participantIndex: number; roster: RosterEntry[] }
  | { t: "mic-changed"; participantId: string; micOpen: boolean }
  | { t: "session-status"; pair: string; status: "connecting" | "live" | "reconnecting" | "failed" | "degraded"; attempt?: number }
  | { t: "caption"; kind: "input" | "output"; text: string; final: boolean; speaker: number }
  | { t: "metrics"; m: RoomMetrics }
  | { t: "error"; code: string; message: string }
  | { t: "pong"; id: number };

interface RoomMetrics {
  e2eLatencyMs: number | null;  // speaker chunk sent -> first translated chunk back (rolling)
  sessions: { pair: string; status: string; reconnects: number }[];
  inboundMsgPerSec: number; outboundMsgPerSec: number;
  errorsLastMin: number; doActiveSec: number;
}
```

Error codes: `unauthorized`, `teacher-taken`, `room-full`,
`unsupported-language`, `mic-forced-muted` (a force-muted student sent
`mic-open` or an audio frame — refused/dropped, mic stays closed; the client
treats this as "the teacher muted you"), `mic-closed` (audio frame from a
participant whose mic is closed — frame dropped, violation counted),
`rate-limited`, `frame-too-large`,
`session-degraded`, `room-closed`, `creation-disabled`.

Additional codes used by the ClassRoom transport layer:
`bad-message` (control frame that is not JSON or fails `isClientMsg`),
`mute-absent` (teacher muted/unmuted a pid that is not a connected student; no
state change), `not-implemented-fanout` (binary frame wired-off gate),
`session-degraded`. The `not-implemented-*` codes are M0
scaffolding: they exist so an unimplemented path
reports itself instead of dropping input silently (NFR-001).

### 3.1 Caption semantics (emitted when the engine yields transcripts)

- `text` is the **full current segment** so far for one turn of one kind for
  one speaker, not a delta: the client replaces its live segment on every
  `caption{final:false}` and commits it to history on `caption{final:true}`.
- `final:true` is emitted exactly once per turn (on the engine's turn-complete
  signal); every earlier emission for that turn carries `final:false`. An
  interrupted turn commits its partial segment as `final:true` rather than
  sending an empty final.
- The `speaker` field carries the pipe's source `participantIndex`; clients
  use it to attribute turns and keep one live caption pair per speaker.
- Routing is per translation pipe, never broadcast: both `output` captions
  (translated text) and `input` captions (source-speech transcription) go to
  live sockets whose membership `lang` equals the pipe's target language, and
  to the pipe's source speaker. The speaker sees the original and
  translated text of their own turn but never its translated audio (FR-015).
  Same-language listeners other than the speaker stay excluded — they receive
  the un-relayed audio instead.
- **Parallel pipes**: several speakers may have their mic open at once, so a
  listener can simultaneously receive one input+output pair per speaking
  source. Caption slots are keyed by `speaker`, not globally: two concurrent
  speakers each own their live slot and commit independently.
- `mic-close` flushes the provider input (`realtimeInput.audioStreamEnd`)
  so speech captured before the button was released is translated. Mic state
  changes never cancel in-flight translated audio (the tail keeps flowing);
  the client NEVER interrupts its own playback on mic or roster changes —
  each pipe drains on the audio clock independently.
- A `mic-changed` frame with `micOpen:false` for speaker S is a turn boundary
  ONLY for S's caption slots: the client commits S's current live turn even if
  `final:true` never arrived (defensive commit for engines that do not emit
  turn-complete), so S's text stays on screen when someone else talks. Mic
  OPEN, and `mic-changed` naming any other speaker, are not boundaries.
  The UI keeps a chronological chat-style transcript: committed turns persist
  and new turns append below them, instead of a live slot overwriting the
  previous text.

## 3.2 Roster synchronisation

`welcome` doubles as the roster-sync frame — there is no separate roster
message. Sent once to a joining participant and again to every *other*
connected client whenever the roster or force-mute state changes (join, leave,
teacher mute/unmute). A client that
already holds a `welcome` for its own `participantId` treats the frame as a
roster update and re-renders from `roster`; a first frame is the join
confirmation. `participantIndex` is stable for a participant and is never
reused after they leave (0 = teacher, students take 1, 2, 3, …).

`mic-changed` carries the light per-speaker updates (`mic-open`/`mic-close`
acknowledgements and teacher-driven force-mute cuts) so live speaking state
does not require a full roster re-render. A freshly admitted client receives
`welcome` with the CURRENT `micOpen`/`forcedMuted` of every participant and
therefore never needs to replay mic history. Decremented state (students who
left while speaking, teacher replacing sockets) never leaks as stale
`micOpen`.

## 3.3 Metrics cadence and semantics

The DO owns the counters and broadcasts `metrics` only as a side effect of real
activity:

- **Cadence**: at most one `metrics` frame per 2 s per room while events are
  flowing (audio/control/status), plus one immediately after any
  `session-status` transition. No timers, no `setInterval`, no wake-up for an
  idle room (FR-042/043) — an empty room stays hibernatable.
- **Counts are real**, not the 20:1 billing ratio: `inboundMsgPerSec` counts
  every browser→DO frame (binary + control), `outboundMsgPerSec` every
  DO→browser frame. Rates use a sliding 1 s window computed at broadcast time.
- **`errorsLastMin`** counts `error` frames sent in the previous 60 s.
- **`sessions`** is a snapshot of live translation pairs: `pair`, current
  `status`, and `reconnects` (attempts since the pair opened). A pair with no
  live listener is absent, so the table cannot show phantom sessions.
- **`doActiveSec`** is seconds since room creation (wall clock), i.e. the
  conservative upper bound on billed DO duration for this instance.
- **`e2eLatencyMs`** is `null` from the DO. The browser measures the real
  speaker-chunk→first-translated-chunk round trip (`audio/latency.ts`) and the
  panel prefers it; the server field is reserved for a future server-side
  timestamp pair and must never be fabricated.

## 3.4 Caption display expectations (client side)

The wire semantics in section 3.1 are normative; the client MUST:

- replace the live text on `final:false` in place and commit the turn on
  `final:true` (keeping at most 50 committed turns in memory); a
  `mic-changed` frame with `micOpen:false` for speaker S commits S's live turn
  defensively when `final:true` is absent; mic-open and other speakers' mic
  changes are never boundaries;
- render a single chronological chat-style transcript in a scrollable area of
  capped height — committed turns persist, new turns append below, and long
  text wraps instead of being clamped, so it never pushes the controls
  off-screen; auto-scroll follows new content only while the reader is near
  the bottom;
- label the source (`input`) and translated (`output`) streams distinctly;
- use `aria-live="polite"` on the committed region and inherit the page `dir`,
  so Arabic and other RTL languages render correctly;
- show the documented empty state when an engine yields no captions (never a
  permanent "loading" affordance).

## 4. Join token (HMAC, M0; Better Auth mints same claims in M2)

```
base64url(header) "." base64url(claims) "." base64url(HMAC_SHA256(secret, header.claims))
claims = { room, pid, role, lang, iat, exp }  // exp: join within 10 min; session persists after
```

The DO treats `claims.room` as authoritative and rejects (401) a token whose
room differs from the DO instance name, `claims.role` as authoritative for
capacity checks, and `claims.lang` as authoritative against
`SUPPORTED_LANGUAGES` (FR-007).

The rejoin endpoint (section 1) verifies the signature, room, role and lang of
the presented token while waiving only the expiry check — the DO's live
membership (same `pid`, seat replacement) remains the authority on whether the
rejoin is admitted. It then re-signs the same claims with fresh `iat`/`exp`.

## 5. Rate limits (defaults, configurable)

≤ 20 audio frames/s and ≤ 10 control msg/s per connection; excess audio
dropped, excess control → `rate-limited` + disconnect on repeat.
