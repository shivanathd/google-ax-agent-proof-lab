# The Agent Ran. What Did That Prove?

An agent demo can end with a confident answer and still leave the important questions unanswered. Did the record change? Was the user allowed to change it? Did a retry create a duplicate? Could someone else reproduce the result?

I want to build a small public lab around those questions. The aim is to make the layers visible, using synthetic workflows that readers can run themselves rather than asking them to trust a recording.

This is the design of that lab, not a results report. The experiments still need to be implemented and executed before I can say what passed.

## Start with a request people understand

The first example starts in a Slack conversation. A user asks for a service request, the application queues the work, creates a ticket, stores a receipt and replies in the original thread.

That is a deliberately ordinary workflow. It gives us several places where something can go wrong without needing a complicated business domain to explain the failure.

I want the reader to see more than the final reply. The lab should show the incoming event, the business action, the stored result and the assertions used to judge completion.

## Give each tool one clear job

Emulate supplies the Slack side of the experiment, including stateful messages, threads, signed callbacks and selected interactions ([Emulate Slack](https://emulate.dev/docs/slack)). I plan to use it so the application can send actual local API requests without posting into a real workspace.

Floci supplies the cloud-shaped dependencies. It documents local cloud emulators, and this lab will begin with the much narrower job of exercising S3 and SQS operations ([Floci](https://floci.io/)).

AX answers a different question: where an agent task runs and how its execution environment is managed ([AX](https://github.com/google/ax)). I would make that an optional execution lane, so readers can understand and run the basic experiment without first setting up a cluster.

CodeRabbit belongs in the review lane, where it can examine code changes ([CodeRabbit](https://docs.coderabbit.ai/guides/code-review-overview)). Its findings can be useful evidence, but I still want a separate test to tell me whether a forbidden approval changed a record.

Putting these tools on the same diagram should not turn them into competitors. The useful question is which responsibility each one owns.

## A convincing reply is not the acceptance test

Suppose the worker says, “Your request is complete.” I want the evaluator to look for the ticket, read the storage receipt and inspect the original Slack thread.

If the receipt is missing, that run should not turn green because the text sounds right. If the collector cannot read the state, the result should remain unknown rather than quietly becoming a zero or a pass.

The next test should repeat the same event. A second delivery is an opportunity to check idempotency, not a reason to create a second service request.

I also want to show an ambiguous outcome. If a provider accepts a write but the response times out, the application may not know whether retrying is safe. That uncertainty deserves a visible state and a recovery path.

## Test who is allowed to act

The second workflow is a synthetic approval request. One person asks for an equipment purchase, and a different authorized person may approve it before the request expires.

The interesting test is the denied one. The requester should not approve their own request, and a copied button interaction from another workspace should not acquire authority just because it looks valid.

The policy should be outside the model's control. A model can propose an action; it should not choose which customer's credentials apply or decide that an expired approval is close enough.

No real payment belongs in this demonstration. The observable outcome is a controlled state transition, or the absence of that transition when the action is not allowed.

## Use a real platform when the question requires one

The third workflow updates a synthetic CRM account. A narrow local contract double is useful for fast tests of request shape, error handling and version conflicts.

It is not Salesforce. A Salesforce scratch org is an actual disposable code and metadata deployment, which gives us a different environment for testing platform-specific behavior ([Salesforce DX](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-scratch-orgs.html)).

That distinction should stay visible in the report. Passing against a local double does not establish that an Apex operation respects the intended persona's permissions, or that a customer's accumulated configuration will behave the same way.

The optional scratch-org lane should therefore run its own checks. If the org is unavailable, the honest result is “not verified here,” not a substituted local success.

## Make the limits part of the lesson

Emulate's Slack documentation lists unsupported behavior, including Socket Mode, slash commands and exact rate limiting ([Slack limits](https://emulate.dev/docs/slack)). The lab should use supported interactions and carry those limits into the article and recording.

A local emulator can help me ask a precise question about my application. It cannot make every production condition disappear.

The same applies to tests. Public cases are useful because readers can inspect and reproduce them, but they are not secret holdouts. If I want a genuinely blind evaluation, it needs a separately controlled environment and undisclosed cases.

## Record evidence, not just a good take

The recording should show a happy path, a denied action and a defect that a test catches. Each clip should identify its run, source revision, profile and whether the worker used a scripted plan or a live model.

I would publish the test inputs and limitations alongside the video. A shorter clip can make the explanation clearer, but an edit should never be passed off as measured execution time.

The first version should use a deterministic scripted worker. That keeps integration behavior reproducible and makes it clear that the experiment is not yet a claim about model reasoning quality.

After the lab runs, the results article can report which cases passed, which injected defects were caught, which integrations were blocked and what another reader reproduced. Until then, those are questions to answer, not numbers to invent.

The standard I want is modest and checkable: someone can inspect the request, follow the action, challenge the result and rerun the case. That is more useful to me than an agent that simply sounds finished.
