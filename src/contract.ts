/**
 * The Job / JobResult wire shapes between city-hall's execute-lane API and this runner.
 *
 * The shapes themselves are `@rackbops/docket-core`'s (`JobSpec`, `JobResult` and friends: the
 * Executor port's types, plan sections 5.4 and 5.12), imported as TYPES ONLY so the runner keeps
 * zero runtime dependencies -- `verbatimModuleSyntax` erases a type-only import, and the image's
 * final stage carries no node_modules. What is the runner's own: the `Lease` city-hall issues with
 * a claim, `Job` (a spec plus its id and lease), `parseJob` (the wire validation), and mirrors of
 * the two default tool lists, which a test pins to the core's values so they cannot drift. The
 * runner knows no task type -- a Job is a `claude -p` call as data, a JobResult is what came back,
 * classified.
 */

import type { FailureKind, JobFailure, JobResult, JobSpec, JobSuccess } from "@rackbops/docket-core"

export type { FailureKind, JobFailure, JobResult, JobSpec, JobSuccess }

export interface Lease {
  /** Opaque token city-hall issued with the claim; every heartbeat and the outcome carry it. */
  token: string
  /** ISO-8601 instant the lease expires unless heartbeats extend it. */
  expiresAt: string
  /** How often the runner must heartbeat, in seconds. */
  heartbeatSeconds: number
}

/** A claimed Job: the core's spec plus the occurrence id (the outcome's idempotency key) and the lease. */
export interface Job extends JobSpec {
  /** The occurrence id: the idempotency key for the outcome. */
  id: string
  lease: Lease
}

/**
 * Mirrors of `@rackbops/docket-core`'s DEFAULT_ALLOWED_TOOLS / DEFAULT_DISALLOWED_TOOLS (plan 5.6):
 * the read-and-web allowlist every run gets, and the shell and file tools no run may use. Values,
 * not types, so they are copied rather than imported; `test/contract.test.ts` asserts equality.
 */
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
