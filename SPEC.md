# Fitra — Live Speech-to-Speech Classroom Translation: Specification

> SPEC-ONLY. No application code exists yet. This document is normative for all
> milestones. `docs/OPEN-QUESTIONS.md` lists everything not yet verified.

## 1. Product overview

Fitra is an educational platform where a teacher teaches live to students in
other countries who speak other languages. The core feature is **real-time
bidirectional speech-to-speech translation**:

- Teacher speaks (e.g. Arabic) → each student hears it in their own language.
- A student speaks (e.g. English, French) → the teacher hears it in the
  teacher's language; classmates optionally hear it in their own languages.

The translation feature is built **first**, as a standalone testable
"Translation Lab" (Milestone 0), before accounts, courses, payments, or
anything else. The developer must be able to open 2–3 browser tabs and test
end to end as early as possible.

## 2. Personas

| Persona | Description | Needs |
|---|---|---|
| Layla (teacher) | Solo teacher, Arabic-speaking, teaches students abroad | Speak naturally; control who speaks; see who is in the room; know translation is working (latency/status) |
| Marco (student) | Student in Spain, speaks Spanish, weak English | Hear the teacher in Spanish; ask questions in Spanish and be understood |
| Aisha (student) | Student in France, speaks French | Same as Marco, in French; optional captions if the engine supports them |
| Dev (solo full-stack developer) | Builds and operates everything on Cloudflare free tier | Test with tabs locally; measure quota consumption from day one; swap the translation engine later |

## 3. User stories (M0 scope)

1. As Layla, I create a room and receive a room code I can share, so students
   can join without accounts.
2. As Marco, I join with room code + display name + role + language, so I can
   participate with zero setup.
3. As Layla, I speak Arabic and Marco hears Spanish, so I can teach.
4. As Marco, I raise my hand; Layla grants me the floor; I speak Spanish and
   Layla hears Arabic, so I can ask questions.
5. As Layla, I can revoke the floor at any time and my speech always takes
   priority, so the class stays orderly.
6. As Dev, I see a live metrics panel (latency, sessions, errors, DO active
   duration), so I can measure free-tier consumption from the first test.
7. As Dev, I can run the whole flow with a fake translation provider, so I
   spend zero Gemini quota in tests and local dev.

## 4. Numbered functional requirements

### 4.1 Rooms and roles

- **FR-001** A room has exactly one teacher and up to N students; N is
  configurable per room, default 30 for MVP.
- **FR-002** M0 has no accounts. Teacher creates a room → gets a room code.
  Participants join with room code + display name + role (`teacher`/`student`)
  + one BCP-47 language used for both listening and speaking.
- **FR-003** On join, the Worker issues a short-lived HMAC-signed join token
  (roomId, participantId, role, language, exp). The Durable Object validates
  it on WebSocket upgrade. The token claims shape MUST be forward-compatible
  with a future Better Auth session minting the same token (M2) without
  changing the wire protocol (see `docs/PROTOCOL.md`).
- **FR-004** Only one teacher per room: a second `teacher` join is rejected
  with `ERROR.teacher-taken`.
- **FR-005** The teacher's language is a room setting fixed at creation.
- **FR-006** Supported languages are a server config list. Initial test set:
  `ar`, `en`, `fr`, `es`. All four are confirmed in the Gemini Live Translate
  supported-language table (70+ languages; source:
  `https://ai.google.dev/gemini-api/docs/live-api/live-translate`).
- **FR-007** Join with an unsupported language is rejected with
  `ERROR.unsupported-language`.

### 4.2 Floor control (half duplex)

- **FR-010** Only ONE person speaks at a time (half duplex). Rationale: mixing
  several simultaneous speakers into one translation stream degrades output
  quality and multiplies Gemini session cost; see `docs/FLOOR-CONTROL.md`.
- **FR-011** Floor states: `IDLE`, `TEACHER_SPEAKING`, `STUDENT_SPEAKING(studentId)`.
- **FR-012** A student may `raise-hand`; the teacher `grant`s or `deny`s.
  Setting `autoGrant` (default off) grants automatically.
- **FR-013** The teacher speaking always preempts: teacher audio/start takes
  the floor immediately, revoking any student floor.
- **FR-014** The teacher may `revoke` the floor at any time.
- **FR-015** A speaker never receives the translation of their own speech.
- **FR-016** Every floor transition is broadcast to all room clients
  (`floor-changed` event); full table and edge cases in
  `docs/FLOOR-CONTROL.md`.

### 4.3 Translation routing

- **FR-020** Translation sessions are keyed by
  `(sourceLanguage → targetLanguage)`, pre-warmed at floor grant then
  shared by all listeners needing that target language, reference-counted,
  closed after an idle timeout (default 60 s, configurable).
- **FR-021** Same-language listener: relay the original audio untouched — no
  translation session, no Gemini cost.
- **FR-022** Teacher speaks → one session per distinct student language.
- **FR-023** Student speaks → one session to the teacher's language, plus one
  per other distinct student language iff `classmatesHearStudent` is on
  (default on).
- **FR-024** Global cap `maxTranslationSessions` per room (default 8,
  configurable). On overflow: keep sessions serving the teacher + earliest
  listeners; new listeners get original-audio-muted + `session-degraded`
  notice (never silent failure). Details in `ARCHITECTURE.md`.
- **FR-025** Session failure: notify clients (`session-status`), reconnect with
  backoff, resume via Gemini session resumption; enable context-window
  compression for long classes (see `ARCHITECTURE.md`; unverified details in
  `docs/OPEN-QUESTIONS.md`).

### 4.4 Audio pipeline

