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

/**
 * What one CLI invocation came back with. Never rejects: a spawn failure is an exit of -1 with
 * the error in stderr.
 */
export interface Exec {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  /**
   * True when `signal` stopped the child (a lost lease); the output is then of no use to anyone.
   */
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
  /** How long a SIGTERM gets before SIGKILL follows. Default `KILL_GRACE_MS`; tests shorten it. */
  killGraceMs?: number
}

/** How long a child stopped by timeout or abort has to exit on SIGTERM before it gets SIGKILL. */
export const KILL_GRACE_MS = 5000

export type Executor = (opts: ExecOptions) => Promise<Exec>

/**
 * Spawns the CLI with the prompt on stdin (never argv: long prompts and Windows command-line
 * limits), captures both streams, kills on timeout or when `signal` aborts. Lifted from
 * research-triage's `runClaudeP`, with the stdin error handling that keeps an EPIPE from taking
 * the process down.
 */
export const realExecutor: Executor = ({
  bin,
  args,
  stdin,
  timeoutMs,
  env,
  signal,
  killGraceMs = KILL_GRACE_MS,
}) =>
  new Promise((resolve) => {
    const started = Date.now()
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    let aborted = false
    let killTimer: NodeJS.Timeout | undefined
    // SIGTERM first; a child that ignores it gets SIGKILL once the grace period is up. 'close'
    // follows either and settles the promise there, so the output so far is kept.
    const kill = () => {
      if (killTimer || settled) return
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL")
      }, killGraceMs)
    }
    const onAbort = () => {
      aborted = true
      kill()
    }
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener("abort", onAbort)
      const exec: Exec = { exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started }
      if (aborted) exec.aborted = true
      resolve(exec)
    }
    const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    const timer = setTimeout(() => {
      timedOut = true
      kill()
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

/**
 * The most tools any run may have (plan 5.6; tier-2 design pass E11, decision 3;
 * docket-runner#23). The runner holds it, not the Job: a Job may narrow it -- a subset, or a rule
 * such as `WebFetch(domain:example.com)` on a tool in it -- and never widen it, so a bug or a
 * stolen source key upstream cannot hand a run the shell beside the subscription token. Widening
 * it is a change to this file, reviewed like any other.
 */
export const TOOL_CEILING: readonly string[] = DEFAULT_ALLOWED_TOOLS

/** A Job named a tool outside `TOOL_CEILING`; the Job is refused before the CLI starts. */
export class ToolCeilingError extends Error {
  override name = "ToolCeilingError"
}

/** The tool an allow or deny entry names: `WebFetch(domain:x)` is `WebFetch`. */
export function toolName(entry: string): string {
  const open = entry.indexOf("(")
  return (open < 0 ? entry : entry.slice(0, open)).trim()
}

export interface ToolPlan {
  /** `--tools`: the only tools that exist in the run. Empty means none at all. */
  tools: string[]
  /** `--allowedTools`: the Job's own entries, each inside the ceiling. */
  allowed: string[]
  /** `--disallowedTools`: the default shell and file denials, plus whatever the Job adds. */
  disallowed: string[]
}

const unique = (xs: readonly string[]): string[] => [...new Set(xs)]

/**
 * What a Job may use, checked against `TOOL_CEILING`. Throws `ToolCeilingError` naming every
 * tool outside it. A Job with no `allowedTools` gets the ceiling's defaults; `disallowedTools`
 * always keeps the default denials, which a Job can add to but not remove. A tool the Job denies
 * outright (a bare name, not a rule) is left out of `tools` too.
 */
export function planTools(job: Pick<Job, "allowedTools" | "disallowedTools">): ToolPlan {
  const allowed = job.allowedTools ?? [...DEFAULT_ALLOWED_TOOLS]
  const outside = unique(allowed.map(toolName).filter((name) => !TOOL_CEILING.includes(name)))
  if (outside.length > 0) {
    const named = outside.map((n) => (n === "" ? '""' : n)).join(", ")
    throw new ToolCeilingError(
      `the Job asks for tools outside the runner's ceiling (${TOOL_CEILING.join(", ")}): ${named}`,
    )
  }
  const disallowed = unique([...DEFAULT_DISALLOWED_TOOLS, ...(job.disallowedTools ?? [])])
  const deniedOutright = new Set(disallowed.filter((e) => !e.includes("(")).map((e) => e.trim()))
  const tools = unique(allowed.map(toolName)).filter((name) => !deniedOutright.has(name))
  return { tools, allowed, disallowed }
}

/**
 * The CLI arguments for a Job. Pure, so the flag set is unit-tested without a process. Throws
 * `ToolCeilingError` for a Job outside the tool ceiling (`runJob` turns that into a failure).
 */
export function buildArgs(job: Job, config: Config): string[] {
  const plan = planTools(job)
  const args = ["-p", "--output-format", "json"]
  const model = job.model ?? config.defaultModel
  if (model) args.push("--model", model)
  args.push("--max-turns", String(job.maxTurns ?? config.defaultMaxTurns))
  args.push("--max-budget-usd", String(job.maxBudgetUsd ?? config.defaultMaxBudgetUsd))
  // --tools is what exists in the run at all: anything not named (Read, Glob, Bash, ...) is gone,
  // not merely unapproved. "" means no tools. --strict-mcp-config with no --mcp-config loads no
  // MCP server from any settings file the CLI might find.
  args.push("--tools", plan.tools.join(","))
  args.push("--strict-mcp-config")
  if (plan.allowed.length > 0) args.push("--allowedTools", plan.allowed.join(","))
  args.push("--disallowedTools", plan.disallowed.join(","))
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

/** How much of the CLI's stdout or stderr a failure detail quotes. */
export const EXCERPT_CHARS = 200
/**
 * Credential shapes scrubbed from a quoted excerpt: Anthropic keys and tokens, and a bearer
 * followed by a token-length run (16+ non-space characters), so prose like "bearer of bad news"
 * is left alone.
 */
const CREDENTIAL_RE = /sk-ant-[\w-]+|\bbearer\s+(?=\S{16,})\S+/gi

/**
 * A short, single-line quote of what the CLI wrote to stdout or stderr, so a failure detail says
 * what happened instead of "(no output)". The first `max` characters, then a `... (N chars)`
 * marker naming the full length; whitespace collapsed, non-printable and non-ASCII characters
 * replaced, credential shapes redacted. The detail goes to city-hall, never to the log, so the
 * no-prompt-above-debug rule is untouched.
 */
export function excerpt(s: string, max: number = EXCERPT_CHARS): string {
  const flat = s
    .replace(CREDENTIAL_RE, "[redacted]")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim()
  return flat.length > max ? `${flat.slice(0, max)}... (${flat.length} chars)` : flat
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
  // Only the unit test sees this branch: the loop discards an aborted result without posting it.
  if (exec.aborted) return base("error", "claude -p was stopped: the lease was lost")

  const stderr = excerpt(exec.stderr)
  const text = `${env?.result ?? ""}\n${stderr}`.trim()
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
      const quoted = excerpt(exec.stdout)
      const parts = [quoted && `stdout: ${quoted}`, stderr && `stderr: ${stderr}`]
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

/**
 * Runs one Job through the CLI and classifies the outcome. The only place the CLI is invoked for
 * work.
 */
export async function runJob(
  job: Job,
  config: Config,
  execute: Executor = realExecutor,
  signal?: AbortSignal,
): Promise<JobResult> {
  let args: string[]
  try {
    args = buildArgs(job, config)
  } catch (err) {
    if (!(err instanceof ToolCeilingError)) throw err
    return { kind: "error", detail: err.message.slice(0, 500), durationMs: 0 }
  }
  const exec = await execute({
    ...(signal ? { signal } : {}),
    bin: config.claudeBin,
    args,
    stdin: job.prompt,
    timeoutMs: job.timeoutMs ?? config.claudeTimeoutMs,
    env: { ...buildSubprocessEnv(), CLAUDE_CODE_OAUTH_TOKEN: config.claudeCodeOauthToken },
  })
  return classify(job, exec)
}
