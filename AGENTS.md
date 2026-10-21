# Fitra — AGENTS.md (rules for future coding agents)

## Fixed stack (do not change; flag problems instead)

Workers + Static Assets · Vite/React/TS/Tailwind (RTL+i18n, Arabic first) ·
Hono · ClassRoom Durable Object (`new_sqlite_classes` only) · D1+Drizzle (M2+) ·
Better Auth (M2+) · Gemini `gemini-3.5-live-translate-preview` over
server-side WSS behind `TranslationProvider` · plain-WS audio (no WebRTC in
MVP) · Vitest Workers pool + Playwright + k6 · pnpm + wrangler + strict TS.

## Repo layout (M0)

```
web/ (SPA) · worker/src/{index.ts (Hono), room.ts (ClassRoom DO),
translation/{provider.ts, gemini.ts, fake.ts, sessions.ts}} ·
packages/shared/ (protocol codec + types) · docs/ · TASKS.md
```

## Hard rules

1. **Never put `GEMINI_API_KEY` (or any secret) in client code.** Server-side
   (DO) only. CI greps `web/dist` for key names.
2. **Never write per-audio-chunk or per-caption data to D1 or DO SQLite.**
   Memory only; M3 summaries batch-write text.
3. **Tests use `FakeTranslationProvider` by default.** Real Gemini only behind
   `SMOKE_GEMINI=1`, never in CI.
4. **Read `docs/LIMITS.md` before touching audio paths.** 100 ms frames,
   minimal DO processing, outbound fan-out is free / inbound is 20:1.
5. **Floor control is server-authoritative** (`docs/FLOOR-CONTROL.md`); clients
   are hints only. Half duplex is a product rule, not a bug.
6. **Protocol changes update `docs/PROTOCOL.md` first**, then code, then tests.
7. **Behaviour change → update the docs** (SPEC/ARCHITECTURE/LIMITS/
   OPEN-QUESTIONS) in the same task. Docs and code ship together.
8. Follow `docs/TEST-PLAN.md` Definition of Done: tsc + tests green,
   diagnostics clean, metrics panel proves it, no commits unless asked.

## Conventions

- Strict TS, no `as any` / `@ts-ignore`; exhaustive switches on message types.
- BCP-47 langs validated against `SUPPORTED_LANGUAGES` at join.
-Arabic UI strings ship with every user-facing feature (RTL check in E2E).
- Small tasks per `TASKS.md` (≤ half day each); todo-track multi-step work.
