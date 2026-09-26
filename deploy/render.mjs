#!/usr/bin/env node
/**
 * answers.env -> .env (compose half) + app.env (container half), next to it. research-triage's
 * render.mjs, cut down to this runner's schema: a CLOSED allowlist (an unknown key is dropped
 * with a warning, never fatal), `required` fields that fail loudly by name (exit 1), and the
 * FORBIDDEN keys that make render exit 2 -- the first of three layers keeping every `claude -p`
 * run on the subscription (loadConfig refuses them at boot, buildSubprocessEnv strips them per
 * call).
 *
 * Value rules match compose's env-file parser: surrounding quotes are notation, an unquoted value
 * ends at ` #`, a rendered value with whitespace, #, $, " or \ is written single-quoted, and a
 * value with a single quote or a line break is rejected by name.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const FORBIDDEN = [
  { key: "ANTHROPIC_API_KEY", why: "the runner runs on the Claude subscription only" },
  { key: "ANTHROPIC_AUTH_TOKEN", why: "the runner runs on the Claude subscription only" },
  {
    key: "ANTHROPIC_BASE_URL",
    why: "the runner runs on the Claude subscription, at its own endpoint",
  },
]

export class RenderError extends Error {
  constructor(message, exitCode) {
    super(message)
    this.name = "RenderError"
    this.exitCode = exitCode
  }
}

// scope: "stack" -> .env only; "app" (default) -> app.env only; "both" -> both files.
export const SCHEMA = [
  {
    key: "COMPOSE_PROJECT_NAME",
    scope: "stack",
    derived: ({ stackName }) =>
      `docket-runner-${stackName.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`,
    validate: (v) =>
      /^[a-z0-9][a-z0-9_-]*$/.test(v) ||
      "must be lowercase letters, digits, - or _ (compose's rule)",
  },
  { key: "IMAGE", default: "ghcr.io/rackbops/docket-runner", scope: "stack" },
  {
    key: "IMAGE_TAG",
    required: true,
    scope: "stack",
    validate: (v) =>
      /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(v) ||
      "must be a docker image tag, e.g. sha-abc1234 or 0.1.0",
  },
  {
    key: "HEALTH_PORT",
    default: "8787",
    scope: "both",
    validate: (v) => /^[0-9]{2,5}$/.test(v) || "must be a port number",
  },

  { key: "CLAUDE_CODE_OAUTH_TOKEN", required: true },
  {
    key: "CITY_HALL_URL",
    required: true,
    validate: (v) => /^https?:\/\//.test(v) || "must be an http(s) URL",
  },
  { key: "CITY_HALL_RUNNER_TOKEN", required: true },
  { key: "CF_ACCESS_CLIENT_ID", default: "" },
  { key: "CF_ACCESS_CLIENT_SECRET", default: "" },
  { key: "CLAUDE_TIMEOUT_MS", default: "120000" },
  { key: "POLL_INTERVAL_MS", default: "1500" },
  { key: "DEFAULT_MAX_TURNS", default: "8" },
  { key: "DEFAULT_MAX_BUDGET_USD", default: "0.50" },
  { key: "DEFAULT_MODEL", default: "" },
  { key: "HEALTH_BIND", default: "0.0.0.0" },
  { key: "NODE_ENV", default: "production" },
  { key: "TZ", default: "America/New_York" },
]

export function parseAnswers(text) {
  const out = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 1) throw new RenderError(`cannot parse line: ${raw}`, 1)
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    } else {
      const hash = value.search(/\s#/)
      if (hash >= 0) value = value.slice(0, hash).trimEnd()
    }
    out.set(key, value)
  }
  return out
}

function quote(key, value) {
  if (/'/.test(value) || /[\r\n]/.test(value)) {
    throw new RenderError(
      `${key}: a value with a single quote or a line break cannot be carried; percent-encode it`,
      1,
    )
  }
  return /[\s#$"\\]/.test(value) ? `'${value}'` : value
}

/** Pure: answers text + context -> { stack, app, warnings }. Throws RenderError. */
export function render(text, { stackName }) {
  const answers = parseAnswers(text)
  for (const { key, why } of FORBIDDEN) {
    if (answers.has(key)) throw new RenderError(`${key} must not appear in answers.env: ${why}`, 2)
  }
  const known = new Set(SCHEMA.map((f) => f.key))
  const warnings = [...answers.keys()]
    .filter((k) => !known.has(k))
    .map((k) => `unknown key ${k} dropped`)
  const stack = []
  const app = []
  for (const field of SCHEMA) {
    let value = answers.get(field.key)
    if (value === undefined || value === "") {
      if (field.required) throw new RenderError(`${field.key} is required and missing or blank`, 1)
      value = field.derived ? field.derived({ stackName }) : (field.default ?? "")
    }
    if (field.validate && value !== "") {
      const verdict = field.validate(value)
      if (verdict !== true) throw new RenderError(`${field.key}: ${verdict}`, 1)
    }
    const line = `${field.key}=${quote(field.key, value)}`
    const scope = field.scope ?? "app"
    if (scope === "stack" || scope === "both") stack.push(line)
    if (scope === "app" || scope === "both") app.push(line)
  }
  return { stack: `${stack.join("\n")}\n`, app: `${app.join("\n")}\n`, warnings }
}

export function main(argv = process.argv.slice(2)) {
  const dir = resolve(argv[0] ?? dirname(fileURLToPath(import.meta.url)))
  const answersPath = join(dir, "answers.env")
  if (!existsSync(answersPath)) throw new RenderError(`no answers.env in ${dir}`, 1)
  const { stack, app, warnings } = render(readFileSync(answersPath, "utf8"), {
    stackName: dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "stack",
  })
  for (const w of warnings) console.warn(`warning: ${w}`)
  writeFileSync(join(dir, ".env"), stack, { mode: 0o600 })
  writeFileSync(join(dir, "app.env"), app, { mode: 0o600 })
  console.log(`rendered ${join(dir, ".env")} and ${join(dir, "app.env")}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(err instanceof RenderError ? err.message : err)
    process.exit(err instanceof RenderError ? err.exitCode : 1)
  }
}
