# Build Orchestration Plan

Status: DRAFT for owner sign-off, 2026-10-28. This plan sequences the supplied `IMPLEMENTATION_PLAN.md` (Tasks 1.1–6.1) across parallel agents. It adds no requirements beyond the spec except where marked **[AMENDMENT]**; every amendment also gets an ADR in `DECISIONS.md`.

## 0. Ground truth checked before planning (2026-10-28)

| Item | Observed | Consequence |
|---|---|---|
| Host | macOS 27 arm64, 18 CPU, 128 GiB, Docker Desktop 29.9, Node 24.22, npm 11.19, Python 3.14, Go 1.27, ffmpeg 6.0, kubectl 1.34 | Local core feasible; gifsicle absent (ffmpeg palette path is sufficient) |
| Emulate | `emulate@0.12.3`, Apache-2.0, vercel-labs | Pin exact; verify Slack seed/simulate API in a spike before adapters |
| Floci | `floci/floci` image exists | Pin by digest; verify arm64 manifest + S3/SQS calls in spike |
| AX | `google/ax`, Apache-2.0, "heavy development" | Pin commit SHA. Runner contract: PID1 `/usr/local/bin/ax-task-runner`, `/healthz` `/readyz` on :80, **control plane does not read command exit status** → outcome must come from the independent collector |
| Substrate | `agent-substrate/substrate`, Apache-2.0; gVisor/microVM only; GKE ≥1.36 with PodCertificate APIs | Optional AX lane only; never in default bootstrap |
| GCP | Cloud project with billing + GKE APIs; existing shared cluster has Substrate, no AX, and unrelated benchmark workloads | Owner chooses dedicated vs shared cluster (§6) |
| Git | Global identity is a work identity | Repo-local identity is mandatory before the first commit |

## 1. Definition of done

1. `python3 tools/validate_package.py` passes and `evals/run-all.sh` returns `LOCAL_CORE_READY`, covering task gates 1.1–6.1, acceptance F1–F6 and public challenges S1–S4.
2. All four mutation probes are caught (caught/uncaught/invalid counts recorded).
3. A fresh clone into an empty directory runs the three workflows; cleanup is proven to remove only owned resources.
4. The README carries 5 PNG screenshots, 3 animated GIFs and 3 posters with a valid `media-manifest.json`. **[AMENDMENT]** It also carries 3 short MP4 clips (≤4 MiB each) under `docs/assets/videos/`, linked through poster images, because GitHub does not inline-play repo-relative MP4. The inline player waits for a post-publication user-attachment upload.
5. `docs/LEARNINGS.md` records **expected vs observed** for each case, benchmark and lane, with surprises and upstream gaps. `docs/CLAIM_LEDGER.md` binds every public claim to a run ID.
6. The optional lanes each report PASS, BLOCKED or UNKNOWN honestly. AX runs on GKE only if the owner approves (§6).
7. The sanitizer gate passes: zero corporate strings, cloud project or cluster IDs, emails, tokens or local paths in tracked files and git history.
8. Nothing has been pushed or published, and no remote has been added. The Mac mini migration is a documented manual step.

## 2. Waves, owners and dependencies

File ownership is disjoint inside each wave, so agents can share one checkout. Each agent commits only its own paths.

```
W0  Bootstrap + spikes (lead)                         ──┐
W1  A: config/CLI/contracts (T1.1)   B: Slack (T2.1)   F: AX runner image + manifests (offline)
     depends W0                       depends W0+A types   depends W0
W2  C: Floci + ledger + W01–W03 (T3.1)   E: Salesforce/CodeRabbit/live-model gates (T5.1)
     depends A,B                           depends A
W3  D: collector, evaluator glue, reports, mutations, CI (T4.1)    depends C
W4  G: console + Playwright media + README build (T6.1)  H: docs, archify, research re-verify, learnings
     depends D                                             depends D (results), runs alongside G
W5  Verification: fresh clone S1, run-all, blind holdouts, benchmarks, sanitizer, adversarial review
W6  Optional AX-on-GKE run (needs approval) → owner confirms → teardown + proof of teardown
```

