# Purpose

## Problem being solved

The docket task tracker (the tracker plugin in Rackbops/rackbops-bot-plugins, on the
Rackbops/docket library) needs a model for its agent-driven task types. It submits that model
work to Lepid-Labs/city-hall, which queues it and leases it to a runner. (A plain-language intake
dialogue is deferred, plan item 31, and would run outside city-hall if it is taken up.) roshne's rule is that every
model call runs on roshne's Claude subscription through the Claude Code CLI in print mode, never
an API key, and that the subscription token never sits on a host roshne does not administer.
city-hall runs on the Lepid-Labs edge, so the token cannot live there.

## What docket-runner is

A small service on roshne's own host that holds that one credential. It claims Jobs from
city-hall over an authenticated, outbound-only connection, runs `claude -p` exactly as each Job
describes, and posts the classified result back. It has no idea what a reminder or a gift scout
is; it knows how to run the CLI safely, prove its credential works, and say precisely how a run
ended.

## Non-goals

- Deciding anything about tasks: no prompts of its own, no model choice, no retries.
- Holding any other credential: no Discord token, no usr admin key, no recall access.
- An API-key path. If Anthropic's terms ever require one, it is a new Executor adapter in
  city-hall, not a change here.

Design: Rackbops/Tooling, `research/city-hall-task-tracker.md`, section 5.12. Epic:
Lepid-Labs/city-hall#4, E8.
