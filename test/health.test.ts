import type { Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"

import type { Exec, ExecOptions } from "../src/claude.js"
import { startHealthServer } from "../src/health.js"
import { CLAIM_FAILURES_UNREADY, type LoopState } from "../src/loop.js"
import { AuthProbe } from "../src/probe.js"
import { testConfig } from "./helpers.js"

let server: Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

function state(running: boolean, consecutiveClaimFailures = 0): LoopState {
  return {
    running,
    lastClaimAt: null,
    lastHeartbeatAt: null,
    lastOutcomeAt: null,
    currentJobId: null,
    pausedUntil: null,
    pauseReason: null,
    jobsDone: 0,
    jobsFailed: 0,
    jobsAbandoned: 0,
    consecutiveClaimFailures,
    lastClaimError: null,
  }
}

async function start(exitCode: number, running: boolean, claimFailures = 0) {
  const execute = async (_o: ExecOptions): Promise<Exec> => ({
    exitCode,
    stdout:
      exitCode === 0
        ? "{}"
        : JSON.stringify({ is_error: true, api_error_status: 401, result: "bad token" }),
    stderr: "",
    timedOut: false,
    durationMs: 1,
  })
  server = await startHealthServer(0, "127.0.0.1", {
    probe: new AuthProbe(testConfig(), execute),
    state: state(running, claimFailures),
    version: "0.0.0-test",
    cliVersion: () => "9.9.9 (fake)",
  })
  const addr = server.address()
  return typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : ""
}

describe("health endpoints", () => {
  it("/healthz is up whatever the credential says", async () => {
    const base = await start(1, true)
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: "0.0.0-test" })
  })

  it("/readyz is 200 with a working credential and a running loop", async () => {
    const base = await start(0, true)
    const res = await fetch(`${base}/readyz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; auth: { ok: boolean }; cli: string }
    expect(body.ok).toBe(true)
    expect(body.auth.ok).toBe(true)
    expect(body.cli).toBe("9.9.9 (fake)")
  })

  it("/readyz is 503 and names the reason on a bad token", async () => {
    const base = await start(1, true)
    const res = await fetch(`${base}/readyz`)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; auth: { detail: string } }
    expect(body.ok).toBe(false)
    expect(body.auth.detail).toBe("API 401: bad token")
  })

  it("/readyz is 503 when the loop is not running", async () => {
    const base = await start(0, false)
    expect((await fetch(`${base}/readyz`)).status).toBe(503)
  })

  it("/readyz is 503 once claims have failed N in a row, 200 one short of that", async () => {
    const down = await start(0, true, CLAIM_FAILURES_UNREADY)
    const res = await fetch(`${down}/readyz`)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false)
    server?.close()
    const up = await start(0, true, CLAIM_FAILURES_UNREADY - 1)
    expect((await fetch(`${up}/readyz`)).status).toBe(200)
  })
})
