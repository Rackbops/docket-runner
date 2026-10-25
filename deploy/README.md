# Deploying docket-runner

One stack directory on roshne's host, in research-triage's shape: `answers.env` is the only file an
operator edits; `rt render` derives the two files compose and the container read.

| File | Where | What |
|---|---|---|
| `answers.example.env` | copy to `<stack>/answers.env`, mode 600 | the one source of truth: image tag, the subscription token, the job queue's address, the runner credential, the Access service token (only through the edge), the caps |
| `render.mjs` | `<stack>/render.mjs` | `answers.env` -> `.env` (compose half) + `app.env` (container half); exit 1 names a missing field, exit 2 a forbidden key |
| `compose.yaml.example` | `<stack>/compose.yaml` | one service, outbound only, on the external `docket` network shared with the queue, health published on host loopback, the CLI's home on a named volume |
| `rt` | `<stack>/rt` | the verbs: `render`, `up`, `pull-and-recreate`, `set-image-tag`, `health`, `logs`, `down` |

## Where it runs

The runner polls [Rackbops/city-hall](https://github.com/Rackbops/city-hall), the queue since 2026-10-09 ([Rackbops/job-queue](https://github.com/Rackbops/job-queue) before it). In production both run on one host, each in its own stack, and both join an external Docker network named `docket`: the runner reaches the queue as `http://city-hall:8510`, the queue's container name, and never crosses the edge, so the Access pair can stay blank. Clients on other hosts reach the queue through its own Cloudflare Tunnel and Access; that sidecar lives in city-hall's stack, not here.

A runner on a host without the queue deletes the two `networks` blocks from `compose.yaml`, sets `CITY_HALL_URL` to the queue's public `https` hostname, and fills the `CF_ACCESS_*` pair.

## Bring-up

1. `mkdir -p /opt/docket-runner/prod && cd /opt/docket-runner/prod`; copy the four files above into it (the stack directory's name becomes the compose project name: `docket-runner-prod`). If the host has no `docket` network yet (`docker network ls`), `docker network create docket`; city-hall's stack joins the same one.
2. `claude setup-token` on any machine where you are logged in to Claude Code; paste the result as `CLAUDE_CODE_OAUTH_TOKEN`. Fill `CITY_HALL_URL` (`http://city-hall:8510` on the queue's host), `CITY_HALL_RUNNER_TOKEN` (the `token` of this runner's entry in the queue's `CITY_HALL_RUNNERS`), the `CF_ACCESS_*` pair only when going through the edge, and `IMAGE_TAG` (a published `x.y.z` or `sha-<7>`). Optionally fill `FIRECRAWL_API_KEY` (a Firecrawl key, from firecrawl.dev) so research Jobs can use Firecrawl's search and scrape; left blank, those Jobs run without them and the runner logs a warning. `chmod 600 answers.env`.
3. `./rt render` -- refuses `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` with exit 2.
4. `./rt up` -- pulls the public image, starts the runner, waits for `/readyz`.
5. `./rt health` -- shows the probe verdict (`auth.ok`), the CLI version and the loop state.

## Updating

`./rt set-image-tag <tag> && ./rt render && ./rt pull-and-recreate`. `restart: unless-stopped` never re-checks the registry, so publishing an image deploys nothing until this runs.

First copy `render.mjs` (and `rt`) from `deploy/` at the release's tag over the stack's copies, keeping a backup. The image tag moves the container, not these host files, and a release that adds a setting (0.0.6's `FIRECRAWL_API_KEY`) needs the new `render.mjs`. With the old one, the stack comes up healthy but without the setting.

## Firecrawl

To turn Firecrawl on (or rotate its key) on a running stack: put the key in `answers.env` on the host as `FIRECRAWL_API_KEY=...`, then `./rt render && ./rt pull-and-recreate` (render writes it to `app.env` only, never `.env`). The runner talks to Firecrawl's hosted server at `https://mcp.firecrawl.dev/v2/mcp` with the key as a bearer header, and only for a Job that names a Firecrawl tool. Firecrawl's other endpoint, `/v2/mcp-oauth`, is not used: it needs an interactive browser sign-in, and the runner is headless.

## What never happens here

The image carries no credential; `CLAUDE_CODE_OAUTH_TOKEN` arrives through `app.env` at run time. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are refused at render (exit 2) and at boot. The child environment of every CLI call is built from an allowlist (`src/subprocess-env.ts`: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TERM`, `LANG`, `LANGUAGE`, `TZ`, the `HTTP(S)_PROXY`/`NO_PROXY` names, and anything starting `LC_`, `NODE_` or the test fixture's `FAKE_CLAUDE_`; `NODE_` includes `NODE_OPTIONS`, which only the operator sets), plus the OAuth token, plus the Firecrawl key only for a run that loads Firecrawl. So no `ANTHROPIC_*` or `CLAUDE_CODE_USE_*` variable, the runner token and the Access secret never reach a run. The stack half (`.env`) never enters the container.

One route off the subscription is outside the runner's reach: the CLI reads `~/.claude/settings.json` from the `claude-home` volume, and an `env` block or an `apiKeyHelper` there would apply to every run (code.claude.com/docs/en/settings, checked 2026-10-24). The runner never writes that file. Don't put one there; if the volume ever holds one, read it before the next deploy.

## Stopping and deploying mid-run

`compose.yaml.example` sets `stop_grace_period: 660s`: on SIGTERM the runner finishes the Job in hand and posts its outcome, and the longest Job timeout the tracker sends is 600 s. Once stopping, an outcome post that keeps failing is retried for at most 30 s more (`OUTCOME_RETRY_STOPPING_MS`) before it is given up on, so the total stays inside the grace period. An idle runner stops within its current sleep (1.5 s, up to 15 s while paused). The bound assumes the queue answers: the claim and outcome requests carry no timeout of their own, so a hung queue can still outlast the grace period (a single hung request, not a refused one, is not bounded). The runner takes any `timeoutMs` a Job names but never more than `MAX_TIMEOUT_MS` (default 600000, the tracker's longest, which the 660 s grace is sized for; docket-runner#36), so raising `MAX_TIMEOUT_MS` means raising `stop_grace_period` with it. A stack whose `compose.yaml` was copied before this setting has Docker's 10 s default, which kills a run in progress on every `pull-and-recreate`; copy the new example over it (keeping a backup) to pick it up.