| Wave | Agent | Owns paths | Exit gate (run by an independent verifier, not the author) |
|---|---|---|---|
| W0 | lead | `package.json`, lockfiles, `compose.yaml`, `DEPENDENCIES.lock.json`, `docs/ENVIRONMENT.md`, `spikes/` | Spikes prove: Emulate Slack boots with strict scopes + signed callback + `conversations.replies`; Floci S3 PUT/GET + SQS send/receive from `@aws-sdk` v3; better-sqlite3 loads on Node 24 arm64 |
| W1 | A | `src/cli/ src/config/ src/contracts/ tests/unit/` | `npm run verify:task -- 1.1`: typecheck, forbidden-endpoint zero-write, two-run isolation, scoped cleanup |
| W1 | B | `src/adapters/slack/ src/http/ fixtures/slack/ tests/integration/slack.test.ts` | `verify:task 2.1`: F2-A1/A2 + G-SIG/G-OLD/G-SCOPE/G-REVOKE via emulator API state |
| W1 | F | `profiles/ax/` | Runner image builds for linux/amd64, honours `/healthz` `/readyz`, writes result file to `/workspace`; `profile doctor ax` → BLOCKED offline |
| W2 | C | `src/workflows/ src/policy/ src/adapters/floci/ src/adapters/crm-local/ src/ledger/ fixtures/cases/` | `verify:task 3.1`: every CASEBOOK W01–W03 row; 5 reps per happy path with all outcomes kept |
| W2 | E | `profiles/salesforce/ profiles/coderabbit/ profiles/live-model/ docs/PROFILES.md` | F5-A1/A2: 4 BLOCKED with prerequisites, 0 external calls |
| W3 | D | `src/collector/ src/evaluator/ src/reports/ tests/mutations/ .github/workflows/` | `verify:task 4.1`, F4-A1/A2, S1–S4, 4/4 mutants caught |
| W4 | G | `web/ tests/browser/ scripts/media/ scripts/record/ docs/assets/ README.md` | `verify:task 6.1`, F6-A1..A5, desktop+narrow render screenshots |
| W4 | H | `docs/*.md` (non-spec), `docs/diagrams/`, `writing/`, `.claude/skills/` | Every claim in docs/article traced to a run ID or labelled DESIGNED/UNKNOWN |

## 3. Verification layers (who checks what)

1. **Author tests**: unit and integration tests inside each agent's paths.
2. **Supplied harness (fixed, never edited)**: `evals/` task, acceptance and S1–S4 scripts via `collect-case`. The worker never writes to `evals/results/`.
3. **Independent wave verifier**: a fresh agent per wave gets the code and the spec but not the author's summary. It reruns the gates, reads diffs for spec drift and reports failures. The author fixes; nothing is marked done until the verifier signs off.
4. **Mutation probes**: four deliberate mutants, each toggled by env flag in test builds only. All must be caught, and the known-good build is restored before evidence capture (F4-R6).
5. **Blind holdouts (genuine)**: after W3, a separate agent writes about 8 extra scenarios into `private-runs/blind/` outside every builder agent's brief. Builders never see them. They are run once against the frozen candidate, and the results are reported as blind. This is the "separate reviewer-controlled environment" from ADR-6, and the public S1–S4 are still called public challenges.
6. **Adversarial review**: one review of this plan before execution, and one of the finished repo before handoff.
7. **Sanitizer**: `ecc:opensource-sanitizer` scans the tree and full git history.

## 4. Benchmarks (methodology, not claims)

- Setup time: cold (empty npm/docker cache) vs warm, 3 runs each, raw values recorded.
- Per-workflow wall clock, from Slack callback to verified receipt, for W01/W02/W03: n=5 each. Report every raw value plus min, median and max. **No p95 or inferential claims** (spec NFR).
- Evaluator overhead: collect-case time vs workflow time.
- AX lane (if run): task submit → Running → result file observed, n=5, on a dedicated cluster only, since shared nodes carry unrelated benchmark load.
- Environment fingerprint stored beside every number; numbers live in `docs/BENCHMARKS.md` with run IDs.

## 5. Research grounding

H re-verifies every row of `docs/RESEARCH.md` against the pinned versions, with a date and the version or commit checked. Gaps found while building (unsupported Emulate surfaces, the AX exit-status gap, Floci quirks) go into `docs/LEARNINGS.md` under *Expected → Observed → Why → What we changed*. Upstream behaviour that contradicts its docs is reproduced with a minimal script in `spikes/` before it is claimed.

## 6. Owner decisions needed (blocking only their lane)

| Decision | Blocks | Default if unanswered |
|---|---|---|
| Git author name/email for this repo (non-work) | First commit | Neutral placeholder, rewritten on the Mac mini |
| AX cluster: dedicated new GKE cluster (≈$0.4–0.8/h estimated, adds IAM bindings, fully deleted on confirm) vs namespaces on the existing shared Substrate cluster (≈$0 extra, teardown removes only our namespaces/CRDs, noisy for benchmarks) | W6 only | AX stays BLOCKED |
| Live-model provider + spend cap; key stored by owner in macOS Keychain (never pasted in chat) | live-model lane | BLOCKED |
| Salesforce: personal (non-work) Dev Hub alias, or skip | Salesforce lane | BLOCKED, parity UNKNOWN |
| CodeRabbit | Needs a hosted repo, so it is deferred to post-publication on the Mac mini | BLOCKED |

## 7. Risks and stop rules

- **Usage budget**: weekly Claude usage was at 99% at plan time. Each wave ends with a commit and a status note in `docs/spec/.../STATUS.md`, so work resumes cleanly if capacity runs out mid-wave.
- Upstream API mismatch: reproduce it, document it, and mark the affected feature BLOCKED after three failed approaches (spec rule). No silent in-memory fake.
- Any secret, production endpoint or corporate identifier found in an artifact stops the run.
- Cloud resources exist only inside the owner-approved project. Every created resource goes into `private-runs/ax/owned-resources.json`, and teardown deletes exactly that list, then re-lists to prove deletion.

## 8. Adversarial review amendments (2026-10-28, supersede §1–§7 where they conflict)

An independent reviewer found 14 defects. Each one is resolved here.

