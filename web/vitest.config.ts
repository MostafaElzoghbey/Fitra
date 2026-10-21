// Vitest config for the pure web helpers (`web/tests/*.test.ts`).
//
// Plain object export, no `defineConfig` import: `vitest` is not a `web`
// devDependency yet (installs are out of scope for the audio tasks), so an
// import of `vitest/config` here would break config loading for anyone running
// the suite before that install lands. Until then, run it with a sibling
// workspace binary from `web/`:
//   ../packages/shared/node_modules/.bin/vitest run
export default {
  resolve: {
    // Mirrors vite.config.ts: the workspace link alone is not enough.
    alias: {
      "@fitra/shared": new URL("../packages/shared/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
};