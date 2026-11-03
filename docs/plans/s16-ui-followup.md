# S16 UI follow-up execution ledger

Spec: user acceptance follow-up to S16 rounds 1–5 and UI consistency.

## Plan

- [x] Separate public and trusted proxy listeners; reject gateway trust; prep warning and pinned media/proxy audit.
- [x] Verify HTTP preview cookie host scope and signed label isolation.
- [x] Repair dashboard primitives, policy and mobile/focus regressions.
- [x] Bring pre-session quickstart pages into shared visual contract without changing authorization.
- [x] Capture baseline/final screenshots; run sequential build/lint/typecheck/tests, Node, Go, Python, browser and shell gates.
- [x] Read-only operation check, deploy CT590 preserving credentials/CA, anonymous verification.
- [x] Update roadmap/report/evidence; commit and push branch without merging.

## Rulings

- Ruling: execute without design approval pauses — the request explicitly delegates technical decisions and authorizes end-to-end execution.
- Ruling: use the existing isolated worktree and branch s16-ui-followup; no separate checkout is needed.
- Ruling: independent security, dashboard and quickstart rendering tasks run concurrently, per dispatching-parallel-agents; integration and live actions stay with the root agent.
- Ruling: retain signed HTTP cookie format and enforce host-only issuance plus exact signed label matching. Existing implementation already does both; add explicit HTTP sibling regression coverage rather than change credentials unnecessarily.
- Ruling: baseline dashboard captures use a clean git archive of b2d8b74a so concurrent edits cannot contaminate baseline.


## Completion evidence

See the final post-merge section in `s16-quickstart.md`. All requested changes
are implemented and committed. The full sequential run passed 4,592 Vitest +
83 Python tests; the final affected MCP rerun passed 715 tests (one additional
wire test), Node passed 151, OIDC 27, local 2 and quickstart UI 1. CT590 was
redeployed and anonymously verified, owner-state digest and gateway certificates
preserved. Screenshots and full absolute manifest are in
`/tmp/umiak-s16-evidence-HumwBq`. Independent acceptance/merge remains external.

- Ruling: Node 26 fetch discards explicit Host headers — native HTTP transport is
  required for a fixed internal destination with a canonical external authority.
  Real socket tests replace the insufficient mock-level assumption.
- Ruling: PVE proxy discovery requires root-only non-propagated Sys.Audit on new
  prepared tokens. Existing adopted tokens fail URL download before any network
  transfer with an actionable permission error; no live ACL is modified.
