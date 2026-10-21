import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Redundant with the pnpm workspace link on purpose: keeps tsc/vite working
    // when node_modules is not installed. Do not "clean up" into an import.
    alias: {
      "@fitra/shared": new URL("../packages/shared/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  build: {
    outDir: "dist",
  },
});
