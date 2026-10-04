// The tracker's side of the end-to-end check (test/e2e/run.sh). Runs under Bun, as the tracker
// plugin does, and drives the tracker's real Executor from a rackbops-bot-plugins checkout
// (plugins/tracker/src/executor.ts) with the real research type's Job (docket-types
// `researchJob`), against a local Rackbops/job-queue, which serves the API that executor and this runner speak.
// Nothing here is imported from the runner's src/.
//
//   bun test/e2e/drive-tracker.ts <scenario> --expect pending|unavailable|result [options]
//
//   --kind K        with result: the JobResult's kind must be K
//   --answer        with result success: docket-types' parseAnswer must accept structuredOutput,
//                   with at least one finding
//   --detail S      with pending or unavailable: an answer of that kind must say S
//   --hold-ms N     with pending: every answer for N ms must be pending (N <= --timeout-ms)
//   --timeout-ms N  give up after N ms (default 20000)
//   --key K         the source key to submit with (default $E2E_CITY_HALL_KEY)
//   --id-file F     write the queue's job id to F once the tracker has one on record
//
// Env: BOT_PLUGINS_DIR, E2E_CITY_HALL_URL, E2E_CITY_HALL_KEY, E2E_CAPABILITY.
// Prints one JSON line per new answer and a last {"final": ...} line; exits 0 when the
// expectation holds, 1 (with "FAIL: why" on stderr) when it does not.
import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const env = (k: string): string => {
  const v = process.env[k]
  if (v === undefined || v === "") {
    console.error(`FAIL: ${k} is not set`)
    process.exit(1)
  }
  return v
}

const args = process.argv.slice(2)
const scenario = args[0] ?? "run"
const opt = (k: string): string | undefined => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : undefined
}
const expectKind = opt("--expect") ?? "result"
const resultKind = opt("--kind")
const detail = opt("--detail")
const holdMs = Number(opt("--hold-ms") ?? "0")
const timeoutMs = Number(opt("--timeout-ms") ?? "20000")
const idFile = opt("--id-file")
const wantAnswer = args.includes("--answer")
const url = env("E2E_CITY_HALL_URL")
const key = opt("--key") ?? env("E2E_CITY_HALL_KEY")
const capability = env("E2E_CAPABILITY")
// The loop stops at the timeout, so a hold longer than it would pass without holding at all.
if (holdMs > 0 && timeoutMs < holdMs) {
  console.error(`FAIL: --timeout-ms ${timeoutMs} is shorter than --hold-ms ${holdMs}`)
  process.exit(1)
}

// docket-core and docket-types come from the plugins checkout, the copies the executor itself
// imports: an error class from a second copy would fail every instanceof below.
const trackerDir = join(env("BOT_PLUGINS_DIR"), "plugins", "tracker")
const core = await import(Bun.resolveSync("@rackbops/docket-core", trackerDir))
const types = await import(Bun.resolveSync("@rackbops/docket-types", trackerDir))
const tracker = await import(join(trackerDir, "src", "executor.ts"))

// The real config parser refuses an http:// origin (executor.ts, parseCityHallConfig), and the
// local queue is http, so the config is built here; the parser's verdict is printed only.
let parser: string
try {
  const s = tracker.parseCityHallConfig({
    TRACKER_CITY_HALL_URL: url,
    TRACKER_CITY_HALL_KEY: key,
    TRACKER_CITY_HALL_CAPABILITY: capability,
  })
  parser = s.config ? "accepted" : `off: ${s.missing.join(",")}`
} catch (e) {
  parser = `refused: ${(e as Error).message}`
}
console.log(JSON.stringify({ scenario, parseCityHallConfig: parser }))

// The tracker's own table (migration 6), in memory: the executor keeps docket's Job key -> the
// queue's job id there.
const db = new Database(":memory:")
db.exec(`CREATE TABLE executor_jobs (job_key TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL,
  remote_id TEXT NOT NULL, created_at TEXT NOT NULL, paused_at TEXT)`)
