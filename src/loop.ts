import { type CityHallClient, CityHallError } from "./cityhall.js"
import type { Executor } from "./claude.js"
import { runJob } from "./claude.js"
import type { Config } from "./config.js"
import { ContractError, type Job, type JobResult } from "./contract.js"
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
  /**
   * Jobs whose outcome was never delivered: city-hall took the lease back, or the post was
   * given up on. Not counted as done or failed.
   */
  jobsAbandoned: number
  /** Claims that failed in a row since the last one that got an answer (a Job or "nothing queued"). */
  consecutiveClaimFailures: number
  /** The most recent claim failure's message; null until one happens. */
  lastClaimError: string | null
}

export interface LoopDeps {
  config: Config
  client: CityHallClient
  log: Logger
  execute?: Executor
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** The shortest heartbeat interval honoured, in seconds. Default `HEARTBEAT_MIN_S`; tests lower it. */
  heartbeatMinSeconds?: number
  /** Called after an auth failure before claiming again; returns true when the credential works. */
  authOk?: () => Promise<boolean>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** How long to pause after a usage-limit result whose message named no reset time. */
export const LIMIT_PAUSE_MS = 60 * 60 * 1000
/** How long to pause after an auth failure before re-probing. */
export const AUTH_PAUSE_MS = 5 * 60 * 1000
/** Claim failures in a row after which `/readyz` reports the runner as not ready. */
export const CLAIM_FAILURES_UNREADY = 5
/** The longest an outcome post is retried, whatever the lease says (heartbeats keep extending it). */
export const OUTCOME_RETRY_MS = 10 * 60 * 1000
/** The longest an outcome post is retried once `stop()` has been called, to fit the deploy's stop grace period. */
export const OUTCOME_RETRY_STOPPING_MS = 30 * 1000
/** The longest wait between two outcome post attempts. */
export const OUTCOME_BACKOFF_MAX_MS = 30 * 1000

const MAX_RESET_CHARS = 100
/** A reset further out than this is taken as unreadable: the flat pause applies instead. */
const MAX_RESET_AHEAD_MS = 14 * 24 * 3_600_000
const CLOCK_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 }
const UNIT_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi

/** The heartbeat interval is city-hall's to name, but a bad value must not flood or starve it. */
export const HEARTBEAT_MIN_S = 1
export const HEARTBEAT_MAX_S = 300
export const heartbeatMs = (seconds: number, minSeconds = HEARTBEAT_MIN_S): number =>
  Math.min(Math.max(seconds, minSeconds), HEARTBEAT_MAX_S) * 1000

/**
 * The instant a usage-limit message says claiming may resume, or null when it names none this
 * can read. Reads a time of day ("3pm", "3:30 PM": the next such moment in the host's zone), a
 * relative span ("2 hours", "1 hour 30 minutes"), or anything `Date.parse` takes (an ISO instant).
 */
