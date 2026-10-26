// Vitest config for `worker/`.
//
// Two projects:
//   - `unit`  — pure logic (token, floor machine, fake provider, SessionManager,
//               Hono routes). Runs on the default threads pool.
//   - `do`    — ClassRoom Durable Object over the real Workers pool
//               (`@cloudflare/vitest-plugin`, workerd + Miniflare). Needed for
//               hibernation WebSockets: `acceptWebSocket`/`webSocketMessage`/
//               `webSocketClose` only exist inside workerd (docs/TEST-PLAN.md §2).
//
// The plugin reads `wrangler.jsonc` so the `CLASSROOM` binding and the
// `new_sqlite_classes` migration match what ships. `JOIN_TOKEN_HMAC_SECRET` is a
// secret (never in wrangler.jsonc) so the test-only value is injected here as a
// plain Miniflare binding. MAX_STUDENTS is pinned to 4 so the room-full case
// stays reachable while floor tests can seat two students plus a teacher.
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

const SHARED_ALIAS = {
  // Mirrors web/vite.config.ts: the workspace link alone is not enough, and the
  // worker package does not (yet) depend on @fitra/shared in package.json.
  "@fitra/shared": new URL("../packages/shared/src/index.ts", import.meta.url)
    .pathname,
};

const TEST_JOIN_TOKEN_SECRET = "t006-test-only-hmac-secret";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        resolve: { alias: SHARED_ALIAS },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: [
            "tests/room.test.ts",
            "tests/floor-do.test.ts",
            "tests/fanout.test.ts",
            "node_modules/**",
          ],
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "../wrangler.jsonc" },
            miniflare: {
              bindings: {
                JOIN_TOKEN_HMAC_SECRET: TEST_JOIN_TOKEN_SECRET,
                MAX_STUDENTS: 4,
                // Caption-routing tests need a transcript-capable fake; the
                // default fake stays silent for every other DO test.
                FAKE_EMIT_TRANSCRIPTS: "1",
              },
            },
          }),
        ],
        resolve: { alias: SHARED_ALIAS },
        test: {
          name: "do",
          include: ["tests/room.test.ts", "tests/floor-do.test.ts", "tests/fanout.test.ts"],
        },
      },
    ],
  },
});
