# Deploying docket-runner

One stack directory on roshne's host, in research-triage's shape: `answers.env` is the only file an
operator edits; `rt render` derives the two files compose and the container read.

| File | Where | What |
|---|---|---|
| `answers.example.env` | copy to `<stack>/answers.env`, mode 600 | the one source of truth: image tag, the subscription token, city-hall's address, the runner credential, the Access service token, the caps |
| `render.mjs` | `<stack>/render.mjs` | `answers.env` -> `.env` (compose half) + `app.env` (container half); exit 1 names a missing field, exit 2 a forbidden key |
| `compose.yaml.example` | `<stack>/compose.yaml` | one service, outbound only, health published on host loopback, the CLI's home on a named volume |
| `rt` | `<stack>/rt` | the verbs: `render`, `up`, `pull-and-recreate`, `set-image-tag`, `health`, `logs`, `down` |

## Bring-up

1. `mkdir -p /opt/docket-runner/prod && cd /opt/docket-runner/prod`; copy the four files above into it (the stack directory's name becomes the compose project name: `docket-runner-prod`).
2. `claude setup-token` on any machine where you are logged in to Claude Code; paste the result as `CLAUDE_CODE_OAUTH_TOKEN`. Fill `CITY_HALL_URL`, `CITY_HALL_RUNNER_TOKEN` (from usr; its shape is proposed on Lepid-Labs/city-hall#2 and still open, plan item 25), the `CF_ACCESS_*` pair, and `IMAGE_TAG` (a published `x.y.z` or `sha-<7>`). `chmod 600 answers.env`.
3. `./rt render` -- refuses `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` with exit 2.
4. `./rt up` -- pulls the public image, starts the runner, waits for `/readyz`.
5. `./rt health` -- shows the probe verdict (`auth.ok`), the CLI version and the loop state.

## Updating

`./rt set-image-tag <tag> && ./rt render && ./rt pull-and-recreate`. `restart: unless-stopped` never re-checks the registry, so publishing an image deploys nothing until this runs.

## What never happens here

The image carries no credential; `CLAUDE_CODE_OAUTH_TOKEN` arrives through `app.env` at run time and is stripped from nothing else. No `ANTHROPIC_*` variable is accepted at render, at boot, or in the child environment of any CLI call. The stack half (`.env`) never enters the container.
