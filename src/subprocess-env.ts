/**
 * The three environment variables that would move a `claude -p` run off the subscription: the
 * CLI resolves `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` ahead of `CLAUDE_CODE_OAUTH_TOKEN`,
 * and `ANTHROPIC_BASE_URL` re-routes it to a gateway. `render.mjs` refuses them at deploy time
 * (exit 2); `loadConfig` refuses them at boot; this is the last layer, on every call, so a stray
 * variable can never switch a run to metered billing. Lifted from research-triage's
 * `buildSubprocessEnv`, widened to all three keys.
 */
export const FORBIDDEN_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const

export function buildSubprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(source)) {
    if ((FORBIDDEN_ENV as readonly string[]).includes(k)) continue
    out[k] = v
  }
  return out
}
