import { type Executor, realExecutor } from "./claude.js"
import type { Config } from "./config.js"
import { buildSubprocessEnv } from "./subprocess-env.js"

export interface AuthState {
  ok: boolean
  detail: string
  checkedAt: string | null
}

/** 6 h on success: every real probe is genuinely billed subscription usage. 5 min on failure: a restored token must show green soon. */
export const PROBE_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000
export const PROBE_FAILURE_TTL_MS = 5 * 60 * 1000
export const PROBE_TIMEOUT_MS = 10_000

/**
 * Proves the credential works with a real `claude -p "ok" --output-format json`, because
 * `claude auth status --json` reports a bogus token as logged in and `--bare` never reads the
 * OAuth token at all (research-triage#330's evidence). Cached, and concurrent callers share one
 * in-flight probe.
 */
export class AuthProbe {
  private cache: { state: AuthState; at: number } | null = null
  private inFlight: Promise<AuthState> | null = null

  constructor(
    private readonly config: Config,
    private readonly execute: Executor = realExecutor,
    private readonly now: () => number = Date.now,
  ) {}

  check(force = false): Promise<AuthState> {
    if (!force && this.cache) {
      const ttl = this.cache.state.ok ? PROBE_SUCCESS_TTL_MS : PROBE_FAILURE_TTL_MS
      if (this.now() - this.cache.at < ttl) return Promise.resolve(this.cache.state)
    }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.probe()
      .then((state) => {
        this.cache = { state, at: this.now() }
        return state
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  /** Test-only: forget the cached verdict. */
  reset(): void {
    this.cache = null
    this.inFlight = null
  }

  private async probe(): Promise<AuthState> {
    const checkedAt = new Date(this.now()).toISOString()
    try {
      const exec = await this.execute({
        bin: this.config.claudeBin,
        args: ["-p", "--output-format", "json", "--no-session-persistence"],
        stdin: "ok",
        timeoutMs: PROBE_TIMEOUT_MS,
        env: { ...buildSubprocessEnv(), CLAUDE_CODE_OAUTH_TOKEN: this.config.claudeCodeOauthToken },
      })
      if (exec.timedOut) return { ok: false, detail: "probe timed out", checkedAt }
      if (exec.exitCode === 0) return { ok: true, detail: "claude -p: authenticated", checkedAt }
      return {
        ok: false,
        detail: describeFailure(exec.exitCode, exec.stdout, exec.stderr),
        checkedAt,
      }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), checkedAt }
    }
  }
}

function describeFailure(exitCode: number, stdout: string, stderr: string): string {
  try {
    const env: unknown = JSON.parse(stdout)
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const obj = env as Record<string, unknown>
      const parts: string[] = []
      if (typeof obj.api_error_status === "number") parts.push(`API ${obj.api_error_status}`)
      if (typeof obj.result === "string" && obj.result) parts.push(obj.result)
      if (parts.length > 0) return parts.join(": ").slice(0, 300)
    }
  } catch {
    // not JSON: a spawn failure or a crash before the envelope
  }
  const detail = stderr.trim() || stdout.trim()
  return detail
    ? `claude -p exited ${exitCode}: ${detail.slice(0, 300)}`
    : `claude -p exited ${exitCode}`
}