1. **Gate order.** S4 and all F6-A\* cases move to the W4 gate. D builds a `collect-case` dispatch table (`src/collector/cases/index.ts`). G owns `src/collector/cases/f6-*.ts` and the S4 console probe.
2. **Ownership.** Every builder agent runs in its own git worktree, and the lead merges between waves. The lead alone edits `package.json` and lockfiles; agents request dependencies in their report. A owns the CLI registry (`src/cli/registry.ts`), and other agents add one file each under `src/cli/commands/`. Docs ownership is per file:
   - W0: `ENVIRONMENT.md`
   - E: `PROFILES.md`
   - G: `REPRODUCING.md`, `CLAIM_LEDGER.md`, README, `recordings/`
   - H: `LEARNINGS.md`, `BENCHMARKS.md`, `docs/diagrams/`, `RESEARCH.md` re-verification, article
   - Tests owned by the agent of the same task: `tests/integration/{workflows,evidence,profiles}.test.ts`.
3. **W1 scope.** B delivers signature checks, raw-body capture and dedup through a `EventStore` interface backed by SQLite. F2-A1/A2 gate in W2, once C's queue exists. B also owns the block-actions handler. F's AX image is rebuilt from the frozen candidate in W6.
4. **Exit codes.** `verify:task X.Y` exits 0 when every state matches the spec's expectation, including optional lanes BLOCKED and GitHub render NOT_RUN. It exits 2 only for a missing *local* prerequisite.
5. **Independence enforced.**
   - The collector runs as a separate process with its own Slack read token (`conversations.*` scopes only).
   - It opens SQLite with `?mode=ro` through a separate file URI and gets its own S3/SQS client credentials.
   - The worker env never receives the simulator, admin or collector creds; a unit test asserts this.
   - `outbound_request_count` comes from a loopback sinkhole proxy that the collector owns, not from the app.
   - `local_render_review_passed` needs a reviewer record written by a non-G agent, stored as hashed evidence.
6. **Verify scripts.** Each `verify:task` calls the supplied `evaluate.py` for its feature's cases as well as its own tests. The wave verifier checks the script against "Proof required".
7. **Mutants.** Each mutant is a patch applied in a throwaway worktree, never an env flag in shipped code. The supplied harness plus the integration tests must catch it. Every bundle records `mutation: none` for the candidate.
8. **Blind holdouts.** Blind cases are new *fixtures and seeds* for the existing case types, kept in a separate cases file with a copy of the evaluator outside the repo (session scratch). They are written only after every builder agent has stopped and run against a pinned tree SHA. Results are labelled "blind to builder agents, not to the orchestrator".
9. **Identity and evidence binding.** The repo-local author is a neutral project identity. A pre-commit hook rejects work-domain emails. Evidence binds to the **git tree SHA** (`HEAD^{tree}`), plus the commit and patch digest when dirty. A later author rewrite therefore leaves the bindings valid. The repo moves to the Mac mini with `git bundle`, not a directory copy.
10. **CASEBOOK coverage.**
    - D's gate: G-UNKNOWN and G-EXPORT (canary quarantine).
    - G-CLEAN runs with an unrelated labelled container present.
    - W01-S and W01-T use a fault-injecting loopback proxy owned by C.
    - W0 spike also proves: two-team installs, `simulate/event-retry`, `simulate/block-actions`, token revocation, and loopback-only binding.
11. **Timeouts.** S1 runs from a pre-pulled image set and a warm npm cache, recorded as a limitation. `EVAL_CASE_TIMEOUT_SECONDS` stays at 180 unless an ADR justifies a change.
12. **AX lane.**
    - Install kubectl ≥1.35, kept separate from the host binary.
    - Emulate and Floci run inside the AX namespace, so there is no tunnel from the Mac.
    - The ADR'd `cases.ax.json` holds the `profile: ax` expectations.
    - Use a dedicated gcloud configuration plus a lab service account via impersonation, never the default compute SA.
    - Every resource gets the label `apl-run=<id>`.
    - Teardown diffs `gcloud asset search-all-resources` before and after.
    - Shared cluster: the owner confirmed nothing else uses it. Existing benchmark deployments are scaled to 0 with their replicas recorded (reversible), and deleted only on owner confirmation.
    - A budget alert plus a scheduled auto-scale-down covers the case where the session dies.
    - `PRIVATE_TERMS` (project, cluster, domain, emails) lives only in gitignored `private-runs/` and feeds the sanitizer and `forbidden_identity_count`.
13. **MP4.** MP4 enters the manifest schema and `media verify`, and counts toward the 25 MiB total. Clips follow RECORDING_RUNBOOK (four clips, with sidecar JSON and captions); total MP4 ≤ 8 MiB, or the overage is reported.
14. **Benchmarks.** Cold runs use a separate npm cache dir, and remove only the lab's pinned images by digest, never the owner's other images. The "expected" column of `LEARNINGS.md` is committed before W5 runs.

Owner answers (2026-10-28):
- The shared Substrate cluster may be cleaned and reused.
- Live-model and Salesforce default to BLOCKED.
- CodeRabbit is deferred until post-publication.
