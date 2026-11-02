# Umiak login branding

Extends `keycloak.v2` from the pinned Keycloak 26.8.1 image. No FreeMarker
overrides: login, errors and required actions retain the stock templates.
The stock header has a dark background in both modes, so the lockup uses
white ink at 40 px canvas height. PatternFly's primary variable is cobalt.

Compose mounts the theme read-only and disables theme/template/static-resource
caching for development. Restart Keycloak after changing its startup options;
subsequent theme edits need only a page reload.

`realm-umiak.json` selects the theme on **first import only**. For an existing
realm, update it through the Admin API or kcadm; do not reset the database:

```sh
docker compose exec keycloak bash -c '/opt/keycloak/bin/kcadm.sh update realms/umiak --no-config --server http://localhost:8080 --realm master --user admin --password "$(cat /run/umiak-secrets/admin-password)" -s loginTheme=umiak'
```

Use the installation's admin credentials if bootstrap credentials were changed.
Outlined Inter assets: `research/umiak-logo/final/` (local source); Inter license
is retained in `apps/web/public/brand/OFL-Inter.txt`.
