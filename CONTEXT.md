# docket-runner -- toolchain and testing reference

## Toolchain

Node 24 (`.nvmrc`), pnpm from `packageManager`, TypeScript 7, vitest 5, Biome 2 -- the versions
rackbops-node-app-kit and Rackbops/docket run. `tsconfig.json` compiles `src/` only;
`tsconfig.test.json` widens `include` to `test/` for the typecheck, so test files are checked
but never emitted. `deploy/render.mjs` is plain ESM JavaScript (it runs on the host with no
build) and its tests use `node --test`.

## The fake CLI

`test/fixtures/fake-claude.mjs` is executable and answers like `claude -p --output-format json`
would, by `FAKE_CLAUDE_MODE`: `success`, `schema`, `auth401`, `limit`, `max_turns`, `budget`,
`slow` (`FAKE_CLAUDE_DELAY_MS`), `crash`, `garbage`. It records its argv to
`FAKE_CLAUDE_ARGV_FILE` so the flag set is asserted, and it reads stdin so a prompt on argv would
be caught. Tests hand `claudeBin` the fixture's path through `testConfig()`.

## The fake city-hall

`test/loop.test.ts` starts an in-process `node:http` server that hands out queued Jobs once each
and records heartbeats and outcomes; the lease heartbeat is 50 ms and the slow fake takes 300 ms,
so a heartbeat is observed without slowing the suite.

## Classification facts

`classify()` reads both the exit code and the envelope: the CLI exits 1 for every `is_error`
envelope. `api_error_status: 401` or "OAuth"/"authenticate"/"Not logged in" text is
`auth_failed`; "You've hit your ... limit" is `usage_limit` and a "Resets at <time>" tail is kept
as `resetsAt`; `subtype: error_max_turns` is `turn_cap`; "Budget limit" is `budget_cap`; no
JSON envelope at all is `error`. A Job with a schema and no `structured_output` (and a `result`
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
