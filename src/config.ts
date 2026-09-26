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

export interface Config {
  /** The subscription credential (a `claude setup-token` result); never logged. */
  claudeCodeOauthToken: string
  /** Path or name of the CLI binary; tests point it at a fake. */
  claudeBin: string
  /** city-hall's base URL, reached through the edge. */
  cityHallUrl: string
  /** The usr-issued runner credential city-hall verifies (shape per city-hall#9); never logged. */
  cityHallRunnerToken: string
  /** Cloudflare Access service token for the tracker hostname; both or neither. */
  cfAccessClientId?: string
  cfAccessClientSecret?: string
  claudeTimeoutMs: number
  pollIntervalMs: number
  defaultMaxTurns: number
  defaultMaxBudgetUsd: number
  defaultModel?: string
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
    healthPort: intOr(env, "HEALTH_PORT", 8787, 0),
    healthBind: env.HEALTH_BIND?.trim() || "0.0.0.0",
  }
  if (!Number.isFinite(config.defaultMaxBudgetUsd) || config.defaultMaxBudgetUsd <= 0) {
    throw new ConfigError("DEFAULT_MAX_BUDGET_USD must be a positive number", 1)
  }
  if (cfId !== "") {
    config.cfAccessClientId = cfId
    config.cfAccessClientSecret = cfSecret
  }
  const model = env.DEFAULT_MODEL?.trim()
  if (model) config.defaultModel = model
  return config
}