const records = new tracker.JobRecords(db)
const logs: string[] = []
const executor = tracker.createCityHallExecutor({
  config: { url: url.replace(/\/$/, ""), key, capability, access: null },
  records,
  log: {
    info: (m: string) => logs.push(`info ${m}`),
    warn: (m: string) => logs.push(`warn ${m}`),
    error: (m: string) => logs.push(`error ${m}`),
  },
  now: () => new Date(),
  databaseId: tracker.databaseId(db),
  notice: async (k: string, t: string) => void logs.push(`notice ${k}: ${t}`),
  timeoutMs: 5000,
})

const spec = types.researchJob({ question: `docket-runner e2e: ${scenario}` })
const occurrence = `o-${scenario}`
const jobKey = `${occurrence}:research:1`

type Answer = { kind: "pending" | "unavailable" | "error" | "result"; detail: unknown }
async function ask(): Promise<Answer> {
  // docket sends the spec until a Job is on record, then asks by key alone.
  const first = records.get(jobKey) === null
  try {
    return { kind: "result", detail: await executor.run(first ? spec : null, occurrence, jobKey) }
  } catch (e) {
    if (e instanceof core.JobPendingError) return { kind: "pending", detail: (e as Error).message }
    if (e instanceof core.ExecutorUnavailableError)
      return { kind: "unavailable", detail: (e as Error).message }
    return { kind: "error", detail: (e as Error).message }
  }
}

function judge(a: Answer): string | null {
  if (a.kind !== expectKind)
    return `expected ${expectKind}, got ${a.kind}: ${JSON.stringify(a.detail)}`
  if (a.kind === "result") {
    const r = a.detail as { kind: string; structuredOutput?: unknown }
    if (resultKind !== undefined && r.kind !== resultKind)
      return `expected a ${resultKind} result, got ${r.kind}: ${JSON.stringify(r)}`
    if (wantAnswer) {
      const parsed = types.parseAnswer(r.structuredOutput) as { findings: unknown[] } | null
      if (parsed === null)
        return `parseAnswer refused the structured output: ${JSON.stringify(r.structuredOutput)}`
      if (parsed.findings.length < 1)
        return `parseAnswer kept no findings from: ${JSON.stringify(r.structuredOutput)}`
    }
  } else if (detail !== undefined && !String(a.detail).includes(detail)) {
    return `expected the ${a.kind} answer to say "${detail}", got ${JSON.stringify(a.detail)}`
  }
  return null
}

const t0 = Date.now()
let asks = 0
let last: Answer = { kind: "error", detail: "never asked" }
let verdict: string | null = "timed out"
const seen = new Set<string>()
while (Date.now() - t0 < timeoutMs) {
  last = await ask()
  asks += 1
  const remoteId = records.get(jobKey)
  if (idFile && remoteId !== null) writeFileSync(idFile, remoteId)
  const line = `${last.kind}:${JSON.stringify(last.detail)}`
  if (!seen.has(line)) {
    seen.add(line)
    console.log(JSON.stringify({ ask: asks, ms: Date.now() - t0, ...last, remoteId }))
  }
  if (expectKind === "pending" && holdMs > 0) {
    // Every answer through the hold must be pending; the first that is not fails it.
    verdict = judge(last)
    if (verdict !== null || Date.now() - t0 >= holdMs) break
  } else if (judge(last) === null) {
    verdict = null
    break
  } else if (last.kind === "result" || last.kind === "error") {
    // A result or a plain error is final: docket would not ask again.
    verdict = judge(last)
    break
  } else {
    verdict = `timed out; last: ${judge(last)}`
  }
  await Bun.sleep(300)
}
console.log(JSON.stringify({ final: last, asks, remoteId: records.get(jobKey), logs }))
if (verdict !== null) {
  console.error(`FAIL: ${scenario}: ${verdict}`)
  process.exit(1)
}
