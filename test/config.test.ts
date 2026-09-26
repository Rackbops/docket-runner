import { describe, expect, it } from "vitest"

import { ConfigError, loadConfig } from "../src/config.js"
import { buildSubprocessEnv } from "../src/subprocess-env.js"

const good = {
  CLAUDE_CODE_OAUTH_TOKEN: "t",
  CITY_HALL_URL: "https://tracker.example/",
  CITY_HALL_RUNNER_TOKEN: "r",
}

describe("loadConfig", () => {
  it("refuses every API-billing variable with exit code 2, even when blank", () => {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
      let caught: unknown
      try {
        loadConfig({ ...good, [key]: "" })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ConfigError)
      expect((caught as ConfigError).exitCode).toBe(2)
      expect((caught as ConfigError).message).toContain(key)
    }
  })

  it("names a missing credential with exit code 1", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...rest } = good
    expect(() => loadConfig(rest)).toThrow(/CLAUDE_CODE_OAUTH_TOKEN is required/)
    try {
      loadConfig(rest)
    } catch (err) {
      expect((err as ConfigError).exitCode).toBe(1)
    }
  })

  it("applies defaults and trims the city-hall URL", () => {
    const c = loadConfig(good)
    expect(c.cityHallUrl).toBe("https://tracker.example")
    expect(c.claudeTimeoutMs).toBe(120_000)
    expect(c.pollIntervalMs).toBe(1_500)
    expect(c.defaultMaxTurns).toBe(8)
    expect(c.defaultMaxBudgetUsd).toBe(0.5)
    expect(c.healthPort).toBe(8787)
    expect(c.cfAccessClientId).toBeUndefined()
  })

  it("wants the Access service token as a pair", () => {
    expect(() => loadConfig({ ...good, CF_ACCESS_CLIENT_ID: "id" })).toThrow(/must be set together/)
    const c = loadConfig({ ...good, CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "s" })
    expect(c.cfAccessClientSecret).toBe("s")
  })
})

describe("buildSubprocessEnv", () => {
  it("strips the three forbidden variables and keeps the rest", () => {
    const env = buildSubprocessEnv({
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "a",
      ANTHROPIC_BASE_URL: "u",
      PATH: "/bin",
      HOME: "/h",
    })
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" })
  })
})
