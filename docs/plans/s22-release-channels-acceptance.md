# Platform release channels: owner live acceptance

Implementation tests are local/faked. No action below was run against pve,
pve2 or CT 590 by the implementation agent.

- [ ] Publish a stable release and an edge prerelease manually. Verify bootstrap
  selects stable by default and edge by `--channel edge`, using numeric sequence
  ordering and stable-over-edge precedence at the same base version.
- [ ] Promote the edge release. Compare both GHCR manifest digests before/after;
  verify the stable bundle's VERSION, original Python sources and node-agent hash.
- [ ] Fresh install: stable + auto ON; legacy first upgrade: stable + auto OFF,
  availability hint. Finish template work before the first pre-fence upgrade.
- [ ] Settings owner/origin restrictions; channel/auto/pause/window persistence;
  running version, dev warning and recipe channel match. Inspect the PVE service
  WorkingDirectory: it must reference the target bundle's installer code.
- [ ] Timer outside window, paused, notify-only, another installer action, active
  template build: no platform restart. A new build cannot pass the maintenance
  fence. The dashboard banner appears and disappears as maintenance finishes.
- [ ] Keep a sandbox running through an update: guest uptime/process survives,
  control-plane/gateway connectivity recovers. Check the updater refreshed all
  configured restricted node agents without granting root access to the CT.
- [ ] Before updating, inspect backup metadata/source version and dump readability.
  Fail backup / exhaust backup space: no release apply. After four updates only
  the last three complete backups remain, with root-only access.
- [ ] Inject unhealthy target with compatible marker: old images recover and new
  DB writes survive. With incompatible or absent marker: old DB + small volumes
  recover, file owners remain correct, history explicitly records lost writes.
- [ ] Interrupt during backup and during apply. Next host invocation recovers;
  failed restoration retains checkpoint/fence instead of claiming success.
  Corrupt a backup: checksum verification refuses before dropdb/volume changes.
- [ ] Failed target does not repeatedly roll back every timer tick. Manual retry
  remains available, and a newer published release is processed autonomously.
- [ ] Signed recipe rollout uses the selected channel after platform update;
  a verified replacement becomes active for new VMs. Existing VMs stay running.
- [ ] Uninstall removes host timer/service; non-Umiak guests and resources remain.

No product/security decisions remain unanswered. Registry promotion, actual
systemd timing, gateway reconnection and database restoration need the above live
acceptance before declaring the stage operationally accepted.
