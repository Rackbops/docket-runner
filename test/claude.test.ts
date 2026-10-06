import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  buildArgs,
  classify,
  EXCERPT_CHARS,
  type Exec,
  excerpt,
  planTools,
  realExecutor,
  runJob,
  TOOL_CEILING,
  ToolCeilingError,
} from "../src/claude.js"
import { parseJob } from "../src/contract.js"
import { FAKE_CLAUDE, job, testConfig } from "./helpers.js"

const config = testConfig()

async function run(
  mode: string,
  overrides: Record<string, unknown> = {},
  env: Record<string, string> = {},
) {
  const j = parseJob(job(overrides))
  process.env.FAKE_CLAUDE_MODE = mode
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  try {
    // The flag set is asserted through buildArgs above; reading the fake CLI's argv here raced
    // the timeout test's 50 ms kill, which can land before the child writes anything.
    return { result: await runJob(j, config) }
  } finally {
    delete process.env.FAKE_CLAUDE_MODE
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
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch")
    expect(args).toContain("--strict-mcp-config")
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

describe("the tool ceiling (docket-runner#23)", () => {
  it("is the web read set", () => {
    expect([...TOOL_CEILING]).toEqual(["WebSearch", "WebFetch"])
  })

  it("gives a Job with no tools the ceiling, with the default denials", () => {
    const plan = planTools({})
    expect(plan.tools).toEqual(["WebSearch", "WebFetch"])
    expect(plan.allowed).toEqual(["WebSearch", "WebFetch"])
    expect(plan.disallowed).toEqual(["Bash", "Edit", "Write", "NotebookEdit", "Task"])
  })

  it("lets a Job narrow it to a subset", () => {
    const plan = planTools({ allowedTools: ["WebSearch"] })
    expect(plan.tools).toEqual(["WebSearch"])
    expect(plan.allowed).toEqual(["WebSearch"])
  })

  it("lets research and the scout ask for the ceiling as it is", () => {
    const plan = planTools({
      allowedTools: ["WebSearch", "WebFetch"],
      disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Task"],
    })
    expect(plan.tools).toEqual(["WebSearch", "WebFetch"])
  })

  it("lets a Job scope a tool by rule: the want-list judge's shop-site fetches", () => {
    const plan = planTools({
      allowedTools: ["WebFetch(domain:shop.example)", "WebFetch(domain:other.example)"],
      disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Task", "WebSearch", "Read"],
    })
    expect(plan.tools).toEqual(["WebFetch"])
    expect(plan.allowed).toEqual([
      "WebFetch(domain:shop.example)",
      "WebFetch(domain:other.example)",
    ])
  })

  it("gives a Job that allows nothing and denies the web no tools at all: the inbox judge", () => {
    const plan = planTools({
      allowedTools: [],
      disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Task", "WebSearch", "WebFetch"],
    })
    expect(plan.tools).toEqual([])
    const args = buildArgs(
      parseJob(job({ allowedTools: [], disallowedTools: ["WebSearch", "WebFetch"] })),
      config,
    )
    expect(args[args.indexOf("--tools") + 1]).toBe("")
    expect(args).not.toContain("--allowedTools")
  })

  it("keeps the default denials when a Job sends its own list, even an empty one", () => {
    expect(planTools({ disallowedTools: [] }).disallowed).toEqual([
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "Task",
    ])
    expect(planTools({ disallowedTools: ["Read", "Bash"] }).disallowed).toEqual([
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "Task",
      "Read",
    ])
  })

  it("refuses a Job that asks for a tool outside the ceiling, naming it", () => {
    expect(() => planTools({ allowedTools: ["WebSearch", "Bash"] })).toThrow(ToolCeilingError)
    expect(() => planTools({ allowedTools: ["Bash(git *)"] })).toThrow(/: "Bash\(git \*\)"$/)
    expect(() => planTools({ allowedTools: ["Read", "mcp__x__y"] })).toThrow(
      /: "Read", "mcp__x__y"$/,
    )
    expect(() => planTools({ allowedTools: [""] })).toThrow(/: ""$/)
    expect(() => planTools({ allowedTools: ["webfetch"] })).toThrow(ToolCeilingError)
    expect(() => buildArgs(parseJob(job({ allowedTools: ["Bash"] })), config)).toThrow(
      ToolCeilingError,
    )
  })

  it("refuses an entry the CLI would split into two tools", () => {
    for (const entry of [
      "WebFetch(x),Bash",
      "WebFetch(x) Bash",
      "WebFetch,Read",
      "WebSearch Read",
      " WebFetch",
      "WebFetch(a(b))",
      "WebFetch(domain:a.example,b.example)",
    ]) {
      expect(() => planTools({ allowedTools: [entry] }), entry).toThrow(ToolCeilingError)
    }
  })

  it("names at most five refused entries, each cut short", () => {
    const many = Array.from({ length: 7 }, (_, i) => `Tool${i}${"x".repeat(60)}`)
    let message = ""
    try {
      planTools({ allowedTools: many })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/and 2 more$/)
    expect(message).not.toContain("x".repeat(41))
  })

  it("never starts the CLI for a refused Job and reports an error naming the tool", async () => {
    let spawned = false
    const result = await runJob(
      parseJob(job({ allowedTools: ["WebFetch", "Bash"] })),
      config,
      async () => {
        spawned = true
        return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false, durationMs: 1 }
      },
    )
    expect(spawned).toBe(false)
    expect(result.kind).toBe("error")
    if (result.kind === "success") return
    expect(result.detail).toContain("outside the runner's ceiling")
    expect(result.detail).toContain("Bash")
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

  it("passes the fake's research answer through as structured output (the e2e's happy path)", async () => {
    const { result } = await run("research", { jsonSchema: { type: "object" } })
    expect(result.kind).toBe("success")
    if (result.kind !== "success") return
    const answer = result.structuredOutput as {
      summary: string
      findings: { claim: string; sources: string[] }[]
      uncertain: string[]
    }
    expect(answer.summary.length).toBeGreaterThan(0)
    expect(answer.findings[0]?.sources[0]).toMatch(/^https:\/\//)
    expect(Array.isArray(answer.uncertain)).toBe(true)
    expect(JSON.parse(result.result)).toEqual(answer)
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
    const garbage = (await run("garbage")).result
    expect(garbage.kind).toBe("error")
    if (garbage.kind === "error") {
      expect(garbage.detail).toContain("stdout: not json at all")
      expect(garbage.detail).not.toContain("(no output)")
    }
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

describe("excerpt", () => {
  it("is one bounded ASCII line with credential shapes redacted", () => {
    const auth = "Authorization: Bearer abc.def-123456789xyz sk-ant-oat01-SECRET_x"
    const quoted = excerpt(`oops\n\t${auth} \u2014 ${"x".repeat(500)}`)
    expect(quoted).not.toContain("abc.def-123456789xyz")
    expect(quoted).not.toContain("SECRET")
    expect(quoted).toContain("[redacted]")
    expect(quoted).toMatch(
      /^oops Authorization: \[redacted\] \[redacted\] \? x+\.\.\. \(\d+ chars\)$/,
    )
    expect(quoted.length).toBeLessThan(EXCERPT_CHARS + 30)
  })

  it("leaves prose with the word bearer alone", () => {
    expect(excerpt("the bearer of bad news")).toBe("the bearer of bad news")
    expect(excerpt("Bearer short")).toBe("Bearer short")
  })

  it("is empty for empty output, so the detail still says (no output)", () => {
    expect(excerpt(" \n ")).toBe("")
    const r = classify(parseJob(job()), {
      exitCode: 2,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 1,
    })
    expect(r.kind === "error" && r.detail).toContain("(no output)")
  })
})

describe("stderr in a failure detail", () => {
  const exec = (over: Partial<Exec>): Exec => ({
    exitCode: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    durationMs: 1,
    ...over,
  })
  const secret = "sk-ant-oat01-SECRETSECRET"
  const bearer = "Bearer eyJhbGciOiJIUzI1NiJ9.payload"

  it("is scrubbed when there is no JSON envelope", () => {
    const r = classify(
      parseJob(job()),
      exec({ stdout: "nope", stderr: `crashed\n${secret} ${bearer} ${"y".repeat(400)}` }),
    )
    expect(r.kind).toBe("error")
    const detail = r.kind === "error" ? r.detail : ""
    expect(detail).toContain("stderr: crashed [redacted] [redacted] y")
    expect(detail).not.toContain("SECRET")
    expect(detail).not.toContain("eyJhbGci")
    expect(detail).toMatch(/\.\.\. \(\d+ chars\)$/)
  })

  it("is scrubbed in the auth_failed and usage_limit details", () => {
    const auth = classify(
      parseJob(job()),
      exec({ stderr: `Not logged in; token ${secret}\n${bearer}` }),
    )
    expect(auth.kind).toBe("auth_failed")
    expect(auth.kind === "auth_failed" && auth.detail).toBe(
      "Not logged in; token [redacted] [redacted]",
    )
    const limit = classify(
      parseJob(job()),
      exec({ stderr: `You've hit your weekly limit (${secret}). Resets at 3pm.` }),
    )
    expect(limit.kind).toBe("usage_limit")
    if (limit.kind === "usage_limit") {
      expect(limit.detail).not.toContain("SECRET")
      expect(limit.resetsAt).toBe("3pm")
    }
  })
})

describe("aborting a run", () => {
  it("kills the CLI when the signal aborts and classifies it as stopped", async () => {
    const controller = new AbortController()
    process.env.FAKE_CLAUDE_MODE = "slow"
    process.env.FAKE_CLAUDE_DELAY_MS = "30000"
    try {
      const started = Date.now()
      setTimeout(() => controller.abort(), 100)
      const r = await runJob(parseJob(job()), config, undefined, controller.signal)
      expect(Date.now() - started).toBeLessThan(3000)
      expect(r.kind).toBe("error")
      if (r.kind === "error") expect(r.detail).toContain("lease was lost")
    } finally {
      delete process.env.FAKE_CLAUDE_MODE
      delete process.env.FAKE_CLAUDE_DELAY_MS
    }
  })
})

describe("the kill fallback", () => {
  it("sends SIGKILL when the CLI ignores SIGTERM, so the run still settles", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "runner-kill-")), "pid")
    const controller = new AbortController()
    const started = Date.now()
    const running = realExecutor({
      bin: FAKE_CLAUDE,
      args: ["-p"],
      stdin: "hang",
      timeoutMs: 60_000,
      env: { ...process.env, FAKE_CLAUDE_MODE: "stubborn", FAKE_CLAUDE_PID_FILE: pidFile },
      signal: controller.signal,
      killGraceMs: 200,
    })
    // Abort only once the child is up and ignoring SIGTERM. The file can exist before its content
    // lands, and a pid of 0 would make the liveness check below probe the whole process group.
    const readPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0)
    while (readPid() <= 0 && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const pid = readPid()
    expect(pid).toBeGreaterThan(0)
    controller.abort()
    const exec = await running
    expect(exec.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
