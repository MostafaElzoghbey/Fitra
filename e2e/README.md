# T-016 E2E (M0 acceptance gate)

Three browser contexts (teacher Layla `ar`, students Marco `en` and Aisha `fr`)
run the full M0 acceptance flow against `FakeTranslationProvider`.

## Run

```sh
npm run e2e          # builds web/, installs chromium if missing, runs the suite
npm run typecheck --prefix e2e   # strict tsc over m0-flow.spec.ts
```

`e2e/tsconfig.json` covers the spec only: `playwright.config.ts` uses Node
builtins and the repo installs no `@types/node`, so it is validated by Playwright
at load time instead.

`playwright.config.ts` starts `wrangler dev` on `http://127.0.0.1:8787`, which
serves the Worker, the ClassRoom DO and the built SPA from one origin. Flow:
create room -> join ×3 (consent-accept each) -> teacher speaks -> students
receive, speaker receives nothing (FR-015) -> raise-hand -> grant -> student
speaks -> teacher receives -> revoke -> silence, plus roster, RTL, floor-banner
and metrics-panel asserts.

## Wrangler pin — read this before changing the harness

The repo root installs `wrangler@3.114.x`, whose bundled workerd tops out at
compatibility date `2025-07-18`. That runtime does **not** populate
`ctx.id.name`, so `ClassRoom.roomCode()` (`worker/src/room.ts`) resolves to `""`
and the upgrade check in `docs/PROTOCOL.md` section 4 rejects *every* join with
`401 unauthorized / "token is for another room"` — no browser can enter a room.

The DO-pool tests (`worker/tests`) cannot catch this: they run on the newer
`workerd` that `worker/node_modules` installs for `@cloudflare/vitest-plugin`,
where `ctx.id.name` is populated. So the config deliberately resolves
`worker/node_modules/.bin/wrangler` first — the same runtime the DO tests use —
and falls back to the root pin only if it is missing. Raising the root
`wrangler` dependency to v4 removes the need for the fallback.

`reuseExistingServer: false` on purpose: silently attaching to a
already-listening 8787 is exactly how a stale runtime can fake a green run.

## Audio (OQ-10 resolved)

`?injectAudio=1` feeds synthetic sine frames straight to `AudioFrameSender`
through the existing capture seam in `web/src/audio/capture.ts`, so the run needs
no microphone, no fake-device WAV and no AudioWorklet. The Chromium flags in
`playwright.config.ts` (`--use-fake-device-for-media-stream`,
`--use-fake-ui-for-media-stream`) are backup for the real-mic path only and never
touch the audio graph here. `--use-file-for-fake-audio-capture` is **not** used:
it needs a WAV on disk and the seam made it unnecessary.

Result: `?injectAudio=1` worked first try. Runtime is ~10 s for the whole flow.

## CI notes

- **No secrets.** `JOIN_TOKEN_HMAC_SECRET` is a local-only dummy passed on the
  CLI (`fitra-e2e-test-only-secret`); it is not a real secret and never leaves
  localhost.
- **No outbound network.** The spec aborts every off-origin request and fails if
  anything but the decorative `fonts.googleapis.com` links in `web/index.html`
  is attempted. The only external URLs in the bundle are an `<a href>` privacy
  link and a React error-message URL — neither makes a request.
- **Zero Gemini.** `TRANSLATION_PROVIDER=fake`. The Gemini hits in `web/dist`
  are PRIVACY-mandated consent copy and a worklet comment, not imports:

  ```sh
  grep -rioE "generativelanguage[a-z./]*|@google/generative-ai|GEMINI_API_KEY|AIza[0-9A-Za-z_-]{10,}" web/dist   # must print nothing
  grep -rnE "^\s*import .*(gemini|Gemini)" web/src                                                          # must print nothing
  ```

- **Fake provider delay** is not env-configurable (`room.ts` constructs
  `new FakeTranslationProvider()` with defaults, `delayMs = 50`), so the spec
  uses generous timeouts instead.

## Known server gap (reported, not fixed — `worker/` is read-only for T-016)

The DO never broadcasts `{t:"metrics"}`, so `RoomMetrics` never reaches any
client and `metric-sessions` can never list a pair. The spec asserts the panel
is mounted and correctly reports "no server metrics yet"
(`metric-sessions-empty`), and proves the live translation pairs through the
`session-status`-driven rows (`session-ar->en`, `session-ar->fr`, `session-en->ar`)
instead. Latency is asserted from the browser-local estimate
(`data-source="local"`). Making `metric-sessions` populate needs a DO-side
`metrics` broadcast (T-012 backend half).