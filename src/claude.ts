import { spawn } from "node:child_process"

import type { Config } from "./config.js"
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_DISALLOWED_TOOLS,
  type Job,
  type JobFailure,
  type JobResult,
} from "./contract.js"
import { buildSubprocessEnv } from "./subprocess-env.js"

/** What one CLI invocation came back with. Never rejects: a spawn failure is an exit of -1 with the error in stderr. */
export interface Exec {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  /** True when `signal` stopped the child (a lost lease); the output is then of no use to anyone. */
  aborted?: boolean
  durationMs: number
}

export interface ExecOptions {
  bin: string
  args: string[]
  stdin: string
  timeoutMs: number
  env: NodeJS.ProcessEnv
  /** Aborting kills the child. The loop aborts when city-hall says the lease is gone. */
  signal?: AbortSignal
}

export type Executor = (opts: ExecOptions) => Promise<Exec>

/**
 * Spawns the CLI with the prompt on stdin (never argv: long prompts and Windows command-line
 * limits), captures both streams, kills on timeout or when `signal` aborts. Lifted from
 * research-triage's `runClaudeP`, with the stdin error handling that keeps an EPIPE from taking
 * the process down.
 */
export const realExecutor: Executor = ({ bin, args, stdin, timeoutMs, env, signal }) =>
  new Promise((resolve) => {
    const started = Date.now()
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    let aborted = false
    const onAbort = () => {
      aborted = true
      child.kill()
      // As with the timeout, 'close' follows the kill and settles the promise.
    }
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      const exec: Exec = { exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started }
      if (aborted) exec.aborted = true
      resolve(exec)
    }
    const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      // The 'close' event follows the kill; finish there so stdout so far is kept.
    }, timeoutMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}spawn ${bin}: ${err.message}`
      finish(-1)
    })
    child.on("close", (code) => finish(code ?? -1))
    child.stdin.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}stdin: ${err.message}`
      child.kill()
    })
    child.stdin.write(stdin, "utf8")
    child.stdin.end()
  })

/** The CLI arguments for a Job. Pure, so the flag set is unit-tested without a process. */
export function buildArgs(job: Job, config: Config): string[] {
  const args = ["-p", "--output-format", "json"]
  const model = job.model ?? config.defaultModel
  if (model) args.push("--model", model)
  args.push("--max-turns", String(job.maxTurns ?? config.defaultMaxTurns))
  args.push("--max-budget-usd", String(job.maxBudgetUsd ?? config.defaultMaxBudgetUsd))
  const allowed = job.allowedTools ?? [...DEFAULT_ALLOWED_TOOLS]
  const disallowed = job.disallowedTools ?? [...DEFAULT_DISALLOWED_TOOLS]
  if (allowed.length > 0) args.push("--allowedTools", allowed.join(","))
  if (disallowed.length > 0) args.push("--disallowedTools", disallowed.join(","))
  if (job.jsonSchema) args.push("--json-schema", JSON.stringify(job.jsonSchema))
  if (job.resumeSessionId) args.push("--resume", job.resumeSessionId)
  else args.push("--no-session-persistence")
  return args
}

interface Envelope {
  result?: string
  structured_output?: unknown
  session_id?: string
  total_cost_usd?: number
  usage?: unknown
  num_turns?: number
  is_error?: boolean
  subtype?: string
  api_error_status?: number
  errors?: unknown[]
}

function parseEnvelope(stdout: string): Envelope | null {
  try {
    const v: unknown = JSON.parse(stdout)
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Envelope) : null
  } catch {
    return null
  }
}

const LIMIT_RE = /hit your (session|weekly|\w+) limit/i
const AUTH_RE = /not logged in|oauth|authenticat|invalid api key|api error: 401/i
const RESET_RE = /resets? (?:at|in) ([^.]+)/i

/** How much of a non-JSON stdout a failure detail quotes. */
export const STDOUT_EXCERPT_CHARS = 200
/** Credential shapes scrubbed from a quoted excerpt: Anthropic keys and tokens, bearer headers. */
const CREDENTIAL_RE = /sk-ant-[\w-]+|bearer\s+[\w.~+/=-]+/gi

