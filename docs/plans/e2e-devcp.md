# E2E on the dev control plane (CT 590)

> Historical plan, predating R1. Current names and contracts: `docs/specs/rename-umiak.md`.

First bring-up of the whole MVP stack (S1–S7) on CT 590 and Ilia's scenario from the Mac: `sbx login` → `create` (template 597, `linux 20261030.16`) → exec → files → preview → ssh → fork → snapshot → stop/resume → delete, plus the TS and Python SDKs. Branch `e2e-devcp`.

## What was done

- `infra/dev-cp/deploy.sh` deploys `main` with all S7 services (api, Keycloak, oauth2-proxy) behind Tailscale Serve; the gateway talks to the api internal listener (`http://api:8082`), the worker gets `SBX_TUNNEL_URL`. Template 597 is active (`sbx-admin bootstrap` in `migrate`).
- `infra/dev-cp/dev-users.sh`: users of the `sbx` realm. `ilia@example.com` with a temporary password in `~/.config/sbx/dev-cp/ilia-initial-password` (0600, outside git) and `e2e@example.com` with a permanent password for the scenario. The team with the owner role is the personal team that the api creates on first login.
- `infra/dev-cp/e2e.sh`: the whole scenario in one command (PASS/FAIL table). Helpers: `kc-browser.py` (device grant confirmation and Keycloak login for the SSO port without a browser), `e2e-pty.py` (`sbx shell` in a pseudo-terminal). SDKs: `packages/sdk-ts/e2e/devcp.ts`, `packages/sdk-py/e2e/devcp.py`.
- A quickstart guide for Ilia (since removed together with the dev stand).

## Result

`infra/dev-cp/e2e.sh` on CT 590, 2026-10-31: 20/20 PASS, about 6 minutes. Create ~14 s, resume ~10 s, fork ~15 s; first `exec` line ~130 ms; 80 MB `cp` each way 4 s; idle stop with `--idle 60s` after 71–81 s. After the run `pve` has no VMs 500–589 and no snapshot LVs.

## Bugs found

### 1. Keycloak eats all of the CT's memory

- **Symptom.** The first `deploy.sh` with S7 did not finish; the CT stopped answering over SSH (`banner exchange` timeout), the CT's `memory.current` hit the 3 GB limit, `memory.events high` kept growing. Keycloak died with code 137 in the middle of the realm import.
- **Cause.** A JVM in Docker inside LXC without its own cgroup limit computes the heap from host memory (`sysinfo` is not virtualized by lxcfs, 125 GB), by default `MaxRAMPercentage=70`. Keycloak grew to 2.5 GB RSS.
- **Fix.** `infra/dev-cp/compose.dev-cp.yaml`: `keycloak` gets `mem_limit: 1200m` and `JAVA_OPTS_KC_HEAP=-Xms128m -Xmx512m`. The `keycloak` database was dropped after the interrupted import. Keycloak is now ~520 MB, the whole stack ~1.1 GB of 3 GB.
- **Test.** No unit test (JVM behavior in LXC). Verified by deploying to the CT and `docker stats`.

### 2. SSH into the sandbox does not work: the worker does not pass the SSH user CA to the agent

