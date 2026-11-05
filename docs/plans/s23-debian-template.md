# S23 implementation plan

> **Status: deferred (2026-11-06).** Implementation reverted from main; Ubuntu stays the only Linux template. Kept as the design record for a later revival.

1. Commit spec and this plan.
2. Add Debian pins and inherited recipe. Generalize recipe schema, image cache,
   downloads and versions updater; enforce cloud.debian.org HTTPS without redirects,
   SHA512 at pin time and both pinned hashes at build time. Add distro helpers in
   linux/lib.sh, adapt kernel/packages/network/cleanup and independent verify script.
3. Register Debian throughout setup, template metadata, dashboard, CLI/API/MCP/SDK
   descriptions and getting-started docs. Recipe bundles already copy the full tree.
4. Add regression tests, run template-builder tests/typecheck, setup tests and lint.
   Commit phases, fetch/rebase origin/main, fast-forward push. Record exact deferred
   live build/verify commands and final main SHA.
