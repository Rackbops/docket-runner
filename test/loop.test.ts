import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"

import { makeCityHallClient } from "../src/cityhall.js"
import { Loop } from "../src/loop.js"
import { job, testConfig } from "./helpers.js"

interface Recorded {
  claims: number
  heartbeats: string[]
  outcomes: { id: string; body: unknown }[]
}

/** A fake city-hall: hands out the queued Jobs once each, records heartbeats and outcomes. */
function fakeCityHall(queue: unknown[], opts: { loseLease?: boolean } = {}) {
  const rec: Recorded = { claims: 0, heartbeats: [], outcomes: [] }
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
        res.writeHead(opts.loseLease ? 409 : 204).end()
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
})

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

  it("does not post an outcome once the lease was lost mid-run", async () => {
    process.env.FAKE_CLAUDE_MODE = "slow"
    process.env.FAKE_CLAUDE_DELAY_MS = "300"
    const { server, rec } = fakeCityHall([job()], { loseLease: true })
    servers.push(server)
    const config = testConfig({ cityHallUrl: await listen(server) })
    const loop = new Loop({ config, client: makeCityHallClient(config), log })
    await runLoopUntil(loop, () => rec.claims >= 3)
    expect(rec.heartbeats.length).toBeGreaterThanOrEqual(1)
    expect(rec.outcomes).toHaveLength(0)
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
})
