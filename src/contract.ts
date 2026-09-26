/**
 * The Job / JobResult wire shapes between city-hall's execute-lane API and this runner.
 *
 * Source of truth: these move into `@rackbops/docket-core` as the Executor port's types once that
 * package publishes them (Rackbops/docket#1 first); until then this file is the v0 contract and
 * city-hall#2 implements the same shape. The runner knows no task type -- a Job is a `claude -p`
 * call as data, a JobResult is what came back, classified. Plan: Rackbops/Tooling,
 * research/city-hall-task-tracker.md, sections 5.4 and 5.12.
 */

export interface Lease {
  /** Opaque token city-hall issued with the claim; every heartbeat and the outcome carry it. */
  token: string
  /** ISO-8601 instant the lease expires unless heartbeats extend it. */
  expiresAt: string
  /** How often the runner must heartbeat, in seconds. */
  heartbeatSeconds: number
}

export interface Job {
  /** The occurrence id: the idempotency key for the outcome. */
  id: string
  lease: Lease
  /** The whole prompt; sent on stdin, never argv. */
  prompt: string
  /** `--model`; the runner's default applies when absent. */
  model?: string
  /** `--json-schema`; when present the result must carry `structuredOutput`. */
  jsonSchema?: Record<string, unknown>
  /** `--allowedTools`; defaults to the read-and-web set. */
  allowedTools?: string[]
  /** `--disallowedTools`; defaults to the shell and file tools. */
  disallowedTools?: string[]
  /** `--max-turns`; the runner's default applies when absent. */
  maxTurns?: number
  /** `--max-budget-usd`; the runner's default applies when absent. */
  maxBudgetUsd?: number
  /** `--resume <session_id>`: continue a conversation (the intake dialogue, E10). */
  resumeSessionId?: string
  /** Per-Job wall-clock limit for the CLI call, in milliseconds; the runner's default when absent. */
  timeoutMs?: number
}

export type FailureKind =
  | "auth_failed"
  | "usage_limit"
  | "turn_cap"
  | "budget_cap"
  | "schema_miss"
  | "timeout"
  | "error"

export interface JobSuccess {
  kind: "success"
  /** The CLI's `result` text. */
  result: string
  /** The CLI's `structured_output` when the Job carried a JSON schema. */
  structuredOutput?: unknown
  sessionId?: string
  /** The CLI's client-side list-price estimate; a proxy under a subscription, not a bill (5.12). */
  totalCostUsd?: number
  usage?: unknown
  numTurns?: number
  durationMs: number
}

export interface JobFailure {
  kind: FailureKind
  /** Operator-readable, secret-free. */
  detail: string
  /** For `usage_limit`: when the window resets, if the CLI's message said. */
  resetsAt?: string
  /** The CLI's `api_error_status` when it reported one. */
  apiErrorStatus?: number
  sessionId?: string
  totalCostUsd?: number
  durationMs: number
}

export type JobResult = JobSuccess | JobFailure

export const DEFAULT_ALLOWED_TOOLS = ["WebSearch", "WebFetch"] as const
export const DEFAULT_DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task"] as const

export class ContractError extends Error {
  override name = "ContractError"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "string") throw new ContractError(`job.${key} must be a string`)
  return v
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ContractError(`job.${key} must be a non-negative number`)
  }
  return v
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ContractError(`job.${key} must be an array of strings`)
  }
  return v
}

/** Validates a claimed Job from the wire. Unknown keys are ignored; wrong types are refused. */
export function parseJob(value: unknown): Job {
  if (!isRecord(value)) throw new ContractError("job must be an object")
  const id = value.id
  if (typeof id !== "string" || id.length === 0)
    throw new ContractError("job.id must be a non-empty string")
  const prompt = value.prompt
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new ContractError("job.prompt must be a non-empty string")
  }
  const lease = value.lease
  if (!isRecord(lease)) throw new ContractError("job.lease must be an object")
  if (typeof lease.token !== "string" || lease.token.length === 0) {
    throw new ContractError("job.lease.token must be a non-empty string")
  }
  if (typeof lease.expiresAt !== "string")
    throw new ContractError("job.lease.expiresAt must be a string")
  if (typeof lease.heartbeatSeconds !== "number" || lease.heartbeatSeconds <= 0) {
    throw new ContractError("job.lease.heartbeatSeconds must be a positive number")
  }
  const jsonSchema = value.jsonSchema
  if (jsonSchema !== undefined && jsonSchema !== null && !isRecord(jsonSchema)) {
    throw new ContractError("job.jsonSchema must be an object")
  }

  const job: Job = {
    id,
    lease: {
      token: lease.token,
      expiresAt: lease.expiresAt,
      heartbeatSeconds: lease.heartbeatSeconds,
    },
    prompt,
  }
  const model = optionalString(value, "model")
  if (model !== undefined) job.model = model
  if (isRecord(jsonSchema)) job.jsonSchema = jsonSchema
  const allowed = optionalStringArray(value, "allowedTools")
  if (allowed !== undefined) job.allowedTools = allowed
  const disallowed = optionalStringArray(value, "disallowedTools")
  if (disallowed !== undefined) job.disallowedTools = disallowed
  const maxTurns = optionalNumber(value, "maxTurns")
  if (maxTurns !== undefined) job.maxTurns = maxTurns
  const maxBudgetUsd = optionalNumber(value, "maxBudgetUsd")
  if (maxBudgetUsd !== undefined) job.maxBudgetUsd = maxBudgetUsd
  const resume = optionalString(value, "resumeSessionId")
  if (resume !== undefined) job.resumeSessionId = resume
  const timeoutMs = optionalNumber(value, "timeoutMs")
  if (timeoutMs !== undefined) job.timeoutMs = timeoutMs
  return job
}
