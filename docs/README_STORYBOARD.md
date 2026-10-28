# GitHub README Storyboard

This is the layout to implement in the finished repository, not a gallery of assets already produced. Replace the specification-package landing page only after the application and required captures exist, preserving a link to the specification.

## Opening

Name the project and explain it in two sentences: a local-first lab for testing Slack-led workflows, with explicit separation of execution, emulation, authorization and evidence. Immediately show the real `lab-overview.png` with a concise caption and synthetic-data notice.

## See a workflow

Embed `slack-service-request.gif` and explain the observed ticket, receipt and thread. Include a static-poster link so readers can inspect the result without following motion.

Illustrative Markdown syntax, to be inserted into the root README only when the files exist:

```markdown
![Emulated Slack request producing one ticket and a matching storage receipt](docs/assets/gifs/slack-service-request.gif)

The local scripted worker processes a synthetic request. The evaluator checks the ticket, receipt and reply thread.

[View the static result](docs/assets/posters/slack-service-request.png)
```

## Understand the layers

Show a compact responsibility table and the mental-model diagram, clearly labeled as architecture rather than execution evidence. Explain the local core and opt-in Salesforce, CodeRabbit, AX and live-model lanes.

## Try it

Provide tested installation, doctor, startup, run and cleanup commands. State actual prerequisites and tested environments; make optional provider accounts visibly optional.

## Watch the boundaries hold

Embed `duplicate-event-safe.gif` and `approval-denied.gif`, each followed by a static poster link. Explain what the test challenged and what remained unchanged.

Use captions tied to the actual result and mode. Do not say “exactly once everywhere” when the evidence covers only a bounded idempotency case.

## Inspect the evidence

Show `evidence-report.png` and link the sanitized run summary. Include scenario ID, tested application revision and limitations beside results.

## Understand what remains unverified

Show `profile-boundaries.png` and explain which optional profiles are blocked or untested. Do not use badges that imply those lanes passed.

## Explore and reproduce

Link the casebook, article, recording runbook, source references and media reproduction commands. Include license/contribution information only after the owner approves it.

## Long-form walkthrough

Add a poster link to an actual uploaded video only after upload authorization and a verified URL. Until then, describe local capture commands without inserting a placeholder video badge or broken link.

## Generated section ownership

`readme build` MUST use explicit `<!-- BEGIN LAB MEDIA -->` and `<!-- END LAB MEDIA -->` markers, or an equally bounded template slot. Re-running it must be idempotent and preserve manual content outside its owned sections.
