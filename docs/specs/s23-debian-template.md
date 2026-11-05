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
downloads the image and verifies SHA512, then records serial, SHA512, SHA256 and
source URL. Signed Umiak recipe bundles distribute these pins. Every build checks
both hashes, including cached files. Do not add a misleading legacy signing key.
If Debian starts publishing signed checksums, migrate to signature verification.

## Lifecycle and acceptance

S5 build/verify/report/seal lifecycle, S22 signed recipe distribution and S21
build-once replication apply unchanged. Show Ubuntu 26.04 / Debian 13 in product
selection. Unit tests cover recipe inheritance, pin validation, download trust,
cache tampering, seed rendering and verify reports. No live stand use until the
parent explicitly confirms availability.
