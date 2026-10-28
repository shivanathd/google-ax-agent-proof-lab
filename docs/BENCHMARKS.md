# Benchmarks

Descriptive timings from one laptop, taken to satisfy the spec's performance NFR and BUILD_PLAN §4. They describe this machine on this day. They are not performance claims about the lab, Emulate, Floci or any other tool, and they support no comparison.

The raw record is [`artifacts/bench/2026-10-28T14-26-41-782Z.json`](../artifacts/bench/2026-10-28T14-26-41-782Z.json), produced by `npm run bench` ([`scripts/bench/run.ts`](../scripts/bench/run.ts)). Every number below is copied from it.

## Environment fingerprint

| Item | Value |
|---|---|
| OS / arch | macOS 27.0.1, arm64 |
| CPU count / RAM | 18 / 128 GiB |
| Node / npm | v24.22.1 / 11.19.1 |
| Docker server | 29.9.2 (Docker Desktop) |
| Load average (1, 5, 15 min) at start | 7.95, 18.76, 21.87 |
| Load average at end | 11.86, 15.46, 19.59 |
| Candidate | commit `4935584`, tree `721110b062ecde0e2941943b6fb685114b07a9a6`, `dirty: false` |
| Recorded | 2026-10-28T14:26:41Z (start of the run) |

The candidate tree differs from the claim-ledger tree (`0f0c432e5c16`) only by `scripts/bench/run.ts`, the `bench` entry in `package.json` and a mutation record. No application code differs.

Other agents' builds and containers were running on the same host throughout. The load averages show it: an 18-core machine at 8 to 22.

## Methodology

**Setup, cold vs warm, ×3 each.** Each install runs `npm ci --no-audit --no-fund` in a fresh temp directory holding a copy of `package.json`, `package-lock.json` and the postinstall patch script. This checkout's `node_modules` is never touched.

- *Cold* points `npm_config_cache` at a new, empty temp directory. A separate check confirmed that a cold install really fetches: the empty cache grew to 51 MB.
- *Warm* uses the default npm cache.
- The user's cache is never cleared and no image is removed.

**Image pull: NOT_RUN.** Removing the pinned Floci image could disrupt other lab runs sharing this Docker host, as in [`ENVIRONMENT.md`](ENVIRONMENT.md).

**Per-workflow wall clock, n=5 each.** Each workflow gets its own run (`startRun`, one run ID) with the real worker, Emulate and Floci.

- The clock starts at the worker's own record of the signed callback: `inbox.received_at` for W01 and W03, and the approval's `resolved_at` for W02, which is set when the signed button action is processed.
- It stops when the collector's clients first see the complete final state. Those are the reader Slack token, the collector's own S3 key and a read-only SQLite handle. The bench uses the collector's own code (`Probe`, `captureTicket`, `captureApproval`) in the bench process.
- Final state means:
  - W01: one ticket, one matching S3 receipt and one completion reply;
  - W02: approved, receipt committed, one resolve action, S3 receipt present and one "approved by" reply;
  - W03: version advanced, description changed and the matching reply.
- The poll interval is 10 ms, so each value carries up to one poll plus one observation of delay. Both clocks are this host's wall clock.

**Collection overhead.** Two numbers, because "overhead" can mean either:

- *observe_ms*: one complete independent observation pass, timed after the final state was reached. This is the collector's own cost.
- *collect-case whole command*: `lab collect-case --case F3-A1` end to end (stack start, stimulus, collection, report, teardown), ×3.

**Evaluator run-all.** `bash docs/spec/active/2026-10-28-agent-proof-lab/evals/run-all.sh` once, timed end to end.

Only raw values and min/median/max are reported. There are no percentiles and no inferential statistics (spec NFR).

## Results

### Setup (seconds)

| Step | Run 1 | Run 2 | Run 3 | min / median / max |
|---|---|---|---|---|
| Cold `npm ci` (empty temp cache) | 3.8 | 4.1 | 4.0 | 3.8 / 4.0 / 4.1 |
| Warm `npm ci` (default cache) | 11.1 | 3.5 | 3.4 | 3.4 / 3.5 / 11.1 |
| Floci image pull | NOT_RUN | NOT_RUN | NOT_RUN | see methodology |

