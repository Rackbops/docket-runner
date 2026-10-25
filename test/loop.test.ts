import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { makeCityHallClient } from "../src/cityhall.js"
import { CLAIM_FAILURES_UNREADY, Loop, parseReset } from "../src/loop.js"
import { job, testConfig } from "./helpers.js"

interface Recorded {
  claims: number
  heartbeats: string[]
  outcomes: { id: string; body: unknown }[]
}

/** A fake city-hall: hands out the queued Jobs once each, records heartbeats and outcomes. */
function fakeCityHall(
  queue: unknown[],
  opts: {
    loseLease?: () => boolean
    /** A status to answer this claim with instead of handing out a Job (undefined: the normal path). */
    claimStatus?: (n: number) => number | undefined
    /** A status to answer this outcome post with instead of recording it (undefined: record it). */
    outcomeStatus?: (n: number) => number | undefined
  } = {},
) {
  const rec: Recorded = { claims: 0, heartbeats: [], outcomes: [] }
  let outcomeCalls = 0
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8")
    })
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer runner-token") {
        res.writeHead(401).end()
        return
      }
      const url = req.url ?? ""
      if (url === "/api/execute/claim") {
        rec.claims += 1
        const forced = opts.claimStatus?.(rec.claims)
        if (forced !== undefined) {
          res.writeHead(forced).end()
          return
        }
        const next = queue.shift()
        if (!next) {
          res.writeHead(204).end()
          return
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ job: next }))
        return
      }
      const m = /^\/api\/execute\/jobs\/([^/]+)\/(heartbeat|outcome)$/.exec(url)
      if (!m) {
        res.writeHead(404).end()
        return
      }
      if (m[2] === "heartbeat") {
        rec.heartbeats.push(decodeURIComponent(m[1] ?? ""))
        res.writeHead(opts.loseLease?.() ? 409 : 204).end()
        return
      }
      outcomeCalls += 1
      const refused = opts.outcomeStatus?.(outcomeCalls)
      if (refused !== undefined) {
        res.writeHead(refused).end()
        return
      }
      rec.outcomes.push({ id: decodeURIComponent(m[1] ?? ""), body: JSON.parse(body) })
      res.writeHead(204).end()
    })
  })
  return { server, rec }
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      resolve(typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "")
    })
  })
}

