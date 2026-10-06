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
model lane across three repos on 127.0.0.1: the tracker plugin's real executor
(rackbops-bot-plugins `plugins/tracker/src/executor.ts`) submits research Jobs built by
docket-types' `researchJob()` to a real Rackbops/job-queue (`node dist/index.js`, two runners
tagged `claude-cli:subscription` and one tagged `other-tag`), this runner's `dist/` claims them
and runs the fake CLI, and the tracker reads the result back. job-queue serves the API the tracker's
executor and this runner already speak (job-queue's README), so neither changes for it. Each
scenario group gets a fresh queue (the wiring negatives share one) and is asserted on the tracker's answer, the queue's view
of the job, and the runner's log; the first failure stops everything, exits non-zero and keeps the
logs. It is not part of `just check`.

- the happy path (fake `research`) ends in `success`, and docket-types' `parseAnswer` accepts it;
- fake `success` on the schema Job is `schema_miss`; `max_turns` is `turn_cap`, `budget` is
  `budget_cap`, `crash` and `garbage` are `error`;
- `auth401` and `limit` are requeued by the queue, and the tracker answers unavailable;
- a wrong source key is a 401 (the tracker answers unavailable); an unknown runner token is a
  claim 401; a runner without the capability tag never claims (and a tagged one then does);
- lost lease (#17): runner A is frozen (SIGSTOP) past a 4 s lease, runner B finishes the Job, and
  on thawing A stops its CLI and posts nothing. Only the outcome is asserted, not the job's status
  in between: job-queue requeues an expired lease on its sweep timer and again, lazily, on the
  next claim, heartbeat or outcome call.

Run it (Node >= 24, pnpm, bun, git, curl and pgrep on PATH; no ANTHROPIC_* variable, which the
script unsets anyway):

```sh
git clone https://github.com/Rackbops/job-queue ../job-queue              # private
git -C ../job-queue checkout 37823cc5bd47762b2034e12722ee1fead1d5ff38
git clone https://github.com/Rackbops/rackbops-bot-plugins ../bot-plugins
git -C ../bot-plugins checkout 6f465f4825c12acd8c4b07bfa36efb091f3a87e4
JOB_QUEUE_DIR=../job-queue BOT_PLUGINS_DIR=../bot-plugins just e2e
```

The script installs and builds job-queue in its checkout (`pnpm install --frozen-lockfile`,
`pnpm run build`) and installs the plugins checkout (`bun install --frozen-lockfile`); `just e2e`
builds this repo first. Logs go to `$E2E_OUT`, a new temp directory by default. It takes about 30
seconds.

Pins: `test/e2e/pins.env` holds both SHAs, and the script refuses a checkout at any other commit
unless `E2E_ALLOW_UNPINNED=1`, and one with uncommitted changes always. To bump one, run
`just e2e` against the new commit with `E2E_ALLOW_UNPINNED=1`, fix what it finds, then change the
full 40-character SHA in `pins.env` in the same PR (and the clone commands above).

job-queue's own `test/e2e/run.sh` is an adapted copy of this script that runs the same twelve
scenarios from the queue's side, pinned to a docket-runner commit. It runs this repo's
`drive-tracker.ts`, so the driver's options and its `E2E_CITY_HALL_URL`, `E2E_CITY_HALL_KEY` and
`E2E_CAPABILITY` variables are an interface to that script; a change to them or to a scenario
here belongs there too.

What it does not prove: the real CLI, the subscription credential, the edge (Cloudflare Access;
the tracker's own config parser refuses `http://`, so the driver builds the config itself), or the
tracker inside a running bot. `/readyz` on roshne's host is still the only proof of the credential.

### In CI

The `e2e` job in `.github/workflows/ci.yml` runs it on every pull request and push to `main`. It
checks the three repos out side by side (`docket-runner/`, `job-queue/`, `bot-plugins/`; not
nested, or job-queue's `pnpm install` would find this repo's `pnpm-workspace.yaml` above it), at
the SHAs it loads from `test/e2e/pins.env` into `$GITHUB_ENV`, sets up just, pnpm, Node 26 and
Bun (the version in the plugins checkout's `package.json`), and runs `just install` and
`just e2e`. It times out after 20 minutes. The third-party actions it uses (setup-just, pnpm,
setup-bun) are pinned to full commit SHAs, with the tag in a comment.

On failure the logs (`$E2E_OUT`) are uploaded as the `e2e-logs` artifact, kept for 3 days. This
repo is public, so the artifact is too, and job-queue output is left out of it: its build log, its
server logs, its databases, and the job reads and job ids (`*.job.json`, `*.id`). What is kept is
this runner's logs, the tracker driver's output and the plugins install log. On a failure,
`run.sh` still prints some job-queue output to the public job log: the queue's log when it fails
to start, and the job read that failed an assertion. It is synthetic test data.

Rackbops/job-queue is private. The job reads it with the repo secret `JOB_QUEUE_READ_TOKEN`: a
fine-grained PAT whose resource owner is Rackbops, scoped to job-queue only, Contents read-only.
It is used for the access probe and the job-queue checkout (with `persist-credentials: false`).
It is not in `run.sh`'s environment, but any code in the job (including the three dependency
trees) could still read it from the runner. The exposure is accepted: it is a read-only Contents
token for one repo, and fork and Dependabot PRs get no secrets. Renovate branches are same-repo,
so they do get it.

The job probes access first: `GET /repos/Rackbops/job-queue/contents/package.json` with the
token (`curl --retry 3 --retry-all-errors --max-time 20`), a Contents read, so a token without
Contents skips here rather than failing at the checkout. When the secret is empty or the probe answers 401, 403 or 404,
the job emits a warning annotation, writes the same line to the job summary, skips every later
step, and stays **green**. A green `e2e` check is therefore not proof the end-to-end check ran:
look at the job's annotations or summary. The warning reads

- `JOB_QUEUE_READ_TOKEN cannot read Rackbops/job-queue (HTTP <code>; not scoped to job-queue with
  Contents read-only, or awaiting approval if the Rackbops org requires it); end-to-end check
  skipped` -- GitHub answers 403 or 404 (an org policy that blocks fine-grained tokens is a 403);
- `JOB_QUEUE_READ_TOKEN was refused (HTTP 401): expired or revoked; renew it; end-to-end check
  skipped` -- renew the token;
- `JOB_QUEUE_READ_TOKEN is not available to this run (e.g. a fork or Dependabot PR, or the secret
  is unset); end-to-end check skipped`.

Anything else is a network or GitHub blip, not a missing token, and fails the job with an error
annotation: no response at all after the retries (`000`), a 5xx, or any other code.

This is deliberate: the job turns itself on at the first run after the secret can read, with no
further PR. Until then the steps after the probe have not run in CI; once the secret is set,
re-run the latest `ci` run on `main` to prove them before setting E2E_REQUIRED.

Once the first real e2e run is green, set the repo variable `E2E_REQUIRED=true` (Settings >
Secrets and variables > Actions > Variables) so an expired or revoked token turns the job red
instead of silently skipping. With it set, each of the three skips above is an error annotation
(the same text, without "; end-to-end check skipped") and a red job.

Renew the token before the expiry shown on its GitHub settings page (same scope) and update the
secret, or the job falls back to
skipping with the 401 warning (or, with `E2E_REQUIRED=true`, goes red).

To bump a pin in CI, change the full 40-character SHA in `pins.env` (as above): the job reads it
from there, so nothing in the workflow changes.

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

## The tool ceiling

`TOOL_CEILING` in `src/claude.ts` (`WebSearch`, `WebFetch`) is the most any run gets
(docket-runner#23). `planTools` refuses a Job whose `allowedTools` names anything else, or an entry
the CLI would split in two (a comma or space outside a rule), and `runJob` posts that as an `error`
without starting the CLI. `--tools` carries the effective list, so tools outside it do not exist in
the run at all; `--strict-mcp-config` with no `--mcp-config` loads no MCP server. All three flags
exist in the pinned CLI (2.1.285). Widening the ceiling is a reviewed change to that constant.

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
compose projects from their directory names. `compose.yaml.example` joins the external `docket`
network, as production does: job-queue's stack (on the same host) joins it too, so the runner
reaches the queue at `http://job-queue:8080` without the edge; a runner on another host drops the
`networks` blocks and uses the public hostname with the Access pair.

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
