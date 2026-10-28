# Reproducing the README media and evidence

The screenshots, GIFs, posters and MP4 clips in the root README are captures of real local integration runs in the teaching console. This page explains how they are produced, what binds them to the tested code and how to check them.

## Prerequisites

The same as the local core (Node.js 24, Docker, the pinned Floci image, `npm ci`), plus FFmpeg 6.x on `PATH` with the `palettegen`/`paletteuse` filters and `libx264`, and Playwright's Chromium (`npx playwright install chromium`). The publication scan also needs the owner's private-terms list at `private-runs/private-terms.txt` in the main checkout; without it, capture and export refuse to run rather than report zero findings.

```bash
npm run lab -- media doctor
```

## One command sequence

Start from a clean working tree (`git status` empty): every run records the whole-tree dirty flag, so `media capture` refuses to start on uncommitted changes, and a capture forced with `--allow-dirty` fails `media verify`.

```bash
npm run media:readme
```

That script runs, in order:

```bash
npm run lab -- media doctor
npm run lab -- media capture --suite readme     # real scenario runs in the console, raw captures to recordings/raw/
npm run lab -- media optimize --suite readme    # PNG/GIF/poster/MP4 + captions + sidecars, sanitized evidence, manifest
npm run lab -- readme build                     # rewrites only the LAB MEDIA slots of README.md
npm run lab -- readme verify --local --record   # links, alt text, captions, fallbacks, local render at 1440 and 400 px
npm run lab -- media verify --suite readme      # decode, hashes, provenance, staleness, budget
```

Then commit `README.md`, `docs/assets/`, `docs/evidence/` and `artifacts/readme-verify/` together. An independent reviewer (not the media pipeline) inspects the rendered README and writes `docs/assets/render-review.json`; F6-A3 accepts only a record whose hashes match the current README and manifest.

## What capture does

`media capture` starts the teaching console on a loopback port and drives it with Playwright at 1440x900, device scale factor 1. Each "Run" is a full `collect-case` run: a fresh Floci container, two Emulate Slack workspaces, the scripted worker and the independent collector, followed by a C5 report. Playwright waits for the console's `data-run-state="reported"` attribute, which appears only after the report exists; it never sleeps to guess readiness. Pauses after a verified state are viewer dwell for legibility and are recorded as edits.

GIFs and clips are encoded from Chromium's lossless screencast frames (a PNG whenever the page repaints). Playwright's VP8 WebM of the same session is kept in `recordings/raw/` as a cross-check. Every capture step scans the visible text and DOM for the secret rules and private terms; any finding stops the capture.

## What binds a capture to the code (ADR-9)

The manifest records `application_revision` (the commit captured) and `application_tree_sha256`: a SHA-256 over `path\0sha256(content)\n` for every tracked file that decides what a captured run does. Application code is defined in `src/media/spec.ts`:

- included: `src/`, `web/`, `fixtures/`, `profiles/`, `compose.yaml`, `package.json`, `package-lock.json`, `DEPENDENCIES.lock.json`, `tsconfig.json`, `scripts/patch-emulate.mjs`;
- excluded: `src/media/` (this pipeline), `src/cli/commands/media.ts`, `readme.ts`, `record.ts`, and the F6/S4 verification handlers `src/collector/cases/f6-*.ts` and `s4.ts`.

Documentation, the README, generated media, `docs/evidence/` and tests are outside the digest, so a docs- or media-only commit does not force a recapture. Any change to an included file (a workflow, the worker, the console, an adapter, a fixture or a dependency lock) makes `media verify` report `stale_capture` until the media are recaptured. Fixtures are also bound separately through `fixture_sha256`.

## Evidence references

Every media item lists `evidence_refs` under `docs/evidence/<run_id>/`. Those directories are the allowlisted `lab export` projection of each run (`report.json`, `observations.json`, `checksums.sha256`) after the tamper check, the secret scan and the private-terms scan. `media verify` checks that each referenced run exists, passes its checksums, came from the captured clean revision and fixtures, and is an unmutated local scripted run of the listed scenario.

## Checks

- `npm run lab -- media verify --suite readme`: file signatures, full FFmpeg decode, dimensions, GIF frame count (more than one), duration (12 to 25 s for the service-request GIF, 8 to 20 s for the others), 960 to 1200 px width and 8 to 12 fps, sha256 against the manifest, posters, provenance, staleness and the budget (2 MiB per PNG, 5 MiB per GIF, 8 MiB of MP4, 25 MiB in total).
- `npm run lab -- readme verify --local`: every relative link and embed resolves, alt text is meaningful, each asset carries its manifest caption (with run ID and mode), every GIF has a static poster link and every clip a poster image; then a local Markdown render (marked) is opened in Chromium at 1440 and 400 px, image loading and horizontal overflow are checked and screenshots are saved to `artifacts/readme-verify/`. These screenshots are verification evidence, not application captures, and a local render is not GitHub verification.
- `npm run lab -- readme verify --github --repo OWNER/REPO --ref REF`: inspects the actual GitHub page only when a remote exists, both options are given and the owner has set `APL_GITHUB_RENDER_AUTHORIZED=1`. Without those it reports `NOT_RUN` (exit 2) and contacts nothing.
- `npm run verify:task -- 6.1` and the supplied cases F6-A1 to F6-A5 and S4 run the console and media checks through the independent collector.

## Single recordings

`npm run lab -- record --case W01-H` records one console scenario run (WebM, screenshots, session record) into `recordings/raw/` without touching the README media. See [recordings](../recordings/README.md).
