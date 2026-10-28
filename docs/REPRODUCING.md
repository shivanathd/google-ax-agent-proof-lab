# Reproducing the README media and evidence

The screenshots, GIFs, posters and MP4 clips in the root README are captures of real local integration runs in the teaching console. This page explains how they are produced, what binds them to the tested code and how to check them.

## Prerequisites

| Needed for | What |
|---|---|
| Everything | Node.js 24.x (`engines` refuses other majors), `npm ci` (applies the pinned Emulate patch) |
| Every case that starts Floci (most of them) | Docker with a running daemon, and the pinned image: `docker pull floci/floci:2.3.0@sha256:e0b292df4dc9559b7b1bf4f51bdda4bb8e269276236438cd03cae661260ea8a9` |
| Console and media cases only (F6-A1 to F6-A5, S4) and media capture | FFmpeg 6.x on `PATH` with the `palettegen`/`paletteuse` filters and `libx264`, and Playwright's Chromium: `npx playwright install chromium` |
| F6-A2, media capture, `lab export` | A private-terms list (below) |

`npm run lab -- doctor` checks the local core; `npm run lab -- media doctor` checks the media prerequisites. Neither makes a network call.

### The private-terms list

`private-runs/private-terms.txt` (gitignored) is the maintainer's local list of forbidden identifiers: names of real employers, customers, projects, hosts or accounts that must never appear in a published capture or export. It is not in the repository, and its contents are never printed; scans report counts and file names only. It is resolved through the git common directory, so worktrees share the main checkout's copy.

A reader creates their own, one term per line, matched case-insensitively as a substring; blank lines are ignored:

```bash
mkdir -p private-runs
printf '%s\n' 'your-employer-name' 'your-real-hostname' > private-runs/private-terms.txt
```

Use terms that are private to you; the lab's own fictional names (Dana, Northstar Demo, `T_LAB_A`) would make every scan fail. Without the list the lab fails closed instead of reporting zero findings: `lab export` is REJECTED, media capture refuses to start, and F6-A2 writes a bundle with `execution: NOT_RUN` and the reason "private-terms list missing" (exit 2). It is never PASS.

### F6-A3 and the render review record

F6-A3 checks the committed README media and also requires `docs/assets/render-review.json`: a record written by an independent reviewer (a person or agent that did not produce the media) after inspecting the rendered README: `reviewer` (not the media builder), `reviewed_at`, `desktop_ok` and `narrow_ok` (1440 and 400 px), and `readme_sha256` and `media_manifest_sha256` matching the current files, so any README or media change invalidates it. The media pipeline never writes it, so the case cannot pass itself. Until such a record exists for the current README, `local_render_review_passed` is false, F6-A3 FAILs and the supplied harness verdict is `LOOP` ([claim ledger](CLAIM_LEDGER.md), C-32). A reader reproducing the run gets the same result.

### Optional pre-commit hook

```bash
git config core.hooksPath .githooks
```

`.githooks/pre-commit` refuses a commit when the author email is not a `*.invalid` or GitHub noreply address, or when any staged line contains a term from `private-runs/private-terms.txt`. It fails closed: with no list it rejects every commit. It is a local guard for the maintainer, not a publication gate.

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
- excluded: every `*.md` file (write-ups beside code, such as `profiles/ax/RESULTS.md`), `src/media/` (this pipeline), `src/cli/commands/media.ts`, `readme.ts`, `record.ts`, and the F6/S4 verification handlers `src/collector/cases/f6-*.ts` and `s4.ts`.

Documentation, the README, generated media, `docs/evidence/` and tests are outside the digest, so a docs- or media-only commit does not force a recapture. Any change to an included file (a workflow, the worker, the console, an adapter, a fixture or a dependency lock) makes `media verify` report `stale_capture` until the media are recaptured. Fixtures are also bound separately through `fixture_sha256`.

## Evidence references

Every media item lists `evidence_refs` under `docs/evidence/<run_id>/`. Those directories are the allowlisted `lab export` projection of each run (`report.json`, `observations.json`, `checksums.sha256`) after the tamper check, the secret scan and the private-terms scan. `media verify` checks that each referenced run exists, passes its checksums, came from the captured clean revision and fixtures, and is an unmutated local scripted run of the listed scenario.

## Checks

- `npm run lab -- media verify --suite readme`: file signatures, full FFmpeg decode, dimensions, GIF frame count (more than one), duration (12 to 25 s for the service-request GIF, 8 to 20 s for the others), 960 to 1200 px width and 8 to 12 fps, sha256 against the manifest, posters, provenance, staleness and the budget (2 MiB per PNG, 5 MiB per GIF, 8 MiB of MP4, 25 MiB in total).
- `npm run lab -- readme verify --local`: every relative link and embed resolves, alt text is meaningful, each asset carries its manifest caption (with run ID and mode), every GIF has a static poster link and every clip a poster image; then a local Markdown render (marked) is opened in Chromium at 1440 and 400 px, image loading and horizontal overflow are checked and screenshots are saved to `artifacts/readme-verify/`. These screenshots are verification evidence, not application captures, and a local render is not GitHub verification.
- `npm run lab -- readme verify --github --repo OWNER/REPO --ref REF`: inspects the actual GitHub page only when a remote exists, both options are given and the owner has set `APL_GITHUB_RENDER_AUTHORIZED=1`. Without those it reports `NOT_RUN` (exit 2) and contacts nothing.
- `npm run verify:task -- 6.1` and the supplied cases F6-A1 to F6-A5 and S4 run the console and media checks through the independent collector.

## Captions only

`npm run lab -- media captions --suite readme` rebuilds every manifest caption and the clips' WebVTT cues from the committed manifest, clip sidecars and `docs/evidence/` reports, without re-encoding media (run `readme build` and both verifiers afterwards). Multi-run clips name every run and its outcome in order; cues closer than 1.5 s are merged so no cue is shorter than 1.5 s and none overlap, and `media verify` checks both rules.

## Single recordings

`npm run lab -- record --case W01-H` records one console scenario run (WebM, screenshots, session record) into `recordings/raw/` without touching the README media. See [recordings](../recordings/README.md).
