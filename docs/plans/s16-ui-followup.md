# S16 UI follow-up execution ledger

Spec: user acceptance follow-up to S16 rounds 1–5 and UI consistency.

## Plan

- [ ] Separate public and trusted proxy listeners; reject gateway trust; prep warning and pinned media/proxy audit.
- [ ] Verify HTTP preview cookie host scope and signed label isolation.
- [ ] Repair dashboard primitives, policy and mobile/focus regressions.
- [ ] Bring pre-session quickstart pages into shared visual contract without changing authorization.
- [ ] Capture baseline/final screenshots; run sequential build/lint/typecheck/tests, Node, Go, Python, browser and shell gates.
- [ ] Read-only operation check, deploy CT590 preserving credentials/CA, anonymous verification.
- [ ] Update roadmap/report/evidence; commit and push branch without merging.

## Rulings

- Ruling: execute without design approval pauses — the request explicitly delegates technical decisions and authorizes end-to-end execution.
- Ruling: use the existing isolated worktree and branch s16-ui-followup; no separate checkout is needed.
- Ruling: independent security, dashboard and quickstart rendering tasks run concurrently, per dispatching-parallel-agents; integration and live actions stay with the root agent.
- Ruling: retain signed HTTP cookie format and enforce host-only issuance plus exact signed label matching. Existing implementation already does both; add explicit HTTP sibling regression coverage rather than change credentials unnecessarily.
- Ruling: baseline dashboard captures use a clean git archive of b2d8b74a so concurrent edits cannot contaminate baseline.
