import assert from "node:assert/strict"
import { test } from "node:test"

import { parseAnswers, RenderError, render } from "./render.mjs"

const good = `
IMAGE_TAG=0.1.0
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-example
CITY_HALL_URL=https://tracker.example
CITY_HALL_RUNNER_TOKEN=runner-secret
`

test("a forbidden key makes render exit 2, even blank", () => {
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
    assert.throws(
      () => render(`${good}${key}=\n`, { stackName: "prod" }),
      (err) => err instanceof RenderError && err.exitCode === 2 && err.message.includes(key),
    )
  }
})

test("a missing required field exits 1 naming it", () => {
  assert.throws(
    () => render(good.replace(/CITY_HALL_URL=.*\n/, ""), { stackName: "prod" }),
    (err) =>
      err instanceof RenderError && err.exitCode === 1 && err.message.includes("CITY_HALL_URL"),
  )
})

test("splits the stack half from the container half and keeps the credential out of .env", () => {
  const { stack, app, warnings } = render(good, { stackName: "prod" })
  assert.equal(warnings.length, 0)
  assert.match(stack, /^COMPOSE_PROJECT_NAME=docket-runner-prod$/m)
  assert.match(stack, /^IMAGE_TAG=0\.1\.0$/m)
  assert.match(stack, /^HEALTH_PORT=8787$/m)
  assert.doesNotMatch(stack, /CLAUDE_CODE_OAUTH_TOKEN/)
  assert.match(app, /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-example$/m)
  assert.match(app, /^CITY_HALL_RUNNER_TOKEN=runner-secret$/m)
  assert.match(app, /^POLL_INTERVAL_MS=1500$/m)
  assert.doesNotMatch(app, /IMAGE_TAG/)
})

test("drops an unknown key with a warning and validates the image tag", () => {
  const { warnings } = render(`${good}RETIRED_KEY=1\n`, { stackName: "prod" })
  assert.deepEqual(warnings, ["unknown key RETIRED_KEY dropped"])
  assert.throws(
    () => render(good.replace("IMAGE_TAG=0.1.0", "IMAGE_TAG=not a tag"), { stackName: "prod" }),
    /IMAGE_TAG/,
  )
})

test("quotes like compose reads: strips notation quotes, ends at ' #', single-quotes specials, refuses a quote", () => {
  const m = parseAnswers('A="x y"\nB=v # note\nC=p$w#x\n')
  assert.equal(m.get("A"), "x y")
  assert.equal(m.get("B"), "v")
  assert.equal(m.get("C"), "p$w#x")
  const { app } = render(`${good}DEFAULT_MODEL=claude sonnet\n`, { stackName: "prod" })
  assert.match(app, /^DEFAULT_MODEL='claude sonnet'$/m)
  assert.throws(() => render(`${good}DEFAULT_MODEL=it's\n`, { stackName: "prod" }), /single quote/)
})
