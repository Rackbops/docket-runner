import { createServer, type Server } from "node:http"

import type { LoopState } from "./loop.js"
import type { AuthProbe } from "./probe.js"

export interface HealthDeps {
  probe: AuthProbe
  state: LoopState
  version: string
  cliVersion: () => string | null
}

/**
 * `/healthz`: the process is up. `/readyz`: the credential works (real-call probe, cached) and the
 * loop is running -- 503 otherwise, with the reason in the body. Never touches a secret.
 */
export function startHealthServer(port: number, bind: string, deps: HealthDeps): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/"
    if (req.method !== "GET") {
      res.writeHead(405).end()
      return
    }
    if (url === "/healthz") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, version: deps.version }))
      return
    }
    if (url === "/readyz") {
      const auth = await deps.probe.check()
      const ok = auth.ok && deps.state.running
      const body = JSON.stringify({
        ok,
        version: deps.version,
        cli: deps.cliVersion(),
        auth,
        loop: deps.state,
      })
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(body)
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, bind, () => resolve(server))
  })
}
