# Environment

The tested host and the pinned dependency set for the local profile. Versions come from `DEPENDENCIES.lock.json`; the timings below were measured on 2026-10-28 and are single-host observations, not performance claims.

## Tested host

| Item | Value |
|---|---|
| OS / arch | macOS 27.0.1, arm64 (Apple silicon) |
| CPU / RAM | 18 cores, 128 GiB |
| Node / npm | 24.22.1 / 11.19.1 |
| Container runtime | Docker Desktop 29.9.2 |
| Python (supplied evaluator only) | 3.14.8 |

No other OS or architecture has been tested. Floci's image is published for `linux/amd64` and `linux/arm64`; `better-sqlite3` builds its native module at install time, so Linux needs a C/C++ toolchain if no prebuilt binary matches. Treat other platforms as UNKNOWN until run.

## Pinned dependencies

| Package | Version | License |
|---|---|---|
| emulate | 0.12.3 (locally patched, see below) | Apache-2.0 |
| fastify | 5.12.7 | MIT |
| better-sqlite3 | 13.0.3 | MIT |
| @aws-sdk/client-s3, @aws-sdk/client-sqs | 3.1151.0 | Apache-2.0 |
| ajv | 8.20.0 | MIT |
| commander | 15.0.0 | MIT |
| vitest / vite | 5.0.4 / 8.3.4 | MIT |
| tsx / typescript | 4.23.15 / 7.0.2 | MIT / Apache-2.0 |
| @playwright/test | 1.64.1 | Apache-2.0 |
| Image `floci/floci:2.3.0` | `sha256:e0b292df4dc9559b7b1bf4f51bdda4bb8e269276236438cd03cae661260ea8a9` | MIT |

`npm install` runs `scripts/patch-emulate.mjs`, which adds the `slack.event_subscriptions` seed key to emulate 0.12.3 (LEARNINGS L-001, ADR-10). It prints that it applied the patch, or exits silently when the patch is already present, and refuses to touch any file whose hash it does not recognise.

## Prerequisites

`npm run lab -- doctor` checks them without any network call: Node 24.x, a reachable Docker daemon, the pinned Floci image present locally, the emulate patch, and a loadable `better-sqlite3`. A missing prerequisite reports BLOCKED and exits 2. No provider account or LLM key is needed for the local profile.

## Setup timings

Three runs each, raw values in seconds, measured with other unrelated workloads running on the same host.

| Step | Run 1 | Run 2 | Run 3 | Notes |
|---|---|---|---|---|
| Cold `npm ci` (fresh, empty `--cache` directory) | 7.9 | 6.7 | 9.0 | Network fetch from the npm registry |
| Warm `npm ci` (populated default cache) | 7.9 | 18.1 | 31.2 | Includes deleting the previous `node_modules`; host was under concurrent load, so warm was not faster here |
| Warm stack start (manifest + `docker compose up --wait` + Floci ready) | 1.6 | 1.2 | 1.6 | Pinned image already pulled |
| Scoped teardown (`stopRun`) | 0.6 | 1.5 | 0.7 | Cleanup status CLEAN every time |

Not measured: a cold image pull. Removing the pinned Floci image would have disrupted other runs sharing this Docker host, so the cold-pull time is NOT_RUN. Emulate Slack instances start in-process and are added to these timings in later tasks.

## Run isolation

Every run gets a UUID run ID, its own loopback ports, its own SQLite file under `private-runs/<run_id>/`, and its own Docker Compose project `apl-<12 hex>`. All of its containers carry the label `dev.agent-proof-lab.run-id=<run_id>`. `npm run lab -- down --run-id <id>` removes only the resources recorded in that run's manifest or carrying that exact label, and it keeps the evidence directory.
