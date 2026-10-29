# Commit map

Before publication the history was rewritten once: every commit's author became the maintainer's GitHub noreply identity, and an AI co-author trailer was removed from every message. File contents did not change, so every commit's tree hash is identical before and after.

That matters for the evidence. Runs, reports and media are bound to tree hashes (ADR-9), and those still verify. The documents also cite short commit IDs from before the rewrite; look them up here.

| Before rewrite | Published | Subject |
|---|---|---|
| `003369f` | `5800166` | docs(media): final recapture on the fully fixed tree |
| `00eb8c3` | `fa39152` | fix(hooks): resolve private-terms list via shared git dir so worktree commits are scanned |
| `00fafa4` | `817523b` | chore(validate): run the supplied package validator on tracked files; drop an em dash |
| `019b964` | `4302b53` | feat(cli): add 'lab test [unit/integration/all]', a thin vitest wrapper |
| `01df0a8` | `f034ebd` | fix(env): child processes get a run-owned HOME, never the developer's |
| `076cd9b` | `dbbcdc2` | merge: final fix pass (C3 reply envelope, C4 symlink containment, F2-R6 disclosure, orphan sweep, reproducibility docs) |
| `08ebe50` | `65c7763` | docs(license): add MIT license and third-party NOTICE |
| `0d7173b` | `ab96b74` | docs(readme): correct AX status wording and the layers/questions count (render review 2) |
| `0f578a0` | `d2fdb30` | docs(evidence): harness set H3 on the publication candidate (LOCAL_CORE_READY) |
| `140f69f` | `4f96f52` | fix(ax): lab image skips dependency install scripts, applies the Emulate patch explicitly |
| `16ecbac` | `319491f` | docs(article): rewrite draft around running, emulated, authorized, verified |
| `18e708c` | `3215783` | docs(learnings): add AX and Substrate findings L-008..L-012 |
| `1ba3c29` | `7821d17` | fix(collector): F6 verify children get the browser cache path under the scoped HOME (L-057) |
| `1d654fb` | `982adcb` | docs(lab): add reproducible teaching and recording kit |
| `229fe3a` | `57b61d0` | feat(profiles): add offline AX runner adapter and gates |
| `24dfd6b` | `d1974e4` | docs: document real prerequisites, the private-terms list, F6-A3 review and the hook |
| `27fbeac` | `2ad71c5` | chore(lab): pin dependencies, add W0 spike and shared profile contract |
| `28fc947` | `cc2941c` | docs(ax): run 3, Substrate reinstalled at v0.6.0 and AX tests run on the cluster (L-045..L-050) |
| `2a34c7e` | `73a4483` | docs(review): commit independent render review 7 (PASS) for the publication README |
| `2d2174b` | `8d6bef7` | docs(claims): add claim ledger bound to run IDs and tree SHAs |
| `351f495` | `17cb597` | docs(review): commit independent render review 6 (PASS); C-32 follows it |
| `356797e` | `14e1304` | merge: caption fixes from independent render review |
| `3579582` | `7a31c4c` | docs(media): recapture after the env fix; re-point ledger (identical outcomes); retire the stale review record |
| `39633a5` | `2adcf30` | docs(claims): rebind ledger to merged main and the README media runs |
| `3ad8941` | `85fe26a` | feat(lab): add safe local profiles and lifecycle |
| `3dd4af6` | `e5f3ca4` | merge: first authorized AX lane run (BLOCKED on AX/Substrate protocol skew), learnings L-030..L-042 |
| `3f6539e` | `b98cb92` | fix(lifecycle): stop orphaning Floci containers; add doctor warning and down --orphans |
| `44b76be` | `f57d002` | docs(readme): replace the spec landing page with the lab README and media slots |
| `45001f9` | `376ffcc` | docs(claims): bind ledger to the final tree, final media runs, AX run 3 and blind holdouts |
| `4935584` | `5defd01` | feat(bench): add npm run bench for setup, workflow, collect-case and harness timings |
| `4a8f100` | `45f1cf1` | docs(media): recapture README media and evidence on the merged application tree |
| `4ac9f9e` | `3e6620e` | merge: final claim ledger, ledger checker and article refresh |
| `5c3855a` | `a0e776a` | fix(evidence): reject symlink escapes from the artifact dir (C4) |
| `5e571da` | `1bc9e4b` | chore(mutations): record probe runs (first run: 3 caught, 1 invalid; second: 4 of 4 caught) |
| `6119769` | `a9399ea` | feat(skill): add add-a-proof-case repo skill |
| `699d16d` | `34a9651` | docs(research): re-verify every row against pinned versions |
| `6d83d75` | `92fdc15` | fix(env): keep Playwright's browser cache reachable under a scoped HOME (S4 regression); ledger checker validates the render review record |
| `6df59b8` | `425f329` | chore(license): set package license to MIT |
| `6ff7607` | `190c831` | docs(ax): record the default teardown and its independent verification |
| `7178fec` | `2f36bf5` | docs(ax): run 2, Substrate v0.6.0 upgrade blocked on IAM prerequisites (L-043, L-044) |
| `7511b22` | `19e8888` | docs(learnings): add core-build findings L-013..L-018 |
| `751880e` | `7af8f6e` | chore(license): lockfile records the MIT license |
| `7aa1f6a` | `8b966f1` | merge: AX teardown schema, context guard, scoped restore, refreshed AX docs |
| `7f30cd5` | `3acd945` | docs(lab): add captured README media, clips and sanitized run evidence |
| `81976ce` | `27d1715` | docs(diagrams): add system, trust-boundary, evidence-flow and AX-lane diagrams |
| `872e83a` | `a81233a` | docs(evidence): final harness set H2 (LOCAL_CORE_READY on clean tree b907eba5) with per-case exports |
| `8cb5085` | `fce57ac` | feat(ax): teardown modes for the Substrate v0.6.0 reinstall |
| `8d8f524` | `7258f03` | docs(benchmarks): record setup, workflow, collection and harness timings |
| `94fdb63` | `d63944a` | chore(evidence): mutation run on the final tree |
| `9555a75` | `c6759ac` | docs(media): final recapture on the merged application tree (BH-07 fix, AX lane, validator) |
| `9876752` | `dc77c34` | docs(ax): record the first authorized cluster run (BLOCKED on AX/Substrate skew), learnings L-030..L-042, ADR-12 |
| `9c14ce9` | `db73425` | fix(ax): one run-dir schema for writer and teardown; scope the v0.5 restore |
| `a1db417` | `e231a5e` | chore: ignore agent worktrees |
| `a2751ed` | `07bf364` | fix(worker): re-check the current grant at job time; never retry policy rejections |
| `a7a695c` | `c184bda` | fix(policy): reject zero-cent approval requests (blind holdout BH-07) |
| `a87560a` | `d036104` | docs(evidence): archive blind holdout scenarios, expectations and results |
| `acb1c34` | `ebd9294` | merge: optional profile gates (Task 5.1 partial; verified 12/12 tests, typecheck clean) |
| `af2a000` | `825ab53` | fix(report): disclose unsupported Slack transport features in every report (F2-R6) |
| `b0affe6` | `3b162a1` | fix(verify): register task 5.1 and exclude agent worktrees from vitest |
| `b0c4043` | `e9f79c5` | docs: mark historical records; add LEARNINGS L-051 to L-053 |
| `b0e953a` | `036b955` | docs(learnings): record W0 findings and pre-run expectations |
| `b19fb73` | `721449d` | feat(ax): evaluator over cases.ax.json; single-tenant ledger seed for the AX case |
| `b3ab42d` | `0f4f5f0` | docs(readme): state the MIT license; point to the ledger for the harness verdict instead of encoding it |
| `b538767` | `e8d6e18` | fix(media): keep Markdown out of the application-tree digest |
| `b573480` | `06e7db5` | feat(profiles): add explicit optional integration gates |
| `b634129` | `cb00ea6` | merge: core Tasks 1.1-3.1 (safe profiles, signed Slack, W01-W03) |
| `bb0a807` | `d600296` | docs(readme): not-affiliated notice and clone step for the public repo; retire the now-stale review record |
| `bbd74fd` | `0c56f99` | fix(verify): report unbuilt task 6.1 as BLOCKED, not an unknown-task failure |
| `bde2081` | `d9fb034` | fix(f6): a missing private-terms list makes F6-A2 NOT_RUN with a reason |
| `be3bb2d` | `c3c8c3f` | fix(lifecycle): never proxy a forbidden Slack endpoint; replace proxies left by a crashed worker |
| `c2fd214` | `4d69d94` | docs(media): recapture after the S4 fix; re-point ledger media rows (identical outcomes verified) |
| `c4d5125` | `af98ed7` | merge: fixes for independent-verifier findings (worker Slack proxy, job-time grants, hardened tests) |
| `cba52e5` | `791f025` | merge: Task 4.1 independent collector, reports, export, mutations, CI |
| `cd34c3d` | `0b6ccf6` | test: make W01-W03, G-SEED and F1-R1 evidence independent and isolated |
| `d02adac` | `caf7554` | chore(evidence): keep the merged-main mutation run (4/4 caught) |
| `d0e10fc` | `69c5605` | merge: claim ledger and article refresh for merged tree |
| `d10d3e6` | `639e0f4` | feat(ax): collector reads /apl/result through the Substrate v0.6.0 router over mTLS |
| `d4111a5` | `6f82d6c` | docs(ax): README records the executed default teardown |
| `d5cac39` | `e2ff05e` | merge: AX run 3 on Substrate v0.6.0 (W01-H, failing command, isolation PASS; two termination assertions FAIL) |
| `d64514e` | `15d62b4` | merge: diagrams, research re-verification, benchmarks, claim ledger, article draft, repo skill |
| `d6b0d18` | `bd84b16` | feat(workflows): add synthetic business journeys and guarded actions |
| `da767df` | `a00c271` | docs(spec): import Agent Proof Lab specification, evaluators and build plan |
| `dc903ca` | `b08c0be` | fix(media): captions name every run of a multi-run clip; WebVTT cues at least 1.5 s |
| `dca11e6` | `3005af5` | feat(evidence): add independent collection and fail-closed reporting |
| `ddb334b` | `69685be` | feat(evidence): bind seed and the Floci image digest to bundle, report and export (F4-R2) |
| `e43abac` | `ee886f1` | fix(policy): route every Slack reply through a validated slack.reply envelope |
| `e482d97` | `1645829` | docs(article,diagrams): add AX run 3 and blind-holdout results; record that Floci ignores credentials |
| `e5e14dc` | `00d86b3` | feat(slack): add signed emulated interactions and replay protection |
| `e75d06b` | `9db2dd2` | fix(slack): give the worker a method-filtering Slack proxy, not the emulator URL |
| `e94e321` | `a0371a1` | merge: AX run 2 (Substrate v0.6.0 upgrade stopped on IAM prerequisite), learnings L-043..L-044 |
| `ea1deca` | `57796b1` | merge: Task 6.1 console, media pipeline, README, sanitized evidence |
| `f052928` | `4f775e9` | docs(diagrams): archify mental model, infrastructure layers, request flow; refresh system map and AX lane |
| `f2e1f0e` | `a27c482` | docs(learnings): add L-020..L-026, fill observed results, add patterns |
| `f5e1b7b` | `543593a` | feat(ax): in-cluster AX lane: case runner, collector, AX allowlist, Emulate image |
| `f67cab3` | `007cc06` | docs(media): final recapture at application revision ab96b74 |
| `f766528` | `243a252` | merge: offline AX runner adapter (verified 15/15 tests, scope and terms clean) |
| `f97acc7` | `033f289` | fix(env): give only the collector the browser cache path; the worker env stays exact |
| `fdb0413` | `6fd9123` | fix(mutations): make the approval-bypass mutant type-correct |
| `fea1fac` | `e8e8ac2` | docs(review): commit the independent render review record (review 5 PASS); C-32 follows it |
| `ffaa365` | `320755b` | fix(media): never delete evidence the media pipeline does not own |
| `ffd259d` | `a251659` | docs(evidence): commit sanitized exports for every run the claim ledger cites |
