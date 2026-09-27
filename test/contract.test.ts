import {
  DEFAULT_ALLOWED_TOOLS as CORE_ALLOWED,
  DEFAULT_DISALLOWED_TOOLS as CORE_DISALLOWED,
  type JobResult as CoreJobResult,
  type JobSpec,
} from "@rackbops/docket-core"
import { describe, expect, it } from "vitest"

import {
  ContractError,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_DISALLOWED_TOOLS,
  type Job,
  type JobResult,
  parseJob,
} from "../src/contract.js"

const wire = {
  id: "occ-1",
  lease: { token: "t", expiresAt: "2026-09-27T00:00:00.000Z", heartbeatSeconds: 30 },
  prompt: "look into it",
  model: "claude-sonnet-5",
  jsonSchema: { type: "object" },
  allowedTools: ["WebSearch"],
  maxTurns: 4,
  maxBudgetUsd: 0.5,
  resumeSessionId: "s1",
  timeoutMs: 60_000,
}

describe("the contract is docket-core's", () => {
  it("mirrors the core's default tool lists exactly", () => {
    expect([...DEFAULT_ALLOWED_TOOLS]).toEqual([...CORE_ALLOWED])
    expect([...DEFAULT_DISALLOWED_TOOLS]).toEqual([...CORE_DISALLOWED])
  })

  it("parses a wire Job into the core's JobSpec plus id and lease", () => {
    const job: Job = parseJob(wire)
    // Type-level: a Job is a JobSpec (the compile is the assertion), and a runner JobResult is
    // the core's JobResult.
    const spec: JobSpec = job
    const result: JobResult = { kind: "success", result: "ok", durationMs: 1 }
    const coreResult: CoreJobResult = result
    expect(spec.prompt).toBe("look into it")
    expect(job.lease.heartbeatSeconds).toBe(30)
    expect(coreResult.kind).toBe("success")
    expect(job).toEqual(wire)
  })

  it("keeps the wire validation the runner's own", () => {
    expect(() => parseJob({ ...wire, lease: undefined })).toThrow(ContractError)
    expect(() => parseJob({ ...wire, maxTurns: -1 })).toThrow(/non-negative/)
  })
})
