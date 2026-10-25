import { FORBIDDEN_ENV } from "./subprocess-env.js"

/** A refused configuration. `exitCode` 2 for a forbidden variable, 1 for anything missing or malformed. */
export class ConfigError extends Error {
  override name = "ConfigError"
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message)
  }
}

/** The longest delay `setTimeout` honours; above it Node fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1

export interface Config {
  /** The subscription credential (a `claude setup-token` result); never logged. */
  claudeCodeOauthToken: string
  /** Path or name of the CLI binary; tests point it at a fake. */
  claudeBin: string
  /** The job queue's base URL: http://city-hall:8510 on its host, else its public hostname. */
  cityHallUrl: string
  /** This runner's token in the queue's CITY_HALL_RUNNERS; never logged. */
  cityHallRunnerToken: string
  /** Cloudflare Access service token for the queue's public hostname; both or neither. */
  cfAccessClientId?: string
  cfAccessClientSecret?: string
  claudeTimeoutMs: number
  pollIntervalMs: number
  defaultMaxTurns: number
  defaultMaxBudgetUsd: number
  defaultModel?: string
  /**
   * What a Job may ask for, at most. The runner holds the subscription, so a Job's own `timeoutMs`,
   * `maxTurns` and `maxBudgetUsd` are clamped to these, as its tools are to `TOOL_CEILING`.
   */
  maxTimeoutMs: number
  maxMaxTurns: number
  maxMaxBudgetUsd: number
  /**
   * Firecrawl's API key (a third-party key, not an Anthropic one), for research Jobs that name a
   * `mcp__firecrawl__` tool. Optional: without it those tools are dropped. Never logged or in argv.
   */
  firecrawlApiKey?: string
  healthPort: number
  healthBind: string
}

function intOr(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min)
    throw new ConfigError(`${key} must be a number >= ${min}, got ${raw}`, 1)
  return n
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]
  if (v === undefined || v.trim() === "") throw new ConfigError(`${key} is required`, 1)
  return v.trim()
}

/**
 * Reads the runner's configuration from the environment and refuses the two things that must
 * never happen: a forbidden API-billing variable (exit 2, before anything else is checked) and a
 * missing credential or endpoint (exit 1).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const key of FORBIDDEN_ENV) {
    if (env[key] !== undefined) {
      throw new ConfigError(
        `${key} is set; the runner runs on the Claude subscription only and refuses to start with it present`,
        2,
      )
    }
  }
  const cfId = env.CF_ACCESS_CLIENT_ID?.trim() ?? ""
  const cfSecret = env.CF_ACCESS_CLIENT_SECRET?.trim() ?? ""
  if ((cfId === "") !== (cfSecret === "")) {
    throw new ConfigError("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together", 1)
  }
  const cityHallUrl = required(env, "CITY_HALL_URL").replace(/\/+$/, "")
  if (!/^https?:\/\//.test(cityHallUrl))
    throw new ConfigError("CITY_HALL_URL must be an http(s) URL", 1)

  const config: Config = {
    claudeCodeOauthToken: required(env, "CLAUDE_CODE_OAUTH_TOKEN"),
    claudeBin: env.CLAUDE_BIN?.trim() || "claude",
    cityHallUrl,
    cityHallRunnerToken: required(env, "CITY_HALL_RUNNER_TOKEN"),
    claudeTimeoutMs: intOr(env, "CLAUDE_TIMEOUT_MS", 120_000),
    pollIntervalMs: intOr(env, "POLL_INTERVAL_MS", 1_500, 100),
    defaultMaxTurns: intOr(env, "DEFAULT_MAX_TURNS", 8),
    defaultMaxBudgetUsd: Number(env.DEFAULT_MAX_BUDGET_USD ?? "0.5"),
    maxTimeoutMs: intOr(env, "MAX_TIMEOUT_MS", 30 * 60_000),
    maxMaxTurns: intOr(env, "MAX_MAX_TURNS", 50),
    maxMaxBudgetUsd: Number(env.MAX_MAX_BUDGET_USD ?? "5"),
    healthPort: intOr(env, "HEALTH_PORT", 8787, 0),
    healthBind: env.HEALTH_BIND?.trim() || "0.0.0.0",
  }
  if (!Number.isFinite(config.defaultMaxBudgetUsd) || config.defaultMaxBudgetUsd <= 0) {
    throw new ConfigError("DEFAULT_MAX_BUDGET_USD must be a positive number", 1)
  }
  if (!Number.isFinite(config.maxMaxBudgetUsd) || config.maxMaxBudgetUsd <= 0) {
    throw new ConfigError("MAX_MAX_BUDGET_USD must be a positive number", 1)
  }
  // Node clamps a timer above 2^31-1 ms to 1 ms, which would kill every run at once.
  if (config.maxTimeoutMs > MAX_TIMER_MS) {
    throw new ConfigError(`MAX_TIMEOUT_MS must be at most ${MAX_TIMER_MS}`, 1)
  }
  for (const [name, def, max] of [
    ["MAX_TIMEOUT_MS", config.claudeTimeoutMs, config.maxTimeoutMs],
    ["MAX_MAX_TURNS", config.defaultMaxTurns, config.maxMaxTurns],
    ["MAX_MAX_BUDGET_USD", config.defaultMaxBudgetUsd, config.maxMaxBudgetUsd],
  ] as const) {
    if (max < def) throw new ConfigError(`${name} must be at least its default (${def})`, 1)
  }
  if (cfId !== "") {
    config.cfAccessClientId = cfId
    config.cfAccessClientSecret = cfSecret
  }
  const model = env.DEFAULT_MODEL?.trim()
  if (model) config.defaultModel = model
  const firecrawl = env.FIRECRAWL_API_KEY?.trim()
  if (firecrawl) config.firecrawlApiKey = firecrawl
  return config
}