- **FR-030** Browser capture: AudioWorklet, mono PCM 16-bit **16 kHz**
  (Gemini Live Translate input requirement; source:
  `https://ai.google.dev/gemini-api/docs/live-api/live-translate`).
- **FR-031** Browser playback: scheduled `AudioBufferSourceNode`s (NOT a
  playback worklet — `createBuffer(1, len, 24000)` lets the browser resample to
  hardware rate; avoids the 24k-played-as-48k chipmunk bug) + jitter buffer
  (target 300–500 ms, 3–5 × 100 ms chunks), playing 24 kHz mono PCM (Gemini
  output format; source:
  `https://ai.google.dev/gemini-api/docs/live-api/live-translate`).
- **FR-032** Browser→DO transport: binary frames, 100 ms chunks
  (3 200 bytes payload + 8-byte header). 100 ms matches the Gemini docs'
  recommended chunk size and keeps DO inbound message rate at ~10 msg/s per
  speaker (battery of the 20:1 billing ratio; see `docs/LIMITS.md`). The DO
  forwards bytes with minimal processing (no decode/resample).
- **FR-033** AudioContext requires a user gesture: joining + tapping
  "unmute/enable audio" resumes the context; mic permission denial shows a
  blocking hint with retry; device selection exposed via `enumerateDevices`;
  UI recommends headphones to avoid echo.
- **FR-034** Captions/transcripts ship as `caption{kind, text, final}` frames
  when the engine returns them (`inputAudioTranscription` /
  `outputAudioTranscription` top-level placement probe-confirmed, see
  OQ-01). Routing: `output` and `input` captions both go to the pair's
  target-language sockets (PROTOCOL.md section 3.1). Memory only — no
  caption data is ever persisted.
- **FR-035** Caption display MUST treat `final:false` as a live replacement of
  the current segment for that `kind` and `final:true` as the commit of that
  segment (never overwrite a committed segment with the next interim one).
  The UI shows a two-line live region per kind, keeps at most 50 committed
  segments in memory, labels input vs translated text, uses `aria-live` for
  the committed line, and inherits the page `dir` so Arabic renders RTL.
  Captions are optional: an engine that yields none shows the documented
  empty state, never a spinner that implies one is coming.

### 4.5 Debug / metrics panel (M0)

- **FR-040** Live panel shows: end-to-end latency estimate (speaker chunk sent
  → first translated chunk received), per-session status, reconnect count,
  inbound/outbound message rates, error log, DO active-duration estimate.
- **FR-041** All metrics are client-observable or DO-reported over the control
  channel; no D1 writes for metrics (free-tier rule).
- **FR-042** The DO broadcasts `metrics` on the control channel at most once
  per 2 s while the room is active, and immediately after a translation
  session status change. Counters are real message counts (not the 20:1
  billing ratio); rates use a 1 s sliding window; `errorsLastMin` counts
  errors in the last 60 s; `sessions` is a snapshot of live pairs with their
  reconnect counts. `e2eLatencyMs` is `null` from the DO until a server-side
  send/receipt pair exists — the browser's local estimate is authoritative
  for display. Broadcasts stop when the room is idle (no timers, no
  `setInterval`).
- **FR-043** A room with no traffic MUST NOT wake or hold the DO open just to
  emit metrics: the throttled broadcast piggybacks on real events, so an idle
  room stays hibernatable.

### 4.6 Security and abuse limits

- **FR-050** Signed join tokens (HMAC, short-lived), validated in the DO on
  upgrade; role in token is authoritative.
- **FR-051** Only the teacher can grant/deny/revoke; students can send audio
  only while holding the floor (DO drops + counts violations otherwise).
- **FR-052** Per-connection rate limiting (default: ≤ 20 audio frames/s,
  ≤ 10 control msg/s), max inbound frame 8 KiB, max participants enforced,
  max room duration (default 2 h), idle-room shutdown (default 15 min with no
  participants → DO lets itself evict; alarm-based cleanup), kill switch
  config (`ROOM_CREATION_DISABLED`).
- **FR-053** The Gemini API key lives only in a Worker secret and is used only
  inside the Durable Object → Gemini connection. It MUST never reach the
  browser (see `AGENTS.md`).

## 5. Non-functional requirements

- **NFR-001** Free-tier-first: the design respects verified Cloudflare free
  limits (`docs/LIMITS.md`); exceeding them fails gracefully, never silently.
- **NFR-002** TypeScript strict mode everywhere; `TranslationProvider`
  interface isolates Gemini (swap to STT→MT→TTS or Fake without touching
  room/floor/audio code).
- **NFR-003** Tests use `FakeTranslationProvider` by default; real Gemini only
  in an opt-in manual smoke test.
- **NFR-004** RTL-first UI; Arabic UI ships in M0 (i18n infra from day one).
- **NFR-005** Target end-to-end latency: first translated chunk < 2 s after
  speaker start on typical broadband (measured, not guaranteed; panel proves it).
- **NFR-006** Deployable with `wrangler deploy` to `workers.dev` in M0.
- **NFR-007** No per-audio-chunk or per-caption writes to D1, ever.

## 6. Out of scope (all milestones unless noted)

Video, payments, recording (explicitly forbidden by default — see
`docs/PRIVACY.md`), mobile apps, WebRTC/SFU (future path: Cloudflare Realtime
SFU — see OQ-09), multi-teacher rooms, breakout rooms, whiteboard, chat.

Also out of scope while the translate model does not document them
(ARCHITECTURE.md §4.1): synthetic voice/tone selection, speech-rate control,
glossary or prompt steering, and per-word caption timing. These must not ship
as placeholder controls.
