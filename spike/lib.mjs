// Pure helpers for the web-search spike: argument parsing, the URLs a result cites, and the
// report. No I/O here, so spike/lib.test.mjs covers them without a model or a network.

/**
 * Spike-only flags on top of the runner's. The runner runs in a clean container; the spike runs
 * on a person's own machine, inside their Claude setup. `--tools` makes the web pair the only
 * tools the run can use at all (`--allowedTools` only pre-approves), and `--strict-mcp-config`
 * with no `--mcp-config` loads none of their MCP servers.
 */
export const ISOLATION_FLAGS = ["--tools", "WebSearch,WebFetch", "--strict-mcp-config"]

export const USAGE = `usage: node spike/run.mjs [--case <id>]... [--repeat <n>] [--out <dir>]
       [--model <name>] [--claude-bin <path>] [--no-link-check]

Runs each case in spike/cases.json through the runner's own claude -p flags and classifier, on
the subscription, and writes one JSON file per run plus report.md into --out.`

/** Parses argv into options; throws an Error whose message is the usage line on a bad argument. */
export function parseArgs(argv) {
  const opts = {
    cases: [],
    repeat: 1,
    out: null,
    model: null,
    claudeBin: "claude",
    linkCheck: true,
  }
  // `pnpm spike -- --case x` hands the script a literal `--` first; it separates nothing here.
  const args = argv[0] === "--" ? argv.slice(1) : argv
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = () => {
      const v = args[++i]
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value\n${USAGE}`)
      return v
    }
    if (arg === "--case") opts.cases.push(value())
    else if (arg === "--repeat") {
      const n = Number(value())
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`--repeat is 1 to 5\n${USAGE}`)
      opts.repeat = n
    } else if (arg === "--out") opts.out = value()
    else if (arg === "--model") opts.model = value()
    else if (arg === "--claude-bin") opts.claudeBin = value()
    else if (arg === "--no-link-check") opts.linkCheck = false
    else if (arg === "--help" || arg === "-h") throw new Error(USAGE)
    else throw new Error(`unknown argument ${arg}\n${USAGE}`)
  }
  return opts
}

/** At most this many links are checked per run, so a long answer cannot stretch a run by minutes. */
export const MAX_LINKS = 30

/** Every distinct http(s) URL anywhere in a structured result, first seen first, up to `MAX_LINKS`. */
export function citedUrls(value) {
  const seen = new Set()
  const walk = (v) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/https?:\/\/[^\s"'<>)\]]+/g))
        seen.add(m[0].replace(/[.,;:]+$/, ""))
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x)
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x)
    }
  }
  walk(value)
  return [...seen].slice(0, MAX_LINKS)
}

/** How many things the result offers: findings, items or listings. */
export function itemCount(caseId, structured) {
  if (!structured || typeof structured !== "object") return 0
  const key = { research: "findings", scout: "items", wantlist: "listings" }[caseId]
  const list = key ? structured[key] : undefined
  return Array.isArray(list) ? list.length : 0
}

function money(n) {
  return typeof n === "number" ? n.toFixed(2) : "-"
}

function secs(ms) {
  return typeof ms === "number" ? (ms / 1000).toFixed(0) : "-"
}

/**
 * The report: one row per run with what the machine can measure, the link check, and a blank
 * grade for the reader. ASCII only: it is read in a Windows console as often as in a browser.
 */
export function renderReport({ startedAt, cliVersion, runs }) {
  const lines = [
    "# Web-search spike report",
    "",
    `Started ${startedAt}; CLI ${cliVersion}. Plan: Rackbops/Tooling`,
    "research/city-hall-task-tracker.md, section 6 ('Web tools in the run') and E8.",
    "",
    "| Case | Run | Outcome | Items | Turns | Est. USD | Secs | Links ok / cited |",
    "|---|---|---|---|---|---|---|---|",
  ]
  for (const r of runs) {
    const links = r.links ? `${r.links.filter((l) => l.ok).length} / ${r.links.length}` : "-"
    lines.push(
      `| ${r.caseId} | ${r.repeat} | ${r.result.kind} | ${itemCount(r.caseId, r.result.structuredOutput)} | ${r.result.numTurns ?? "-"} | ${money(r.result.totalCostUsd)} | ${secs(r.result.durationMs)} | ${links} |`,
    )
  }
  const total = runs.reduce((s, r) => s + (r.result.totalCostUsd ?? 0), 0)
  lines.push(
    "",
    `Estimated total: ${money(total)} USD (the CLI's list-price estimate, not a bill).`,
  )
  lines.push(
    "",
    "## Grade each run",
    "",
    "Open the run's JSON next to this file. For each, score 1 (useless) to 5 (would act on it):",
    "",
    "- **Relevant** -- does it answer the ask, through the lens for the scout?",
    "- **True** -- spot-check three claims or items against the pages cited.",
    "- **Sourced** -- are the links real pages that say what the run says? A 403 in the link",
    "  check is often a site refusing scripts, not a fake link; open it in a browser.",
    "- **Honest** -- does it admit what it could not find (wantlist: no invented listings)?",
    "",
    "| Case | Run | Relevant | True | Sourced | Honest | Notes |",
    "|---|---|---|---|---|---|---|",
  )
  for (const r of runs) lines.push(`| ${r.caseId} | ${r.repeat} | | | | | |`)
  const failures = runs.filter((r) => r.result.kind !== "success")
  if (failures.length > 0) {
    lines.push("", "## Failures", "")
    for (const r of failures)
      lines.push(`- ${r.caseId} run ${r.repeat}: ${r.result.kind} -- ${r.result.detail}`)
  }
  return `${lines.join("\n")}\n`
}
