# Optional profiles

The local profile is the lab. Four optional lanes can add evidence later: Salesforce, CodeRabbit, AX and live-model. Each one is off until the owner meets its prerequisites and authorizes a run. Right now every optional lane is BLOCKED. That is deliberate: the owner has not approved any account, org, app install, API key or provider call.

A blocked optional lane blocks only itself (F5-R6). It never changes the local-core result, and the report shows it as a separate line.

## Status vocabulary

These come from C5 in `docs/spec/active/2026-10-28-agent-proof-lab/contracts/CONTRACTS.md`.

| Status | Meaning in a profile lane |
|---|---|
| BLOCKED | A prerequisite is missing, or the run was requested without explicit authorization. The reason names what is missing. No provider call was made. |
| NOT_RUN | Prerequisites are satisfied, but the lane has no execution evidence yet. A satisfied doctor also reports NOT_RUN, because readiness is not a result. |
| SKIPPED | A test exists but was not executed, for example the Salesforce platform tests without authorization. Skipped never counts as PASS. |
| UNKNOWN | The lane ran but its state could not be read, or a comparison was never made. Salesforce parity is UNKNOWN until the platform tests run. |
| PASS | Every required assertion passed with direct evidence from the provider. No adapter returns PASS from configuration alone. |
| FAIL | A required assertion failed with evidence. |

Every adapter implements `ProfileAdapter` from `src/contracts/profile.ts`:

- `doctor(env)` reads local configuration only. It makes zero provider calls (`external_calls: 0`).
- `run(caseId, { authorized, env })` returns BLOCKED unless the doctor is satisfied and `authorized` is true. `authorized` is an explicit operator opt-in per run, separate from the owner's standing approval flags.

No adapter reads ambient credentials. `SF_TARGET_ORG`, a default Salesforce org, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `GITHUB_TOKEN` are all ignored.

## Salesforce (`profiles/salesforce/`)

**What it proves.** The W03 compare-and-write rules hold on a real Salesforce runtime: a permitted update advances the version, a read-only persona is denied, and a stale expected version conflicts without overwriting (F5-R2). It runs under real sharing, CRUD and FLS enforcement with known permission sets (`APL_Writer`, `APL_ReadOnly`, `APL_Observer`).

**What it cannot prove.** It says nothing about a customer org's configuration, other editions, data volume or production behavior. A scratch org is a clean, temporary Developer-edition org. Tests that pass against the local double do not count for this lane. Parity between the double and the platform stays UNKNOWN until both have run and the report generator compares them.

**Contents.**

- `index.ts`: the adapter. The doctor checks for `sf` v2+ on PATH (it only runs `sf --version`, with telemetry and update checks disabled), `APL_SF_DEVHUB_ALIAS` and `APL_SF_OWNER_APPROVED=yes`. It never reads the default org.
- `force-app/`: Apex REST class `AccountDescriptionResource` (`PATCH /services/apexrest/apl/account-description`). It runs `with sharing`, checks CRUD/FLS explicitly, uses `WITH USER_MODE` with `FOR UPDATE`, and writes in user mode. The custom field `Account.APL_Description_Version__c` is a semantic version, not a native one. Also here: the Apex test class (permitted, denied, stale version, missing input) and the three permission sets.
- `data/Account.json`: the synthetic seed. Account "Northstar Demo", description "Trial account", version 1.
- `config/scratch-def.json`, `sfdx-project.json`.
- `lifecycle.ts`: owner-run `create | deploy | seed | test | delete`. Each command needs a satisfied doctor and `--authorize`. Every `sf` call names `--target-org` or `--target-dev-hub` explicitly. Before deploy, seed or test, the guard checks that the target's Organization Id matches the manifest and that the org is a scratch org (`IsSandbox` plus `TrialExpirationDate`, not expired). The manifest at `private-runs/salesforce/scratch-manifest.json` (gitignored) records alias, username, org id, Dev Hub alias, creation time, expiry and owner. `delete` removes only manifest-owned orgs.
- `tests/platform.test.ts`: runs the Apex tests on the owned org. It is SKIPPED unless `APL_SF_AUTHORIZE_RUN=yes` and an active manifest org exists.

`run()` never creates an org. Creation is a separate owner step.

**Owner steps to enable.**

1. Get a Dev Hub you are allowed to use for a personal lab, with scratch-org allocation available. If the quota is exhausted, the lane stays BLOCKED. Never point it at production.
2. Install the Salesforce CLI v2 and authorize the Dev Hub under an explicit alias: `sf org login web --alias apl-devhub`. Do not set it as the default.
3. Export `APL_SF_DEVHUB_ALIAS=apl-devhub` and `APL_SF_OWNER_APPROVED=yes`, then check `doctor` reports NOT_RUN.
4. `npx tsx profiles/salesforce/lifecycle.ts create --authorize`, then `deploy --authorize`, then optionally `seed --authorize`.
5. `APL_SF_AUTHORIZE_RUN=yes npx vitest run profiles/salesforce`, or call `run("W03-SF", { authorized: true })`.
6. `npx tsx profiles/salesforce/lifecycle.ts delete --authorize`. The org also expires after one day.

