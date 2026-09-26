import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { makeCityHallClient } from "./cityhall.js"
import { ConfigError, loadConfig } from "./config.js"
import { startHealthServer } from "./health.js"
import { makeLogger } from "./log.js"
import { Loop } from "./loop.js"
import { AuthProbe } from "./probe.js"
import { buildSubprocessEnv } from "./subprocess-env.js"

const log = makeLogger()

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string
    }
    return pkg.version ?? "dev"
  } catch {
    return "dev"
  }
}

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      log("error", err.message)
      process.exit(err.exitCode)
    }
    throw err
  }
  const version = readVersion()
  let cliVersion: string | null = null
  try {
    // `--version` proves the binary is present, nothing about auth; the probe does that.
    cliVersion = execFileSync(config.claudeBin, ["--version"], {
      env: buildSubprocessEnv(),
      encoding: "utf8",
      timeout: 10_000,
    }).trim()
  } catch (err) {
    log("error", "claude CLI not runnable", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const probe = new AuthProbe(config)
  const client = makeCityHallClient(config, fetch, version)
  const loop = new Loop({ config, client, log, authOk: async () => (await probe.check(true)).ok })
  const server = await startHealthServer(config.healthPort, config.healthBind, {
    probe,
    state: loop.state,
    version,
    cliVersion: () => cliVersion,
  })
  log("info", "docket-runner started", {
    version,
    cli: cliVersion,
    cityHall: config.cityHallUrl,
    pollIntervalMs: config.pollIntervalMs,
    healthPort: config.healthPort,
  })

  // Prove the credential once at start; the loop pauses itself if a Job later says otherwise.
  probe
    .check()
    .then((a) => log(a.ok ? "info" : "error", "auth probe", { ok: a.ok, detail: a.detail }))

  const shutdown = (signal: string) => {
    log("info", "stopping", { signal })
    loop.stop()
    server.close()
  }
  process.once("SIGTERM", () => shutdown("SIGTERM"))
  process.once("SIGINT", () => shutdown("SIGINT"))
  await loop.run()
  log("info", "stopped")
}

main().catch((err) => {
  log("error", "fatal", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
  process.exit(1)
})
