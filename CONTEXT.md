# docket-runner -- toolchain and testing reference

## Toolchain

Node 24 (`.nvmrc`), pnpm from `packageManager`, TypeScript 7, vitest 5, Biome 2 -- the versions
rackbops-node-app-kit and Rackbops/docket run. `tsconfig.json` compiles `src/` only;
`tsconfig.test.json` widens `include` to `test/` for the typecheck, so test files are checked
but never emitted. `deploy/render.mjs` is plain ESM JavaScript (it runs on the host with no
build) and its tests use `node --test`.

## The fake CLI

`test/fixtures/fake-claude.mjs` is executable and answers like `claude -p --output-format json`
would, by `FAKE_CLAUDE_MODE`: `success`, `schema`, `research` (an answer in the tracker's research
schema, for the end-to-end check), `auth401`, `limit`, `max_turns`, `budget`, `slow`
(`FAKE_CLAUDE_DELAY_MS`), `crash`, `garbage`, and `stubborn` (ignores SIGTERM and never answers,
for the SIGKILL fallback). It records its argv to `FAKE_CLAUDE_ARGV_FILE` so the flag set is
asserted, and its pid to `FAKE_CLAUDE_PID_FILE` so a test can check the process is gone; it reads
stdin so a prompt on argv would be caught. The runner's auth probe (`src/probe.ts`'s exact argv,
`ok` on stdin) is answered at once even in `slow` and `stubborn`, and writes no pid file, so a
runner started in those modes is not held up for the delay. Tests hand `claudeBin` the fixture's
path through `testConfig()`.

## The fake city-hall

`test/loop.test.ts` starts an in-process `node:http` server that hands out queued Jobs once each
and records heartbeats and outcomes; the lease heartbeat is 50 ms and the slow fake takes 300 ms,
so a heartbeat is observed without slowing the suite. `loseLease` is a predicate: a heartbeat
answers 409 while it returns true. The lost-lease test answers 204 until the fake CLI has written
its pid file and 409 after, because on a busy machine the first 50 ms heartbeat can land before
the child is up; it runs the slow fake for 30 s and asserts the loop kills it within a few
seconds, posts nothing and counts it in `jobsAbandoned`.

## The end-to-end check

`just e2e` (`test/e2e/run.sh`, driving `test/e2e/drive-tracker.ts` under Bun) runs the tracker's
model lane across three repos on 127.0.0.1: the tracker plugin's real city-hall executor
(rackbops-bot-plugins `plugins/tracker/src/executor.ts`) submits research Jobs built by
docket-types' `researchJob()` to a real city-hall (`node dist/server/index.js`, two runners tagged
`claude-cli:subscription` and one tagged `other-tag`), this runner's `dist/` claims them and runs
the fake CLI, and the tracker reads the result back. Each scenario gets a fresh city-hall and is
asserted on the tracker's answer, city-hall's view of the job, and the runner's log; the first
failure stops everything, exits non-zero and keeps the logs. It is not part of `just check`.

- the happy path (fake `research`) ends in `success`, and docket-types' `parseAnswer` accepts it;
- fake `success` on the schema Job is `schema_miss`; `max_turns` is `turn_cap`, `budget` is
  `budget_cap`, `crash` and `garbage` are `error`;
- `auth401` and `limit` are requeued by city-hall, and the tracker answers unavailable;
- a wrong source key is a 401 (the tracker answers unavailable); an unknown runner token is a
  claim 401; a runner without the capability tag never claims (and a tagged one then does);
