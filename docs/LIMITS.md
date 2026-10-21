# Fitra — Verified Free-Tier Limits + Quota Budget

All numbers verified against official docs on 2026-10-14. Re-check before
touching audio paths (rule in `AGENTS.md`).

## 1. Cloudflare (Workers Free plan)

| Fact | Value | Source |
|---|---|---|
| Free plan allows ONLY SQLite-backed DOs | yes | `https://developers.cloudflare.com/durable-objects/platform/pricing/` |
| DO requests | 100 000 / day; over → fail; reset 00:00 UTC | same |
| DO duration | 13 000 GB-s / day (128 MB per object) | same |
| Inbound WS messages billed 20:1 (billing only; metrics show real counts) | 100 msgs = 5 billed requests | same |
| Outgoing WS messages | free; protocol pings free + auto-handled | same + `.../durable-objects/best-practices/websockets/` |
| Outbound WS (to Gemini) prevents hibernation/eviction up to 15 min per connection; billed full duration | yes | `.../durable-objects/best-practices/websockets/` and `.../durable-objects/concepts/durable-object-lifecycle/` |
| Simultaneous outgoing connections per invocation | 6 | `https://developers.cloudflare.com/durable-objects/platform/limits/` |
| DO CPU per event | 30 s default (configurable to 5 min) | same |
| WS message size cap | 32 MiB inbound (we cap at 8 KiB) | same |
| Workers Free CPU | 10 ms / invocation; 100 k req/day; static-asset requests free/unlimited | `https://developers.cloudflare.com/workers/platform/pricing/` and `.../workers/platform/limits/` |
| D1 Free | 5 M rows read/day, 100 K rows written/day, 5 GB total; over-limit queries FAIL (enforced since 2026-09-01) | `https://developers.cloudflare.com/d1/platform/pricing/` and `https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/` |
| Deploys disconnect all WS | yes — plan reconnect UX | `.../durable-objects/best-practices/websockets/` |

Correction to initial belief: the per-day DO storage rows (5 M read / 100 K
written, 5 GB) on the pricing page refer to **DO SQLite storage API usage**,
not D1 — D1 has its own identical-looking but separate quota (table above).
Either way the rule stands: never write per-chunk data anywhere.

## 2. Gemini Live Translate (docs)

| Fact | Value | Source |
|---|---|---|
| Model | `gemini-3.5-live-translate-preview` (preview), 70+ languages incl. ar/en/fr/es | `https://ai.google.dev/gemini-api/docs/live-api/live-translate` |
| Audio in | raw PCM16LE 16 kHz mono; chunks of 100 ms; audio-only input | same |
| Audio out | raw PCM16LE 24 kHz mono | same |
| Setup | `responseModalities: ["AUDIO"]`, `translationConfig: { targetLanguageCode (BCP-47), echoTargetLanguage (default false) }` | same + `https://ai.google.dev/api/live` |
| Transcripts | `inputAudioTranscription` / `outputAudioTranscription` enable them | same (placement disputed → OQ-01) |
| Session caps | audio-only 15 min; connection ~10 min (GoAway ~60 s before); resumption tokens valid 2 h; compression via `triggerTokens` (5 000–128 000) + `targetTokens` sliding window; ~25 audio tokens/s | `https://ai.google.dev/gemini-api/docs/live-api/session-management` |
| Paid price (translate model) | in $3.50 or $0.0053/min; out $21.00 or $0.0315/min; ≈ $0.0368/min blended | `https://ai.google.dev/gemini-api/docs/pricing` |
| Free tier data use | free-tier content MAY be used to improve Google products (+ human review); paid tier is not | `https://ai.google.dev/gemini-api/terms` and pricing page ("Used to improve our products: Yes" on Free) |

## 3. One-hour class budget: 1 teacher + 10 students, 3 languages (ar/en/fr)

Assumptions: half-duplex (one speaker), 100 ms frames, ~40 min actual speech.

| Item | Math | Result |
|---|---|---|
| Inbound WS msgs | 10/s × 3 600 s | 36 000 msgs → **1 800 billed req** |
| DO duration (no hibernate while Gemini WS open) | 3 600 s × 0.125 GB | **450 GB-s** (≈ 3.5% of 13 000; ≈ 28 room-h/day capacity) |
| Outbound fan-out | ~10 listeners × 10/s × 3 600 | 360 000 msgs, **free** |
| Gemini sessions | teacher speaks: 2 (ar→en, ar→fr); student speaks: 2 + optional classmates | ≤ 2 concurrent typical |
| Gemini paid cost | 40 speech-min × 2 sessions × $0.0368/min | **≈ $2.94 / class-hour** |
| Gemini free tier | $0, but audio used to improve Google products → free tier is dev/test only (see `docs/PRIVACY.md`) | — |
| D1 (M0) | unused | 0 |

Headroom check: 1 800 billed req ≪ 100 000/day; one room-hour = 450 GB-s,
so ~28 sequential room-hours (or ~3 concurrent 8-hour rooms) fit the free day.
30-student rooms: inbound unchanged (one speaker); outbound fan-out free —
scale limit is CPU-per-event and the 6-outbound-connection cap, not billing.
