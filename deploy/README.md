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

The runner polls [Rackbops/job-queue](https://github.com/Rackbops/job-queue) (the `CITY_HALL_*` names are the shipped ones from when city-hall was the queue; they stay). In production both run on one host, each in its own stack, and both join an external Docker network named `docket`: the runner reaches the queue as `http://job-queue:8080`, the queue's container name, and never crosses the edge, so the Access pair can stay blank. Clients on other hosts reach the queue through its own Cloudflare Tunnel and Access; that sidecar lives in job-queue's stack, not here.

A runner on a host without the queue deletes the two `networks` blocks from `compose.yaml`, sets `CITY_HALL_URL` to the queue's public `https` hostname, and fills the `CF_ACCESS_*` pair.

## Bring-up

1. `mkdir -p /opt/docket-runner/prod && cd /opt/docket-runner/prod`; copy the four files above into it (the stack directory's name becomes the compose project name: `docket-runner-prod`). If the host has no `docket` network yet (`docker network ls`), `docker network create docket`; job-queue's stack joins the same one.
2. `claude setup-token` on any machine where you are logged in to Claude Code; paste the result as `CLAUDE_CODE_OAUTH_TOKEN`. Fill `CITY_HALL_URL` (`http://job-queue:8080` on the queue's host), `CITY_HALL_RUNNER_TOKEN` (the `token` of this runner's entry in the queue's `JOB_QUEUE_RUNNERS`), the `CF_ACCESS_*` pair only when going through the edge, and `IMAGE_TAG` (a published `x.y.z` or `sha-<7>`). `chmod 600 answers.env`.
3. `./rt render` -- refuses `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` with exit 2.
4. `./rt up` -- pulls the public image, starts the runner, waits for `/readyz`.
5. `./rt health` -- shows the probe verdict (`auth.ok`), the CLI version and the loop state.

## Updating

`./rt set-image-tag <tag> && ./rt render && ./rt pull-and-recreate`. `restart: unless-stopped` never re-checks the registry, so publishing an image deploys nothing until this runs.

## What never happens here

The image carries no credential; `CLAUDE_CODE_OAUTH_TOKEN` arrives through `app.env` at run time and is stripped from nothing else. No `ANTHROPIC_*` variable is accepted at render, at boot, or in the child environment of any CLI call. The stack half (`.env`) never enters the container.
