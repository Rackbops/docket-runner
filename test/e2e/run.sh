#!/usr/bin/env bash
# The end-to-end check of the tracker's model lane (`just e2e`): the tracker plugin's city-hall
# executor submits research Jobs to a real local city-hall, docket-runner claims them and runs the
# fake CLI (test/fixtures/fake-claude.mjs), and the result goes back to the tracker. Everything
# listens on 127.0.0.1; no model, no Claude credential, no network beyond the installs.
#
#   CITY_HALL_DIR=<Lepid-Labs/city-hall checkout> BOT_PLUGINS_DIR=<rackbops-bot-plugins checkout> \
#     just e2e
#
# Each checkout must be at its pin in test/e2e/pins.env (E2E_ALLOW_UNPINNED=1 runs anyway, with a
# warning). Needs node >= 24, pnpm, bun and git on PATH. Installs and builds city-hall in its
# checkout, installs the plugins checkout; `just e2e` builds this repo first. Logs go to
# $E2E_OUT (default: a new temp directory), kept and named on failure.
#
# No CI job runs this yet: it needs read access to Lepid-Labs/city-hall, which is private (and so
# is its GHCR image). When that is granted, the job is this repo's usual setup (just, pnpm, node,
# plus oven-sh/setup-bun), two actions/checkout steps at the pins (`ref:` from pins.env, `path:`
# outside the workspace's src/), and `just e2e` with CITY_HALL_DIR and BOT_PLUGINS_DIR set.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
FAKE="$ROOT/test/fixtures/fake-claude.mjs"
# shellcheck source=pins.env
. "$HERE/pins.env"

say() { printf 'e2e: %s\n' "$*"; }
die() {
  printf 'e2e: FAIL: %s\n' "$*" >&2
  exit 1
}

# --- the subscription-only rule: nothing here may carry an API-billing variable -----------------
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL

# --- inputs ---------------------------------------------------------------------------------------
check_checkout() { # $1 variable name, $2 pin
  local name=$1 pin=$2 dir head
  dir=${!name:-}
  [ -n "$dir" ] || die "$name is not set: point it at a checkout (at $pin)"
  [ -d "$dir" ] || die "$name=$dir is not a directory"
  head=$(git -C "$dir" rev-parse HEAD 2>/dev/null) || die "$name=$dir is not a git checkout"
  if [ "$head" != "$pin" ]; then
    if [ "${E2E_ALLOW_UNPINNED:-}" = "1" ]; then
      say "WARNING: $name is at $head, not the pin $pin (E2E_ALLOW_UNPINNED=1)"
    else
      die "$name=$dir is at $head, not the pin $pin (test/e2e/pins.env); check out the pin, or set E2E_ALLOW_UNPINNED=1"
    fi
  fi
  printf '%s' "$(cd "$dir" && pwd)"
}
CITY_HALL_DIR=$(check_checkout CITY_HALL_DIR "$CITY_HALL_PIN")
BOT_PLUGINS_DIR=$(check_checkout BOT_PLUGINS_DIR "$BOT_PLUGINS_PIN")
export BOT_PLUGINS_DIR

for tool in node pnpm bun git curl pgrep; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 24 ] || die "node $(node --version) is too old: city-hall needs node:sqlite (>= 24)"
[ -f "$ROOT/dist/index.js" ] || die "dist/index.js is missing: run \`just build\` (\`just e2e\` does)"

