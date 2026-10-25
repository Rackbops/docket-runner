import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SCRIPT = fileURLToPath(new URL("../scripts/check-no-runtime-deps.mjs", import.meta.url))

function check(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "runner-deps-"))
  mkdirSync(join(dir, "nested"))
  writeFileSync(join(dir, "nested", "mod.js"), source)
  return spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" })
}

describe("scripts/check-no-runtime-deps.mjs", () => {
  it("passes output that names no @rackbops module", () => {
    expect(check('import { join } from "node:path"\nexport const x = 1\n').status).toBe(0)
  })

  it.each([
    ["a static import", 'import { x } from "@rackbops/docket-core"'],
    ["a bare import", 'import "@rackbops/docket-core"'],
    ["a dynamic import", 'const m = await import("@rackbops/docket-core")'],
    ["a dynamic import with a space", "const m = await import ( '@rackbops/docket-core' )"],
    ["a require", 'const m = require("@rackbops/docket-core")'],
  ])("fails on %s", (_name, source) => {
    const r = check(source)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("mod.js")
  })
})

describe("the Dockerfile smoke grep", () => {
  const dockerfile = readFileSync(fileURLToPath(new URL("../Dockerfile", import.meta.url)), "utf8")
  const grep = /! (grep -rqE ".*") dist/.exec(dockerfile)?.[1]

  // Runs the Dockerfile's own grep over a fixture directory; exit 0 means it found an import.
  const finds = (source: string): boolean => {
    const dir = mkdtempSync(join(tmpdir(), "runner-docker-grep-"))
    writeFileSync(join(dir, "mod.js"), source)
    return spawnSync("sh", ["-c", `${grep} ${dir}`]).status === 0
  }

  it("is found in the Dockerfile", () => {
    expect(grep).toBeDefined()
  })

  it.each([
    'import { x } from "@rackbops/docket-core"',
    'import "@rackbops/docket-core"',
    'const m = await import("@rackbops/docket-core")',
    'const m = require("@rackbops/docket-core")',
  ])("finds %s", (source) => {
    expect(finds(source)).toBe(true)
  })

  it("leaves clean output alone", () => {
    expect(finds('import { join } from "node:path"')).toBe(false)
  })
})
