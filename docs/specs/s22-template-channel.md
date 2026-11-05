# S22: Signed recipe channel and autonomous rollout

Recipes ship separately from platform images as immutable `recipes-<version>`
GitHub releases. `recipes.tar` contains infra/templates and channel.json (version,
builder API, minimum/maximum platform, minimum agent, changelog including pinned
versions diff). SHA256SUMS is signed with an Ed25519 publisher key. Public keys
are provisioned by the owner, never fetched from the channel. This follows the
agent package trust model, with a distinct publisher authority.

The owner-only quickstart control plane polls daily (interval configurable,
checking and rollout independently disabled). Verify signature, archive checksum,
strict archive paths/types and compatibility before caching recipes. Baked recipes
remain the fallback. Missing publisher keys disables consumption with a visible
error; an installation's private agent key cannot authenticate upstream releases.

Rollout defaults on. Reconcile enabled OS types serially on idle nodes through
the existing build reservation and verification path. Persist release identity
in manifests; promote only a verified result. Reuse S21 build-once replication;
failed replicas retain their old active build. Running sandboxes are never stopped.
Windows rebuilds reuse recorded local ISO inputs; missing media is an actionable
error. Restart reconstructs work from active manifests and durable build records.

Rollback promotes a verified deprecated build only while its VM/base disks still
exist. Retire deprecated builds after 24 hours only with no machine, snapshot or
transfer references, using the existing fenced node-template retirement service.
Dashboard exposes settings, available changelog, progress/history, retry and rollback.
No scheduled GitHub workflow or live host access is part of implementation.