- lost lease (#17): runner A is frozen (SIGSTOP) past a 4 s lease, runner B finishes the Job, and
  on thawing A stops its CLI and posts nothing. Only the outcome is asserted: city-hall requeues an
  expired lease lazily, on the next claim, heartbeat or outcome call, not when it expires.

Run it (Node >= 24, pnpm, bun, git, curl and pgrep on PATH; no ANTHROPIC_* variable, which the
script unsets anyway):

```sh
git clone https://github.com/Lepid-Labs/city-hall ../city-hall            # private
git -C ../city-hall checkout 90a06ec48c513ee39f9d93fdd34917a85a83487b
git clone https://github.com/Rackbops/rackbops-bot-plugins ../bot-plugins
git -C ../bot-plugins checkout 6f465f4825c12acd8c4b07bfa36efb091f3a87e4
CITY_HALL_DIR=../city-hall BOT_PLUGINS_DIR=../bot-plugins just e2e
```

The script installs and builds city-hall in its checkout (`pnpm install --frozen-lockfile`,
`pnpm run build`) and installs the plugins checkout (`bun install --frozen-lockfile`); `just e2e`
builds this repo first. Logs go to `$E2E_OUT`, a new temp directory by default. It takes about 30
seconds.

Pins: `test/e2e/pins.env` holds both SHAs, and the script refuses a checkout at any other commit
unless `E2E_ALLOW_UNPINNED=1`, and one with uncommitted changes always. To bump one, run
`just e2e` against the new commit with `E2E_ALLOW_UNPINNED=1`, fix what it finds, then change the
SHA in `pins.env` in the same PR (and the clone commands above).

What it does not prove: the real CLI, the subscription credential, the edge (Cloudflare Access;
the tracker's own config parser refuses `http://`, so the driver builds the config itself), or the
tracker inside a running bot. `/readyz` on roshne's host is still the only proof of the credential.

### In CI

The `e2e` job in `.github/workflows/ci.yml` runs it on every pull request and push to `main`. It
checks the three repos out side by side (`docket-runner/`, `city-hall/`, `bot-plugins/`; not
nested, or city-hall's `pnpm install` would find this repo's `pnpm-workspace.yaml` above it), at
the SHAs it loads from `test/e2e/pins.env` into `$GITHUB_ENV`, sets up just, pnpm, Node 26 and
Bun (the version in the plugins checkout's `package.json`), and runs `just install` and
`just e2e`. On failure the logs (`$E2E_OUT`) are uploaded as the `e2e-logs` artifact.

Lepid-Labs/city-hall is private. The job reads it with the repo secret `CITY_HALL_READ_TOKEN`: a
fine-grained PAT whose resource owner is Lepid-Labs, scoped to city-hall only, Contents read-only.
It is used for the access probe and the city-hall checkout (with `persist-credentials: false`),
and never reaches `run.sh`. Lepid-Labs requires its owner to approve a fine-grained token before
it can read anything.

The job probes access first (`GET /repos/Lepid-Labs/city-hall` with the token). When the secret is
empty (a fork PR) or the probe fails, the job emits a warning annotation, writes the same line to
the job summary, skips every later step, and stays **green**. A green `e2e` check is therefore not
proof the end-to-end check ran: look at the job's annotations or summary. The warning reads

- `CITY_HALL_READ_TOKEN cannot read Lepid-Labs/city-hall yet (HTTP <code>; waiting on Lepid-Labs
  owner approval of the token); end-to-end check skipped` -- not approved yet (GitHub answers 403
  or 404);
- `CITY_HALL_READ_TOKEN was refused (HTTP 401): expired or revoked; ...` -- renew the token;
- `CITY_HALL_READ_TOKEN is not available to this run (a fork PR, or the secret is unset); ...`.

This is deliberate: the job turns itself on at the first run after the token is approved, with no
further PR. The token expires **2026-12-31**; renew it (same scope, owner approval again) and
update the secret before then, or the job falls back to skipping with the 401 warning.

To bump a pin in CI, change the SHA in `pins.env` (as above): the job reads it from there, so
nothing in the workflow changes.

## A lost lease stops the CLI

When a heartbeat comes back 409, the loop aborts an `AbortController` whose signal `runJob` hands
the executor, which kills the child through the same `kill()` the timeout uses: SIGTERM, then
SIGKILL if 'close' has not fired within `KILL_GRACE_MS` (5 s; `ExecOptions.killGraceMs` overrides
it, which the tests use). The Job is then abandoned: no outcome is posted and it counts in
`jobsAbandoned` (in the loop state `/readyz` reports), neither done nor failed. A 409 means
city-hall has already taken the lease back -- requeued the Job, or failed it after
`maxExpiredLeases` expiries (Lepid-Labs/city-hall `src/server/lib/jobs.ts:128-130,175-183` at
90a06ec). A heartbeat still in flight when the run ends is ignored. Before this, the CLI ran to
the end and spent subscription usage on a result city-hall would refuse.

## Classification facts

`classify()` reads both the exit code and the envelope: the CLI exits 1 for every `is_error`
envelope. `api_error_status: 401` or "OAuth"/"authenticate"/"Not logged in" text is
`auth_failed`; "You've hit your ... limit" is `usage_limit` and a "Resets at <time>" tail is kept
as `resetsAt`; `subtype: error_max_turns` is `turn_cap`; "Budget limit" is `budget_cap`; no
JSON envelope at all is `error`, and its detail quotes stdout and stderr through `excerpt()`, so
it says what came back instead of "(no output)". `excerpt()` keeps the first 200 characters, then
a `... (N chars)` marker naming the full length; it is one line, ASCII, with `sk-ant-` shapes and
a bearer followed by a 16+ character token redacted. Stderr goes through it in every detail, the
auth, limit and cap branches too. A Job with a schema and no `structured_output` (and a `result`
that is not JSON) is `schema_miss`. Sources: code.claude.com/docs (headless, cli-reference,
errors) and research-triage's `claudeAuth.ts` evidence, both as of 2026-09-26.

## Deploy shape

`deploy/` mirrors research-triage: `answers.env` (mode 600) is the only edited file;
`render.mjs` writes `.env` (compose: image, tag, health port, project name) and `app.env` (the
container's environment) with compose's own quoting rules; `rt` wraps compose. `render` exits 1
naming a missing required field and 2 on a forbidden key. Two stacks on one host get distinct
compose projects from their directory names.

## Images

`release.yml` publishes `ghcr.io/rackbops/docket-runner:x.y.z` and `:latest` on a `v*` tag and
`:dev` plus `:sha-<7>` on every push to main, with the source and revision labels. The repo is
public, so the image is public and `rt` needs no registry login. `just version X.Y.Z`, commit as
`chore(release): vX.Y.Z`, tag, push with tags.

## Repo stamps

Labels from Rackbops/Tooling's `sync_labels.py`; Renovate through `github>Rackbops/renovate-config`
plus a regex manager for the CLI pin in the Dockerfile; `push-notify.yml` needs the
`DISCORD_PUSH_WEBHOOK` secret.

## pnpm's minimum release age

pnpm 12 refuses to install a version published less than a day ago (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`),
and it checks the policy against the lockfile even under `--frozen-lockfile`. `pnpm-workspace.yaml`
(pnpm's settings file here, not a workspace) exempts `@rackbops/docket-core`, our own library, which
this runner adopts the day it ships. The Dockerfile copies that file into the build stage for the
same reason; leaving it out fails the image build for 24 hours after every docket release.
