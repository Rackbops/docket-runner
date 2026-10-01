import type { Config } from "./config.js"
import { type Job, type JobResult, parseJob } from "./contract.js"

/**
 * The execute-lane API the runner expects from city-hall, as proposed in Lepid-Labs/city-hall#17
 * (not yet agreed; the runner follows whatever city-hall settles on):
 *
 *   POST /api/execute/claim                        -> 200 { job: Job } | 204 (nothing queued)
 *   POST /api/execute/jobs/:id/heartbeat { leaseToken } -> 204 | 409 (lease lost)
 *   POST /api/execute/jobs/:id/outcome { leaseToken, result: JobResult } -> 204 | 409 (lease lost)
 *
 * Every request carries the runner's usr-issued credential as a bearer token and, when
 * configured, the Cloudflare Access service-token pair for city-hall's hostname. Outbound only:
 * nothing on roshne's host listens for city-hall.
 */
export class CityHallError extends Error {
  override name = "CityHallError"
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export interface CityHallClient {
  claim(): Promise<Job | null>
  heartbeat(job: Job): Promise<"ok" | "lost">
  outcome(job: Job, result: JobResult): Promise<"ok" | "lost">
}

export function makeCityHallClient(
  config: Config,
  fetchImpl: typeof fetch = fetch,
  version = "dev",
): CityHallClient {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.cityHallRunnerToken}`,
    "content-type": "application/json",
    "user-agent": `docket-runner/${version}`,
  }
  if (config.cfAccessClientId && config.cfAccessClientSecret) {
    headers["cf-access-client-id"] = config.cfAccessClientId
    headers["cf-access-client-secret"] = config.cfAccessClientSecret
  }
  const post = (path: string, body: unknown) =>
    fetchImpl(`${config.cityHallUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

  return {
    async claim() {
      const res = await post("/api/execute/claim", {})
      if (res.status === 204) return null
      if (!res.ok) throw new CityHallError(`claim: HTTP ${res.status}`, res.status)
      const data: unknown = await res.json()
      const job =
        typeof data === "object" && data !== null ? (data as { job?: unknown }).job : undefined
      return parseJob(job)
    },
    async heartbeat(job) {
      const res = await post(`/api/execute/jobs/${encodeURIComponent(job.id)}/heartbeat`, {
        leaseToken: job.lease.token,
      })
      if (res.status === 409) return "lost"
      if (!res.ok) throw new CityHallError(`heartbeat: HTTP ${res.status}`, res.status)
      return "ok"
    },
    async outcome(job, result) {
      const res = await post(`/api/execute/jobs/${encodeURIComponent(job.id)}/outcome`, {
        leaseToken: job.lease.token,
        result,
      })
      if (res.status === 409) return "lost"
      if (!res.ok) throw new CityHallError(`outcome: HTTP ${res.status}`, res.status)
      return "ok"
    },
  }
}
