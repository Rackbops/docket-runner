# The web-search spike

The plan of record lists "Web tools in the run" as a risk: `WebSearch` and `WebFetch` are
available to `claude -p` and scoped by `--allowedTools`, but nobody has shown that the results are
good enough for the scout, the want-list watcher and one-off research (categories 1, 2 and 5).
E8 answers it with a one-day spike before anything else is built there (Rackbops/Tooling
`research/city-hall-task-tracker.md`, section 6 and section 7's E8). This folder is that spike.

It runs three cases, one per category, through the runner's own `buildArgs` (the flags,
including the read-and-web tool allowlist and the shell and file denylist),
`buildSubprocessEnv` (no API-key variable reaches the CLI) and `classify` (the outcome kinds).
It skips the runner's claim loop and allows 600 s a case where the runner defaults to 120 s.
What it adds is a link check on the URLs a result cites, and a report for a person to grade. It
never talks to city-hall.

The runner runs in a clean container; the spike runs on a desktop, inside that person's Claude
setup. So it also passes `--tools WebSearch,WebFetch`, which leaves the run no other tool at all,
and `--strict-mcp-config`, which loads none of that person's MCP servers. It runs the CLI from an
empty temporary directory, so no repo's `CLAUDE.md` reaches it. With `CLAUDE_CODE_OAUTH_TOKEN` set
it also gives the CLI an empty config directory, so no user `CLAUDE.md`, hooks or settings load
either. That is the closest match to the runner, and the one to use if the numbers matter.

## Run it

On roshne's machine, in a checkout of this repo, with the Claude CLI logged in to the
subscription:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm spike                          # all three cases, once each
pnpm spike --case scout --repeat 3  # one case, three times
```

- **Cost.** Each run is capped at 20 turns and 1 USD of the CLI's estimate
  (`spike/cases.json`); the CLI checks the cap between turns, so a run can end a little over it.
  All three cases once is about 3 USD of estimated usage from the shared five-hour window, and
  `--repeat` multiplies that. It is an estimate against the subscription, not a bill. A usage
  limit or a failed login stops the run cleanly; resume later with `--case` for what is left.
- **Credential.** The spike uses the CLI's own login on the machine, or
  `CLAUDE_CODE_OAUTH_TOKEN` when that is set. It refuses to start while `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` is set, as the runner does.
- **Where the results go.** `spike-results/<time>/` (gitignored), or `--out <dir>`: one JSON file
  per run (the Job, the classified result, the link check) and `report.md`. They stay on the
  machine: they can hold whatever the web returned.
- **Other options.** `--model <name>` picks the model (the CLI's default otherwise),
  `--no-link-check` skips the link GETs (at most 30 per run, 10 s each), and `--claude-bin
  <path>` names the CLI. The spike spawns without a shell, so on Windows a `claude.cmd` shim
  cannot run: pass the full path to `claude.exe` if `claude` fails (inferred, not tried).

## What it should tell us

Grade each run in `report.md` on four scores: relevant, true, sourced, honest. Then answer
these, which is what E8 needs to decide:

1. Is the research answer good enough to DM as is, or does it need the reviewer pass that
   category 5 plans (a second Job)?
2. Does the scout find current things through the lens, or recycle evergreen lists?
3. Does the want-list run find real listings, give seller signals with sources, and say "not
   found" rather than invent one? This one decides how much of category 2 must be plain-code
   source adapters (the eBay Browse API, items 20 and 26) rather than web search.
4. What turn and budget caps do the types need? The runner's defaults are 8 turns and 0.5 USD;
   the report shows what each case actually used.

Edit `cases.json` to match real asks before the run if you like: the prompts and schemas are the
first draft of what the types' `prepare` will send.

## Check it without a model

The runner's test double stands in for the CLI. It is a script with a shebang, so this works on
Linux, macOS or WSL, not from a Windows shell:

```sh
pnpm build
FAKE_CLAUDE_MODE=schema pnpm spike --claude-bin test/fixtures/fake-claude.mjs --no-link-check --out /tmp/spike-dry
```

`spike/lib.test.mjs` (part of `pnpm test`) covers the argument parsing, the URL extraction and
the report.
