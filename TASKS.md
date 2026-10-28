# Fitra — Tasks

Each task ≤ half a day, independently testable, with acceptance + proving test.

## M0 "Translation Lab" (full detail)

| ID | Task | Acceptance | Proved by |
|---|---|---|---|
| T-001 | Repo skeleton: `web/` (Vite+React+TS+Tailwind+i18n+RTL), `worker/` (Hono), `packages/shared` (protocol types), pnpm + wrangler.jsonc per ARCHITECTURE §5, strict TS | `pnpm dev` serves stub UI; `wrangler deploy --dry-run` ok | tsc |
| T-002 | Protocol codec (`packages/shared`): binary header + JSON guards | Round-trip + reject cases pass | unit |
| T-003 | Floor-control machine (pure module, table rows 1–12) | Exhaustive transition tests pass | unit |
| T-004 | `TranslationProvider` interface + `FakeTranslationProvider` (echo+tag, delay, failure injection) | Fake loops audio with configured delay; injectable failure fires `onStatus` | unit |
| T-005 | Hono: `POST /rooms` (code+config), `POST /rooms/:code/join` (HMAC token), kill switch, validation-before-DO | Invalid join → 4xx without DO hit; token verifies | DO-pool test |
| T-006 | ClassRoom DO: membership + upgrade auth + roster + Hibernation WS | 2 tabs join, roster correct; bad token → 401 | DO-pool test |
| T-007 | Floor control wired in DO (grant/deny/revoke/autoGrant, preempt, broadcasts) | Tab scenario follows transition table | DO-pool + E2E |
| T-008 | SessionManager: lazy/shared/refcount/idle-close/cap+degradation | 2 same-target listeners = 1 session; overflow → `degraded`, teacher leg kept | unit + DO-pool |
| T-009 | DO audio fan-out (binary forward, same-lang passthrough, speaker excluded, rate limits) with Fake | en+fr students get frames; ar teacher gets none of own speech | DO-pool |
| T-010 | Browser capture (AudioWorklet 16 kHz mono, 100 ms frames, device select, gesture resume) | Mic → frames on socket at ~10/s; denial shows hint | E2E (fake mic file) |
| T-011 | Browser playback (scheduled AudioBufferSourceNodes + 300–500 ms jitter buffer, headphones hint) | Received frames audible/out-of-speaker stats advance; gap tolerant | E2E |
| T-012 | Metrics panel (latency, sessions, reconnects, rates, errors, DO active-sec) | Numbers move during a live tab session | E2E assert |
| T-013 | Consent modal + RTL Arabic UI + join/create screens | ar RTL correct; joining blocked until consent | E2E |
| T-014 | Gemini probe script (setup placements, OQ-01/02/03/07) + record results in OPEN-QUESTIONS | `setupComplete` + translated audio logged, or documented failure | manual log |
| T-015 | `GeminiTranslationProvider` (behind env flag, key server-side only) | ar→en live translation in 2 tabs; client bundle key-free | manual smoke |
| T-016 | Playwright E2E: full M0 acceptance flow on Fake (SPEC §8 example) | CI green, zero Gemini calls | playwright |
| T-017 | `wrangler deploy` to workers.dev + 2-tab live check + no-key-in-bundle CI grep | Public URL works per acceptance example | manual + CI |
| T-018 | 30-min soak (Fake, then Gemini-on) → correct LIMITS.md if off | Drop/reconnect counts recorded | soak log |
| T-019 | Gemini smoke latency log (OQ-06) + NFR-005 baseline | Latency numbers in TEST-PLAN appendix/OPEN-QUESTIONS | manual log |

## M0.6 "Translation you can trust" (observability + captions)

| ID | Task | Acceptance | Proved by |
|---|---|---|---|
| T-020 | DO metrics broadcast: real inbound/outbound counters, 60 s error window, live session snapshot, `doActiveSec`, 2 s throttle + immediate-on-status; `e2eLatencyMs` stays `null` | `metrics` reaches clients while audio flows; rates match sent counts; idle room emits none; frame passes `isRoomMetrics` | `worker/tests/metrics*.test.ts` + DO test + E2E `metric-sessions` |
| T-021 | Caption UX: pure reducer (`web/src/captions.ts`), interim→final commit, 2-line live + 50-segment scrollback, input/output labels, `aria-live`, RTL inheritance, documented empty state | Interim updates replace; finals commit once; history caps at 50; Arabic renders RTL; empty engine state shown | `web/tests/captions.test.ts` + E2E captions |
| T-022 | Capture Gemini `sessionResumptionUpdate` handles and pass them on reconnect; surface `GoAway` as `reconnecting` with attempt; no behaviour depends on context surviving | Handle captured per session, resent on reconnect, stale-generation updates ignored | `worker/tests/gemini.test.ts` + `sessions.test.ts` |
| T-023 | UI copy pass: "voice is generated" note, headphones hint, no voice/tone/glossary controls | Arabic + English strings agree; no control exists for an undocumented capability | E2E + review |
| T-024 | Panel shows server sessions and real rates (replace the "server gap" expectation in `e2e/m0-flow.spec.ts`) | `metric-sessions` rows carry `data-status="live"` | E2E |
| T-025 | Mic-off tail + sender captions: `speaking-stop` flushes provider input (`audioStreamEnd`); floor changes never interrupt listeners' playback; the source speaker also receives their own `input`/`output` captions | Buffered speech still translates after mic-off; listeners hear the tail; speaker sees both caption kinds; same-language non-speakers stay excluded | `worker/tests/{gemini,sessions,fanout}.test.ts` + `web/tests/floor-gate.test.ts` + E2E |

M0 acceptance (end to end): teacher tab (ar) speaks → student tab (en) hears
English; student raises hand → granted → speaks → teacher hears Arabic;
metrics panel shows latency. Deployable via `wrangler deploy`.

## M1 "Multi-language & resilience" (coarse)

3+ languages live, same-language passthrough at scale, cap/degradation demo,
reconnect/resume against forced restarts, rate-limit abuse test, k6 30-student
fan-out, idle-shutdown + max-duration enforced.

## M2 "Accounts & courses" (coarse)

Better Auth + D1 schema (users, courses, sessions, enrollments), rooms bound
to courses with same token claims, RTL-polished UI, D1 quota-safe access
patterns (indexed, no hot writes).

## M3 "Learning features" (coarse)

Captions if OQ-01 confirms transcripts, glossary/terminology config, batched
session summaries to D1, teacher dashboard. SFU spike (OQ-09) as separate note.
