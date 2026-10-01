# docket-runner image. Two stages on the same glibc base (never alpine: the Claude CLI's native
# bits get their widest support on Debian).
#   build -- pnpm install + tsc -> /app/dist
#   final -- the compiled output, tini, and the pinned Claude CLI, running as the unprivileged
#            `node` user. No runtime npm dependencies: the runner is stdlib-only on purpose, since
#            this process holds the subscription token. `@rackbops/docket-core` is a devDependency
#            used for types only; the smoke check below refuses a compiled runtime import of it.
#
# Subscription-only is a hard constraint: nothing here (no ARG, no ENV) can carry a credential.
# CLAUDE_CODE_OAUTH_TOKEN arrives at RUN time through compose's env_file and is never baked into a
# layer; loadConfig refuses ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL at boot and
# buildSubprocessEnv strips them from every CLI call regardless.

FROM node:26-bookworm-slim AS build
RUN npm install -g pnpm@12.8.1
WORKDIR /app
# pnpm-workspace.yaml is pnpm's settings file, not a workspace: it carries the minimum-release-age
# exemption for @rackbops/docket-core, and pnpm enforces that policy against the lockfile even
# with --frozen-lockfile, so an install without the file fails on a fresh release of the library.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY scripts ./scripts
RUN pnpm build

FROM node:26-bookworm-slim
# tini is PID 1: node registers no SIGTERM handler as PID 1 and would never reap a grandchild
# orphaned by a claude subprocess; tini forwards the signal and reaps.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
# The Claude CLI, pinned so a rebuild is reproducible and a CLI bump is a Renovate PR
# (renovate.json's custom manager reads this line).
RUN npm install -g @anthropic-ai/claude-code@2.1.285 && npm cache clean --force
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
# Build-time smoke check: the entry point exists and the CLI runs (its version, not its auth).
RUN test -f dist/index.js && ! grep -rq 'from "@rackbops/' dist && claude --version
ENV NODE_ENV=production \
  HOME=/home/node \
  HEALTH_PORT=8787 \
  HEALTH_BIND=0.0.0.0
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node
USER node
EXPOSE 8787
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
