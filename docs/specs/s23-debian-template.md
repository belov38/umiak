# S23: Debian 13 sandbox template

Add `debian` (trixie, amd64 genericcloud) alongside `linux` (Ubuntu 26.04,
unchanged default). Reuse the Linux recipe steps, seed, files and verification;
select apt sources, kernel, Java and Ubuntu-specific behavior by distro.
Same agent package, tunnel CA, SSH policy, user and tooling as Ubuntu.
Debian uses its amd64 kernel and Java 21 where Ubuntu uses generic and Java 25.
Both archives get bounded retries, HTTP timeouts and host-level download queues.
Archive failures must surface one concise reason in the builder error.

## Trust

Debian current cloud images do not publish signed checksums:
https://cloud.debian.org/images/cloud/ documents this explicitly. Parent approved
HTTPS TOFU at pin time, weaker than Ubuntu's signed SHA256SUMS. The versions
updater fetches SHA512SUMS over strict HTTPS restricted to cloud.debian.org,
downloads the image (at most five HTTPS redirects, never HTTP downgrade) and verifies SHA512, then records serial, SHA512, SHA256 and
source URL. Signed Umiak recipe bundles distribute these pins. Every build checks
both hashes, including cached files. Do not add a misleading legacy signing key.
If Debian starts publishing signed checksums, migrate to signature verification.

## Lifecycle and acceptance

S5 build/verify/report/seal lifecycle, S22 signed recipe distribution and S21
build-once replication apply unchanged. Show Ubuntu 26.04 / Debian 13 in product
selection. Unit tests cover recipe inheritance, pin validation, download trust,
cache tampering, seed rendering and verify reports. No live stand use until the
parent explicitly confirms availability.

## Initial pins and validation

- Cloud serial: `20261103-2651`, official Debian 13 genericcloud amd64 qcow2.
- SHA256: `de9d63f5e5ec5927d7548bc05b6043b87457b8c1cb9bcb95365168e8d0293b4f`.
- SHA512 and canonical source URL: `infra/templates/debian/versions.toml`.
- Debian/security snapshot: `20261105T000000Z`.
- Docker CE/CLI: `5:29.9.3-1~debian.13~trixie`; containerd `2.4.2-3`,
  Compose `5.7.0-1`, buildx `0.38.1-1` (all Debian 13 trixie revisions).
- Tool archives, Rust bootstrap, Chrome and npm agent pins initially equal Ubuntu's.

The base image was downloaded and SHA512 verified locally to establish these
pins. No live VM build or stand access is part of this implementation validation.
Deferred build/verification commands are in `apps/template-builder/README.md`.