/**
 * A short, single-line quote of what the CLI wrote to stdout when it was not a JSON envelope, so a
 * failure detail says what happened instead of "(no output)". Bounded, whitespace collapsed,
 * non-printable and non-ASCII characters replaced, credential shapes redacted. The detail goes to
 * city-hall, never to the log, so the no-prompt-above-debug rule is untouched.
 */
export function stdoutExcerpt(stdout: string): string {
  const flat = stdout
    .replace(CREDENTIAL_RE, "[redacted]")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim()
  return flat.length > STDOUT_EXCERPT_CHARS
    ? `${flat.slice(0, STDOUT_EXCERPT_CHARS)}... (${flat.length} chars)`
    : flat
}

/**
 * Turns a finished CLI call into a JobResult. Exit code and `is_error` are both read; neither is
 * trusted alone (the CLI exits 1 for every `is_error` envelope, including the diagnostic ones).
 */
export function classify(job: Job, exec: Exec): JobResult {
  const env = parseEnvelope(exec.stdout)
  const base = (kind: JobFailure["kind"], detail: string): JobFailure => {
    const f: JobFailure = { kind, detail: detail.slice(0, 500), durationMs: exec.durationMs }
    if (env?.session_id) f.sessionId = env.session_id
    if (typeof env?.total_cost_usd === "number") f.totalCostUsd = env.total_cost_usd
    if (typeof env?.api_error_status === "number") f.apiErrorStatus = env.api_error_status
    return f
  }
  if (exec.timedOut)
    return base("timeout", `claude -p exceeded ${job.timeoutMs ?? "the default"} ms and was killed`)
  if (exec.aborted) return base("error", "claude -p was stopped: the lease was lost")

  const text = `${env?.result ?? ""}\n${exec.stderr}`.trim()
  const failed = exec.exitCode !== 0 || env?.is_error === true || env === null
  if (failed) {
    if (env?.api_error_status === 401 || AUTH_RE.test(text))
      return base("auth_failed", text || "authentication failed")
    if (LIMIT_RE.test(text)) {
      const f = base("usage_limit", text)
      const m = RESET_RE.exec(text)
      if (m?.[1]) f.resetsAt = m[1].trim()
      return f
    }
    if (env?.subtype === "error_max_turns" || /max[_ ]turns/i.test(text))
      return base("turn_cap", text || "turn cap reached")
    if (/budget limit/i.test(text)) return base("budget_cap", text)
    if (env === null) {
      const quoted = stdoutExcerpt(exec.stdout)
      const parts = [
        quoted && `stdout: ${quoted}`,
        exec.stderr.trim() && `stderr: ${exec.stderr.trim()}`,
      ]
      const said = parts.filter(Boolean).join("; ")
      return base(
        "error",
        `claude -p exited ${exec.exitCode} without a JSON envelope: ${said || "(no output)"}`,
      )
    }
    return base("error", text || `claude -p exited ${exec.exitCode}`)
  }

  const result = typeof env.result === "string" ? env.result : ""
  let structured: unknown = env.structured_output
  if (job.jsonSchema && structured === undefined) {
    try {
      structured = JSON.parse(result)
    } catch {
      return base(
        "schema_miss",
        "the Job carried a JSON schema but the CLI returned no structured output",
      )
    }
  }
  const ok: JobResult = { kind: "success", result, durationMs: exec.durationMs }
  if (structured !== undefined) ok.structuredOutput = structured
  if (env.session_id) ok.sessionId = env.session_id
  if (typeof env.total_cost_usd === "number") ok.totalCostUsd = env.total_cost_usd
  if (env.usage !== undefined) ok.usage = env.usage
  if (typeof env.num_turns === "number") ok.numTurns = env.num_turns
  return ok
}

/** Runs one Job through the CLI and classifies the outcome. The only place the CLI is invoked for work. */
export async function runJob(
  job: Job,
  config: Config,
  execute: Executor = realExecutor,
  signal?: AbortSignal,
): Promise<JobResult> {
  const exec = await execute({
    ...(signal ? { signal } : {}),
    bin: config.claudeBin,
    args: buildArgs(job, config),
    stdin: job.prompt,
    timeoutMs: job.timeoutMs ?? config.claudeTimeoutMs,
    env: { ...buildSubprocessEnv(), CLAUDE_CODE_OAUTH_TOKEN: config.claudeCodeOauthToken },
  })
  return classify(job, exec)
}