const logs: string[] = []
const log = (level: string, msg: string) => {
  logs.push(`${level} ${msg}`)
}
let servers: Server[] = []
afterEach(() => {
  for (const s of servers) s.close()
  servers = []
  delete process.env.FAKE_CLAUDE_MODE
  delete process.env.FAKE_CLAUDE_DELAY_MS
  delete process.env.FAKE_CLAUDE_PID_FILE
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function runLoopUntil(loop: Loop, done: () => boolean, ms = 4000): Promise<void> {
  const running = loop.run()
  const start = Date.now()
  while (!done() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10))
  loop.stop()
  await running
}

describe("the claim loop against a fake city-hall", () => {
  it("claims a Job, heartbeats while the CLI runs, posts the outcome, then idles", async () => {
    process.env.FAKE_CLAUDE_MODE = "slow"
    process.env.FAKE_CLAUDE_DELAY_MS = "300"
    const { server, rec } = fakeCityHall([job()])
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    const loop = new Loop({ config, client: makeCityHallClient(config), log })
    await runLoopUntil(loop, () => rec.outcomes.length === 1 && rec.claims >= 2)

    expect(rec.outcomes).toHaveLength(1)
    const posted = rec.outcomes[0]?.body as {
      leaseToken: string
      result: { kind: string; sessionId?: string }
    }
    expect(rec.outcomes[0]?.id).toBe("occ-1")
    expect(posted.leaseToken).toBe("lease-1")
    expect(posted.result.kind).toBe("success")
    expect(posted.result.sessionId).toBe("s-slow")
    expect(rec.heartbeats.length).toBeGreaterThanOrEqual(1)
    expect(loop.state.jobsDone).toBe(1)
    expect(loop.state.currentJobId).toBeNull()
    expect(loop.state.lastOutcomeAt).not.toBeNull()
  })

  it("kills the CLI as soon as the lease is lost, and posts nothing", async () => {
    process.env.FAKE_CLAUDE_MODE = "slow"
    process.env.FAKE_CLAUDE_DELAY_MS = "30000"
    const pidFile = join(mkdtempSync(join(tmpdir(), "runner-lease-")), "pid")
    process.env.FAKE_CLAUDE_PID_FILE = pidFile
    // 204 until the fake CLI has written its pid file, then 409: a busy machine can take longer
    // than the first 50 ms heartbeat to start the child, and the test needs the pid to check it.
    const { server, rec } = fakeCityHall([job()], { loseLease: () => existsSync(pidFile) })
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server), claudeTimeoutMs: 60_000 })
    const loop = new Loop({ config, client: makeCityHallClient(config), log })
    logs.length = 0
    const started = Date.now()
    await runLoopUntil(loop, () => logs.some((l) => l.includes("job abandoned")))
    const elapsed = Date.now() - started

    // A 30 s run that the first 409 cut short, well inside the loop's own budget.
    expect(logs.some((l) => l.includes("job abandoned"))).toBe(true)
    expect(elapsed).toBeLessThan(3000)
    expect(existsSync(pidFile)).toBe(true)
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false)
    expect(rec.heartbeats.length).toBeGreaterThanOrEqual(1)
    expect(rec.outcomes).toHaveLength(0)
    expect(logs.filter((l) => l.includes("lease lost during run"))).toHaveLength(1)
    expect(loop.state.currentJobId).toBeNull()
    expect(loop.state.jobsFailed).toBe(0)
    expect(loop.state.jobsDone).toBe(0)
    expect(loop.state.jobsAbandoned).toBe(1)
  })

  it("pauses claiming after an auth failure and reports it in state", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth401"
    const { server, rec } = fakeCityHall([job(), job({ id: "occ-2" })])
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    let probes = 0
    const loop = new Loop({
      config,
      client: makeCityHallClient(config),
      log,
      authOk: async () => {
        probes += 1
        return false
      },
    })
    await runLoopUntil(loop, () => rec.outcomes.length === 1, 2000)
    expect(rec.outcomes[0]?.body).toMatchObject({
      result: { kind: "auth_failed", apiErrorStatus: 401 },
    })
    expect(loop.state.pauseReason).toBe("auth")
    expect(loop.state.pausedUntil).not.toBeNull()
    expect(rec.claims).toBe(1)
    expect(probes).toBe(0)
  })

  it("pauses until the reset time after a usage limit", async () => {
    process.env.FAKE_CLAUDE_MODE = "limit"
    const { server, rec } = fakeCityHall([job()])
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    const now = Date.parse("2026-09-27T00:00:00Z")
    const loop = new Loop({ config, client: makeCityHallClient(config), log, now: () => now })
    await runLoopUntil(loop, () => rec.outcomes.length === 1, 2000)
    expect(loop.state.pauseReason).toBe("usage_limit")
    expect(loop.state.pausedUntil).toBe("2026-09-27T01:00:00.000Z")
    expect(rec.claims).toBe(1)
  })

  it("pauses until a time-of-day reset the message names", async () => {
    process.env.FAKE_CLAUDE_MODE = "limit_clock"
    const { server, rec } = fakeCityHall([job()])
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    const now = new Date(2026, 9, 25, 10, 0, 0).getTime()
    const loop = new Loop({ config, client: makeCityHallClient(config), log, now: () => now })
    await runLoopUntil(loop, () => rec.outcomes.length === 1, 2000)
    expect(loop.state.pausedUntil).toBe(new Date(2026, 9, 25, 15, 0, 0).toISOString())
  })
  it("keeps heartbeating and retrying the outcome past the old three attempts", async () => {
    // Six refusals: the old loop gave up after three and dropped the finished Job.
    const { server, rec } = fakeCityHall([job()], {
      outcomeStatus: (n) => (n <= 6 ? 503 : undefined),
    })
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    const loop = new Loop({ config, client: makeCityHallClient(config), log })
    await runLoopUntil(loop, () => rec.outcomes.length === 1)
    expect(rec.outcomes).toHaveLength(1)
    expect(rec.outcomes[0]?.body).toMatchObject({ result: { kind: "success" } })
    expect(loop.state.jobsDone).toBe(1)
    expect(loop.state.jobsAbandoned).toBe(0)
  })

  it("gives up once the lease has run out, logs it at error level and does not count the Job", async () => {
    const { server, rec } = fakeCityHall([job()], { outcomeStatus: () => 503 })
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    // A fake clock that jumps past the lease between attempts.
    let t = Date.now()
    const loop = new Loop({
      config,
      client: makeCityHallClient(config),
      log,
      now: () => t,
      sleep: async () => {
        t += 120_000
        await new Promise((r) => setTimeout(r, 1))
      },
    })
    logs.length = 0
    await runLoopUntil(loop, () => logs.some((l) => l.startsWith("error outcome not delivered")))
    expect(logs.some((l) => l.startsWith("error outcome not delivered"))).toBe(true)
    expect(rec.outcomes).toHaveLength(0)
    expect(loop.state.jobsDone).toBe(0)
    expect(loop.state.jobsAbandoned).toBe(1)
  })

  it("answers a 413 on the outcome with a short error outcome", async () => {
    const { server, rec } = fakeCityHall([job()], {
      outcomeStatus: (n) => (n === 1 ? 413 : undefined),
    })
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    const loop = new Loop({ config, client: makeCityHallClient(config), log })
    await runLoopUntil(loop, () => rec.outcomes.length === 1)
    expect(rec.outcomes).toHaveLength(1)
    const posted = rec.outcomes[0]?.body as { result: { kind: string; detail: string } }
    expect(posted.result.kind).toBe("error")
    expect(posted.result.detail).toContain("413")
  })

  it("answers a claimed Job that fails validation with an error outcome naming the field", async () => {
    const { server, rec } = fakeCityHall([job({ maxTurns: "8" })])
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    const loop = new Loop({ config, client: makeCityHallClient(config), log })
    await runLoopUntil(loop, () => rec.outcomes.length >= 1)
    expect(rec.outcomes[0]?.id).toBe("occ-1")
    const posted = rec.outcomes[0]?.body as {
      leaseToken: string
      result: { kind: string; detail: string }
    }
    expect(posted.leaseToken).toBe("lease-1")
    expect(posted.result.kind).toBe("error")
    expect(posted.result.detail).toContain("job.maxTurns")
  })

  it("goes unready after consecutive claim failures and recovers on one success", async () => {
    let failing = true
    const { server } = fakeCityHall([], { claimStatus: () => (failing ? 401 : undefined) })
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    const loop = new Loop({
      config,
      client: makeCityHallClient(config),
      log,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    })
    const running = loop.run()
    const until = async (done: () => boolean) => {
      const start = Date.now()
      while (!done() && Date.now() - start < 4000) await new Promise((r) => setTimeout(r, 5))
    }
    await until(() => loop.state.consecutiveClaimFailures >= CLAIM_FAILURES_UNREADY)
    expect(loop.state.consecutiveClaimFailures).toBeGreaterThanOrEqual(CLAIM_FAILURES_UNREADY)
    expect(loop.state.lastClaimError).toContain("HTTP 401")
    failing = false
    await until(() => loop.state.consecutiveClaimFailures === 0)
    loop.stop()
    await running
    expect(loop.state.consecutiveClaimFailures).toBe(0)
  })

  it("sleeps four poll intervals after a failed claim", async () => {
    const { server } = fakeCityHall([], { claimStatus: () => 500 })
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server), pollIntervalMs: 100 })
    const sleeps: number[] = []
    const loop = new Loop({
      config,
      client: makeCityHallClient(config),
      log,
      sleep: async (ms) => {
        sleeps.push(ms)
        await new Promise((r) => setTimeout(r, 1))
      },
    })
    await runLoopUntil(loop, () => sleeps.length >= 2)
    expect(sleeps.every((ms) => ms === 400)).toBe(true)
  })

  it("claims again after an auth pause once the probe passes", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth401"
    const { server, rec } = fakeCityHall([job(), job({ id: "occ-2" })])
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    let t = Date.now()
    let probes = 0
    const loop = new Loop({
      config,
      client: makeCityHallClient(config),
      log,
      now: () => t,
      sleep: async () => {
        t += 60_000
        await new Promise((r) => setTimeout(r, 1))
      },
      authOk: async () => {
        probes += 1
        return true
      },
    })
    await runLoopUntil(loop, () => rec.outcomes.length === 2)
    expect(probes).toBeGreaterThanOrEqual(1)
    expect(rec.outcomes).toHaveLength(2)
  })

  it("stays paused while the probe keeps failing", async () => {
    process.env.FAKE_CLAUDE_MODE = "auth401"
    const { server, rec } = fakeCityHall([job(), job({ id: "occ-2" })])
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    let t = Date.now()
    let probes = 0
    const loop = new Loop({
      config,
      client: makeCityHallClient(config),
      log,
      now: () => t,
      sleep: async () => {
        t += 60_000
        await new Promise((r) => setTimeout(r, 1))
      },
      authOk: async () => {
        probes += 1
        return false
      },
    })
    await runLoopUntil(loop, () => probes >= 2, 3000)
    expect(probes).toBeGreaterThanOrEqual(2)
    expect(rec.claims).toBe(1)
    expect(loop.state.pauseReason).toBe("auth")
  })
})

