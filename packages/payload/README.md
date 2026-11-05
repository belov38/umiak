# Payload configuration store

Payload backs the homelab dashboard and admin. API and worker use its Local API
for identity, personal teams, scoped API keys, templates, sizes and quotas.
The owner strategy accepts only the trusted ingress's client stamp and resolves
the stable internal owner subject. Client-supplied login headers are ignored.

`idpSubject` remains the legacy storage name of the stable internal session
subject; `umiak:local` and the internal operator group are used by owner login.
They are not an external-directory integration. Teams remain necessary for
sandbox ownership, API key scopes, quotas and foreign-resource isolation.

Identity/config hooks notify API caches and the gateway after changes. Owner
network admission is checked on every request before resolving an identity.

Migrations are append-only. `20261105_000000_owner_only` drops the obsolete
platform port-policy columns and enum, and converts directory deactivation
reasons to `operator` before narrowing the enum. Its generated JSON snapshot
keeps future schema diffs accurate. `20261105_011533_retire_directory_notices`
drops the directory-sync notice table, its enum and locked-document relation.
Old migrations remain unchanged. Browser sessions are resolved on every request;
the obsolete external-session cache and its listener were removed.

```sh
pnpm --filter @umiak/payload test
node packages/payload/src/create-migration.ts <name>
```
