// The runner has zero runtime dependencies (AGENTS.md): `@rackbops/docket-core` is a
// devDependency imported as types only, and the image's final stage carries no node_modules.
// A value import would compile fine and crash at boot, so the build refuses it here.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const offenders = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith(".js") && /from\s+["']@rackbops\//.test(readFileSync(path, "utf8"))) {
      offenders.push(path)
    }
  }
}
walk("dist")
if (offenders.length > 0) {
  console.error(
    `runtime import of @rackbops/* in compiled output (types only, please): ${offenders.join(", ")}`,
  )
  process.exit(1)
}
console.log("no runtime dependencies in dist")