All six installs exited 0. Cold and warm are about the same: on this network the fetch is a small part of `npm ci`. The 11.1 s warm value came first, under higher load. An earlier, single-host measurement in `ENVIRONMENT.md` (6.7 to 9.0 s cold; 7.9 to 31.2 s warm) was taken while other agents were installing at the same time.

### Callback receipt to independently verified final state (milliseconds)

| Workflow | Run ID | Rep 1 | Rep 2 | Rep 3 | Rep 4 | Rep 5 | min / median / max |
|---|---|---|---|---|---|---|---|
| W01 service request | `42bb1f6b-e41b-4de2-b46a-e62631e3eb50` | 71 | 19 | 17 | 17 | 18 | 17 / 18 / 71 |
| W02 approval | `84a91a9a-dadf-4a07-973e-4fb4b88c74f5` | 27 | 23 | 22 | 23 | 20 | 20 / 23 / 27 |
| W03 CRM update | `5b7acbfe-1b97-4b9a-8564-974a1c64d49f` | 41 | 15 | 14 | 14 | 13 | 13 / 14 / 41 |

All 15 repetitions reached the verified state; none timed out. The first repetition of each workflow was the slowest every time. From the coordinator's post (or click, for W02) to verified, the times were:

- W01: 84, 21, 19, 19, 19 ms;
- W02: 31, 25, 24, 26, 22 ms;
- W03: 52, 16, 16, 15, 14 ms.

### Collection overhead

| Measure | Values | min / median / max |
|---|---|---|
| observe_ms, W01 (ledger + S3 + Slack thread) | 5, 4, 4, 4, 4 ms | 4 / 4 / 5 |
| observe_ms, W02 (ledger + S3 + Slack thread) | 5, 4, 4, 3, 4 ms | 3 / 4 / 5 |
| observe_ms, W03 (ledger + Slack thread) | 1, 1, 1, 1, 1 ms | 1 / 1 / 1 |
| `collect-case --case F3-A1`, whole command | 3.3, 3.1, 3.3 s (runs `e16abef0-6171-4dbe-8bcd-04fde5275f32`, `95abc1a9-59ad-428c-bfb2-68a5d066c6e3`, `05330766-c388-4726-8f28-1f7bf944d6ec`) | 3.1 / 3.3 / 3.3 |

Relative to the W01 workflow median of 18 ms, one observation pass (median 4 ms) is about 22%. The whole `collect-case` command is about 180 times the workflow. Most of it is stack start and teardown, the case's fixed 500 ms settle wait, and the coordinator's 100 ms polling.

### Evaluator run-all

| Measure | Value |
|---|---|
| `run-all.sh` wall clock | 260.6 s |
| Exit code / verdict | 2 / `BLOCKED` (task 6.1, F6 and S4 have no console in this tree; everything else PASS) |

The earlier harness run used for the claim ledger (tree `0f0c432e5c16`) took about 5 min 45 s by its start and finish timestamps. That one was not timed by the bench, and the host was more heavily loaded then (load average 38 at start).

## Limitations

- **One laptop, other workloads running.** Load averages are recorded, but the bench cannot control them. A quiet machine would likely differ.
- **Small n.** Five repetitions per workflow and three per setup step. Min, median and max describe these samples only.
- **Same-host clocks.** Callback-to-verified subtracts a worker timestamp from a bench timestamp on the same machine. Resolution is about one 10 ms poll plus one observation.
- **In-process collector code.** The timing runs the collector's code inside the bench process, not as a separate collector process, so process start-up is excluded. The credentials and clients are the collector's own.
- **Cold setup excludes the image pull** (NOT_RUN) and native compilation is not separated out.
- **Network-dependent.** Cold `npm ci` speed depends on the registry and the local network on the day.

## Reproduce

```bash
npm run bench                   # all stages; about 7 minutes on this host
npm run bench -- workflows      # one stage: setup, workflows, collect or runall
```

The output goes to `artifacts/bench/<timestamp>.json`, with new run IDs.
