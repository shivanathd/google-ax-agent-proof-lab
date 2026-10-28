# README Media Production Contract

Version 1.1.0. Screenshots, animated GIFs and their integration into the root GitHub README are required implementation deliverables, not optional polish. This document instructs the coding agent to create them after the real local application works; this specification package contains no pretend captures.

## Required assets

| Path under repository root | Capture | Required content |
|---|---|---|
| `docs/assets/screenshots/lab-overview.png` | Main application | Scenario picker, emulated Slack conversation, layer view and selected run |
| `docs/assets/screenshots/service-request-success.png` | W01-H | Correct thread reply plus ticket and receipt evidence |
| `docs/assets/screenshots/approval-denied.png` | W02-U | Visible denial and unchanged request state |
| `docs/assets/screenshots/evidence-report.png` | Completed run | Assertions, evidence references, profile and limitations |
| `docs/assets/screenshots/profile-boundaries.png` | Optional profile view | Actual PASS/BLOCKED/UNKNOWN states, never staged green badges |
| `docs/assets/gifs/slack-service-request.gif` | W01-H, 12–25 seconds | User message, processing and verified result |
| `docs/assets/gifs/duplicate-event-safe.gif` | W01-D, 8–20 seconds | Original result, explicit retry, unchanged ticket/reply counts |
| `docs/assets/gifs/approval-denied.gif` | W02-U, 8–20 seconds | Unauthorized click, denial, unchanged state |

Each GIF MUST also have a static poster PNG in `docs/assets/posters/` with the same basename. Keep full-motion source recordings in gitignored capture storage; sanitize them before any separately approved upload. Source MP4/WebM may be linked from a release or video host only after approval; a published long-form video is not required for local README completion.

## Capture real behavior

Use Playwright to drive the built application, connected to actual Emulate Slack and Floci processes. Wait for independently verified application state rather than hardcoded sleeps, then capture browser pixels. Use the same pinned application candidate and synthetic fixtures as the acceptance run.

The agent MUST NOT use design mockups, generated screenshots, edited success labels, fabricated chat messages or fixture-only replays in place of these required integration captures. A visible local Slack transcript must reflect emulator state, not an independently staged UI.

Prefer a clean 1440×900 capture viewport at device scale factor 1. Hide unrelated browser chrome and notifications. Ensure status, scenario, local profile and scripted/live mode are readable; place longer revision/run details in the caption and manifest if including them in every frame would make the interface illegible.

## Reproducible commands

Implement these exact interfaces; they are not already installed by this handoff:

```bash
npm run lab -- media doctor
npm run lab -- media capture --suite readme
npm run lab -- media optimize --suite readme
npm run lab -- media verify --suite readme
npm run lab -- readme build
npm run lab -- readme verify --local
```

`media doctor` checks browser, pinned encoder, disk space and app/emulator prerequisites. `capture` runs the cases and stores source captures plus observation bundles. `optimize` produces the PNGs/GIFs/posters without replacing evidence. `verify` validates actual file signatures, decode success, nonzero dimensions, GIF frame count, durations, sizes, hashes and provenance. `readme build` writes only the bounded generated media section and preserves the rest of the README. `readme verify --local` checks links, alt text and local rendered layout; it MUST NOT label that as GitHub verification.

If an encoder is missing, install an approved local dependency or return a concrete blocker. Missing GIFs or screenshots means the required media gate remains BLOCKED, even if application tests pass.

## Encoding and repository size

Use a pinned image/video toolchain, such as FFmpeg with a generated palette for GIFs. Target 960–1200 px GIF width and 8–12 frames per second, preserving legibility and outcome state. These are lab publishing defaults, not GitHub platform limits.

Target at most 2 MiB per PNG, 5 MiB per GIF and 25 MiB total committed README media. Shorten or crop recordings before making text unreadable; if a faithful capture cannot meet the budget, report the trade-off rather than silently exceeding it. Verify that a `.gif` is actually animated, not a renamed video or single-frame image.

Crop empty margins and pauses, not outcome-changing steps. Disclose cuts or speed changes in the caption and manifest; never interpret edited duration as measured latency. No flashing transitions, excessive zoom or decorative motion.

## Manifest and revision binding

Generate `docs/assets/media-manifest.json` with `schema_version: 1`, `generated_at`, `application_revision`, `application_tree_sha256`, `fixture_sha256`, `capture_tool_versions`, `media` and `readme_verification`.

Each media item MUST contain `id`, `path`, `sha256`, `mime_type`, `width`, `height`, `bytes`, `run_id`, `scenario_ids`, `profile`, `mode`, `source_capture_sha256`, `evidence_refs`, `alt_text`, `caption`, `edits`, `redaction_review` and `visual_review`. Animated items additionally require `duration_ms`, `frame_count`, `poster_path` and `poster_sha256`. Optional video URLs remain null with a reason when not published.

`application_revision` identifies the tested code, not a later documentation-only commit adding generated assets. Record the application-tree digest so a media/docs-only commit does not create an impossible recapture loop. A change to relevant application code, fixture or dependency lock invalidates the captures until rerun; label historical captures with their old revision rather than presenting them as current.

All paths MUST be relative, within the repository and free of secrets or local machine identifiers. Evidence references MUST point to sanitized committed evidence summaries or an approved durable artifact. A gitignored local path alone is not reproducible public evidence.

## README layout and embedding

Use `docs/README_STORYBOARD.md` to build the actual root README. The screenshot near the opening should explain the app in one glance; short GIFs should explain behavior, not dominate every section.

Use repository-relative image paths and meaningful alt text. GitHub documents image support in README files and recommends relative paths for images in the same repository ([GitHub image and relative-path guidance](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax)).

Every GIF MUST have a visible nearby static-image link and a short text explanation of the result. Do not rely on custom JavaScript, iframes, autoplay video or browser-storage features in the README. Link longer video with a poster image after a real approved URL exists; do not fabricate or leave dead placeholder links.

## Verification and completion

The local gate requires five valid screenshots, three animated GIFs, three static posters, a complete manifest, sanitized evidence references and working README embeds. It also requires a local rendered README inspection at desktop and narrow viewport widths, including every media item's loaded state and alt text.

A separate `readme verify --github --repo OWNER/REPO --ref REF` command MUST inspect the actual GitHub-rendered README only after the repository/ref exists and access is authorized. Check image loading, relative paths, caption legibility, static fallback links and private URL leakage. Save sanitized verification evidence; do not create or push a repository merely to satisfy this check.

Track `local_media_status` and `github_render_status` separately. The local package may be `LOCAL_CORE_READY` with all media complete while GitHub verification is `NOT_RUN` pending publication authorization. It MUST NOT claim `GITHUB_RENDER_VERIFIED` from a local Markdown preview.

## Failure cases

Missing files, invalid format, a single-frame “GIF”, stale captures, wrong run binding, unreadable text, broken embeds or private data MUST fail the affected local media check. Missing publication authorization MUST leave only the GitHub-render check pending; it does not authorize publication or invalidate otherwise complete local media.
