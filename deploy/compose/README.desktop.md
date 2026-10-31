# Desktop TURN (S10)

The TURN server is self-hosted coturn, enabled with `--profile desktop`.
Assign a dedicated IPv4 address to the Linux host and set `SBX_TURN_IP` and
`SBX_TURN_REALM` in `.env`. It must not share gateway's IP on TCP 443.
No external tunnel/relay service is used. Dev addresses belong in `infra/dev-cp/`.

Place `auth-secret`, `tls.crt` and `tls.key` in `secrets/turn/`, readable only by
UID 1000 (the worker and coturn), directory 0700, private files 0600. The shared
secret must contain at least 32 random bytes, encoded as base64/hex. The worker
reads the same secret from its own read-only mount and sends only expiring HMAC
credentials to guests. Never put the secret in `.env`, API responses or logs.

Open UDP/TCP 3478 and TCP 443 to clients. Relay ports 49152–65535 stay local:
peer permissions deny all IPv4/IPv6 addresses except this server's own IPv4.
Only relay-to-relay candidates can pass. There is no unauthenticated mode.
TLS certs and the auth secret are mandatory. coturn's config is generated in
private tmpfs; the process is unprivileged with only NET_BIND_SERVICE.

Proxmox egress firewall changes remain a separate operator step with a rollback
timer and prior master notification. No firewall is changed by compose.
Real relay-to-relay connectivity, secret expiry on Refresh and upstream stream
pairing are acceptance/spike items, not claims made by config tests.

For the worker, set `SBX_TURN_SECRET_FILE=/turn-secrets/auth-secret` and
`SBX_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:443?transport=tcp`.
The read-only mount is shared with coturn. Credentials last 24 hours and are
refreshed by `ctl-desktop-turn` every ten minutes once older than twelve hours.
