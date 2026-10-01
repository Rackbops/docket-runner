import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { buildArgs, classify, runJob } from "../src/claude.js"
import { parseJob } from "../src/contract.js"
import { job, testConfig } from "./helpers.js"

const config = testConfig()

async function run(
  mode: string,
  overrides: Record<string, unknown> = {},
  env: Record<string, string> = {},
) {
  const j = parseJob(job(overrides))
  const argvFile = join(mkdtempSync(join(tmpdir(), "fake-claude-")), "argv.jsonl")
  process.env.FAKE_CLAUDE_MODE = mode
  process.env.FAKE_CLAUDE_ARGV_FILE = argvFile
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  try {
    const result = await runJob(j, config)
    // A run killed early (the timeout case) can end before the fake CLI records its argv.
    const argv = existsSync(argvFile)
      ? (JSON.parse(readFileSync(argvFile, "utf8").trim().split("\n")[0] ?? "[]") as string[])
      : []
    return { result, argv }
  } finally {
    delete process.env.FAKE_CLAUDE_MODE
    delete process.env.FAKE_CLAUDE_ARGV_FILE
    for (const k of Object.keys(env)) delete process.env[k]
  }
}

describe("buildArgs", () => {
  it("is print mode with JSON output, the caps, the web tool set and no session by default", () => {
    const args = buildArgs(parseJob(job()), config)
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"])
    expect(args).toContain("--max-turns")
    expect(args[args.indexOf("--max-turns") + 1]).toBe("8")
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.5")
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch")
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash")
    expect(args).toContain("--no-session-persistence")
    expect(args).not.toContain("--resume")
    expect(args).not.toContain("--json-schema")
  })

  it("passes the Job's schema, model, caps and resumed session through", () => {
    const args = buildArgs(
      parseJob(
        job({
          jsonSchema: { type: "object" },
          model: "sonnet",
          maxTurns: 2,
          maxBudgetUsd: 0.1,
          resumeSessionId: "abc",
        }),
      ),
      config,
    )
    expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}')
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet")
    expect(args[args.indexOf("--max-turns") + 1]).toBe("2")
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.1")
    expect(args[args.indexOf("--resume") + 1]).toBe("abc")
    expect(args).not.toContain("--no-session-persistence")
  })

  it("never puts the prompt on the command line", () => {
    const args = buildArgs(parseJob(job({ prompt: "SECRET PROMPT TEXT" })), config)
    expect(args.join(" ")).not.toContain("SECRET PROMPT TEXT")
  })
})

describe("runJob against the fake CLI", () => {
  it("succeeds and carries the envelope's telemetry", async () => {
    const { result } = await run("success")
    expect(result.kind).toBe("success")
    if (result.kind !== "success") return
    expect(result.result).toBe("ok: 6 chars")
    expect(result.sessionId).toBe("s-1")
    expect(result.totalCostUsd).toBe(0.03)
    expect(result.numTurns).toBe(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("strips the API key from the child's environment and passes the subscription token", async () => {
    const { result } = await run("success", {}, { ANTHROPIC_API_KEY: "sk-should-not-leak" })
    expect(result.kind).toBe("success")
    // The fake sees the env the runner built; a leak would be invisible here, so assert on the builder too.
    const { buildSubprocessEnv } = await import("../src/subprocess-env.js")
    expect(buildSubprocessEnv({ ANTHROPIC_API_KEY: "x", KEEP: "y" })).toEqual({ KEEP: "y" })
  })

  it("returns structured output when the Job carried a schema", async () => {
    const { result } = await run("schema", {
      jsonSchema: { type: "object", properties: { answer: { type: "integer" } } },
    })
    expect(result.kind).toBe("success")
    if (result.kind === "success") expect(result.structuredOutput).toEqual({ answer: 42 })
  })

  it("classifies a 401 as auth_failed", async () => {
    const { result } = await run("auth401")
    expect(result.kind).toBe("auth_failed")
    if (result.kind === "auth_failed") expect(result.apiErrorStatus).toBe(401)
  })

  it("classifies a usage limit and keeps the reset time", async () => {
    const { result } = await run("limit")
    expect(result.kind).toBe("usage_limit")
    if (result.kind === "usage_limit") expect(result.resetsAt).toBe("2026-09-27T01:00:00Z")
  })

  it("classifies the turn cap, the budget cap, a crash and garbage output", async () => {
    expect((await run("max_turns")).result.kind).toBe("turn_cap")
    expect((await run("budget")).result.kind).toBe("budget_cap")
    const crash = (await run("crash")).result
    expect(crash.kind).toBe("error")
    if (crash.kind === "error") expect(crash.detail).toContain("boom")
    expect((await run("garbage")).result.kind).toBe("error")
  })

  it("kills a run that exceeds the Job's timeout", async () => {
    const { result } = await run("slow", { timeoutMs: 50 }, { FAKE_CLAUDE_DELAY_MS: "2000" })
    expect(result.kind).toBe("timeout")
  })
})

describe("classify", () => {
  it("is a schema miss when a schema was asked for and nothing structured came back", () => {
    const r = classify(parseJob(job({ jsonSchema: { type: "object" } })), {
      exitCode: 0,
      stdout: JSON.stringify({ result: "plain prose" }),
      stderr: "",
      timedOut: false,
      durationMs: 1,
    })
    expect(r.kind).toBe("schema_miss")
  })
})
