# Agent Working Rules

This repository is a personal educational lab. Use fictional companies, users, records and credentials; keep all employer, customer and internal-project material out of the public artifacts.

## Implementation

- Read the active specification before changing application code. Commit the spec separately from implementation.
- Preserve supplied acceptance expectations. Propose a specification amendment rather than weakening a failed assertion.
- Run only the selected profile. Default to local emulators with explicit endpoint overrides and fake credentials.
- Keep local integration execution, fixture replay, injected faults and live-provider validation visibly distinct.
- Use upstream APIs directly where practical. Do not build a generic agent framework, universal emulator interface or production SaaS control plane.
- Do not equate missing evidence with failure, success or a numeric zero. Preserve the status and reason.
- Treat the visual README as required work: follow `docs/README_MEDIA_SPEC.md`, produce actual screenshots/GIFs/posters and verify every embed. A missing encoder or capture is a blocker, not permission to replace real media with a mockup.

## Authority and publication

- No cloud provisioning, external messages, provider app installation, public publication or push without explicit approval.
- Do not harvest ambient credentials from the developer's machine. The local profile must refuse live endpoints even if real credentials are present.
- Keep evaluator administration endpoints inaccessible to the worker. Public test definitions are reproducibility tools, not hidden holdouts.
- Record only synthetic views and sanitized outputs. Do not record login screens or access tokens.
- Keep the article pre-results until actual runs exist. No invented savings, speedups, parity claims or endorsements.
