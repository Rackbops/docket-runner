#!/usr/bin/env node
// The web-search spike (plan section 6, "Web tools in the run"; E8): runs each case in
// spike/cases.json through the runner's own flag builder, subprocess environment and classifier
// -- the code a Job goes through in production -- and writes the results for a person to grade.
// Run it on roshne's machine after `pnpm build`; see spike/README.md. It spends subscription
// usage and never an API key: it refuses to start with one set, as the runner does.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildArgs, classify, realExecutor } from "../dist/claude.js"
import { buildSubprocessEnv, FORBIDDEN_ENV } from "../dist/subprocess-env.js"
import { citedUrls, ISOLATION_FLAGS, parseArgs, renderReport } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))

for (const key of FORBIDDEN_ENV) {
  if (process.env[key] !== undefined) {
    console.error(`${key} is set; the spike runs on the Claude subscription only. Unset it first.`)
    process.exit(2)
  }
}

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const { cases: all } = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"))
const unknown = opts.cases.filter((id) => !all.some((c) => c.id === id))
if (unknown.length > 0) {
  console.error(`unknown case ${unknown.join(", ")}; cases are ${all.map((c) => c.id).join(", ")}`)
  process.exit(1)
}
const cases = opts.cases.length > 0 ? all.filter((c) => opts.cases.includes(c.id)) : all

const startedAt = new Date().toISOString()
const out = resolve(opts.out ?? join("spike-results", startedAt.replace(/[:.]/g, "-")))
mkdirSync(out, { recursive: true })

// Everything the runner would pass, less the city-hall settings a spike has no use for. The token
// is passed only when set; otherwise the CLI uses its own login on this machine.
const config = {
  claudeBin: opts.claudeBin,
  defaultMaxTurns: 8,
  defaultMaxBudgetUsd: 0.5,
  ...(opts.model ? { defaultModel: opts.model } : {}),
}
const env = buildSubprocessEnv()
if (!env.CLAUDE_CODE_OAUTH_TOKEN) delete env.CLAUDE_CODE_OAUTH_TOKEN
// A path given for the CLI still has to work after the chdir below.
if (/[\\/]/.test(opts.claudeBin)) opts.claudeBin = resolve(opts.claudeBin)
// Run the CLI from an empty directory, so no repo's CLAUDE.md or project settings reach it. With a
// token, also give it an empty config directory: then no user CLAUDE.md, hooks, plugins or
// settings load either, which is as close to the runner's clean container as a desktop gets.
const workDir = mkdtempSync(join(tmpdir(), "docket-spike-"))
if (env.CLAUDE_CODE_OAUTH_TOKEN)
  env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "docket-spike-home-"))
process.chdir(workDir)

let cliVersion = "unknown"
try {
  cliVersion = execFileSync(opts.claudeBin, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  }).trim()
} catch (err) {
  console.error(`could not run ${opts.claudeBin} --version: ${err.message}`)
  console.error(
    "On Windows pass --claude-bin with the full path to claude.exe (a .cmd shim cannot run).",
  )
  process.exit(1)
}

/** One GET per URL, 10 s each; a status, not a verdict (plenty of sites refuse scripts). */
async function checkLinks(urls) {
  const results = []
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "Mozilla/5.0 (docket-runner web-search spike)" },
      })
      results.push({ url, status: res.status, ok: res.ok })
      await res.body?.cancel().catch(() => {})
    } catch (err) {
      results.push({
        url,
        status: null,
        ok: false,
        error: String(err?.cause?.code ?? err?.name ?? err),
      })
    }
  }
  return results
}

/** Outcomes every later run would repeat: a spent usage window, or a login that does not work. */
const STOPS = new Set(["usage_limit", "auth_failed"])

console.log(`web-search spike: ${cases.length} case(s) x ${opts.repeat}, CLI ${cliVersion}`)
console.log(`results: ${out}`)
const runs = []
for (const c of cases) {
  for (let repeat = 1; repeat <= opts.repeat; repeat++) {
    const job = {
      prompt: c.prompt,
      jsonSchema: c.schema,
      maxTurns: c.maxTurns,
      maxBudgetUsd: c.maxBudgetUsd,
      timeoutMs: c.timeoutMs,
    }
    console.log(`- ${c.id} run ${repeat}: running (up to ${c.timeoutMs / 1000} s)`)
    const args = [...buildArgs(job, config), ...ISOLATION_FLAGS]
    const exec = await realExecutor({
      bin: opts.claudeBin,
      args,
      stdin: job.prompt,
      timeoutMs: job.timeoutMs,
      env,
    })
    const result = classify(job, exec)
    const links =
      opts.linkCheck && result.kind === "success"
        ? await checkLinks(citedUrls(result.structuredOutput))
        : null
    // The flags, minus the schema already in `job`: what the CLI was actually told.
    const flags = args.filter((_a, i) => args[i - 1] !== "--json-schema")
    const run = { caseId: c.id, category: c.category, repeat, flags, job, result, links }
    runs.push(run)
    writeFileSync(join(out, `${c.id}-${repeat}.json`), `${JSON.stringify(run, null, 2)}\n`)
    const cost = result.totalCostUsd?.toFixed(2) ?? "-"
    console.log(`  = ${result.kind}, ${result.numTurns ?? "-"} turns, about ${cost} USD`)
    if (STOPS.has(result.kind)) {
      console.log(`  ! ${result.kind}; stopping. ${result.detail ?? ""}`.trimEnd())
      console.log("    Fix it, then resume with --case for what is left.")
      break
    }
  }
  if (STOPS.has(runs.at(-1)?.result.kind)) break
}

writeFileSync(join(out, "report.md"), renderReport({ startedAt, cliVersion, runs }))
console.log(`+ report: ${join(out, "report.md")}`)
