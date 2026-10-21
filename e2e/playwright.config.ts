// T-016: Playwright E2E gate for the M0 acceptance flow (docs/TEST-PLAN.md 3).
//
// One localhost origin serves everything: `wrangler dev` runs the Worker, the
// ClassRoom DO and the static SPA from web/dist (build it first: `npm run e2e`
// does that). TRANSLATION_PROVIDER is pinned to `fake`, so zero Gemini quota is
// spent. JOIN_TOKEN_HMAC_SECRET is a throwaway local-only value passed with
// --var: it is NOT a real secret and never leaves localhost (no keys, ever).
//
// WRANGLER PIN — read before changing this line.
// The repo root installs `wrangler@3.114.x`, whose bundled workerd tops out at
// compatibility date 2025-07-18. That runtime does NOT populate
// `ctx.id.name`, so ClassRoom.roomCode() (`worker/src/room.ts`) resolves to ""
// and EVERY WebSocket upgrade is rejected with 401 "token is for another room"
// (docs/PROTOCOL.md section 4) — no browser can join a room. The DO-pool tests
// miss it because they run on the newer runtime that `worker/node_modules`
// installs for @cloudflare/vitest-plugin. So the E2E harness deliberately uses
// the same (newer) wrangler the DO tests use; see e2e/README.md.
//
// CI: `npm run e2e` (builds web, installs chromium if missing, runs this
// config). No secrets and no network beyond 127.0.0.1: the spec aborts every
// off-origin request and fails the test if one is ever attempted.
import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_PORT = 8787;
const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Prefer the wrangler the DO-pool tests run on (worker's own node_modules,
 * workerd >= 1.20261012); fall back to the root pin only if it is gone, so the
 * suite still runs on a leaner checkout instead of failing to start.
 */
function resolveWranglerBin(): string {
  const candidates = [
    path.join(REPO_ROOT, "worker", "node_modules", ".bin", "wrangler"),
    path.join(REPO_ROOT, "node_modules", ".bin", "wrangler"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No wrangler binary found in ${REPO_ROOT}. Run "npm install" at the repo root first.`,
  );
}

export default defineConfig({
  testDir: ".",
  testMatch: ["m0-flow.spec.ts"],
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: E2E_ORIGIN,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        // Backup for the real microphone path only (OQ-10): the suite feeds
        // audio with ?injectAudio=1, so these never touch the audio graph.
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    command: [
      resolveWranglerBin(),
      "dev",
      "--port",
      String(E2E_PORT),
      "--var",
      "JOIN_TOKEN_HMAC_SECRET:fitra-e2e-test-only-secret",
      "--var",
      "TRANSLATION_PROVIDER:fake",
    ].join(" "),
    url: `${E2E_ORIGIN}/api/health`,
    cwd: REPO_ROOT,
    timeout: 120_000,
    // Never reuse: silently attaching to an already-listening server is how a
    // stale-runtime 8787 hides a green run. A busy port must fail loudly.
    reuseExistingServer: false,
  },
});