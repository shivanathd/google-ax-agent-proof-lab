# Recordings

Raw captures live in `recordings/raw/`, which is gitignored. Nothing in this directory is published.

Each capture session is a timestamped folder created by `npm run lab -- media capture --suite readme` (or `npm run lab -- record --case <scenario>` for a single run). It contains:

- `session.json`: candidate revision, git tree, application-tree digest, fixtures digest, browser version, viewport, and for every shot the run IDs, timeline marks, screenshot hashes and the on-screen publication-scan counts;
- `<shot>-frames/` and `<shot>-frames.json`: lossless Chromium screencast PNG frames with timestamps and per-frame SHA-256 (the source of the GIFs and MP4 clips);
- `<shot>.webm`: Playwright's VP8 recording of the same session, kept as a cross-check;
- PNG screenshots taken at verified states (the README screenshots and posters are byte-for-byte copies);
- `*.ffconcat`: the exact frame lists `media optimize` encoded.

`recordings/raw/latest.json` names the session that `media optimize` reads.

The committed, sanitized derivatives are in `docs/assets/` (with captions and sidecar records for the clips in `docs/assets/videos/`) and their run evidence in `docs/evidence/`. Inline video playback on GitHub would need a separately approved upload; until then the README links the MP4 files through poster images.

Before any upload, follow the review steps in the [recording runbook](../docs/RECORDING_RUNBOOK.md) and the [publication checklist](../docs/PUBLICATION_CHECKLIST.md). Recordings must not show login screens, tokens or emulator auth inspectors; the console never displays them, and the capture stops if its scan finds a secret pattern or a private term on screen.
