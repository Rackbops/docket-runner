# docket-runner

Runs Claude Code print-mode Jobs for the docket task tracker. A small service on roshne's host
that holds the **only** Claude credential the tracker has, claims Jobs from
[Rackbops/city-hall](https://github.com/Rackbops/city-hall), runs `claude -p` exactly as the
Job says, and posts the result back. It knows no task type: the types live in
[Rackbops/docket](https://github.com/Rackbops/docket) and run in the tracker plugin
([Rackbops/rackbops-bot-plugins](https://github.com/Rackbops/rackbops-bot-plugins) `plugins/tracker`),
which hands each model Job to city-hall; city-hall only queues and leases it, and this process
only executes the CLI call it describes. The execute-lane API it calls was merged first into the upstream, Lepid-Labs/city-hall
(pull request [Lepid-Labs/city-hall#18](https://github.com/Lepid-Labs/city-hall/pull/18), commit
`90a06ec`); its decision record is still proposed, pending Nazu's review on the proposal issue
[Lepid-Labs/city-hall#17](https://github.com/Lepid-Labs/city-hall/issues/17).

Design: Rackbops/Tooling, `research/city-hall-task-tracker.md`, section 5.12. Scaffold: [#1](https://github.com/Rackbops/docket-runner/issues/1).

## What it does

```
loop:  claim Job from city-hall  ->  claude -p (prompt on stdin, JSON out)  ->  post JobResult
       heartbeat the lease while the CLI runs; a dead runner's lease expires and city-hall requeues
```

- **Subscription only.** The credential is a `claude setup-token` result in `CLAUDE_CODE_OAUTH_TOKEN`. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are refused three times: at `rt render` (exit 2), at boot (exit 2), and left out of every CLI call's environment, which is built from an allowlist (`src/subprocess-env.ts`) that also keeps the runner token and the Access secret out of every run.
- **The wall is the CLI's own, and the runner holds its ceiling.** No run ever has more than `WebSearch`, `WebFetch`, and Firecrawl's `mcp__firecrawl__firecrawl_search` and `mcp__firecrawl__firecrawl_scrape` (`TOOL_CEILING` in `src/claude.ts`, docket-runner#23): a Job may narrow that list or scope a tool by rule (`WebFetch(domain:...)`), and a Job asking for anything else is refused as an `error` before the CLI starts. `--tools` names the only built-in tools that exist in the run, `--strict-mcp-config` loads no MCP server except Firecrawl's hosted one, which `--mcp-config` adds only when `FIRECRAWL_API_KEY` is set and the Job names a Firecrawl tool, and `Bash`, `Edit`, `Write`, `NotebookEdit` and `Task` are always denied besides, `--max-turns` and `--max-budget-usd` on every run, `--resume` only when a Job continues a conversation, `--no-session-persistence` otherwise. The prompt travels on stdin, never argv.
- **Firecrawl is optional.** BoardGameGeek's robots.txt blocks ClaudeBot, so `WebFetch` gets 403 there; Firecrawl fetches as FirecrawlAgent. With no `FIRECRAWL_API_KEY`, a Job that names Firecrawl tools still runs, without them, and the runner logs a warning naming the dropped tools (never the key). The key reaches the CLI only through its environment, for a run that loads Firecrawl; the inline MCP config names `${FIRECRAWL_API_KEY}`, which the CLI expands, so the key is never in argv.
- **Every result is classified**, not just success: `auth_failed` (401: stop claiming, alarm), `usage_limit` (stop until the reset the CLI names, or an hour), `turn_cap`, `budget_cap`, `schema_miss`, `timeout`, `error`. A limit or an auth failure charges nobody; city-hall requeues.
- **Health that tells the truth.** `/readyz` runs a real `claude -p "ok"` probe (cached 6 h on success, 5 min on failure) because `claude auth status` reports a bogus token as logged in; it also reports the CLI version and the loop's last claim, heartbeat and outcome, and returns 503 once five claims in a row have failed (`consecutiveClaimFailures`, `lastClaimError` in the body). A finished Job's outcome is retried with backoff while the lease holds, for up to 10 minutes; if it is never delivered the Job counts in `jobsAbandoned`.
- **Zero runtime dependencies.** Node's `http`, `child_process` and `fetch`. This process holds the token; the smaller the tree, the better. The Job and JobResult shapes are [`@rackbops/docket-core`](https://github.com/Rackbops/docket)'s, imported as types only (a devDependency); the build refuses a runtime import of it.

## The city-hall contract

The runner calls three endpoints, merged first into the upstream Lepid-Labs/city-hall by pull request [Lepid-Labs/city-hall#18](https://github.com/Lepid-Labs/city-hall/pull/18) (commit `90a06ec`, the runner endpoints claim/heartbeat/outcome). Their decision record (city-hall ADR 0002) is still proposed, pending Nazu's review on the proposal issue [Lepid-Labs/city-hall#17](https://github.com/Lepid-Labs/city-hall/issues/17); if that review changes the API, the runner follows. Bearer: the runner's usr credential; plus the Cloudflare Access service-token headers when configured:

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
