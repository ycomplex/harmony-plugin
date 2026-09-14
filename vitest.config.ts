import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // B-1007: `main` is source-only, so a fresh clone / CI checkout has no `dist/` on disk — and
    // several tests shell out to the real dist/bin/harmony.js. This builds it ONCE before the
    // parallel workers spawn (a beforeAll cannot: files run in separate workers), and is a no-op
    // when the bundle is already there. See src/vitest-global-setup.ts.
    globalSetup: ["./src/vitest-global-setup.ts"],
  },
});
