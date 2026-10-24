import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const compose = readFileSync(new URL("../deploy/compose.yaml.example", import.meta.url), "utf8")

/** The longest `timeoutMs` a tracker Job carries today: research and scout, docket-types. */
const LONGEST_JOB_TIMEOUT_S = 600
/** The CLI's kill grace (5 s) plus the outcome post and its retries, with room to spare. */
const AFTER_RUN_S = 30

describe("compose.yaml.example", () => {
  it("gives a run in progress longer than the longest Job timeout to finish on stop (#38)", () => {
    const m = /^\s+stop_grace_period:\s*(\d+)s\s*$/m.exec(compose)
    expect(m, "stop_grace_period in seconds").not.toBeNull()
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(LONGEST_JOB_TIMEOUT_S + AFTER_RUN_S)
  })
})