describe("parseReset", () => {
  const now = new Date(2026, 9, 25, 10, 0, 0).getTime()
  const at = (h: number, m = 0, dayOffset = 0) =>
    new Date(2026, 9, 25 + dayOffset, h, m, 0, 0).getTime()

  it("reads a time of day as the next such moment in the host zone", () => {
    expect(parseReset("3pm", now)).toBe(at(15))
    expect(parseReset("3:30 PM", now)).toBe(at(15, 30))
    expect(parseReset("9am", now)).toBe(at(9, 0, 1))
    expect(parseReset("12am", now)).toBe(at(0, 0, 1))
    expect(parseReset("12pm", now)).toBe(at(12))
  })

  it("reads a relative span", () => {
    expect(parseReset("2 hours", now)).toBe(now + 2 * 3_600_000)
    expect(parseReset("1 hour 30 minutes", now)).toBe(now + 5_400_000)
    expect(parseReset("45 minutes", now)).toBe(now + 45 * 60_000)
  })

  it("reads an ISO instant and refuses the past and the unreadable", () => {
    expect(parseReset("2026-10-26T00:00:00Z", now)).toBe(Date.parse("2026-10-26T00:00:00Z"))
    expect(parseReset("2020-01-01T00:00:00Z", now)).toBeNull()
    expect(parseReset("whenever", now)).toBeNull()
    expect(parseReset("13pm", now)).toBeNull()
    expect(parseReset(undefined, now)).toBeNull()
    expect(parseReset("3:75pm", now)).toBeNull()
    expect(parseReset("2 hours until later", now)).toBeNull()
  })

  it("refuses a span too far out for a Date, and bounds work on a long digit run", () => {
    expect(parseReset("99999999999 hours", now)).toBeNull()
    expect(parseReset("400 hours", now)).toBeNull()
    const started = Date.now()
    expect(parseReset(`${"1".repeat(100_000)}x`, now)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
