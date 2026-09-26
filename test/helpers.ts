import { fileURLToPath } from "node:url"

import type { Config } from "../src/config.js"

export const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url))

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    claudeCodeOauthToken: "test-token",
    claudeBin: FAKE_CLAUDE,
    cityHallUrl: "http://127.0.0.1:1",
    cityHallRunnerToken: "runner-token",
    claudeTimeoutMs: 5_000,
    pollIntervalMs: 20,
    defaultMaxTurns: 8,
    defaultMaxBudgetUsd: 0.5,
    healthPort: 0,
    healthBind: "127.0.0.1",
    ...overrides,
  }
}

export function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "occ-1",
    lease: {
      token: "lease-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      heartbeatSeconds: 0.05,
    },
    prompt: "say ok",
    ...overrides,
  }
}
