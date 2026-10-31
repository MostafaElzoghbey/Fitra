# Fitra — Mic Control (multi-speaker, Zoom/Meet model)

Replaces the former half-duplex FLOOR-CONTROL doc (revised 2026-10-28).
Server-authoritative: clients are hints; every rule below is enforced in the
ClassRoom DO. WG wire shapes: `docs/PROTOCOL.md` §3.

## Why multi-speaker

Users expect Zoom/Meet control semantics: the teacher force-mutes nobody, one,
or all students; every non-forced participant may open or close their mic at
will; students and the teacher (and multiple students) can talk
simultaneously. Each open mic is an INDEPENDENT translation source — its own
provider sessions per target language — so overlapping speech is translated
per speaker, never mixed into one stream.

Cost is bounded the same way as before: session cap `MAX_TRANSLATION_SESSIONS`
(default 8) with the existing degrade-to-`MutedSession` policy (teacher leg
protected first, FR-024). One ar student speaking alongside the Arabic teacher
adds ≤1 session per distinct listener language.

## Per-participant state (DO memory, never persisted)

- `micOpen: boolean` — live capture on the CURRENT socket. Starts closed on
  every join/rejoin; never survives a disconnect.
- `forcedMuted: boolean` — set only by the teacher. Applies to students only;
  the teacher is never force-muted.
- Room flag `muteAllActive: boolean` — set by `mute-all`; students joining
  while it is active are admitted already `forcedMuted`.

Related: `teacherConnected` (used for room-roll pausing semantics that no
longer gate student speech — a teacher disconnect closes the TEACHER's pipes
only; students keep talking to each other).

## Client → server events

| Event | Who | Server rule |
|---|---|---|
| `mic-open` | any | If `forcedMuted` → `error{mic-forced-muted}` to sender, mic stays closed. Else set `micOpen=true`, broadcast `mic-changed{pid,true}`, pre-warm this speaker's pipe set (session-status flows before first frame). |
| `mic-close` | any | If open: set `micOpen=false`, broadcast `mic-changed{pid,false}`, flush provider input (`audioStreamEnd`) and release this speaker's sessions after flush — the translated tail keeps playing (never cancelled). If already closed: no-op. |
| `mute{pid}` | teacher | Set target pid's `forcedMuted=true`. If their mic is open: cut it — `micOpen=false`, flush + release pipes, broadcast `mic-changed{pid,false}`. Broadcast full `roster` (forcedMuted flag visible). Unknown/absent student pid → `error{mute-absent}` to teacher, no change. |
| `mute-all` | teacher | Every student: `forcedMuted=true`; open mics cut as above; `muteAllActive=true`. One `roster` broadcast + one `mic-changed{pid,false}` per participant that actually had an open mic. |
| `unmute {pid}` | teacher | `forcedMuted=false`; `roster` broadcast. Does NOT open their mic — the student still decides. |
| `unmute-all` | teacher | Clear `forcedMuted` for every student; `muteAllActive=false`; `roster` broadcast. |
| audio frame | sender | Requires `micOpen`. Closed mic → frame dropped, violation counted, `error{mic-closed}` to sender — except when the sender is force-muted, where the truthful reason `error{mic-forced-muted}` is answered instead (so the client's UI never reports "open your mic" for a teacher mute). |

## Normative edge cases

- **Force-mute is not auto-mute**: `unmute`/`unmute-all` NEVER set
  `micOpen=true`; only participants open their own mics.
- **Force-mute cuts, it does not delete**: a cut speaker's in-flight provider
  input flushes (`audioStreamEnd`) so already-captured speech still translates
  as a tail; listeners hear the tail; nothing is interrupted mid-playback.
- **Self-hearing: never** — the DO excludes the speaker's own socket from
  every pipe fan-out, even if languages match (FR-015 unchanged).
- **Concurrent speakers**: two students can both hold `micOpen=true`; each is
  a separate pipe keyed `${speakerIndex}:${src}->{tgt}`. Sessions shared per
  pipe across that speaker's listeners (one feed per frame exactly once).
- **Sequence demuxing**: downlink `seq` is per (listener, speaker-pipe);
  clients demultiplex by the downlink `speaker` index and run one jitter
  queue per source (no cross-pipe seq correlation).
- **Caption turns**: keyed by speaker; a `mic-changed{pid,false}` is the turn
  boundary ONLY for pid's caption slots (PROTOCOL §3.1).
- **Disconnect**: pipe release (flush + release) for that pid; `micOpen`
  reset; `forcedMuted` row removed with the roster row; a rejoin starts
  unmuted (closed mic) and un-forced unless `muteAllActive`.
- **Teacher disconnect**: teacher's pipes released; students unaffected;
  `muteAllActive` and flags retained; second-teacher join still rejected
  (`teacher-taken`, FR-004); teacher socket replacement uses the rejoin path
  (`teacher-rejoin` roster broadcast, never `teacher-taken`).
- **Room expiry / idle shutdown**: wipes all state; the persisted `mic_control`
  row is dropped with the rest of the room's tables.
- **Hibernation**: the teacher force-mute policy (`forcedMuted` +
  `muteAllActive`) is persisted in the `mic_control` SQLite row and reloaded
  on wake, so a hibernation eviction can never silently drop the mute latch.
  `micOpen` is deliberately memory-only: an open mic streams frames
  continuously, so a room with any open mic never hibernates; on wake every
  server-side mic is closed and a client that keeps streaming re-syncs via
  mic-closed errors.

## What was removed

`raise-hand`, `lower-hand`, `grant`, `deny`, `revoke`, `autoGrant`, the
`FloorHolder` state machine and `floor-changed`. Hand-raising UX belongs to
the M3 class-feature backlog if ever wanted; it is not a wire feature now.
