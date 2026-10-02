# docket-runner -- Agent Instructions

The `claude -p` Job runner for the docket task tracker: it holds roshne's Claude subscription
credential, claims Jobs from Lepid-Labs/city-hall, runs the CLI as the Job says, and posts the
result back. Plan of record: Rackbops/Tooling `research/city-hall-task-tracker.md`, section 5.12;
epic Lepid-Labs/city-hall#4 (E8); this repo's scaffold is #1.

My personal global instructions govern *how I work* -- the review gate, escalation, git and
shipping, tool routing, shell choice. Claude Code loads them from `~/.claude/CLAUDE.md`; Codex
from `~/.codex/AGENTS.md`. They are **not restated here**; this file covers only what a session
needs to know about the code in this repo.

**Commit convention:** Conventional Commits `type(scope): subject`; PR titles are checked by the
`PR guidelines` workflow. Merges land as squash commits titled `<subject> (#N)`.

---

## The one rule

**Every model call runs on the subscription through `claude -p`; an API key is forbidden.**
Three layers enforce it and all three stay: `deploy/render.mjs` exits 2 on
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL`; `loadConfig` refuses to
start with any of them present; `buildSubprocessEnv` strips them from every CLI call. Never add
an `ANTHROPIC_*` variable, an SDK dependency, or a `--bare` flag (it never reads the OAuth token).

## What this process is, and is not

- **A service with zero runtime dependencies.** Node's `http`, `child_process` and `fetch`. It
  holds the token, so the dependency tree stays empty; `@rackbops/node-app-kit` was considered
  and declined for that reason (revisit if the health server grows).
- **It knows no task type.** A Job is a `claude -p` call as data; the runner never inspects a
  prompt, never chooses a model on its own, never decides what to do with a result. Type logic
  lives in Rackbops/docket and city-hall.
- **The wire shapes are `@rackbops/docket-core`'s** (`JobSpec`, `JobResult`, `FailureKind`),
  imported in `src/contract.ts` as **types only** from a devDependency, so the zero-runtime-
  dependency rule holds: `verbatimModuleSyntax` erases the import, `scripts/check-no-runtime-
  deps.mjs` fails the build on a value import, and the Dockerfile's smoke check repeats it. The
  runner's own are `Lease`, `Job` (spec + id + lease), `parseJob`, and mirrors of the default
  tool lists that `test/contract.test.ts` pins to the core's.
- **Outbound only.** It polls city-hall through the edge with a Cloudflare Access service token
  and its usr-issued credential. Nothing listens except the health endpoint, published on host
  loopback.
- **It never retries a Job.** A failure is classified and posted; city-hall decides. A lost
  lease means the outcome is not posted at all and the CLI is stopped.

## Ground truth

The code is the source; the plan is the design. `src/contract.ts` is the v0 of the Job and
JobResult shapes and moves to `@rackbops/docket-core` once that package publishes the Executor
port types -- when it does, import the types and delete the local copy. The CLI facts the
classifier relies on (`is_error`, `api_error_status`, `subtype: error_max_turns`, the limit
messages) came from code.claude.com/docs and research-triage's production evidence; a CLI bump
that changes them shows up as a classification test failure, not a silent misfile.

## Testing & checks

`just check` = lint, typecheck (src and test), vitest, `deploy/render.test.mjs`, build. Tests
never touch the real CLI: `test/fixtures/fake-claude.mjs` stands in for `claude`
(`FAKE_CLAUDE_MODE` picks the answer), and `test/loop.test.ts` runs a fake city-hall in-process.
CI also builds the image and runs `claude --version` inside it. **What CI cannot prove is the
credential**: `/readyz` on roshne's host is the only test of that, and the deploy README says
so. Never point a test at a real token.

## Code style

TypeScript ESM, `strict`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Biome 2 (two
spaces, double quotes, no semicolons, width 100); `just fix` writes. Logs are JSON lines and
`redact` covers any field whose name smells like a secret; never log a prompt above debug.
ASCII in prose; `--` for a dash.

## Key gotchas

- `CLAUDE_BIN` exists for the tests (they point it at the fake). Production leaves it unset.
- The prompt goes on stdin. Putting it in argv breaks on long prompts and leaks it to `ps`.
- `--no-session-persistence` is the default; only a Job with `resumeSessionId` keeps a session,
  and those live on the `claude-home` volume under the transcripts policy.
- `push-notify.yml` needs the `DISCORD_PUSH_WEBHOOK` secret; `AGENTS.md` and `CLAUDE.md` are
  deliberately not muted in its path filter.
