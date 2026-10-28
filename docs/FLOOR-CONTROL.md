# Fitra — Floor Control (half duplex)

## Why half duplex

Mixing simultaneous speakers into one translation stream degrades output
quality and multiplies Gemini session cost (one session per language pair per
active speaker). One speaker at a time keeps cost predictable and translation
clean. This is a product rule, enforced server-side — clients cannot override it.

## States

- `IDLE` — nobody holds the floor.
- `TEACHER_SPEAKING` — teacher holds the floor.
- `STUDENT_SPEAKING(pid)` — granted student `pid` holds the floor.

Related server data (not states): `raisedHands: pid[]` (FIFO queue),
`autoGrant: bool`, `teacherConnected: bool`.

## Transition table

| # | From | Event | To | Broadcast | Notes |
|---|---|---|---|---|---|
| 1 | IDLE | teacher `speaking-start` | TEACHER_SPEAKING | `floor-changed{teacher}` | — |
| 2 | IDLE | grant(pid) (auto or manual) | STUDENT_SPEAKING(pid) | `floor-changed{student pid}` | Dequeues pid from hands |
| 3 | TEACHER_SPEAKING | teacher `speaking-stop` / disconnect | IDLE | `floor-changed{none}` | Input flushed; sessions idle-close later |
| 4 | STUDENT_SPEAKING(p) | speaker `speaking-stop` / revoke / disconnect | IDLE | `floor-changed{none}` | Input flushed; revoke is teacher-only |
| 5 | STUDENT_SPEAKING(p) | teacher `speaking-start` | TEACHER_SPEAKING | `floor-changed{teacher, preempted:p}` | Teacher always preempts; p must re-raise |
| 6 | ANY | student audio without floor | (no change) | `error{not-your-floor}` to sender | Frame dropped, violation counted |
| 7 | IDLE/STUDENT_* | raise-hand(q) | (no change) | `hands` update | Duplicates ignored; `autoGrant`+IDLE → rule 2 immediately |
| 8 | STUDENT_SPEAKING(p) | raise-hand(q), q≠p | (no change) | `hands` update | Queue for later; no interruption |
| 9 | STUDENT_SPEAKING(p) | grant(q) | STUDENT_SPEAKING(q) | `floor-changed{student q}` | Implicit revoke of p (teacher handover) |
| 10 | ANY | teacher disconnect | IDLE | `floor-changed{none, teacher-gone}` + room pauses translation | Students keep sockets; rejoin resumes |
| 11 | STUDENT_SPEAKING(p) | p disconnects | IDLE | `floor-changed{none}` | Hands queue unchanged otherwise |
| 12 | ANY | second `teacher` join | (no change) | `error{teacher-taken}` | FR-004 |

## Edge cases (normative)

- **Two students raise at once**: FIFO by arrival order in the DO;
  simultaneous = whichever `webSocketMessage` runs first (single-threaded DO —
  no tie possible).
- **Speaker disconnects mid-sentence**: rules 3/4/11; sessions using that
  speaker as source are released; listeners hear silence (no filler audio).
- **Speaker stops mid-sentence (still connected)**: `speaking-stop` flushes
  the provider input, and the translated tail keeps flowing to listeners after
  the floor becomes IDLE. A client interrupts its own playback only when a
  different holder takes the floor from it — never merely because the floor
  became IDLE, since the translated tail may still be playing.
- **Teacher disconnects**: translation stops (no source), room state retained
  in DO memory/SQLite; on teacher rejoin (same room code + `teacher` role +
  valid token) state resumes at IDLE. A teacher REPLACING their own socket
  (rejoin endpoint) broadcasts `floor-changed{none, teacher-rejoin}` so
  clients resync; it must never surface `error{teacher-taken}`, and the
  replaced socket's close cannot evict the live membership row.
- **Floor grant pre-warms translation**: the grant effect opens the pair set
  eagerly (see `ARCHITECTURE.md` section 4), so the first spoken frame does
  not pay the session-opening gap.
- **Grant to absent pid**: `error` to teacher, no state change.
- **Revoke with IDLE floor**: no-op, still broadcast (keeps clients in sync).
- **Self-hearing**: never — the DO excludes the speaker's own socket from
  fan-out even if languages match (FR-015).
