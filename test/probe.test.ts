import { describe, expect, it } from "vitest"

import type { Exec, ExecOptions } from "../src/claude.js"
import { AuthProbe, PROBE_FAILURE_TTL_MS, PROBE_SUCCESS_TTL_MS } from "../src/probe.js"
import { testConfig } from "./helpers.js"

function fakeExec(results: Partial<Exec>[]) {
  const calls: ExecOptions[] = []
  const execute = async (opts: ExecOptions): Promise<Exec> => {
    calls.push(opts)
    const next = results.shift() ?? {}
    return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false, durationMs: 1, ...next }
  }
  return { execute, calls }
}

describe("AuthProbe", () => {
  it("probes with a real print-mode call, stripped of API-billing variables, and caches a success for six hours", async () => {
    let now = 1_000_000
    const { execute, calls } = fakeExec([{ exitCode: 0 }])
    const probe = new AuthProbe(testConfig(), execute, () => now)
    const first = await probe.check()
    expect(first.ok).toBe(true)
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-p", "--output-format", "json"])
    expect(calls[0]?.stdin).toBe("ok")
    expect(calls[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-token")
    expect(calls[0]?.env.ANTHROPIC_API_KEY).toBeUndefined()
    now += PROBE_SUCCESS_TTL_MS - 1
    await probe.check()
    expect(calls).toHaveLength(1)
    now += 2
    await probe.check()
    expect(calls).toHaveLength(2)
  })

  it("reports a 401 with its reason and re-probes after five minutes", async () => {
    let now = 5_000_000
    const { execute, calls } = fakeExec([
      {
        exitCode: 1,
        stdout: JSON.stringify({
          is_error: true,
          api_error_status: 401,
          result: "OAuth access token is invalid.",
        }),
      },
      { exitCode: 0 },
    ])
    const probe = new AuthProbe(testConfig(), execute, () => now)
    const bad = await probe.check()
    expect(bad.ok).toBe(false)
    expect(bad.detail).toBe("API 401: OAuth access token is invalid.")
    now += PROBE_FAILURE_TTL_MS + 1
    const good = await probe.check()
    expect(good.ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it("coalesces concurrent callers into one probe", async () => {
    const { execute, calls } = fakeExec([{ exitCode: 0 }])
    const probe = new AuthProbe(testConfig(), execute)
    await Promise.all([probe.check(), probe.check(), probe.check()])
    expect(calls).toHaveLength(1)
  })
})
