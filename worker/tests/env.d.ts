// Ambient bindings for the Vitest Workers pool (`cloudflare:test`).
//
// `import { env } from "cloudflare:test"` is typed as `Cloudflare.Env`; that
// namespace is normally emitted by `wrangler types`. M0 keeps the worker's
// bindings hand-written, so declare them here instead of widening `env` to
// `any` (AGENTS.md: strict TS, no `any`).
/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    /** One ClassRoom DO instance per room, keyed by room code (`idFromName`). */
    readonly CLASSROOM: DurableObjectNamespace;
    /** Test-only join-token secret injected by `worker/vitest.config.ts`. */
    readonly JOIN_TOKEN_HMAC_SECRET: string;
    readonly MAX_STUDENTS: number;
    readonly MAX_ROOM_MINUTES: number;
    readonly SUPPORTED_LANGUAGES: readonly string[];
  }
}