- **Symptom.** `sbx ssh` → `cannot reach sshd in sandbox`; the gateway log shows `backend login failed ... unable to authenticate, attempted methods [none publickey]`. In the VM `/etc/ssh/sbx_user_ca.pub` is empty.
- **Cause.** The gateway logs into the VM's sshd with a certificate from the SSH user CA (`SBX_GATEWAY_SSH_USER_CA_KEY_FILE`), while the agent trusts the keys from Claim (`ssh_user_ca_keys`). The worker takes them from `SBX_SSH_USER_CA_KEYS_FILE`, but `deploy/compose/gateway.yaml` gave the worker only the gateway token. The list was empty in any compose stack.
- **Fix.** `deploy/compose/gateway.yaml`: the worker gets `SBX_SSH_USER_CA_KEYS_FILE=/run/sbx-gateway/ssh_user_ca.pub` (the gateway secrets directory is already mounted).
- **Test.** `apps/worker/test/compose-wiring.test.ts` parses `gateway.yaml` and checks the "gateway CA → worker's `.pub`" pair. It failed on the old `gateway.yaml` (`expected undefined to be '/run/sbx-gateway/ssh_user_ca.pub'`). Steps `sbx ssh` and `plain ssh :2222` in `e2e.sh`.
- **Limitation.** The key arrives only in Claim (create, fork, create --from). Resume does not repeat Claim: sandboxes created before the fix stay without SSH, and a change of the SSH user CA does not reach existing sandboxes. See "Open questions". Closed by branch `fix-resume-sshca`: the `provision` step (resume, recover, reprovision) calls `System/UpdateSshCa`.

### 3. Every deploy that recreates the gateway stalls the stack for 16 minutes

- **Symptom.** A repeated `deploy.sh` hung for more than 10 minutes: the old gateway `unhealthy`, the new one and the worker in `Created`.
- **Cause.** `gateway.yaml` sets the production drain (`stop_grace_period: 960s`, drain up to 950 s: it waits for tunnels and SSH to move to another instance). There is one gateway on the CT, nowhere to move, so compose waits the whole period, and the worker depends on the gateway.
- **Fix.** `infra/dev-cp/compose.dev-cp.yaml`: `SBX_GATEWAY_DRAIN_TIMEOUT=20s` and `stop_grace_period: 30s`. Compose takes the stop timeout from the old container, so the first deploy after the fix waited once more (the old gateway was stopped with `docker kill`); after that recreation takes seconds.
- **Test.** Deploy to the CT; `docker inspect` of the gateway: `StopTimeout 30`, `SBX_GATEWAY_DRAIN_TIMEOUT=20s`.

### Minor findings along the way (not product bugs)

- The `sbx` realm uses the email as the username (`registrationEmailAsUsername`), so Ilia's login is `ilia@example.com`, not `ilia`.
- Keycloak 26 requires a first and last name (required action `VERIFY_PROFILE`): without them the device grant login stops at the profile form. `dev-users.sh` sets them.
- `docker compose exec -T` reads stdin: in a script passed through `ssh … bash -s` it swallowed the rest of the script (`</dev/null` in `dev-users.sh`).

## Open questions for master

- **SSH user CA only in Claim** (S3/S6). The agent stores `ssh_user_ca_keys` from the first Claim, resume does not update them. So CA rotation (S4 §9.3) does not reach existing sandboxes. Passing keys on resume or a separate agent call is needed — a protocol or orchestration change, not done within e2e.
- `create --from <snapshot>` does not carry over the source sandbox's env and secrets (the disk is carried over). Looks like the intended behavior (env is set in the request), but the S7 spec does not say so explicitly.
- `sbx logs -f` exits with `0` for a command with a non-zero code (the spec defines the command's code only for `exec`/`run`).
- `sbx snapshot save` without `--wait`: the snapshot is ready in ~2 s, the scenario waits for `snapshot list`.
- Idle stop with `--idle 60s` fires after ~80 s (activity accounting step).

## Closed by branch `fix-resume-sshca` (2026-10-31)

- SSH user CA: the worker sends `System/UpdateSshCa` with the current key set in the `provision` step (S6 §7.6, S3 §8.1). The agent protocol did not change: the RPC existed since S3. Sandboxes created before the CA was configured get the key on the next stop/resume.
- `sbx logs -f` exits with the command's code, like `exec` (S7 §14.2, §14.3); without `-f` — `0`.
- `snapshot save --wait` existed before, the scenario did not use it. Now the output matches other waiting commands (JSONL `accepted` → `ready`, 5 min limit); `e2e.sh` waits via `--wait`.
- `create --from <snapshot>` does not carry over env and secrets — recorded in S7 §8.3 as intended.