OUT=${E2E_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/docket-runner-e2e.XXXXXX")}
mkdir -p "$OUT"
say "node $(node --version), bun $(bun --version); logs in $OUT"

# --- install and build the checkouts --------------------------------------------------------------
say "installing and building city-hall"
(cd "$CITY_HALL_DIR" && pnpm install --frozen-lockfile && pnpm run build) >"$OUT/city-hall-build.log" 2>&1 ||
  die "city-hall install or build failed: $OUT/city-hall-build.log"
say "installing rackbops-bot-plugins"
(cd "$BOT_PLUGINS_DIR" && bun install --frozen-lockfile) >"$OUT/bot-plugins-install.log" 2>&1 ||
  die "rackbops-bot-plugins install failed: $OUT/bot-plugins-install.log"

# --- process bookkeeping: everything started here is stopped on any exit --------------------------
PIDS=()
cleanup() {
  local rc=$? p
  for p in "${PIDS[@]}"; do
    kill -CONT "$p" 2>/dev/null || true
    kill "$p" 2>/dev/null || true
  done
  # A fake CLI left by a runner stopped mid-run (the lost-lease one sleeps for a minute).
  for p in "$OUT"/*.pid; do
    [ -f "$p" ] && kill "$(cat "$p")" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  if [ "$rc" -ne 0 ]; then
    printf 'e2e: failed; logs kept in %s\n' "$OUT" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

free_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

KEY=e2e-source-key-not-a-secret
TOKEN_A=e2e-runner-a-token
TOKEN_B=e2e-runner-b-token
TOKEN_X=e2e-runner-x-token
CAPABILITY=claude-cli:subscription
export E2E_CITY_HALL_KEY=$KEY E2E_CAPABILITY=$CAPABILITY

start_city_hall() { # $1 scenario, $2 lease seconds
  local port
  port=$(free_port)
  export E2E_CITY_HALL_URL="http://127.0.0.1:$port"
  # Two runners carry the tracker's capability tag; runner-x carries another one.
  CITY_HALL_DB="$OUT/$1.city-hall.db" CITY_HALL_API_KEY="$KEY" CITY_HALL_POLL_INTERVAL=0 \
    CITY_HALL_REGISTRY_URL=http://127.0.0.1:9 CITY_HALL_LEASE_SECONDS="$2" PORT="$port" \
    CITY_HALL_GITHUB_TOKEN='' CITY_HALL_GITHUB_ORG_TOKEN='' \
    CITY_HALL_RUNNERS="[{\"id\":\"runner-a\",\"token\":\"$TOKEN_A\",\"tags\":[\"$CAPABILITY\"]},{\"id\":\"runner-b\",\"token\":\"$TOKEN_B\",\"tags\":[\"$CAPABILITY\"]},{\"id\":\"runner-x\",\"token\":\"$TOKEN_X\",\"tags\":[\"other-tag\"]}]" \
    node "$CITY_HALL_DIR/dist/server/index.js" >"$OUT/$1.city-hall.log" 2>&1 &
  CITY_HALL_PID=$!
  PIDS+=("$CITY_HALL_PID")
  for _ in $(seq 100); do
    curl -fsS "$E2E_CITY_HALL_URL/api/health" >/dev/null 2>&1 && return 0
    kill -0 "$CITY_HALL_PID" 2>/dev/null || break
    sleep 0.1
  done
  cat "$OUT/$1.city-hall.log" >&2
  die "$1: city-hall did not start"
}

stop() { # pid...
  local p
  for p in "$@"; do
    kill -CONT "$p" 2>/dev/null || true
    kill "$p" 2>/dev/null || true
    wait "$p" 2>/dev/null || true
  done
}

start_runner() { # $1 log name, $2 token, $3 FAKE_CLAUDE_MODE, [$4 delay ms]
  CITY_HALL_URL="$E2E_CITY_HALL_URL" CITY_HALL_RUNNER_TOKEN="$2" \
    CLAUDE_CODE_OAUTH_TOKEN=e2e-fake-not-a-token CLAUDE_BIN="$FAKE" \
    FAKE_CLAUDE_MODE="$3" FAKE_CLAUDE_DELAY_MS="${4:-400}" FAKE_CLAUDE_PID_FILE="$OUT/$1.pid" \
    POLL_INTERVAL_MS=200 HEALTH_PORT=0 HEALTH_BIND=127.0.0.1 \
    node "$ROOT/dist/index.js" >"$OUT/$1.runner.log" 2>&1 &
  RUNNER_PID=$!
  PIDS+=("$RUNNER_PID")
}

drive() { # $1 scenario, then driver options
  local name=$1
  shift
  bun "$HERE/drive-tracker.ts" "$name" --id-file "$OUT/$name.id" "$@" >"$OUT/$name.tracker.jsonl" ||
    {
      cat "$OUT/$name.tracker.jsonl" >&2
      die "$name: the tracker's answer was not the expected one (above)"
    }
}

job() { # $1 scenario: city-hall's view of the scenario's job, as the source reads it
  curl -fsS -H "Authorization: Bearer $KEY" "$E2E_CITY_HALL_URL/api/execute/jobs/$(cat "$OUT/$1.id")"
}

expect_job() { # $1 scenario, $2 JS expression over `j` (the GET body) that must be true
  local body
  body=$(job "$1") || die "$1: could not read the job back from city-hall"
  printf '%s\n' "$body" >"$OUT/$1.job.json"
  node -e 'const j=JSON.parse(process.argv[1]);process.exit(eval(process.argv[2])?0:1)' "$body" "$2" ||
    die "$1: city-hall's job does not satisfy \`$2\`: $body"
}

wait_log() { # $1 file, $2 fixed string, $3 seconds
  for _ in $(seq $(($3 * 10))); do
    grep -qF -- "$2" "$1" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}

PASSED=()
pass() {
  PASSED+=("$1")
  say "PASS $1"
}
T0=$(date +%s)

# --- 1. happy path: a research Job answered in the research schema -------------------------------
start_city_hall happy 120
start_runner happy "$TOKEN_A" research
drive happy --expect result --kind success --answer
expect_job happy 'j.job.status==="done" && j.job.runner==="runner-a" && j.job.result.kind==="success"'
stop "$RUNNER_PID" "$CITY_HALL_PID"
pass "happy path: success, and parseAnswer accepts the answer"

# --- 2. CLI outcomes that end the Job: the tracker gets the runner's classification ---------------
for case in success:schema_miss max_turns:turn_cap budget:budget_cap crash:error garbage:error; do
  mode=${case%%:*}
  kind=${case##*:}
  start_city_hall "cli-$mode" 120
  start_runner "cli-$mode" "$TOKEN_A" "$mode"
  drive "cli-$mode" --expect result --kind "$kind"
  expect_job "cli-$mode" "j.job.status===\"failed\" && j.job.result.kind===\"$kind\""
  stop "$RUNNER_PID" "$CITY_HALL_PID"
  pass "fake mode $mode: $kind"
done

# --- 3. outcomes city-hall requeues: the tracker sees unavailable, not a result -------------------
for case in auth401:auth_failed limit:usage_limit; do
  mode=${case%%:*}
  kind=${case##*:}
  start_city_hall "requeue-$mode" 120
  start_runner "requeue-$mode" "$TOKEN_A" "$mode"
  drive "requeue-$mode" --expect unavailable --detail "requeued the job after $kind"
  stop "$RUNNER_PID"
  # A limit whose reset time is past lets the runner claim again at once, so the job may be
  # running again; either way its last claim ended in $kind and nothing finished it.
  expect_job "requeue-$mode" "[\"queued\",\"running\"].includes(j.job.status) && j.job.lastOutcome===\"$kind\" && j.job.attempts>=1 && j.job.result.kind===\"$kind\""
  stop "$CITY_HALL_PID"
  pass "fake mode $mode: $kind, requeued, tracker unavailable"
done

# --- 4. wiring negatives --------------------------------------------------------------------------
start_city_hall wiring 120
drive wrong-key --key e2e-not-the-source-key --expect unavailable --detail "HTTP 401" --timeout-ms 3000
pass "wrong source key: 401, tracker unavailable"

start_runner bad-token e2e-unknown-runner-token research
wait_log "$OUT/bad-token.runner.log" '"error":"claim: HTTP 401"' 10 ||
  die "bad-token: the runner never logged a claim 401: $(cat "$OUT/bad-token.runner.log")"
stop "$RUNNER_PID"
pass "unknown runner token: claim 401"

start_runner wrong-tag "$TOKEN_X" research
X_PID=$RUNNER_PID
drive wrong-tag --expect pending --hold-ms 3000 --timeout-ms 10000
if grep -qF '"job claimed"' "$OUT/wrong-tag.runner.log"; then
  die "wrong-tag: runner-x (tag other-tag) claimed a $CAPABILITY job"
fi
expect_job wrong-tag 'j.job.status==="queued" && j.job.attempts===0'
stop "$X_PID"
# The same job is claimable: a runner with the tag takes it, so the negative above is not vacuous.
start_runner wrong-tag-drain "$TOKEN_A" research
for _ in $(seq 100); do
  job wrong-tag | grep -qF '"status":"done"' && break
  sleep 0.1
done
expect_job wrong-tag 'j.job.status==="done" && j.job.runner==="runner-a"'
stop "$RUNNER_PID" "$CITY_HALL_PID"
pass "wrong capability tag: never claims (and a tagged runner then does)"

# --- 5. lost lease (docket-runner#17) -------------------------------------------------------------
# Runner A claims a slow Job and is frozen (SIGSTOP) past its 4 s lease; runner B takes the Job and
# finishes it. When A thaws, its heartbeat is refused: it must stop its CLI and post nothing.
# Only the outcome is asserted, not the job's status in between (city-hall requeues an expired
# lease when a runner next claims, not when it expires).
start_city_hall lease 4
start_runner lease-a "$TOKEN_A" slow 60000
A_PID=$RUNNER_PID
bun "$HERE/drive-tracker.ts" lease --id-file "$OUT/lease.id" --expect result --kind success \
  --answer --timeout-ms 60000 >"$OUT/lease.tracker.jsonl" &
DRIVER_PID=$!
PIDS+=("$DRIVER_PID")
wait_log "$OUT/lease-a.runner.log" '"job claimed"' 20 || die "lease: runner A never claimed"
# The Job's CLI, found by its --json-schema flag: the runner's start-up auth probe runs the same
# fake (and writes the same pid file) without one.
A_CLI=
for _ in $(seq 50); do
  A_CLI=$(pgrep -P "$A_PID" -f -- '--json-schema' || true)
  [ -n "$A_CLI" ] && break
  sleep 0.1
done
[ -n "$A_CLI" ] || die "lease: runner A's CLI never started"
kill -STOP "$A_PID"
sleep 6
start_runner lease-b "$TOKEN_B" research
B_PID=$RUNNER_PID
wait "$DRIVER_PID" || {
  cat "$OUT/lease.tracker.jsonl" >&2
  die "lease: the tracker did not get runner B's result (above)"
}
expect_job lease 'j.job.status==="done" && j.job.runner==="runner-b" && j.job.result.kind==="success" && j.runs.some(r=>r.runner==="runner-a" && r.outcome==="lease_expired")'
kill -CONT "$A_PID"
wait_log "$OUT/lease-a.runner.log" 'job abandoned: lease lost; CLI stopped, no outcome posted' 15 ||
  die "lease: runner A did not abandon the job: $(cat "$OUT/lease-a.runner.log")"
for _ in $(seq 100); do
  kill -0 "$A_CLI" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$A_CLI" 2>/dev/null; then die "lease: runner A's CLI (pid $A_CLI) is still running"; fi
if grep -qE '"(job finished|outcome refused|outcome post failed)"' "$OUT/lease-a.runner.log"; then
  die "lease: runner A tried to post an outcome: $(cat "$OUT/lease-a.runner.log")"
fi
expect_job lease 'j.job.status==="done" && j.job.runner==="runner-b" && j.job.attempts===2'
stop "$A_PID" "$B_PID" "$CITY_HALL_PID"
pass "lost lease: B finishes, A's CLI stopped and its outcome never posted"

say "all ${#PASSED[@]} scenarios passed in $(($(date +%s) - T0)) s:"
printf '  %s\n' "${PASSED[@]}"
