# In-cluster Emulate Slack for the AX lane. Build from the repository root:
#   docker buildx build --platform linux/amd64 -f profiles/ax/emulate/Dockerfile -t <repo>/apl-emulate .
# Base pinned by index digest (resolved 2026-10-28); emulate pinned by this directory's lockfile (ADR-10),
# then patched with the repository's hash-checked scripts/patch-emulate.mjs (L-001).
FROM node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
WORKDIR /app
COPY profiles/ax/emulate/package.json profiles/ax/emulate/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY scripts/patch-emulate.mjs scripts/patch-emulate.mjs
RUN node scripts/patch-emulate.mjs
COPY profiles/ax/emulate/server.mjs ./
USER node
EXPOSE 8080 8081
ENTRYPOINT ["node", "server.mjs"]
