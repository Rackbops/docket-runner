import type { CityHallClient } from "./cityhall.js"
import type { Executor } from "./claude.js"
import { runJob } from "./claude.js"
import type { Config } from "./config.js"
import type { Job, JobResult } from "./contract.js"
import type { Logger } from "./log.js"

export type PauseReason = "auth" | "usage_limit"

export interface LoopState {
  running: boolean
  lastClaimAt: string | null
  lastHeartbeatAt: string | null
  lastOutcomeAt: string | null
  currentJobId: string | null
  pausedUntil: string | null
  pauseReason: PauseReason | null
  jobsDone: number
  jobsFailed: number
  /** Jobs stopped because city-hall took the lease back: nothing posted, not done or failed. */
  jobsAbandoned: number
}

export interface LoopDeps {
  config: Config
  client: CityHallClient
  log: Logger
  execute?: Executor
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Called after an auth failure before claiming again; returns true when the credential works. */
  authOk?: () => Promise<boolean>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** How long to pause after a usage-limit result whose message named no reset time. */
export const LIMIT_PAUSE_MS = 60 * 60 * 1000
/** How long to pause after an auth failure before re-probing. */
export const AUTH_PAUSE_MS = 5 * 60 * 1000

function parseReset(resetsAt: string | undefined, now: number): number | null {
  if (!resetsAt) return null
  const t = Date.parse(resetsAt)
  return Number.isFinite(t) && t > now ? t : null
}

/**
 * claim -> heartbeat while running -> outcome, forever, until stopped. A dead runner's lease
 * expires on city-hall's side and the Job is claimed again; this loop never retries a Job on its
 * own. Auth failures and usage limits pause claiming (the note's third outcome, 5.12); they
 * charge nobody, because the outcome says so and city-hall requeues.
 */
export class Loop {
  readonly state: LoopState = {
    running: false,
    lastClaimAt: null,
    lastHeartbeatAt: null,
    lastOutcomeAt: null,
    currentJobId: null,
    pausedUntil: null,
    pauseReason: null,
    jobsDone: 0,
    jobsFailed: 0,
    jobsAbandoned: 0,
  }
  private stopped = false
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly deps: LoopDeps) {
    this.sleep = deps.sleep ?? defaultSleep
    this.now = deps.now ?? Date.now
  }

  stop(): void {
    this.stopped = true
  }

  /** Runs until `stop()`; resolves once the in-flight Job (if any) has reported its outcome. */
  async run(): Promise<void> {
    const { config, client, log } = this.deps
    this.state.running = true
    try {
      while (!this.stopped) {
        if (this.state.pausedUntil) {
          const until = Date.parse(this.state.pausedUntil)
          if (this.now() < until) {
            await this.sleep(Math.min(until - this.now(), config.pollIntervalMs * 10))
            continue
          }
          if (
            this.state.pauseReason === "auth" &&
            this.deps.authOk &&
            !(await this.deps.authOk())
          ) {
            this.state.pausedUntil = new Date(this.now() + AUTH_PAUSE_MS).toISOString()
            log("warn", "credential still failing; staying paused", {
              until: this.state.pausedUntil,
            })
            continue
          }
          log("info", "pause over; claiming again", { reason: this.state.pauseReason })
          this.state.pausedUntil = null
          this.state.pauseReason = null
        }

        let job: Job | null
        try {
          job = await client.claim()
          this.state.lastClaimAt = new Date(this.now()).toISOString()
        } catch (err) {
          log("warn", "claim failed", { error: err instanceof Error ? err.message : String(err) })
          await this.sleep(config.pollIntervalMs * 4)
          continue
        }
        if (!job) {
          await this.sleep(config.pollIntervalMs)
          continue
        }
        await this.work(job)
      }
    } finally {
      this.state.running = false
    }
  }

  private async work(job: Job): Promise<void> {
    const { client, config, log } = this.deps
    this.state.currentJobId = job.id
    log("info", "job claimed", { jobId: job.id, resume: Boolean(job.resumeSessionId) })

    // A lost lease means city-hall will not accept this run's outcome, so the CLI is stopped
    // rather than left to spend subscription usage on a result nobody takes.
    const lease = new AbortController()
    // A heartbeat still in flight when the run ends must not touch state or abort a finished run.
    let running = true
    const beat = setInterval(() => {
      client
        .heartbeat(job)
        .then((r) => {
          if (!running) return
          this.state.lastHeartbeatAt = new Date(this.now()).toISOString()
          if (r === "lost" && !lease.signal.aborted) {
            log("warn", "lease lost during run; stopping the CLI", { jobId: job.id })
            lease.abort()
          }
        })
        .catch((err) =>
          log("warn", "heartbeat failed", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
    }, job.lease.heartbeatSeconds * 1000)

    let result: JobResult
    try {
      result = await runJob(job, config, this.deps.execute, lease.signal)
    } finally {
      running = false
      clearInterval(beat)
    }

    if (lease.signal.aborted) {
      // Nothing is posted, and the Job counts as abandoned, neither done nor failed: a 409 means
      // city-hall has already taken the lease back (requeued the Job, or failed it after
      // `maxExpiredLeases` expiries), so this run's work is not its to report.
      this.state.jobsAbandoned += 1
      this.state.currentJobId = null
      log("warn", "job abandoned: lease lost; CLI stopped, no outcome posted", {
        jobId: job.id,
        durationMs: result.durationMs,
      })
      return
    }

    if (result.kind === "success") this.state.jobsDone += 1
    else this.state.jobsFailed += 1
    log(result.kind === "success" ? "info" : "warn", "job finished", {
      jobId: job.id,
      kind: result.kind,
      durationMs: result.durationMs,
      costUsd: result.totalCostUsd ?? null,
    })

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const r = await client.outcome(job, result)
        this.state.lastOutcomeAt = new Date(this.now()).toISOString()
        if (r === "lost")
          log("warn", "outcome refused: lease lost; city-hall requeues", { jobId: job.id })
        break
      } catch (err) {
        log("warn", "outcome post failed", {
          jobId: job.id,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        })
        if (attempt < 3) await this.sleep(config.pollIntervalMs * attempt)
      }
    }
    this.state.currentJobId = null

    if (result.kind === "auth_failed") {
      this.state.pauseReason = "auth"
      this.state.pausedUntil = new Date(this.now() + AUTH_PAUSE_MS).toISOString()
      log("error", "credential rejected; pausing claims until the probe passes", {
        until: this.state.pausedUntil,
      })
    } else if (result.kind === "usage_limit") {
      const reset = parseReset(result.resetsAt, this.now())
      this.state.pauseReason = "usage_limit"
      this.state.pausedUntil = new Date(reset ?? this.now() + LIMIT_PAUSE_MS).toISOString()
      log("warn", "usage limit hit; pausing claims", {
        until: this.state.pausedUntil,
        resetsAt: result.resetsAt ?? null,
      })
    }
  }
}
