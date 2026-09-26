import { defineConfig } from "vitest/config"

// deploy/render.test.mjs is a node:test file (the render script runs on the host with no build
// step); `pnpm test` runs it separately, so vitest must not pick it up.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
})
