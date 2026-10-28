# Blind holdout scenarios (archived)

Fifteen scenarios (BH-01 to BH-15) written by an agent that never saw the builders' tests, after every builder agent had stopped. Expectations were written before any scenario ran (`expectations.json`, sha256 `486f13a72c2fa04be8f3d8862ae12fa78d805e2a2da3bf67f73560ef4f9fb80c`, written 2026-10-28T15:16:47.440674+00:00) and run once against frozen candidate commit `ea1deca` (tree `60f9f1bf`).

Result: 13 PASS, 2 FAIL (BH-07, BH-03b). See `results/` and LEARNINGS L-027 and L-028. BH-07 was fixed afterwards; BH-03b is disclosed as a weak control.

These results are **blind to the builder agents, not to the orchestrator**. Now that they are published they are public challenge cases, not holdouts: re-running them on later trees is a regression check, not a blind result. The scripts expect `APL_BLIND_CANDIDATE` (a checkout of the candidate) and `APL_BLIND_DIR` (this folder).
