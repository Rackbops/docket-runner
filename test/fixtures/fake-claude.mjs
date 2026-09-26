#!/usr/bin/env node
// A stand-in for the Claude CLI so tests never touch the real one or the subscription. Reads the
// prompt from stdin like the real `claude -p`, then answers according to FAKE_CLAUDE_MODE:
//   success (default) | schema | auth401 | limit | max_turns | budget | slow | crash | garbage
// It records its argv to FAKE_CLAUDE_ARGV_FILE when set, so tests can assert on the flag set.
import { appendFileSync } from "node:fs"

const mode = process.env.FAKE_CLAUDE_MODE ?? "success"
const argvFile = process.env.FAKE_CLAUDE_ARGV_FILE
if (argvFile) appendFileSync(argvFile, `${JSON.stringify(process.argv.slice(2))}\n`)

let prompt = ""
process.stdin.setEncoding("utf8")
for await (const chunk of process.stdin) prompt += chunk

if (process.argv.includes("--version")) {
  process.stdout.write("9.9.9 (fake)\n")
  process.exit(0)
}

const out = (obj, code = 0) => {
  process.stdout.write(JSON.stringify(obj))
  process.exit(code)
}

switch (mode) {
  case "slow":
    await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_DELAY_MS ?? "400")))
    out({
      result: `slow ok: ${prompt.length} chars`,
      session_id: "s-slow",
      total_cost_usd: 0.01,
      num_turns: 1,
    })
    break
  case "schema":
    out({
      result: JSON.stringify({ answer: 42 }),
      structured_output: { answer: 42 },
      session_id: "s-schema",
      total_cost_usd: 0.02,
      usage: { input_tokens: 10, output_tokens: 5 },
      num_turns: 1,
    })
    break
  case "auth401":
    out(
      {
        is_error: true,
        api_error_status: 401,
        result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
      },
      1,
    )
    break
  case "limit":
    out(
      { is_error: true, result: "You've hit your session limit. Resets at 2026-09-27T01:00:00Z." },
      1,
    )
    break
  case "max_turns":
    out(
      {
        is_error: true,
        subtype: "error_max_turns",
        result: "Reached max turns (2)",
        session_id: "s-turns",
        total_cost_usd: 0.05,
      },
      1,
    )
    break
  case "budget":
    out({ is_error: true, result: "Budget limit reached: $0.50" }, 1)
    break
  case "crash":
    process.stderr.write("boom\n")
    process.exit(3)
    break
  case "garbage":
    process.stdout.write("not json at all")
    process.exit(0)
    break
  default:
    out({
      result: `ok: ${prompt.length} chars`,
      session_id: "s-1",
      total_cost_usd: 0.03,
      usage: { input_tokens: 3, output_tokens: 2 },
      num_turns: 1,
    })
}
