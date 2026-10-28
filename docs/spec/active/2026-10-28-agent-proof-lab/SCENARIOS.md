# Public Challenge Scenarios

These are post-implementation end-to-end challenges. They live in a public package and therefore are not genuinely hidden holdouts; the `evals/holdout/` path is a harness convention, not an access-control claim.

For a blind evaluation, an independent reviewer must create additional data/seeds outside the implementing agent's readable workspace, run against a pinned candidate and release sanitized results afterward. No hidden-test security is claimed by putting “do not read” in a file.

## Happy Path Scenarios

### S1: A new reader reproduces a Slack-led workflow

**Persona:** Developer with no provider accounts.
**Goal:** Run the service-request demonstration and inspect what happened.
**Entry point:** Fresh checkout, empty state, declared prerequisites installed.

**Journey:** Start local profile; seed a fictional workspace; submit a bot mention; observe the signed callback; inspect one ticket and matching S3 receipt; open the reply thread and evidence report.

**Satisfaction criteria:** Exactly one business effect and one completion reply; actual emulator state and evaluator report agree. Setup documentation has no undeclared external account dependency.

**Adversarial variant:** Execute a second run concurrently with the same synthetic input; confirm neither run can read or mutate the other's state.

## Failure & Recovery Scenarios

### S2: A reply times out after a successful remote write

**Persona:** Operator diagnosing incomplete delivery.
**Goal:** Recover without duplicate replies or a false success claim.
**Entry point:** Ticket/receipt committed, Slack write outcome temporarily ambiguous.

**Journey:** Inject a timeout after write acceptance; inspect the UNKNOWN state; perform bounded reconciliation against the original thread; identify the committed message or retain UNKNOWN; do not blindly post another completion.

**Satisfaction criteria:** One ticket, no more than one completion reply, no false green result, explicit recovery evidence.

**Adversarial variant:** Restart the worker during reconciliation and redeliver the original event.

### S3: An attacker tries a stale approval from another workspace

**Persona:** Unauthorized synthetic user.
**Goal:** Attempt to approve a request using a copied interaction and stale request digest.
**Entry point:** Awaiting approval in workspace A, attacker bound to B.

**Journey:** Replay the interaction; forge identity fields; then submit from a valid but unauthorized user. Verify no terminal state transition and no approval receipt.

**Satisfaction criteria:** Zero unauthorized writes, no cross-workspace information leak, clear denied-action evidence.

**Adversarial variant:** A previously authorized approver loses permission immediately before clicking.

## Contract & Integration Scenarios

### S4: A green worker log conflicts with missing evidence

**Persona:** Reader reviewing a proposed success.
**Goal:** Determine whether the outcome was actually verified.
**Entry point:** C1/C2/C3 execute a case whose worker logs success, but C4 receipt collection is missing and an optional provider is unavailable.

**Journey:** Collect state; build C5; view the console; export the run. Check that missing evidence remains UNKNOWN/FAIL as appropriate and the optional provider remains BLOCKED.

**Satisfaction criteria:** No overall false green, evidence references remain valid, status aggregation and console agree.

**Adversarial variant:** Delete a referenced evidence file or change a hash after collection; verification must reject the claimed proof.

## Contract coverage

S1 covers C1–C5 end to end. S2 covers action idempotency and evidence uncertainty in C3–C5. S3 covers identity/authorization binding in C1–C3. S4 covers collector/report integrity in C4–C5. Every case must retain input and outcome evidence, including failures.