export function parseReset(resetsAt: string | undefined, now: number): number | null {
  // The text is model output; a long run of digits would make the span regex quadratic.
  const text = resetsAt?.trim().slice(0, MAX_RESET_CHARS)
  if (!text) return null
  let t = Number.NaN
  const clock = CLOCK_RE.exec(text)
  if (clock) {
    const hour = Number(clock[1])
    const minute = Number(clock[2] ?? 0)
    if (hour >= 1 && hour <= 12 && minute <= 59) {
      const d = new Date(now)
      d.setHours((hour % 12) + (clock[3]?.toLowerCase() === "pm" ? 12 : 0), minute, 0, 0)
      if (d.getTime() <= now) d.setDate(d.getDate() + 1)
      t = d.getTime()
    }
  } else {
    const spans = [...text.matchAll(UNIT_RE)]
    if (spans.length > 0 && spans.map((m) => m[0]).join(" ") === text.replace(/\s+/g, " ")) {
      let ms = 0
      for (const m of spans)
        ms += Number(m[1]) * (UNIT_MS[(m[2] ?? "").charAt(0).toLowerCase()] ?? 0)
      t = now + ms
    } else {
      t = Date.parse(text)
    }
  }
  return Number.isFinite(t) && t > now && t - now <= MAX_RESET_AHEAD_MS ? t : null
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
    consecutiveClaimFailures: 0,
    lastClaimError: null,
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

  /** Runs until `stop()`; resolves once the in-flight Job (if any) has reported its outcome or the post was given up on. */
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
          this.state.consecutiveClaimFailures = 0
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // A Job city-hall sent that does not validate was answered (cityhall.ts), so the queue
          // and the credential work; it is not a sign the runner cannot claim.
          if (!(err instanceof ContractError)) this.state.consecutiveClaimFailures += 1
          this.state.lastClaimError = message
          log("warn", "claim failed", { error: message })
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
    // The lease lasts `leaseMs` past the last heartbeat city-hall answered (inferred from the
    // claim: expiresAt minus now); the outcome post is retried only while it would be accepted.
    const claimed = Date.parse(job.lease.expiresAt) - this.now()
    // An unreadable or already-past expiry would disable retrying; assume the longest we retry.
    const leaseMs = Number.isFinite(claimed) && claimed > 0 ? claimed : OUTCOME_RETRY_MS
    let leaseUntil = this.now() + leaseMs
    // Heartbeats keep going until the outcome is delivered or given up; one still in flight when
    // that happens must not touch state.
    let beating = true
    const beat = setInterval(
      () => {
        client
          .heartbeat(job)
          .then((r) => {
            if (!beating) return
            this.state.lastHeartbeatAt = new Date(this.now()).toISOString()
            if (r === "ok") leaseUntil = this.now() + leaseMs
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
      },
      heartbeatMs(job.lease.heartbeatSeconds, this.deps.heartbeatMinSeconds),
    )

    try {
      const result = await runJob(job, config, this.deps.execute, lease.signal, log)

      if (!lease.signal.aborted) {
        log(result.kind === "success" ? "info" : "warn", "job finished", {
          jobId: job.id,
          kind: result.kind,
          durationMs: result.durationMs,
          costUsd: result.totalCostUsd ?? null,
        })
        const delivered = await this.deliver(job, result, lease.signal, () => leaseUntil)
        if (delivered === "gave_up") this.state.jobsAbandoned += 1
        else if (delivered === "substituted" || result.kind !== "success")
          this.state.jobsFailed += 1
        else this.state.jobsDone += 1
      } else {
        // Nothing is posted, and the Job counts as abandoned, neither done nor failed: a 409 means
        // city-hall has already taken the lease back (requeued the Job, or failed it after
        // `maxExpiredLeases` expiries), so this run's work is not its to report.
        this.state.jobsAbandoned += 1
        log("warn", "job abandoned: lease lost; CLI stopped, no outcome posted", {
          jobId: job.id,
          durationMs: result.durationMs,
        })
      }
      this.state.currentJobId = null
      this.pauseAfter(result)
    } finally {
      beating = false
      clearInterval(beat)
    }
  }

  /** Auth failures and usage limits pause claiming; everything else claims on. */
  private pauseAfter(result: JobResult): void {
    const { log } = this.deps
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

  /**
   * Posts the outcome, retrying with backoff while the lease is still good (heartbeats keep
   * running meanwhile) and for at most `OUTCOME_RETRY_MS`. A 4xx other than 409/408/429 will not
   * change on retry, so the first one is answered with a short `error` outcome in its place (a 413
   * on a huge result, for instance); a second ends the attempt. Returns "gave_up" when nothing was
   * delivered, so the caller does not count the Job as done.
   */
  private async deliver(
    job: Job,
    result: JobResult,
    leaseSignal: AbortSignal,
    leaseUntil: () => number,
  ): Promise<"ok" | "substituted" | "refused" | "gave_up"> {
    const { client, config, log } = this.deps
    const started = this.now()
    let body = result
    let substituted = false
    for (let attempt = 1; ; attempt += 1) {
      let status: number | null = null
      try {
        const r = await client.outcome(job, body)
        this.state.lastOutcomeAt = new Date(this.now()).toISOString()
        if (r === "lost") {
          log("warn", "outcome refused: lease lost; city-hall requeues", { jobId: job.id })
          return "refused"
        }
        return substituted ? "substituted" : "ok"
      } catch (err) {
        status = err instanceof CityHallError ? err.status : null
        log("warn", "outcome post failed", {
          jobId: job.id,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      const permanent =
        status !== null && status >= 400 && status < 500 && ![408, 429].includes(status)
      if (leaseSignal.aborted) return this.giveUp(job, "lease lost while posting")
      if (permanent) {
        if (substituted) return this.giveUp(job, `HTTP ${status} again on the substitute outcome`)
        substituted = true
        body = {
          kind: "error",
          detail: `the ${result.kind} outcome was refused with HTTP ${status}`,
          durationMs: result.durationMs,
        }
        continue
      }
      const now = this.now()
      const budget = this.stopped ? OUTCOME_RETRY_STOPPING_MS : OUTCOME_RETRY_MS
      if (now >= leaseUntil() || now - started >= budget) {
        return this.giveUp(job, "the lease ran out before the post got through")
      }
      await this.sleep(Math.min(config.pollIntervalMs * 2 ** (attempt - 1), OUTCOME_BACKOFF_MAX_MS))
    }
  }

  private giveUp(job: Job, why: string): "gave_up" {
    this.deps.log("error", "outcome not delivered; giving up", { jobId: job.id, why })
    return "gave_up"
  }
}
