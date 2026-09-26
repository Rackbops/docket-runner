/** JSON lines on stdout. Secrets never reach here by construction; `redact` is the belt to that braces. */
export type Level = "debug" | "info" | "warn" | "error"

const SECRET_KEY = /token|secret|key|password|authorization/i

export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : v
  return out
}

export type Logger = (level: Level, msg: string, fields?: Record<string, unknown>) => void

export function makeLogger(
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Logger {
  return (level, msg, fields = {}) => {
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...redact(fields) }))
  }
}
