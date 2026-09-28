import assert from "node:assert/strict"
import { test } from "node:test"

import { citedUrls, itemCount, MAX_LINKS, parseArgs, renderReport } from "./lib.mjs"

test("parseArgs reads every option and refuses what it does not know", () => {
  assert.deepEqual(
    parseArgs(["--case", "scout", "--case", "research", "--repeat", "2", "--no-link-check"]),
    {
      cases: ["scout", "research"],
      repeat: 2,
      out: null,
      model: null,
      claudeBin: "claude",
      linkCheck: false,
    },
  )
  assert.deepEqual(parseArgs(["--", "--case", "wantlist"]).cases, ["wantlist"], "pnpm's --")
  assert.throws(() => parseArgs(["--repeat", "9"]), /--repeat is 1 to 5/)
  assert.throws(() => parseArgs(["--case"]), /--case needs a value/)
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument --bogus/)
})

test("citedUrls finds each URL once, anywhere in the result, without trailing punctuation", () => {
  const result = {
    findings: [
      { claim: "a", sources: ["https://energy.gov/x", "https://example.org/y."] },
      { claim: "see https://energy.gov/x and (https://z.test/q)", sources: [] },
    ],
    uncertain: ["none"],
  }
  assert.deepEqual(citedUrls(result), [
    "https://energy.gov/x",
    "https://example.org/y",
    "https://z.test/q",
  ])
  assert.deepEqual(citedUrls(null), [])
  const many = Array.from({ length: 50 }, (_, i) => `https://example.org/${i}`)
  assert.equal(citedUrls(many).length, MAX_LINKS)
})

test("itemCount counts what each case offers", () => {
  assert.equal(itemCount("research", { findings: [1, 2] }), 2)
  assert.equal(itemCount("scout", { items: [1] }), 1)
  assert.equal(itemCount("wantlist", { listings: [], notFound: true }), 0)
  assert.equal(itemCount("scout", undefined), 0)
})

test("the report has a row and a grade line per run, the total, and the failures", () => {
  const report = renderReport({
    startedAt: "2026-09-28T04:00:00.000Z",
    cliVersion: "9.9.9",
    runs: [
      {
        caseId: "scout",
        repeat: 1,
        result: {
          kind: "success",
          structuredOutput: { items: [{}, {}] },
          numTurns: 7,
          totalCostUsd: 0.31,
          durationMs: 64000,
        },
        links: [{ ok: true }, { ok: false }],
      },
      {
        caseId: "wantlist",
        repeat: 1,
        result: { kind: "turn_cap", detail: "max turns", durationMs: 1000 },
        links: null,
      },
    ],
  })
  assert.match(report, /\| scout \| 1 \| success \| 2 \| 7 \| 0\.31 \| 64 \| 1 \/ 2 \|/)
  assert.match(report, /\| wantlist \| 1 \| turn_cap \| 0 \| - \| - \| 1 \| - \|/)
  assert.match(report, /Estimated total: 0\.31 USD/)
  assert.match(report, /- wantlist run 1: turn_cap -- max turns/)
  assert.equal(report.match(/^\| (scout|wantlist) \| 1 \| \| /gm)?.length, 2)
  assert.ok(
    [...report].every((ch) => ch.charCodeAt(0) < 128),
    "ASCII only",
  )
})
