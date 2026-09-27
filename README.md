# docket-runner

Runs Claude Code print-mode Jobs for the docket task tracker. A small service on roshne's host
that holds the **only** Claude credential the tracker has, claims Jobs from
[Lepid-Labs/city-hall](https://github.com/Lepid-Labs/city-hall), runs `claude -p` exactly as the
Job says, and posts the result back. It knows no task type: the types live in
[Rackbops/docket](https://github.com/Rackbops/docket) and run inside city-hall; this process only
executes the CLI call they describe.

Design: Rackbops/Tooling, `research/city-hall-task-tracker.md`, section 5.12. Scaffold: [#1](https://github.com/Rackbops/docket-runner/issues/1).

## What it does

```
loop:  claim Job from city-hall  ->  claude -p (prompt on stdin, JSON out)  ->  post JobResult
       heartbeat the lease while the CLI runs; a dead runner's lease expires and city-hall requeues
```

- **Subscription only.** The credential is a `claude setup-token` result in `CLAUDE_CODE_OAUTH_TOKEN`. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are refused three times: at `rt render` (exit 2), at boot (exit 2), and stripped from every CLI call's environment.
- **The wall is the CLI's own.** `--allowedTools WebSearch,WebFetch` by default, shell and file tools denied, `--max-turns` and `--max-budget-usd` on every run, `--resume` only when a Job continues a conversation, `--no-session-persistence` otherwise. The prompt travels on stdin, never argv.
- **Every result is classified**, not just success: `auth_failed` (401: stop claiming, alarm), `usage_limit` (stop until the reset the CLI names, or an hour), `turn_cap`, `budget_cap`, `schema_miss`, `timeout`, `error`. A limit or an auth failure charges nobody; city-hall requeues.
- **Health that tells the truth.** `/readyz` runs a real `claude -p "ok"` probe (cached 6 h on success, 5 min on failure) because `claude auth status` reports a bogus token as logged in; it also reports the CLI version and the loop's last claim, heartbeat and outcome.
- **Zero runtime dependencies.** Node's `http`, `child_process` and `fetch`. This process holds the token; the smaller the tree, the better. The Job and JobResult shapes are [`@rackbops/docket-core`](https://github.com/Rackbops/docket)'s, imported as types only (a devDependency); the build refuses a runtime import of it.

## The city-hall contract

The runner expects three endpoints, which city-hall#2 implements (bearer: the runner's usr credential; plus the Cloudflare Access service-token headers when configured):

| Call | Answer |
|---|---|
| `POST /api/execute/claim` | `200 { job }` or `204` |
| `POST /api/execute/jobs/:id/heartbeat { leaseToken }` | `204`, or `409` lease lost |
| `POST /api/execute/jobs/:id/outcome { leaseToken, result }` | `204`, or `409` lease lost |

The `Job` and `JobResult` shapes are in [`src/contract.ts`](src/contract.ts) for now and move into `@rackbops/docket-core` as the Executor port's types once it publishes them.

## Develop

Requires [just](https://just.systems), Node 24 and pnpm (`corepack enable`).

```sh
just install
just check          # lint, typecheck, tests against test/fixtures/fake-claude.mjs, build
just docker-build   # the image, locally
```

Tests never run the real CLI: `test/fixtures/fake-claude.mjs` answers by `FAKE_CLAUDE_MODE`, and a fake city-hall in `test/loop.test.ts` records claims, heartbeats and outcomes. The one thing CI cannot prove is the credential itself; `/readyz` on roshne's host does.

## Deploy

[`deploy/README.md`](deploy/README.md): one stack directory, `answers.env`, `rt render`, `rt up`. Images publish to `ghcr.io/rackbops/docket-runner` on `v*` tags (`x.y.z`, `latest`) and on every push to main (`dev`, `sha-<7>`).
