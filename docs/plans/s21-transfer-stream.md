# S21 template transport

The only supported replication transport is `volume.sendTo` / full-copy.ts:
standard Proxmox raw+size export/import, zstd and pinned cluster SSH, with
streaming SHA-256 and durable UUID-bound import receipts. Enabled by default.

The custom block relay and experimental binary delta/sandbox FULL paths were
removed by the owner's 2026-11-05 decision. Cold moves are deferred; future
options are standard pvesm full copy, rsync over a base snapshot, or ZFS send -i.
See `../specs/s21-portable-sandboxes.md` and the current acceptance runbook.
