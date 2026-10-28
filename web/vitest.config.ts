export default {
  resolve: {
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
