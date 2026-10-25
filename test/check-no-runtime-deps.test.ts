import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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
