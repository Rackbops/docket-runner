import type { Config } from "./config.js"
import { ContractError, type Job, type JobResult, parseJob } from "./contract.js"

/**
 * The execute-lane API the runner calls on city-hall, merged there by pull request
 * Lepid-Labs/city-hall#18 (https://github.com/Lepid-Labs/city-hall/pull/18, commit 90a06ec). Its
 * decision record (ADR 0002) is still proposed, pending Nazu's review on the proposal issue
 * Lepid-Labs/city-hall#17 (https://github.com/Lepid-Labs/city-hall/issues/17); if that review
 * changes the API, the runner follows:
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

  /** Best effort: tells city-hall why a leased Job it sent cannot be run. Never throws. */
  const rejectInvalid = async (raw: unknown, err: ContractError): Promise<void> => {
    if (typeof raw !== "object" || raw === null) return
    const { id, lease } = raw as { id?: unknown; lease?: { token?: unknown } | null }
    const token = lease?.token
    if (typeof id !== "string" || id === "" || typeof token !== "string" || token === "") return
    try {
      await post(`/api/execute/jobs/${encodeURIComponent(id)}/outcome`, {
        leaseToken: token,
        result: {
          kind: "error",
          detail: `invalid Job: ${err.message}`.slice(0, 500),
          durationMs: 0,
        },
      })
    } catch {
      // The lease expiring is the fallback, as before.
    }
  }

  return {
    async claim() {
      const res = await post("/api/execute/claim", {})
      if (res.status === 204) return null
      if (!res.ok) throw new CityHallError(`claim: HTTP ${res.status}`, res.status)
      const data: unknown = await res.json()
      const job =
        typeof data === "object" && data !== null ? (data as { job?: unknown }).job : undefined
      try {
        return parseJob(job)
      } catch (err) {
        // City-hall has already leased this Job to us. Without an answer it sits until the lease
        // expires, is leased again, fails the same way, and ends as a vague expiry failure.
        if (err instanceof ContractError) await rejectInvalid(job, err)
        throw err
      }
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
