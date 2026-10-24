/**
 * The three environment variables that would move a `claude -p` run off the subscription: the
 * CLI resolves `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` ahead of `CLAUDE_CODE_OAUTH_TOKEN`,
 * and `ANTHROPIC_BASE_URL` re-routes it to a gateway. `render.mjs` refuses them at deploy time
 * (exit 2); `loadConfig` refuses them at boot. The child environment below never carries them
 * either, since it is built from an allowlist they are not on.
 */
export const FORBIDDEN_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const

/**
 * The names a `claude` child may inherit from the runner's environment (#37). Everything else is
 * dropped: the queue's runner token, the Access secret, the Firecrawl key, every `ANTHROPIC_*`
 * name and every other route off the subscription (`CLAUDE_CODE_USE_BEDROCK`,
 * `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_CUSTOM_HEADERS`, ...). A run that needs a credential gets
 * it added by name at the call site: the OAuth token always, the Firecrawl key only for a run that
 * loads Firecrawl (`runJob`). The proxy names pass so a runner behind an egress proxy still
 * reaches the API.
 */
export const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "LANG",
  "LANGUAGE",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const

/**
 * Name prefixes that pass too: locale (`LC_*`), Node's own settings (`NODE_ENV`,
 * `NODE_EXTRA_CA_CERTS`), and `FAKE_CLAUDE_*`, which only the test fixture reads (it is how a test
 * picks the fake CLI's answer, like `CLAUDE_BIN`; production sets none).
 */
export const INHERITED_ENV_PREFIXES = ["LC_", "NODE_", "FAKE_CLAUDE_"] as const

export function buildSubprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    const inherited =
      (INHERITED_ENV as readonly string[]).includes(k) ||
      INHERITED_ENV_PREFIXES.some((p) => k.startsWith(p))
    if (inherited) out[k] = v
  }
  return out
}
