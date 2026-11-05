# S22 implementation plan

1. Publish signed immutable recipe bundles with manual dispatch, optional pin
   refresh and committed version diff. Test signature/checksum/compatibility.
2. Add durable polling, validated recipe selection and idle rollout via setup
   jobs and S21 replication. Reuse fenced promotion/retirement; add rollback.
3. Expose channel settings, changelog, errors/history and actions in Templates.
   Run targeted tests, typecheck and lint; rebase and push each green phase.

Live acceptance is owner-run: publish a test release, observe idle build/copy,
verify create uses new versions, corrupt assets, test incompatibility, retry,
rollback and reference-protected retirement. Confirm restart and pause behavior.
