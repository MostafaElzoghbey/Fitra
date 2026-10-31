# Fitra — Test Plan

Default rule: **every test uses `FakeTranslationProvider`** (echo + `delayMs` +
failure injection). Real Gemini only in the opt-in manual smoke test.

## 1. Unit (Vitest)

| Target | Cases | Proves |
|---|---|---|
| Mic-policy machine (`worker/src/mic.ts`) | every row of `docs/MIC-CONTROL.md`: mic-open/close, force-mute refuses mic-open, mute cuts an open mic (flush + release), mute-all + late joiner inherits, unmute never auto-opens, unknown pid → `mute-absent`, double-teacher, disconnect mid-speech | FR-010–016 |
| SessionManager | lazy open, refcount share (2 listeners 1 session), idle-close, cap overflow protects teacher leg, reconnect backoff sequence | FR-020–025 |
| Protocol codec | header encode/decode, seq wrap, oversize reject, bad version reject, JSON type guards | `docs/PROTOCOL.md` |
| Join token | sign/verify, expiry, tamper reject, role binding, rejoin verify (`ignoreExpiry`) re-signing the SAME pid | FR-003/050 |
| Caption reducer (`web/tests/captions.test.ts`) | interim replaces in place, a turn (input+output) commits when every non-empty live kind is final, `commitLiveCaptions` safety commit (mic-changed `micOpen:false` for that speaker / missing turnComplete; other speakers' mic changes keep the turn live), slots keyed by speaker (two concurrent speakers never overwrite each other), next interim never overwrites committed turns, 50-turn cap evicts oldest, input/output lines independent, stray final ignored, RTL text passes through unchanged | FR-034/035 |
| Metrics aggregation (`worker/tests/metrics.test.ts`) | sliding 1 s rate window, 60 s error window, session snapshot ordering, throttled emit (≤1/2 s), immediate emit on status change, idle room emits nothing | FR-040–043 |

## 2. Durable Object (Vitest + Cloudflare Workers pool)

`@cloudflare/vitest-pool-workers` (Miniflare; per-test isolated storage;
source: `https://developers.cloudflare.com/workers/testing/vitest-integration/`).
Configured in `worker/vitest.config.ts` as a second Vitest project: pure logic
runs on the default threads pool, `tests/room.test.ts` runs on the Workers pool
because the Hibernation WebSocket API only exists inside workerd. It connects
with real `WebSocketPair`s through `env.CLASSROOM.getByName(roomCode)`, pinning
`MAX_STUDENTS=1` and a test-only `JOIN_TOKEN_HMAC_SECRET` as Miniflare bindings.
Drive the DO with Fake provider: join teacher+students, open mics, push
PCM frames, assert fan-out per language, same-language relay resampled 16→24 kHz,
audio from a closed mic dropped, force-mute cut, rate-limit trips. Hono routes tested via
`app.request` (source: `https://hono.dev/docs/guides/testing`).

M0.5 latency/quality suite (`tests/fanout.test.ts`, describe
"pipe-fanout dedupe, pre-warm, captions, rejoin"): each translation pipe
receives exactly ONE uplink feed per frame regardless of listener count
(N same-language listeners share one session feed); sessions pre-warm at
mic-open (`session-status` arrives before any audio); caption routing
(both kinds → members whose join language matches the pipe target, tagged
with the pipe's source speaker index; same-language listeners other than
the speaker get neither, and the speaker keeps seeing their own captions
(FR-034)); teacher socket replacement
keeps the membership row and mic/force-mute state (`teacher-rejoin` broadcast, no
`error{teacher-taken}`, replaced socket's close cannot evict the row).
Concurrent-speaker suite (`tests/mic-do.test.ts`): teacher + two students with
mics open at once — three pipe sets, per-speaker downlink seq cursors, no
cross-feed between same-target sessions.

M0.6 observability suite (`tests/metrics-do.test.ts`): a live room receives
`metrics` within 2 s of audio/control activity; the frame validates against
`isRoomMetrics`; `inboundMsgPerSec`/`outboundMsgPerSec` are real counts
(not the 20:1 ratio); `sessions` lists exactly the live pairs with reconnect
counts; `errorsLastMin` increments after an `error` frame and expires;
`doActiveSec` advances with wall clock; a room with no traffic emits no
`metrics` frame (no timer wakes it). Caption frames with
`FAKE_EMIT_TRANSCRIPTS=1` validate against `isServerMsg` and reach only the
target-language sockets (already covered in fanout, re-asserted here).

## 3. E2E (Playwright, Chromium, no Gemini)

- 3 contexts: teacher (ar) + students (en, fr), `FakeTranslationProvider`.
- Fake media flags: `--use-fake-device-for-media-stream`,
  `--use-file-for-fake-audio-capture=<wav>` (verify or correct in OQ-10).
- Flow: create → join ×2 → teacher speaks (WAV in) → students receive audio
  (assert `audioFramesReceived > 0` via console/panel hooks); student opens
  mic → speaks → teacher receives — while the teacher mic is ALSO open
  (concurrent pipes); teacher `mute` on the student → student mic closes and
  `mic-open` is refused; `unmute` → student can open again; metrics panel
  shows latency number.
- CI-safe: no secrets, no network beyond localhost/Miniflare.

M0.6 E2E additions: the room shell is launched with `FAKE_EMIT_TRANSCRIPTS=1`;
after the teacher speaks, the `en` student sees `captions` — a chronological
chat-style transcript — with a live `output` line (the fake emits non-final
segments; committing turns, the mic-close safety commit and the 50-turn cap
are covered by `web/tests/captions.test.ts`), and the teacher sees
their own `input` and `output` captions while their mic is open. On
`mic-close` the provider receives `audioStreamEnd` and the translated tail
keeps playing for listeners; a mic change never interrupts any listener's
playback (`web/tests/playback-scheduler.test.ts` covers per-speaker queues).
`metric-sessions` now lists `0:ar->en` and `0:ar->fr` from the DO broadcast
(`data-status="live"`), proving FR-040/041 instead of asserting the old
"no server metrics" gap. The caption live region is asserted to be
`aria-live="polite"` and to inherit `dir="rtl"` on the Arabic UI, and the
metrics counters advance while audio flows.

Harness note (T-016): `e2e/playwright.config.ts` must run the **worker's**
wrangler, not the repo-root one. The root pin (`wrangler@3.114`) bundles a
workerd capped at compatibility date 2025-07-18, which does not populate
`ctx.id.name`; `ClassRoom.roomCode()` then resolves to `""` and every WebSocket
upgrade fails with `401 "token is for another room"` (PROTOCOL section 4). The
DO-pool tests in section 2 miss it because they run on the newer workerd that
`worker/node_modules` installs. Keep the two runtimes aligned — see
`e2e/README.md`.

### 3.1 Stable `data-testid` contract (T-013 → T-016)

E2E must select on these, never on copy or CSS classes — the UI is RTL and
multilingual, so text assertions are inherently fragile.

| Screen | Selector | Notes |
|---|---|---|
| Join | `consent-modal`, `consent-accept`, `consent-decline`, `consent-lang` | `join-room` stays disabled until `consent-accept` |
| Join | `join-room`, `room-code-input`, `display-name`, `role-group`, `participant-lang` | |
| Create | `create-room`, `teacher-name`, `teacher-lang`, `toggle-classmates`, `consent-confirm`, `room-code` | |
| Room | `mic-banner` | carries `data-speaking` = JSON list of participantIndexes with an open mic (empty list when nobody speaks) |
| Room | `mic-toggle`, `test-deployment-badge`, `headphones-hint`, `room-error` | `mic-toggle` stays enabled; while teacher-force-muted it carries `data-forced="true"`, a press is rejected with `mic-forced-muted` and the forced-muted notice renders |
| Room | `mute-all`, `unmute-all` | teacher-only controls in the room bar |
| Room | `roster`, `roster-row-<participantId>`, `mute-<participantId>`, `unmute-<participantId>` | `participantId` comes from `welcome`; row carries `data-mic="true|false"` and `data-forced="true|false"`; the leading control is `mute-` for any unforced student (even a quiet one) and `unmute-` for a forced one; teacher-only |
| Room | `room-disconnected`, `room-code-banner` | `room-disconnected` shows while the socket is down and the client rejoin retries are exhausted or blocked |
| Room | `captions`, `captions-empty`, `caption-live-input`, `caption-live-output`, `caption-history`, `caption-history-<index>` | chat-style transcript: committed turns (`caption-history-<index>`) persist oldest-first, the live turn appends below and updates in place; the transcript area scrolls; `captions-empty` until the first caption |
| Room | `metrics-mount` | T-012 renders the panel inside this node |
| Room | `metrics-panel` | T-012 panel root; `metrics-pending` chip until the first `metrics` frame |
| Room | `metric-latency` | `data-latency-ms` absent until measured, `data-samples`, `data-source` = `local` (browser estimate) / `server` |
| Room | `metric-sessions` | per-pair table (`metric-session-<pair>` rows), or `metric-sessions-empty` |

Integration seams owned by T-013, consumed by later tasks:

- **T-010/T-011** — Room attaches `attachRoomAudio` itself; the mic gesture
  drives `RoomAudioHandle.openMic` / `RoomAudioHandle.closeMic`
  (`web/src/audio/roomShell.ts`). `RoomProps.onMicToggle`/`micError` remain
  optional observer hooks. Raw frames flow through `RoomSocket.sendAudio` /
  `RoomSocket.onAudio`.
- **T-012** — `RoomProps.renderMetrics(metrics)` renders into `#metrics-mount`.
  Latency is measured in the browser (`web/src/audio/latency.ts`, first
  translated chunk back, polled from `AudioFrameSender.stats.framesSent` and
  `PlaybackScheduler.stats.framesPlayed`) and falls back to
  `RoomMetrics.e2eLatencyMs` until the local estimate exists.
- The socket accepts a text frame only if `isServerMsg` passes; violations are
  reported on `RoomSocket.onProtocolViolation` and never reach React state.

## 4. Manual smoke (real Gemini, env-flagged)

`SMOKE_GEMINI=1` + `GEMINI_API_KEY`: single ar→en pair, 2-min speech, logs
measured first-chunk/steady latency; resolves OQ-02/04/06/07. Never in CI.

## 5. Load (k6, WebSocket fan-out)

1 teacher + up to 30 students (Fake provider, M1): join storm, 10 audio
msg/s uplink, assert DO p95 forward latency, no drops past rate limits,
reconnect storm after forced restart. Soak variant (30 min, Gemini on) for OQ-05.

## 6. Definition of Done (every milestone)

- [ ] Acceptance criteria in `TASKS.md` demonstrated (tabs/E2E/smoke as specified)
- [ ] `tsc --noEmit` + unit + DO tests green; Playwright green (M0+)
- [ ] `lsp_diagnostics` clean on changed files
- [ ] Metrics panel shows the release's new behavior working
- [ ] Docs updated (`LIMITS.md` numbers corrected if measured otherwise)
- [ ] No key in client bundle (`grep` for key names in `web/dist` in CI)
- [ ] No per-chunk D1/DO-SQLite writes (review checklist)
