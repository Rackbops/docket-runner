import { describe, expect, it } from "vitest"

import { ConfigError, loadConfig } from "../src/config.js"
import { makeLogger, redact } from "../src/log.js"
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

  it("sets ceilings above the defaults and refuses ones below them or beyond a timer", () => {
    const c = loadConfig(good)
    expect([c.maxTimeoutMs, c.maxMaxTurns, c.maxMaxBudgetUsd]).toEqual([1_800_000, 50, 5])
    expect(() => loadConfig({ ...good, MAX_MAX_TURNS: "4" })).toThrow(
      /MAX_MAX_TURNS must be at least/,
    )
    expect(() => loadConfig({ ...good, MAX_MAX_BUDGET_USD: "0.1" })).toThrow(/MAX_MAX_BUDGET_USD/)
    expect(() => loadConfig({ ...good, MAX_TIMEOUT_MS: "1000" })).toThrow(
      /MAX_TIMEOUT_MS must be at least/,
    )
    expect(() => loadConfig({ ...good, MAX_TIMEOUT_MS: "3000000000" })).toThrow(
      /at most 2147483647/,
    )
  })

  it("wants the Access service token as a pair", () => {
    expect(() => loadConfig({ ...good, CF_ACCESS_CLIENT_ID: "id" })).toThrow(/must be set together/)
    const c = loadConfig({ ...good, CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "s" })
    expect(c.cfAccessClientSecret).toBe("s")
  })
})

describe("FIRECRAWL_API_KEY", () => {
  it("is optional: absent or blank leaves it unset, and it is not a forbidden variable", () => {
    expect(loadConfig(good).firecrawlApiKey).toBeUndefined()
    expect(loadConfig({ ...good, FIRECRAWL_API_KEY: "  " }).firecrawlApiKey).toBeUndefined()
    expect(loadConfig({ ...good, FIRECRAWL_API_KEY: " fc-abc " }).firecrawlApiKey).toBe("fc-abc")
  })

  it("is redacted from a log line under either spelling", () => {
    expect(redact({ firecrawlApiKey: "fc-abc", FIRECRAWL_API_KEY: "fc-abc", jobId: "j" })).toEqual({
      firecrawlApiKey: "[redacted]",
      FIRECRAWL_API_KEY: "[redacted]",
      jobId: "j",
    })
    const lines: string[] = []
    makeLogger((l) => lines.push(l))("info", "config", {
      ...loadConfig({ ...good, FIRECRAWL_API_KEY: "fc-abc" }),
    })
    expect(lines.join("\n")).not.toContain("fc-abc")
  })
})

describe("buildSubprocessEnv", () => {
  it("keeps only the allowlisted names, so no forbidden variable gets through", () => {
    const env = buildSubprocessEnv({
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "a",
      ANTHROPIC_BASE_URL: "u",
      PATH: "/bin",
      HOME: "/h",
    })
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" })
  })

  it("drops the runner's own secrets, other routes off the subscription and unlisted names (#37)", () => {
    const env = buildSubprocessEnv({
      PATH: "/bin",
      LC_ALL: "C.UTF-8",
      NODE_ENV: "production",
      TZ: "America/New_York",
      HTTPS_PROXY: "http://proxy:3128",
      CITY_HALL_RUNNER_TOKEN: "runner-secret",
      CF_ACCESS_CLIENT_ID: "id",
      CF_ACCESS_CLIENT_SECRET: "cf-secret",
      FIRECRAWL_API_KEY: "fc-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_CUSTOM_HEADERS: "x: y",
      ANTHROPIC_BEDROCK_BASE_URL: "https://b",
      ANTHROPIC_VERTEX_BASE_URL: "https://v",
      SOME_UNLISTED_VAR: "x",
    })
    expect(env).toEqual({
      PATH: "/bin",
      LC_ALL: "C.UTF-8",
      NODE_ENV: "production",
      TZ: "America/New_York",
      HTTPS_PROXY: "http://proxy:3128",
    })
  })
})
