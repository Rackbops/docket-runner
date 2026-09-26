# docket-runner -- runs claude -p Jobs for the docket tracker on roshne's subscription
# Requires: just, node >= 24, pnpm (the version in package.json's packageManager)

default:
    @just --list

# Install dependencies
install:
    pnpm install --frozen-lockfile

# Run all checks: lint, typecheck (src + test), tests (vitest + the render script's), build
check: lint typecheck test build

# Lint and check formatting
lint:
    pnpm biome check .

# Fix lint and formatting issues
fix:
    pnpm biome check --write .

# Type-check sources and tests
typecheck:
    pnpm typecheck

# Run the tests: vitest against the fake claude, then deploy/render.test.mjs
test:
    pnpm test

# Compile src/ to dist/
build:
    pnpm build

# Run from dist/ with the current environment (needs CLAUDE_CODE_OAUTH_TOKEN, CITY_HALL_URL, CITY_HALL_RUNNER_TOKEN)
start: build
    pnpm start

# Build the container image locally, tagged docket-runner:local
docker-build:
    docker build -t docket-runner:local .

# Bump the version (no commit, no tag); then commit `chore(release): v<version>`, tag, push with tags
version version:
    npm version {{version}} --no-git-tag-version

# Remove build artifacts and node_modules
clean:
    rm -rf node_modules dist coverage *.tsbuildinfo

fresh: clean install