## CodeRabbit (`profiles/coderabbit/`)

**What it proves.** An external reviewer looked at a specific commit and raised findings, which a person then adjudicated. It is a review lane, not the execution oracle (F5-R3). The deterministic evaluator still decides PASS and FAIL.

**What it cannot prove.** Correctness, test coverage or the absence of bugs. A missing review is not a clean review, and there is no review score while the app is absent.

**Contents.**

- `index.ts`: the adapter. It is BLOCKED until there is a hosted repo (`APL_CODERABBIT_REPO=owner/name`), the app is approved (`APL_CODERABBIT_APP_APPROVED=yes`), data disclosure is accepted (`APL_CODERABBIT_DATA_CONSENT=yes`) and a repo-root `.coderabbit.yaml` exists. Even when authorized, it does not open PRs or fetch reviews. Ingestion is not built, so it reports NOT_RUN.
- `.coderabbit.yaml`: a proposal only, stored here rather than at the repo root, so it is inactive.
- `illustrative-defects.json`: three hand-written seeded defects (approval bypass, missing evidence turned into zero, unguarded CRM write). Each is labelled ILLUSTRATIVE FIXTURE. None of them is CodeRabbit output or a review result.

**Owner steps to enable.**

1. Host the repository. This is deferred: the lab is local-only for now.
2. Read CodeRabbit's data-handling terms and decide whether diffs may go to a third party. Then set `APL_CODERABBIT_DATA_CONSENT=yes`.
3. Install the CodeRabbit app on that one repository only, and set `APL_CODERABBIT_APP_APPROVED=yes` and `APL_CODERABBIT_REPO`.
4. Copy `profiles/coderabbit/.coderabbit.yaml` to the repo root and commit it.
5. Open a PR yourself. Record the review against the PR head commit and adjudicate each finding (accepted, rejected or deferred, with a reason) before citing it.

## AX (`profiles/ax/`)

Another builder owns this adapter. Until `profiles/ax/index.ts` exists, the profile tests report AX as BLOCKED with the reason "adapter not installed". When it is present, the tests import it and hold it to the same gates: BLOCKED doctor, zero external calls, and no run without authorization. It needs no cluster in the default bootstrap. Its own prerequisites and limits belong in that adapter's documentation.

## Live-model (`profiles/live-model/`)

**What it proves.** A real model, given only the same restricted actions as the scripted driver, produces runs that pass the same deterministic evaluator (F5-R5). It records the model identity and spends no more than the cap allows.

**What it cannot prove.** That the model is reliable in general, or that results repeat across model versions or prompts. Scripted and replay runs are never labelled as live-model output (F3-R4).

**Contents.**

- `tools.ts`: the tool schema. It allows six operations, `ticket.create`, `receipt.put`, `approval.request`, `approval.resolve`, `crm.description.update` and `slack.reply`, under provider-safe names such as `crm_description_update`. Inputs reject unknown fields. The model never supplies tenant, actor, connection, authorization decision or policy version: the runtime binds those, and deterministic policy authorizes every action outside the model. The field names are provisional. The scripted driver's C3 operation schemas are canonical, and these should be reconciled with them.
- `index.ts`: the adapter. It is BLOCKED until `APL_LIVE_MODEL_APPROVED=yes`, `APL_LIVE_MODEL_ID` is set, `APL_LIVE_MODEL_BUDGET_CENTS` is a positive integer, and the Keychain item exists. The doctor checks the item with a metadata lookup and never reads the secret. `readApiKey()` reads the key with `/usr/bin/security find-generic-password -s agent-proof-lab/live-model -w`, and only on an authorized run. The key is never read from env vars, `.env` files or chat. No provider client is wired yet, so an authorized run reports NOT_RUN and sends nothing.

**Owner steps to enable.**

1. Choose a provider and model and accept its data terms. Then set `APL_LIVE_MODEL_APPROVED=yes` and `APL_LIVE_MODEL_ID=<exact model id>`.
2. Set a spend cap in cents, for example `APL_LIVE_MODEL_BUDGET_CENTS=500`. When it is reached, new requests stop, with no unbounded retry.
3. Store the key in the Keychain only: `security add-generic-password -s agent-proof-lab/live-model -a lab -w` (it prompts for the value).
4. Approve wiring a provider client that calls `readApiKey()` at run time, offers only `LIVE_MODEL_TOOLS`, enforces the cap, and passes outputs through the same policy and evaluator.
