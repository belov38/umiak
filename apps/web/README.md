# Umiak web

Next.js serves the owner dashboard at `/app` and Payload admin at `/admin`.
The installer-managed owner ingress verifies browser sessions and keeps the web
listener private. Web checks the ingress's client-network stamp and enforces
the configured Origin for writes. Client-supplied user/group headers never
select the authenticated identity.

Payload resolves the stable owner identity with operator rights and a personal
team. Single-tenancy presentation hides team management while internal team
ownership, quotas and scoped API keys remain enforced by the API.

Use the root development Compose stack:

```sh
docker compose --env-file compose.dev.env -f compose.yaml -f compose.dev.yaml up --build
```

`e2e/quickstart-ui.mjs` is an isolated owner-renderer fixture. Unit/integration
checks run with `pnpm --filter @umiak/web test`. See the repository getting-started
guide for claim links, CLI pairing, session revocation and owner recovery.
