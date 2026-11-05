# Umiak API

The API runs in the installer-managed homelab stack behind the trusted owner
ingress. Browser sessions and CLI pairing are verified by that ingress; the API
uses the stable owner session and also accepts scoped team API keys. Private
listeners validate the ingress network and the configured host authorities.
Unsafe browser requests require the dashboard Origin.

Payload stores users, personal teams, keys, templates, sizes and quotas. Worker
and API use the same Payload configuration. Internal gateway calls use service
tokens and remain separate from owner credentials.

`GET /v1/meta` advertises owner authentication and single tenancy.
`GET /v1/openapi.json` provides the API contract through the trusted ingress.

```sh
pnpm --filter @umiak/api openapi
pnpm --filter @umiak/sdk gen
cd packages/sdk-py && uv run python scripts/gen.py
```

See [architecture](../../docs/architecture.md) and [getting started](../../docs/getting-started.md).
