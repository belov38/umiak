# S10. Desktop and computer-use: specification

> Superseded template selection (2026-11-03): [S17](s17-windows-single.md) makes `windows` the single Windows 11 desktop recipe (VM 595). `windows-desktop` is an input alias. VM 598 is retired, read-only, and retained for existing sandboxes/snapshots. Historical build evidence below is unchanged.

Status: agreed by the master session 2026-10-29 (Ilia's decisions refined 2026-10-31, §26). Area S10 from `docs/roadmap.md`. Architecture: `docs/architecture.md` (§7, §8, §10). Relies on S2 (tunnel), S3 (agent), S4 (gateway), S5 (Linux template), S6 (control plane), S7 (public API), S8 (dashboard), S9 (Windows). The boundary with phase 2 is S29 "desktop v2" in `docs/roadmap-phase2.md`.

The mark **[S10]** is a decision of the spec author within the master session's brief; it can be changed without new agreement if the reason is recorded. The mark **[implementer]** is a detail the implementer chooses themselves from the results of spikes and tests. The master's decisions and open questions are in §26.

## 1. Why and what counts as success

AI agents and people need a graphical desktop in a sandbox: to check a web app in a real browser, debug Electron, go through a GUI wizard, see what an agent is doing. A sandbox has no public IP, so the whole path to the screen goes through the platform.

Scenarios by priority:

1. **An agent controls the screen through the API.** An agent outside the VM (through MCP S11 or the SDK) takes a screenshot, clicks, types, reads the clipboard. It needs neither a stream nor a browser.
2. **A person watches and intervenes.** The user opens the Desktop tab in the dashboard and sees the desktop in an iframe. Latency is low, the mouse and keyboard work. The agent keeps acting through the API at the same time.
3. **A link for another tool.** An integration server gets a one-time link through the API and embeds the stream in its own application (as in boat).
4. **A colleague opens the desktop by a permanent link** in `sso` mode.
5. **Windows.** All the same on the `windows` template (boat has no Windows).

Success:
- `linux-desktop` and `windows` give the same desktop and computer-use APIs;
- the stream runs without public IPs on sandboxes; dev addresses and the transport for access to the stand are set only in `infra/dev-cp/`;
- a cold create of `linux-desktop` allows up to ~1 min, Windows — up to 5 min (§15);
- Sunshine and moonlight-web are installed from upstream releases unchanged. The S10 exception: a pinned coturn with a minimal patch re-checking REST credentials on Refresh (justification and RED→GREEN below).

## 2. Goals, non-goals, anti-goals

**Goals:**
- the `linux-desktop` template as an S5 build variant;
- the Windows desktop on the S9 template;
- a stream to the browser for the dashboard and API clients through the S4 gateway: WebRTC through TURN and a fallback WebSocket transport;
- computer-use primitives (screenshot, mouse, keyboard, clipboard) in the agent and in the S7 public API, so that S11 wraps them in MCP;
- access to the stream in the modes `token`, `sso`, `public`;
- sizes and RAM admission for cold creation.

**Non-goals** (phase 2, S29, unless stated otherwise):
- a browser-only stream with Chrome profiles (`boat browser`);
- recording to mp4;
- noVNC as a fallback path;
- wallpaper, `overlay=0`, `theme`;
- the accessibility tree, a window list, launching applications through the API (cua-driver can do this, the API to it is S29);
- a clipboard with images;
- changing the screen resolution through the API;
- limiting the number of simultaneous viewers and a "view only" mode (in the MVP there can be several viewers, §8.4);
- hardware encoding (the Intel Arc GPU on `pve`, SR-IOV);
- registering the MCP `computer` in the harness inside the VM (S15).

**Anti-goals** (a failure even if it formally works):
- TURN becomes an open relay: through it traffic can be sent somewhere other than to the other end of our own stream;
- a sandbox gets an inbound address or a forwarded port;
- a desktop link or cookie ends up in logs, in Referer, or in code in the sandbox;
- a viewer whose access was revoked keeps controlling the screen;
- a user without the exec right gets the desktop (the desktop gives full control over `user`, who has sudo);
- a fork of the streamer that has to be maintained;
- a screenshot through the API depends on whether a stream is open.

## 3. Constraints

- Sandboxes have no public IPs. The product does not depend on Tailscale; dev access settings are only in `infra/dev-cp/`. External tunnel/relay services (cloudflared, ngrok, trycloudflare) are forbidden; TURN is self-hosted.
- The control plane runs in Kubernetes behind oauth2-proxy.
- The trust boundary is the VM (S2 §16). Everything inside the VM can read its VM's streamer data.
- Windows Server Core is not in the MVP.
- The VM has no GPU: capture and encoding on the CPU (x264).
- The `pve` host: VMIDs from 500, no more than 8 GB RAM for all sandbox VMs, `local-lvm`, do not touch existing VMs, LXC, `vmbr0`, templates 9000/9001; the firewall is changed only with a rollback timer (S1 §4.4).
- The latest stable versions of all dependencies (§23).

## 4. Stack choice

### 4.1 Comparison

Checked 2026-10-29 against GitHub releases and documentation.

| Stack | Linux | Windows | Transport | Latency and quality | License | What we build |
|---|---|---|---|---|---|---|
| **Sunshine + moonlight-web** | yes | yes | WebRTC (needs TURN), a fallback WebSocket is built in | best: H.264 video codec, 30–60 fps, adaptive bitrate, FEC | GPL-3.0 (both) | Packaging, automatic pairing, TURN, injecting the user header in the gateway. No fork needed: v3 has `ice_server_script`, `forwarded_header`, a WebSocket transport |
| KasmVNC 1.5.2 | yes | **no** | WebSocket through the gateway | good for a static screen, worse for video | GPL-2.0 | Little on Linux, but Windows needs a second stack |
| Selkies 2.1.0 | yes | **no** | WebSocket by default, WebRTC optionally | good (GStreamer, x264) | MPL-2.0 | Little on Linux, Windows is a second stack |
| noVNC 1.7.0 + a VNC server (x11vnc 0.9.17, TigerVNC 1.16.2; on Windows TightVNC/UltraVNC) | yes | yes | WebSocket through the gateway, TURN not needed | worst: raster updates, no sound, heavy on video | noVNC MPL-2.0, servers GPL-2.0 | The least. This is the S29 fallback path |
| Guacamole 1.6.0 (guacd + a JS client): VNC on Linux, RDP on Windows | yes | yes (RDP) | TCP through the tunnel, TURN not needed | medium | Apache-2.0 | guacd in the cluster, TCP forwarding to the VM. On Windows RDP takes over the console session, and when RDP disconnects the screen for computer-use disappears. There is no RDP host in Home |
| neko 3.2.0 | yes | no | WebRTC | good | Apache-2.0 | Designed for Docker, no Windows |

### 4.2 Decision [S10]

**Sunshine + moonlight-web on both OSes.** This decision is already recorded in the architecture (§8) and confirmed by the comparison:
- one stack on Linux and Windows: one scheme of pairing, authorization, TURN, and acceptance;
- the best latency and loss resilience;
- moonlight-web v3 meets our needs by configuration, without a fork (boat keeps its own fork — we avoid that, an anti-goal);
- the fallback WebSocket transport is built in (`dataTransport: auto`: WebRTC first for 15 s, then WebSocket). For networks without UDP the stream goes through the gateway and tunnel, TURN is not needed.

The GPL-3.0 of the two components is allowed by Ilia (§17, §26). x264 encoding uses the CPU (§15).

**Computer-use is the agent's own primitives, not a proxy to cua-driver** [S10]. This changes the wording of architecture §8. Reasons:
- cua-driver evolves very fast: the `cua-driver-rs` releases 0.30–0.38 came out within a month, and all are marked prerelease. The public API v1 contract must not depend on its schemas;
- four primitives (screenshot, mouse, keyboard, clipboard) are a small amount of code. On Windows they already have a place in the `umiak-session` helper (S9 §13);
- a screenshot through the API works without a streamer too.

cua-driver is still installed in the templates (§6.3, §7) as an MCP server for agents inside the VM: the accessibility tree, background work with windows. Its registration in the harness is S15, an API on top of it is S29.

## 5. Overview

```
 browser: dashboard iframe / API client page
   | HTTPS + WSS: https://<slug>-desktop.umiak.<domain>         | browser: UDP/TCP 3478, TLS 443
   v                                                          v
 gateway (S4): label "<slug>-desktop", access,         coturn "turn.<domain>"
   open redirect, X-Umiak-Desktop-User                   relays only between its own allocations
   |  tunnel CONNECT 127.0.0.1:47800 (S2)                     ^
   v                                                          | UDP 3478 egress via node SNAT
 VM ----------------------------------------------------------+-- (IPSet umiak-turn)
 |  umiak-agent (root / SYSTEM): Desktop service, streamer manager, TURN config
 |    |-- moonlight-web 127.0.0.1:47800  (WebRTC relay candidates or WebSocket media)
 |    |      | GameStream over loopback
 |    |   Sunshine 127.0.0.1:47989  (x11 / ddx capture, x264)
 |    |-- umiak-session (in user session): screenshot, input, clipboard
 |  Linux: LightDM autologin -> Xorg :0 (dummy, 1920x1080) -> openbox, tint2, Chrome
 |  Windows: autologon console session (S9) -> Edge
 |  cua-driver (user service) for in-VM agents (S15)
```

Data paths:
- **Computer-use API:** client → `api` (`/v1/sandboxes/{sb}/desktop/*`) → tunnel → the `Desktop` agent → `umiak-session` → the screen. The streamer does not take part.
- **Stream, WebRTC:** the browser loads the viewer page and signaling through the gateway. Media and input go over WebRTC; both sides go through TURN.
- **Stream, WebSocket:** the same, but media goes over a WebSocket through the gateway and tunnel.

## 6. The `linux-desktop` template

### 6.1 Recipe

An S5 build variant (S5 §16): `extends: linux`. The build starts from a clean image, the `linux` steps plus its own step `60-desktop`.

```yaml
# infra/templates/linux-desktop/template.yaml
slug: linux-desktop
os: linux
extends: linux                   # inherits source, disk, hw, steps of linux; lists below override
hw:
  vga: std                       # operator console only; the desktop uses the Xorg dummy driver
  tablet: 0
steps: [00-base, reboot, 10-system, 20-docker, 30-toolchains, 40-coding-agents, 50-umiak-agent, 60-desktop, 90-cleanup]
vmids: [595, 596]               # own template slots; never 597/598/599
# Default size 4gb, allowed 4gb/8gb: runtime seeds/config, not S5 recipe keys.
boot_timeout_s: 300
verify: linux-desktop
```

How `extends` merges fields is decided by the S5 builder **[implementer]**. One thing is mandatory: `linux-desktop` is built from the same pinned versions as `linux` (`versions.toml` is inherited, its own file adds only desktop packages).

### 6.2 Why this way [S10]

- **X11, not Wayland.** X11 has XTEST and proven input and clipboard tools; cua-driver on Linux is tested on a real Xorg; Chrome works. The Sunshine `x11` capture is the most CPU-expensive, but at 1080p30 it is acceptable (§15.2). Wayland (labwc or sway + `wlr` capture) is a phase 2 experiment.
- **Xorg with the `dummy` driver**, not a VM device: the resolution does not depend on the Proxmox `vga`, capture comes from the X server's memory. boat does this for the browser view. Xvfb was rejected: Sunshine and cua-driver are tested on Xorg.
- **LightDM with autologin** of `user`, not our own unit with `xinit`. LightDM opens a real logind session on seat0. It provides `XDG_RUNTIME_DIR`, the session D-Bus, uaccess to `/dev/uinput` for Sunshine input, and PAM through which the sandbox env arrives (S3 §8.2). boat is built the same way. The implementer may replace LightDM with their own unit if the §6.6 checks pass.
- **openbox + tint2**, not XFCE: 200–300 MB less RAM at idle. The minimum on which a person will find a terminal and a browser is needed.

### 6.3 Contents (`60-desktop`)

Ubuntu packages (from the apt snapshot, S5 §6.2):
- `xserver-xorg-core`, `xserver-xorg-video-dummy`, `xserver-xorg-input-libinput` (the virtual uinput devices from Sunshine), `x11-xserver-utils`, `dbus-x11`;
- `lightdm` without a greeter with a UI (`lightdm-gtk-greeter` is not installed; autologin works without a greeter — to verify, otherwise a minimal greeter);
- `openbox`, `tint2`, `xfce4-terminal`, `pcmanfm`;
- fonts: `fonts-noto-core`, `fonts-noto-cjk`, `fonts-noto-color-emoji`, `fonts-dejavu-core`;
- `at-spi2-core` (the accessibility tree for cua-driver and the browser);
- `pipewire`, `pipewire-pulse`, `wireplumber` — sound in the stream, best effort (§8.5);
- `xdotool`, `xclip`, `scrot` — for people and agents in the VM; the agent does not rely on them.

Not from Ubuntu (versions and sha256 in `versions.toml`, §23):
- **Google Chrome stable** — a `.deb` from the Google repository (architecture decision §1). The Google repository stays in the apt sources, no auto-update (S5 turns it off). Managed policy in `/etc/opt/chrome/policies/managed/umiak.json`: no first run, no default-browser check, no promo tabs, no reports. Chrome is the default browser (`xdg-settings`, `update-alternatives`);
- **Sunshine** — `sunshine_<v>-1+ubuntu26.04_amd64.deb` from the LizardByte release;
- **moonlight-web** — `moonlight-web-x86_64-unknown-linux-gnu.tar.gz` from the release, in `/opt/umiak-desktop/moonlight-web/<v>/`;
- **cua-driver** — `cua-driver-rs-<v>-linux-x86_64-binary.tar.gz`, the sigstore signature is verified at build time, in `/opt/umiak-desktop/cua-driver/<v>/`. The `cua-perception` extension (AGPL) is not installed.

Configuration:
- `/etc/X11/xorg.conf.d/10-umiak-dummy.conf`: the `dummy` driver, `VideoRam 256000`, mode `1920x1080` (a modeline from `cvt 1920 1080 60`), 24 bit, DPI 96.
- `/etc/lightdm/lightdm.conf.d/50-umiak.conf`: `autologin-user=user`, `autologin-session=umiak`, `xserver-command=X -nolisten tcp -dpms -s 0`.
- The session `umiak` (`/usr/share/xsessions/umiak.desktop` → `/usr/local/lib/umiak-desktop/session`): imports `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` into the user manager (`systemctl --user import-environment`, `dbus-update-activation-environment --systemd`), starts the user units `umiak-session.service` and `cua-driver.service`, then `exec openbox-session`.
- No lock screen, screensaver, or DPMS: `light-locker` and `xscreensaver` are not installed, `xset s off -dpms` in the openbox autostart.
- `/etc/pam.d/lightdm-autologin` contains the same two `pam_env` lines as `sshd` (S3 §8.2): the session gets the sandbox env and secrets.
- `uinput`: the module in `/etc/modules-load.d/umiak-uinput.conf`, the udev rule from the Sunshine package (uaccess for the active session).
- `OOMScoreAdjust=-500` for Xorg and LightDM (a drop-in): when memory runs out the kernel kills user applications first, not the screen.
- `agent.toml`: `[readiness] required = ["identity", "claim", "secrets", "docker", "desktop"]`, `[desktop] enabled = true`, `[ports] exclude` is extended with the streamer's ports (§8.1).

### 6.4 Session and claim

The agent starts and restarts the desktop session itself (`systemctl start|restart lightdm`). `lightdm.service` is not enabled in `graphical.target` [S10].

| Moment | What the agent does | Why |
|---|---|---|
| cold boot before the claim | wait for identity and claim | there is no pool in the MVP |
| the first claim of this identity (S6 `System/Claim{reason: claim}`) | after the S3 §8.1 steps restart the session | the session's PAM must read the claim's env and secrets. There are no user programs on the desktop yet, nothing to lose |
| boot after a claim (resume, recover, reprovision) | start the session when the secrets for the current boot are applied (the `secrets` phase = `ready` with a new `bootId`) | the session gets the secrets. Until then `desktop: pending` |
| a change of env or secrets of a running sandbox in the same boot | do not touch the session | as for running commands (S3 §8.1): the new env is seen by new agent processes. Documented in S7 |

The trigger is the agent's internal state (the first claim of an identity; secrets applied for the current `bootId`), not an RPC name. So the rule does not depend on whether the control plane delivers secrets after boot through `System/Claim{reason: resume}` (S6 §7.6) or through `UpdateSecrets` (S3 §8.1).

A session restart takes no more than 3 s (measurement §20). `desktop: pending` for that time. The sandbox becomes `ready` when the `desktop` phase (readiness `required`) is ready too.

Desktop programs do not survive stop, resume, and fork, as in boat. The Chrome profile is on disk and is preserved.

### 6.5 Env

- **All commands and SSH sessions** on a template with a desktop get `DISPLAY=:0` and `XAUTHORITY=/home/user/.Xauthority` in the platform env (S3 §8.2, item 2). Then `google-chrome https://…` from `exec` opens a window on the desktop. It is also written to `/etc/umiak/env` for SSH.
- **`CommandSpec.desktop: true`** (the S9 §13 field) on Linux: the agent checks that the `desktop` phase = `ready` (otherwise `failed_precondition desktop_not_ready`) and adds the graphical session env: `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`, `XDG_SESSION_TYPE=x11`, `XDG_CURRENT_DESKTOP=openbox`. The process is still started in its own unit under the shim (S3 §9.3).
- On a template without a desktop `desktop: true` → `failed_precondition desktop_unsupported`.

### 6.6 Build verification (`verify: linux-desktop`)

All S5 §10 checks except item 4, plus:

1. The S5 §10 item 4 check (listening sockets) with the desktop list: with the streamer stopped there are no new TCP sockets; Xorg listens only on a unix socket.
2. After boot and before the claim: LightDM does not start, `desktop: pending`. After the claim and applying the current boot's secrets: LightDM is active, `user` is in an `x11` session on seat0 (`loginctl`), openbox is running, the resolution is 1920×1080 (`xrandr`), the `desktop` phase = `ready`. This clarification aligns the check with §6.4 and the absence of a pool in the MVP.
3. `umiak-agent doctor --desktop --json`: a screenshot through `umiak-session` is a PNG 1920×1080, not single-colored (the tint2 panel is on the desktop).
4. Input: the agent moves the cursor and clicks (the cursor position matches); `type` types a string with non-ASCII characters in `xfce4-terminal`, and it matches; clipboard: `SetClipboard` → `xclip -o` from the session gives the same text, and back.
5. Streamer: `Desktop/Open` starts Sunshine and moonlight-web, pairing passes, the response contains `hostId` and `appId`; Sunshine and moonlight-web listen only on `127.0.0.1`. `Desktop/StopStreamer` stops them.
6. The versions `google-chrome --version`, `sunshine --version`, moonlight-web, cua-driver match the manifest. The `cua-driver` user unit is active, its socket answers `get_screen_size`.
7. A session restart (as at claim) fits in 3 s; after it the `desktop` phase is `ready` again.
8. No swap (S5), `uinput` is loaded, `/dev/uinput` is available to the `user` session.

## 7. The Windows desktop

The `windows` template (S9) already provides the `user` autologon, an unlocked console session, the `umiak-session` helper, and the `desktop` phase (S9 §13). S10 adds to the step `60-desktop`:

- **Sunshine** — `Sunshine-Windows-AMD64-installer.msi`, silent install. The service `SunshineService` has the Manual start type. The upstream service itself starts `sunshine.exe` in the active console session; the agent starts and stops it through SCM. The config is §8.2.
- **moonlight-web** — `moonlight-web-x86_64-pc-windows-gnu.zip` in `C:\Program Files\umiak-desktop\moonlight-web\<v>\`. The agent registers the service `umiak-moonlight-web` (Manual, the virtual account `NT SERVICE\umiak-moonlight-web`). It does not need the desktop: it only forwards the Sunshine stream.
- **cua-driver** — `cua-driver-rs-<v>-windows-x86_64.zip`; started by `umiak-session` in the `user` session.
- **The browser is Edge**, which is in Windows 11 [S10]. Chrome is not installed on Windows. Edge policies: `HideFirstRunExperience=1`, no sign-in and sync offers.
- **The video adapter** — per spike W (§19.2). Candidates in order: `vga: std` (Microsoft Basic Display Adapter), `vga: virtio` with the `viogpudo` driver from the pinned virtio-win, an IddCx virtual display driver (Virtual Display Driver, MIT, or SudoVDA). Criterion: Sunshine's `ddx` capture and the `umiak-session` screenshot give 1920×1080 with no black screen after waking from hibernation. The winner is recorded in the recipe's `hw.vga` and in §24.
- **Resolution:** `umiak-session` sets 1920×1080, 96 DPI at start (`ChangeDisplaySettingsExW`) if the adapter allows it.
- **Sound** is best effort: `audio0: device=ich9-intel-hda,driver=none` if the spike shows that Sunshine does not start a stream without it. Otherwise `stream_audio = disabled`.
- `agent.toml`: `[ports] exclude` is extended with the streamer's ports (§8.1). `[readiness]` is as in S9.
- The `windows-desktop` verification profile (S9 §15) is extended with the §6.6 items 3–6 in the Windows variant.

Windows limitations inherited from S9: the hostname from the claim is not applied; the desktop is the console session of `user`; UAC without prompts (`PromptOnSecureDesktop=0`), so capturing the secure desktop is not needed.

## 8. The streamer in the guest

### 8.1 Processes and ports

| Process | Linux | Windows | Listens on |
|---|---|---|---|
| Sunshine | a user unit of the user `user` from the package (`app-dev.lizardbyte.app.Sunshine.service`) | `SunshineService` → `sunshine.exe` in the console session | `127.0.0.1`: TCP 47984, 47989, 47990 (web UI), 48010; UDP 47998–48000, 48002, 48010 |
| moonlight-web | the system unit `umiak-moonlight-web.service`, user `umiakstream` (a system user, no shell) | the service `umiak-moonlight-web` | `127.0.0.1:47800` TCP; UDP — ephemeral ports for WebRTC |

The TCP ports `47800`, `47984`, `47989`, `47990`, `48010` are in the platform's shared list of reserved ports (S4 §4.2, S7 §11.2): they cannot be published as an ordinary port. They are also in the agent's `[ports] exclude`.

### 8.2 Configuration

Sunshine (`sunshine.conf`, put in by the template; the web UI credentials are set by the agent):

```ini
bind_address = 127.0.0.1
origin_web_ui_allowed = pc
upnp = disabled
capture = x11            # Windows: ddx
encoder = software
sw_preset = superfast
sw_tune = zerolatency
stream_audio = enabled   # see 8.5
min_log_level = info
```

moonlight-web (`config.json`): the template gets it with the command `web-server config generate` at build time and edits the keys below. The file cannot be written from scratch: some fields (`first_login_create_admin`, `first_login_assign_global_hosts`) have no defaults, and an incomplete file will not load.

```json
{
  "web_server": {
    "bind_address": "127.0.0.1:47800",
    "first_login_create_admin": false,
    "first_login_assign_global_hosts": false,
    "forwarded_header": {
      "username_header": "X-Umiak-Desktop-User",
      "auto_create_missing_user": false
    }
  },
  "webrtc": {
    "ice_servers": [],
    "ice_server_script": "/usr/local/lib/umiak-desktop/ice-servers"
  }
}
```

- The standard Google STUN servers are off (`--disable-default-webrtc-ice-servers`): no external STUN, only our TURN.
- `ice-servers` is a small executable (on Windows `ice-servers.cmd`) that prints JSON from the agent's file `desktop/ice-servers.json` (§9.3). moonlight-web runs it at every stream start and gives the same list to the browser. So fresh TURN credentials do not require restarting moonlight-web.
- `webrtc.port_range` is not set: the VM goes to TURN with outgoing packets and has no incoming ports.

### 8.3 Pairing and moonlight-web users

The streamer state (`/var/lib/umiak-agent/desktop/` on Linux, `ProgramData\umiak-agent\desktop\` on Windows; access root/SYSTEM) contains:
- the Sunshine web UI login and password (32 random bytes);
- the moonlight-web administrator password and the `umiak` user password — separate random secrets, not the Sunshine password (s10-fix; in a state written before the split the shared password remains until the next identity change);
- the identifiers `hostId` and `appId` after pairing.

The moonlight-web administrator is created before the service's first start: the agent puts into `data.json` a store in the upstream v3 format (role `Admin` and one user, PBKDF2-HMAC-SHA256, 600,000 iterations, as in `src/app/password.rs` v3.0.1), and `first_login_create_admin = false`. The first `/api/login` no longer creates an administrator, and there is no race with another client (s10-fix).

The agent generates them itself and performs pairing on the first streamer start after an identity change (S3 §7, S9 §11):
1. Set the Sunshine credentials, write the moonlight-web store with the administrator, start Sunshine and moonlight-web.
2. Through the moonlight-web HTTP API (as the administrator): create the role `viewer` and the user `umiak` with that role, add the host `localhost`, start pairing, and get the PIN.
3. Pass the PIN to Sunshine through the web UI API: `POST https://127.0.0.1:47990/api/pin` with basic auth, a CSRF token, and `pairing_id`, as the current version requires.
4. Read the `hostId` and `appId` of the application `Desktop`.

Rights of the role `viewer`: `allow_add_hosts = false`; H.264 only; no HDR; `maximum_bitrate_kbps = 20000`; both transports allowed.

An identity change erases this state, as well as `sunshine_state.json` and the moonlight-web data: a fork and a VM from a snapshot do not carry the source's streamer credentials. Pairing is done lazily on the first open for each new identity, including create and fork (a few seconds).

The exact moonlight-web v3 and Sunshine API calls are fixed by spike L **[implementer]**.

### 8.4 Start on demand

- The streamer does not run until the desktop is opened. Screenshots and input through the API bypass it.
- `Desktop/Open` (§11.1) starts Sunshine and moonlight-web if they are not running, waits for readiness (up to 20 s), and returns `{hostId, appId}`.
- The agent stops the streamer after 15 min without an active stream [S10]. This way it does not spend CPU and RAM. The countdown is from the last `Open` or the last observed viewer; the agent's desktop loop (once a second) does `StopStreamer` once per idle period, and the next `Open` starts the streamer again. Stopping is idempotent, so it works for a streamer that survived an agent restart too (s10-fix).
- **Whether a stream is running.** The agent needs a `streaming` flag (at least one stream is running): for idle (§11.4) and for stopping by timer. There is no ready source upstream: moonlight-web v3 is one process with no separate process per stream, and the Sunshine API gives only a list of paired clients. Candidates in order **[implementer, spike L]**:
  1. the client connect and disconnect lines in the Sunshine log;
  2. moonlight-web's connected UDP sockets to Sunshine's control port (`127.0.0.1:47999`);
  3. a fallback flag that works on both OSes: the Sunshine process CPU above 2% on average over 30 s (without a stream Sunshine does not encode and spends almost no CPU).

  The agent reports the number of streams if the source gives it; otherwise only `streaming`. When the flag changes the agent sends the event `desktop.streaming_changed{streaming, count?}` (§11.4).
- **Several viewers** [S10]. Sunshine connects a second client to an already running application, and moonlight-web also allows several streams. Each viewer is a separate x264 encode, i.e. another 0.7–1.5 vCPU, and each can control the screen. In the MVP we do not limit the number of viewers: there is no reliable way to count streams at start time (see above), and `Open` when issuing a link must not cut off someone who is already watching. The limit and a "view only" mode are S29. The CPU of two viewers is measured by spike L.
- **Ending streams.** `Desktop/EndStreams` cuts all active streams: a restart of Sunshine and moonlight-web. This way access revocation also affects a stream through TURN, bypassing the gateway (§10.5).

### 8.5 Stream profile

- The screen is 1920×1080. The viewer requests 1920×1080, 30 fps, 8 Mbit/s, H.264 [S10]. An API client can ask for 60 fps and up to 20 Mbit/s (link parameters, §13.2).
- 30 fps by default, because x264 runs on the CPU: 60 fps is about twice as expensive (measurement §20). The sandbox CPU is also needed by the agent itself in the VM.
- Sound is best effort, not part of acceptance. On Linux Sunshine itself creates a virtual sink in PipeWire. On Windows — §7.

### 8.6 The moonlight-web patch on Windows (s10-followups, W1-B)

**The bug.** In Sunshine (v2026.914.233613 and the current master) `recvThread` receives the video and audio socket pings into one shared `udp::endpoint peer`. On Windows (IOCP) the kernel writes the sender's address directly into this buffer when the receive completes, so if the video ping and the audio ping completed before the first handler ran, both pings are attributed to one port. If it is the port of moonlight-web's audio socket, Sunshine sends all the video to the audio socket: moonlight-web receives no video packet, `moonlight_common::stream::proto::video` asks for an IDR once a second (`requesting idr and unsyncing depayloader`, `IDR_REQUEST_TIMEOUT` 1 s), and the browser sees "Connection Complete" and a black frame. The pings always coincide in time: moonlight-common-rust starts polling the audio/video drivers only after the control stream connects, and the first pings of both streams go out at once — exactly when Sunshine registers the session. The outcome is decided by a race; on a loaded VM it happens more often.

Evidence (`infra/dev-cp/desktop-media-probe.ts`, Sunshine `min_log_level = verbose`): in the black attempt `Received ping [v2] from 127.0.0.1:57337` twice, although the video ping came from 57338 (`Recv: 127.0.0.1:57338 :: VIDEO`); Sunshine encodes and sends frames (`Sent Frame`), there is no `received first video packet` in the moonlight-web log, and in the browser 0 video WebSocket messages and 0 calls of `VideoDecoder.decode`. Linux did not show this bug in the runs.

**The fix.** The `windows-desktop` template installs `web-server.exe` built from the same moonlight-web v3.0.1 release with the patch `infra/templates/windows/moonlight-web/ping-order.patch` to the pinned moonlight-common-rust: the audio stream (and its ping) is not polled until the video stream has received its first packet (Sunshine has already recorded the video address), but not longer than 3 s (Sunshine's ping timeout is 10 s). Audio in the stream is off (`stream_audio = disabled`), so the wrong audio address is harmless. The build is `moonlight-web/build.sh` (Docker, `rust:1.99.0-trixie` + mingw-w64, no PE timestamp); the output `files/moonlight-web/{web-server.exe,build.json}` is not stored in git. The installer replaces the server from the pinned zip and checks the SHA256 from `build.json`; the web resources stay from the zip. Verify: `desktop_moonlight_patch`. Linux stays on the upstream build. A fix in Sunshine (a separate `endpoint` per socket) is a candidate for upstream, after which the patch is removed.

Diagnostics (s10-followups): the `umiak-moonlight-web` service keeps the previous run's log as `web-server.log.1` (`EndStreams` restarts it); `e2e-desktop.ts` on a stream failure before `EndStreams` collects the moonlight-web log, the Sunshine log, a screenshot through the agent, and the viewer counters (video messages and IDR of the WebSocket, `VideoDecoder` calls and errors, WebRTC `inbound-rtp`).

## 9. Transport and TURN

### 9.1 How a stream is established

1. The viewer page (`stream.html`) and WebRTC signaling go over HTTPS through the gateway and tunnel to moonlight-web.
2. moonlight-web and the browser get the same list of ICE servers — only our TURN.
3. The VM's address in `umiak0` is unreachable for the browser, and TURN forbids relay to all addresses except its own (§9.2). So in the PoC and in a corporate network ICE converges on the relay ↔ relay pair. The VM goes to TURN over UDP: the moonlight-web WebRTC stack (webrtc-rs) gathers relay candidates only over UDP. The browser can go to TURN over UDP, TCP, or TLS 443.
4. **A direct path in production.** If the browser has a public address (e.g. an employee outside the VPN), ICE may gather a direct pair "VM through the node's SNAT ↔ browser": outbound UDP to the internet is allowed for the sandbox (S1). This is acceptable [S10]: the sandbox still has no inbound address, it is ordinary outbound VM traffic. Revoking access cuts such a stream too (`EndStreams` in the VM, §10.5). The guaranteed path is TURN.
5. If WebRTC did not connect within 15 s (e.g. the browser has UDP closed and TCP/TLS to TURN does not pass either), the viewer switches itself to WebSocket: media goes through the gateway and tunnel.

Why WebRTC through TURN is the main path and not WebSocket alone [S10]:
- lower latency and loss resilience (UDP, FEC, no head-of-line blocking);
- 8–20 Mbit/s per viewer do not go through the agent's tunnel, where they would be shared with RPC and files, and do not load the gateway;
- a gateway deploy does not break the stream: after WebRTC starts the gateway is not on the path.

### 9.2 coturn: placement and configuration

- **Where.** In Kubernetes next to the gateway, but not in the gateway process (S4 §13). TURN runs in **its own network namespace** (s10-fix2), not on the host network: in compose a separate bridge network, in Kubernetes an ordinary pod (not `hostNetwork`). Inside the namespace the TURN address is attached to `lo`, so relay ↔ relay stays inside the namespace, and only 3478/udp, 3478/tcp, and 443/tcp are published outward (DNAT preserving the client address: compose `ports`, in Kubernetes a Service `LoadBalancer`/`NodePort` with `externalTrafficPolicy: Local`). The choice of Service is S12, the check is §20.
- **Name:** `turn.<domain>` → the TURN IP. The certificate for `turns:` is issued by cert-manager (like `*.umiak`).
- **Ports:** `3478/udp`, `3478/tcp`, TLS on `443/tcp` (TURN has its own IP, so 443 does not conflict with `gateway-edge`). The relay ports are **61000–65535** (`UMIAK_TURN_RELAY_MIN/MAX`), above the Linux ephemeral range (`ip_local_port_range` default 32768–60999); they are not published outward. In the TURN namespace the relay range is reserved (`net.ipv4.ip_local_reserved_ports`), and the entrypoint refuses to start if the relay range overlaps this namespace's `ip_local_port_range`.
- **Sandbox → TURN.** The VM goes to TURN with outgoing UDP packets to 3478 through the node's SNAT. The S1 firewall needs an IPSet `umiak-turn` with the TURN address and a rule in the group `umiak-egress` before the denials (TCP is not needed: the VM uses TURN over UDP only, item 3 of §9.1):

```
[IPSET umiak-turn] # umiak S10: TURN server address(es)
OUT ACCEPT -dest +umiak-turn -p udp -dport 3478
```

  The firewall change is an S1 runbook step with a rollback timer (S1 §4.4).
- **Configuration** (`turnserver.conf`, the gist; the implementer checks the exact keys against 4.18):

```ini
listening-port=3478
tls-listening-port=443
external-ip=<turn ip>
realm=turn.<domain>
fingerprint
use-auth-secret
static-auth-secret=<from Secret>
# Not an open relay: relay only between allocations of this server.
denied-peer-ip=0.0.0.0-255.255.255.255
denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
allowed-peer-ip=<turn ip>
no-tcp-relay
no-multicast-peers
no-cli
no-software-attribute
user-quota=4
max-bps=3000000          # bytes per second per session, ~24 Mbit/s
total-quota=400
prometheus
```

- **Relay port filter** (s10-fix, s10-fix2). coturn's `allowed-peer-ip` sets only an IP: permission for TURN's own address lets an allocation reach any UDP port of that address. On the host network that would be other host services (on CT 590 the acceptance reached with a Send indication a listener on `:40123` and tailscaled `:41641`) and any of its sockets in the relay range — including ephemeral client sockets (DNS, etc.), because the old range 49152–65535 overlapped 32768–60999. Protection in three layers:
  1. **Its own namespace.** The entrypoint adds the TURN address to the `lo` of its namespace and refuses to start if this address already exists on another interface (meaning the container runs on the host network). `listening-ip` is the address of the namespace interface (where DNAT arrives), `relay-ip` and `external-ip` are the TURN address. The namespace has no other processes with sockets on the TURN address, so a peer can only be a relay socket of the same coturn. The earlier refusal of its own namespace was about NAT: Docker's hairpin NAT rewrote the peer address relay ↔ relay. Here the TURN address is local inside the namespace, relay ↔ relay packets do not leave it and do not pass NAT.
  2. **The nftables table `inet umiak_turn`** in the TURN namespace (hook `output`, `meta skuid` + address + relay port): coturn's relay sockets (uid `UMIAK_TURN_UID`) send only to relay ports of the same address. The entrypoint installs it as root at every start, then runs turnserver under `UMIAK_TURN_UID` (`setpriv`, only `NET_BIND_SERVICE` remains).
  3. **Fail closed.** The entrypoint stays the container's init process and every `UMIAK_TURN_GUARD_INTERVAL` (2 s) compares `nft -s list table inet umiak_turn` with what it installed. If the table is missing or changed (e.g. root in the container via `docker exec`), init exits, the kernel kills turnserver together with the PID namespace, and the `restart` policy brings the container up with a new table. The compose healthcheck (`entrypoint.sh health`) does the same check; both also check the TURN address on `lo` (below). An nftables reload on the host (`flush ruleset`) does not touch the table in the TURN namespace.

  **A send to a forbidden port kills its own allocation** (expected, s10-followups). A packet from a relay socket to a port outside the relay range is dropped by the `drop` rule of the table `inet umiak_turn` in the hook `output`, and `sendto` in coturn gets `EPERM`. coturn treats this as a socket error and closes the allocation: the next `Refresh` gets `437 Allocation Mismatch`. This is the sender's self-denial — the affected allocation belongs to whoever sent the forbidden packet (its credentials and its 5-tuple); other allocations, relay ↔ relay, and coturn itself keep working. Ordinary WebRTC does not send such packets: `CreatePermission` allows only the TURN address, and the other side's candidates are relay ports. There is nothing to fix: the refusal is closed, and a client that tries forbidden ports loses only its own allocation.
  **The TURN address on `lo`** is also under watch (s10-followups): init and the healthcheck check that `UMIAK_TURN_IP/32` stays on the namespace's `lo`. Without it new allocations get `508 Insufficient Capacity` and relay ↔ relay does not work; earlier the healthcheck stayed `healthy` in this case. Now init exits and the container is restarted with the address.

  **A production requirement (S12):** TURN is a pod with its own network namespace (not `hostNetwork`), the TURN address on the pod's `lo`, `NET_ADMIN` only for the entrypoint (turnserver runs under a separate uid), the relay range above `ip_local_port_range` and in the pod's `ip_local_reserved_ports` (both sysctls in Kubernetes are namespaced and allowed as safe), only 3478 and 443 published, preserving the client address. Liveness is the same `entrypoint.sh health` check. If the host firewall is reloaded with `flush ruleset`, it must not delete the NAT publication rules (otherwise TURN is unreachable, but not open). `no-software-attribute` and `no-cli` are on.
- **Why this way.** The peers that TURN lets in are only its own relay addresses. So leaked credentials do not turn TURN into a proxy to the outside (an anti-goal). ICE pairs where TURN would have to send to the other side's host or srflx candidate get an immediate `CreatePermission` refusal, and ICE chooses relay ↔ relay (or the direct path from item 4 of §9.1 if there is one). Relay from TURN to the browser's address is not supported.

### 9.3 TURN credentials

- The TURN REST API scheme: `username = "<unix-expiry>:<sandboxId>"`, `credential = base64(HMAC-SHA1(secret, username))`. The secret is in a Kubernetes Secret, read only by `worker` and coturn. The VM and `api` do not have the secret. **This overrides S4 §13**, where `api` issued the credentials together with the URL: the credentials are needed by the streamer in the VM at every stream start, not only when issuing a link, and in the `sso`/`public` modes nobody requests a link through the API.
- The lifetime is 24 h [S10]. The worker issues credentials through `Desktop/Configure` (§11.1):
  - in the `claim` step (S6 §7.3) after `System/Claim`;
  - in the `provision` step after every boot (resume, recover, reprovision — S6 §7.6, §7.8), right after secret delivery;
  - the `desktop-turn` controller every 10 min renews the credentials of `ready` sandboxes with a desktop if they are older than 12 h.
- The agent writes them to `desktop/ice-servers.json` (`[{urls: [...], username, credential}]`). The URLs come from the config `UMIAK_TURN_URLS`: `turn:turn.<domain>:3478?transport=udp`, `turn:turn.<domain>:3478?transport=tcp`, `turns:turn.<domain>:443?transport=tcp`.
- The viewer's browser gets the same credentials. This is acceptable: TURN is not a relay to the outside (§9.2), and the credentials have a quota.
- A stream lives no longer than the lifetime of the credentials it had at the moment of its start. In practice this is at least 12 h; then the viewer reconnects. Whether coturn checks the expiry on `Refresh` of an existing allocation is recorded by spike L.
- Rotation of `static-auth-secret` is S12. If coturn 4.18 accepts only one secret from the file, rotation goes with a short window when new streams do not start.

### 9.4 WebSocket through the gateway

- The moonlight-web `websocket` transport is an HTTP upgrade to `/api/host/stream/web_socket` of the same host. The gateway proxies it like any WebSocket (S4 §7.3). `VideoDecoder` needs a secure context in the browser — HTTPS is there.
- Traffic of 8–20 Mbit/s per viewer goes through the gateway and the agent's tunnel. A gateway deploy closes such a stream after 2 min (S4 §10.2), and the viewer reconnects.
- The link parameter `transport=websocket` forces this path: for networks without UDP and for debugging.

## 10. Gateway: the host `<slug>-desktop`

### 10.1 Route

The suffix `-desktop` is already reserved (S4 §4.2). The response of `GET /internal/v1/gateway/routes/{label}` for the label `<slug>-desktop` gets a new field `kind` (for ports — `"port"`):

```json
{
  "label": "quiet-otter-lamp-desktop",
  "kind": "desktop",
  "sandboxId": "sb_...", "slug": "quiet-otter-lamp",
  "port": 47800,
  "machineId": "0192...", "sandboxState": "ready",
  "access": "token" | "sso" | "public",
  "tokenHash": null,
  "authEpoch": 3,
  "blocked": false, "blockReason": null,
  "hostRewrite": "localhost", "appProtocol": "http1", "teamId": "team_..."
}
```

- `404 route_not_found` if the sandbox's template has no `desktop` capability.
- `blocked: true, blockReason: "public_disabled"` if `access = public` and the operator has not allowed a public desktop (§10.4).
- `NOTIFY umiak_routes '<slug>'` — a trigger on `sandbox_desktops` (§13.5), as for ports.

### 10.2 Access

| Mode | How the browser gets in | Default |
|---|---|---|
| `token` | a one-time **ticket** from `POST /v1/sandboxes/{sb}/desktop/links` (§13.2) | yes |
| `sso` | login through oauth2-proxy, as for ports (S4 §8.4), but **only members of the sandbox's team and operators** are let in | — |
| `public` | no authorization; only if the operator turned on `PlatformDefaults.publicDesktopEnabled` (default `false`) | — |

A ticket is accepted in all modes except `public` (it is not needed there). This way the dashboard works the same in any mode.

**Ticket** [S10]:
- `umiakd_` + 32 random bytes (base64url). `api` stores the SHA-256.
- Lifetime 10 min. One-time. Bound to `(sandboxId, label, userId, authEpoch)`.
- Passed in the query `_ticket`: the gateway sees only the query, the URL fragment is unavailable to it.

The check order on `<slug>-desktop` (instead of S4 §8.3):
1. A valid cookie `__Host-umiak_auth` for this label with `m: "d"` and the current `authEpoch` → let through. `_ticket`, if present, is stripped without exchange.
2. `_ticket` in the query → `POST /internal/v1/gateway/desktop-auth/exchange {ticket, label}`. A valid one → a cookie, `302` to the same URL without `_ticket`, `Referrer-Policy: no-referrer`. An invalid or used one → `401 token_invalid` (the S4 §11 authorization failure counter).
3. `sso` → the S4 §8.4 flow. `api` checks the policy for `kind = desktop` (team or operator), not `ssoPortPolicy`.
4. `public` → let through.
5. Otherwise `401 auth_required`, a page "a desktop link is needed".

**Cookie** — the same `__Host-umiak_auth` (S4 §8.2): `m: "d"`, lifetime 12 h, attributes `Secure; HttpOnly; Path=/; SameSite=None; Partitioned`. `SameSite=None; Partitioned` is needed so that the stream works in an iframe of a third-party site (scenario 3). In the dashboard's iframe (the same site) the cookie works in any browser; in a third-party site's iframe — where CHIPS exists (Chrome, Firefox, Edge). Safari in a third-party iframe is not supported.

**CSRF protection** with `SameSite=None`: on labels with `kind = desktop` the gateway requires `Origin` = `https://<label>.<umiak-domain>` on all requests except `GET`/`HEAD`, and on a WebSocket upgrade. Otherwise `403 origin_forbidden`.

**No CORS preflight bypass.** The S4 §8.5 rule (a preflight passes without authorization) on labels with `kind = desktop` **does not apply**: `OPTIONS` requires authorization like any request. The moonlight-web viewer lives on the same origin and does not need CORS. The reason: `OPTIONS /api/host/stream/webrtc` of moonlight-web answers with `Link` headers carrying ICE servers, i.e. TURN credentials, to any request with the user header (§10.4).

### 10.3 Opening: `GET /`

The gateway itself handles `GET /` on the `desktop` label after authorization (the moonlight-web host list page is not used):
1. `POST /internal/v1/gateway/desktop/open {label}` → `api` calls the agent's `Desktop/Open` (§11.1), the response `{hostId, appId}`.
2. `302` to `/stream.html?hostId=<h>&appId=<a>` plus the allowed parameters from the original query: `fps`, `bitrate`, `dataTransport`, `language`. Others are dropped.
3. The streamer did not start within 20 s → `503 desktop_starting` (a page with auto-refresh after 5 s). The `desktop` phase not `ready` → also `503 desktop_starting`.

A link from the API looks like `https://<slug>-desktop.umiak.<domain>/?_ticket=…&fps=30`. Step 2 of §10.2 and step 2 of §10.3 merge into one redirect: the ticket exchange, then `Open`, then `302` to `stream.html` with the cookie.

### 10.4 Headers and the rest

- To the moonlight-web request the gateway sets `X-Umiak-Desktop-User: umiak` (the header name and value are gateway config) **only after successful authorization** per §10.2. An unauthorized request does not reach moonlight-web at all. An incoming header with this name is stripped together with all `X-Umiak-*` (S4 §7.4). The other S4 §7.4 stripping rules apply.
- `hostRewrite: localhost`: moonlight-web sees `Host: localhost:47800`.
- The global switch `publicDesktopEnabled` is in S8 `PlatformDefaults`, separate from `publicPortsEnabled`. Its change sends `NOTIFY umiak_routes '*'`.
- Error pages, limits, logs — as for ports. In the access log `access=desktop`.
- The label request limit (S4 §11) applies, but the viewer's static files are loaded once, so they do not hit it.

### 10.5 Access revocation

The desktop's `authEpoch` grows:
- on a change of access mode;
- on `DELETE /desktop/streams` (§13.2);
- on sandbox stop;
- on an operator block;
- on access revocation of a person or key (below).

Together with this `api` calls `Desktop/EndStreams` if the sandbox is `ready`. The cookies stop working at once, and the active stream (including through TURN, bypassing the gateway) is cut in the VM. After resume a new link is needed; in `sso` mode the browser signs in again itself.

**Access revocation of a person or key.** `api` already keeps a registry of open streams by principal and closes them on `NOTIFY umiak_identity` (the S8 C9 change). The same handler for the desktop [S10]:

| Event | Which sandboxes | Action |
|---|---|---|
| revocation or expiry of an API key | sandboxes for which tickets were issued by this key in the last 12 h (`desktop_tickets.api_key_id`) | `authEpoch+1`, `EndStreams` |
| removing a member from a team, deactivating a user | sandboxes for which this user got tickets in 12 h, and all of the team's sandboxes in `sso` mode | `authEpoch+1`, `EndStreams` |

12 h is the cookie lifetime: an older ticket can no longer hold a cookie. A viewer who opened a link issued by another person loses access together with whoever issued it. This is intentional: a link is a delegation of the issuer's access.

## 11. The agent

### 11.1 The service `umiak.agent.v1.Desktop`

A new Connect service, `proto/umiak/agent/v1/desktop.proto`:

| Method | What | Idempotency |
|---|---|---|
| `Status` | the `desktop` phase, screen size, cursor position, streamer (`running`, `streaming`, `stream_count` if known), versions of Sunshine, moonlight-web, cua-driver | `NO_SIDE_EFFECTS` |
| `Configure{ice_servers}` | TURN credentials (§9.3) into `desktop/ice-servers.json` | `Umiak-Request-Id` |
| `Open` | start the streamer on demand, pairing if needed (§8.3), the response `{host_id, app_id}` | `IDEMPOTENT` |
| `StopStreamer` | stop Sunshine and moonlight-web | `IDEMPOTENT` |
| `EndStreams` | cut the active streams (§8.4) | `IDEMPOTENT` |
| `Screenshot{format, quality, max_width, max_height, region, cursor}` | the image and sizes (§12.1) | `NO_SIDE_EFFECTS` |
| `Act{actions, coordinate_space}` | a sequence of input actions (§12.2) | `Umiak-Request-Id` |
| `GetClipboard` / `SetClipboard{text}` | the clipboard text (§12.3) | `NO_SIDE_EFFECTS` / `Umiak-Request-Id` |

- **The `Umiak-Request-Id` cache and the payload** (s10-fix). The outcome of `Act` is stored in the agent's request cache (`state.db`, up to 24 h) without a screenshot: a repeat with the same id does not repeat the input and returns the stored result (`completed`, cursor, screen) with a **fresh** screenshot if one was requested (`Screenshot` has no side effects). The body of `SetClipboard` is not stored in the cache (only the request hash), `Screenshot` and `GetClipboard` are not cached. So screenshots do not end up in `state.db`, snapshots, or forks (§16).
- A screenshot is returned in the response body (`bytes`). For this service the Connect message limit is 32 MiB **[implementer: check that `libs/tunnel` lets it through]**.
- Input is serialized: one `Act` at a time runs on a machine. The others wait up to 10 s, then `resource_exhausted desktop_busy`.
- Capabilities (S2 §10.2): `desktop.v1`, `desktop.stream.v1`, `desktop.input.v1`, `desktop.clipboard.v1`. If the agent lacks them, `api` answers `409 agent_outdated`.
- `ErrorDetail.code` codes: `desktop_unsupported`, `desktop_not_ready`, `desktop_busy`, `streamer_failed`, `action_failed`, `invalid_action`, `clipboard_unavailable`.

### 11.2 `umiak-session` on Linux

S9 introduced `umiak-session`, a helper in the interactive Windows session. S10 makes it shared by both OSes [S10]: one protocol, one logic in the agent, OS-dependent code in the helper.

- The `umiak-session` binary is in the agent package (`versions/<v>/umiak-session` on Linux). It is started by the user unit `umiak-session.service` of the user `user` from the session script (§6.3), `Restart=always`.
- It connects to the agent over the unix socket `/run/umiak-session/session.sock`: the directory `0750 root:user`, the socket `0660 root:user`. Not inside `/run/umiak-agent`: that directory is `0700 root` (S3 §5), and `user` would not reach the socket. The S9 §13 protocol (length-prefixed protobuf, `proto/umiak/session/v1/session.proto`) is extended with the messages `Capture`, `Input`, `ClipboardGet`, `ClipboardSet` and the responses to them.
- **The `desktop` phase on Linux** = `ready` when the helper is connected, the X server answers, and the helper reported `State{width, height}`. For Windows — as in S9 §13.
- Linux implementation **[implementer]**:
  - screenshot — `GetImage` (or MIT-SHM) over X11 from Go (`github.com/jezek/xgb`);
  - mouse and keys — XTEST;
  - typing arbitrary Unicode — a temporary rebinding of a free keycode to the needed keysym, as in xdotool, or calling `xdotool type` from the helper;
  - clipboard — the helper itself owns the `CLIPBOARD` selection (it lives the whole session, so `xclip` is not needed).
- **On Windows** the helper uses GDI `BitBlt` or DXGI Desktop Duplication (chosen by spike W), `SendInput` with `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` and `KEYEVENTF_UNICODE` for text, and the Win32 clipboard (`CF_UNICODETEXT`).
- The agent re-encodes the helper's raw frame to PNG or JPEG and scales it (`golang.org/x/image/draw`, CatmullRom). The helper returns uncompressed BGRA over the socket: so there is one codec for both OSes.

### 11.3 Streamer supervisor

- Linux: `systemctl start|stop umiak-moonlight-web.service` and `systemctl --user -M user@ start|stop sunshine.service` over D-Bus.
- Windows: SCM (`ServiceManager`, S3 §18).
- The agent watches the processes and restarts a crashed streamer no more often than once per 10 s. After 5 crashes in a row `Open` answers `streamer_failed`.

### 11.4 Events and idle

- A new journal event `desktop.streaming_changed{streaming, count?}` (§8.4).
- The counter **`desktopStreams`** (1 if a stream is running and the count is unknown) is added in both places from which S6 takes idle (S6 §12): in the `activity` event payload and in the `System/Activity` response, which S6 calls live before an idle-stop. With `desktopStreams > 0` the sandbox is `busy`, and idle-stop does not stop it. Without this a viewer through TURN would be invisible: a WebRTC stream has no TCP streams through the tunnel.
- The agent's idle flag (S3 §13) also counts an active stream as busy.
- **Observation error** (s10-fix). A failed viewer sample keeps the previous value (at least 1) for no more than 2 min of consecutive errors; after that the agent counts `desktopStreams = 0`. Otherwise a broken source would keep the sandbox busy and idle-stop would never trigger. A successful sample resets the window.
- Computer-use API calls update `last_api_call_at` like any API calls (S6 `touchApiActivity`).

## 12. Computer-use primitives

The semantics are the same on Linux and Windows. Coordinates are screen pixels, the origin is the top left corner.

### 12.1 Screenshot

- `format`: `png` (default) or `jpeg` (`quality` 1–100, default 80).
- `max_width`, `max_height`: shrink preserving proportions (does not enlarge). For an LLM 1280×720 or 1024×768 is convenient.
- `region {x, y, width, height}`: cut a rectangle before scaling.
- `cursor`: draw the cursor on top (default `true`).
- The response: the image, `screen {width, height}`, `image {width, height}`, `scale` (= image / screen by width), the cursor position.

### 12.2 Actions (`Act`)

The list is executed in order and stops at the first error. The response: `completed` (the number of executed actions), the cursor position, the screen size. On an error — `action_failed` with the action index; actions executed before it are not rolled back.

| `type` | Fields | What it does |
|---|---|---|
| `move` | `x, y` | move the cursor |
| `click` | `x?, y?, button = left\|right\|middle, count = 1..3, modifiers?` | move (if coordinates are given) and click; `count: 2` is a double click |
| `mouse_down`, `mouse_up` | `x?, y?, button` | press or release a button |
| `scroll` | `x?, y?, dx, dy` | scroll in wheel "clicks"; `dy > 0` is down |
| `drag` | `path [{x, y}, …]` (≥ 2 points), `button = left` | press at the first point, move along the points, release at the last |
| `key` | `keys ["ctrl", "shift", "t"]` | a chord: press in order, release in reverse |
| `key_down`, `key_up` | `key` | for holding |
| `type` | `text` (up to 10,000 characters), `delay_ms = 5` (0–100) | type Unicode text as keyboard input |
| `wait` | `ms` (up to 10,000) | a pause |

- `coordinate_space {width, height}` in the request: the coordinates are given in the space of the scaled-down screenshot, and the agent converts them to screen ones. This way an LLM passes coordinates from a 1280×720 picture without converting.
- Coordinates off screen → `invalid_action` before the first action is executed (the whole list is checked in advance).
- **Windows: blocked input** (s10-fix). `SendInput` returns 0 inserted events while the input desktop is not `Default` (the login transition on a fresh fork, the secure desktop). The helper repeats only the uninserted events every 50 ms for up to 2 s; then `action_failed` with the input desktop name in the message. No keypress is sent twice.
- Limits: up to 100 actions per request, up to 60 s in total.
- **Key names** are a fixed dictionary in the proto, lowercase: modifiers `ctrl`, `alt`, `shift`, `meta` (Super/Win); `enter`, `tab`, `escape`, `backspace`, `delete`, `insert`, `space`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `f1`…`f24`, `capslock`, `printscreen`, `menu`; single printable characters (`a`, `1`, `/`). An unknown name → `invalid_action`.
- The `click` modifiers use the same dictionary.

### 12.3 Clipboard

- UTF-8 text only, up to 1 MiB. Images are S29.
- `GetClipboard` with no text in the clipboard → an empty string, `has_text: false`.
- In a moonlight-web stream the browser passes pasted text as input. This is a separate path, the clipboard API does not depend on it.

## 13. Public API (additions to S7)

### 13.1 Permissions

A new scope **`desktop`**: links, access mode, ending streams, screenshot, actions, clipboard. It is in the `full` preset and not in `read-only` and `ci`. `GET /desktop` (status) is available with `sandboxes:read`.

Rationale: the desktop gives full control over the `user` session (who has sudo), i.e. equals `exec` in power. A separate scope lets you issue a key for exec without a screen and vice versa.

### 13.2 Endpoints

| Method and path | What | Scope |
|---|---|---|
| `GET /v1/sandboxes/{sandbox}/desktop` | status: `{state: "ready"\|"starting"\|"unavailable", reason, screen, cursor, access, url, streamer: {running, streaming}}` | `sandboxes:read` |
| `POST /v1/sandboxes/{sandbox}/desktop/links` | a one-time link; the body `{fps?: 30\|60, bitrateKbps?: 1000..20000, transport?: "auto"\|"webrtc"\|"websocket"}` → `201 {url, expiresAt}` | `desktop` |
| `PUT /v1/sandboxes/{sandbox}/desktop/access` | `{access: "token"\|"sso"\|"public"}` → `{access, url}` | `desktop` |
| `DELETE /v1/sandboxes/{sandbox}/desktop/streams` | cut the streams and reset cookies (`authEpoch+1`) → `204` | `desktop` |
| `GET /v1/sandboxes/{sandbox}/desktop/screenshot` | query: `format`, `quality`, `maxWidth`, `maxHeight`, `x`, `y`, `width`, `height`, `cursor` → `200 image/png\|image/jpeg` | `desktop` |
| `POST /v1/sandboxes/{sandbox}/desktop/actions` | `{actions: [...], coordinateSpace?: {width, height}, screenshot?: {format, quality, maxWidth, maxHeight}}` → `200 {completed, cursor, screen, screenshot?}`; `Idempotency-Key` | `desktop` |
| `GET /v1/sandboxes/{sandbox}/desktop/clipboard` | `{text, hasText}` | `desktop` |
| `PUT /v1/sandboxes/{sandbox}/desktop/clipboard` | `{text}` → `204` | `desktop` |

- **The link** is built as `https://<slug>-desktop.<umiak-domain>/?_ticket=<t>&fps=<n>…` (§10.3). It is a secret, like a URL with a port token. It is not returned in lists and `GET`. `POST /links` calls `Desktop/Open` in the background beforehand so that the streamer is ready for opening.
- **The screenshot** is the image bytes with the headers `Umiak-Screen-Width`, `Umiak-Screen-Height`, `Umiak-Image-Width`, `Umiak-Image-Height`, `Umiak-Cursor-X`, `Umiak-Cursor-Y`, `Cache-Control: no-store`. In the `actions` response with `screenshot` — JSON `{contentType, width, height, data: <base64>}`: this is a screenshot after the actions in one call, as MCP needs.
- **Errors** (an addition to S7 §5.5):

| HTTP | `code` | `retryable` | When |
|---|---|---|---|
| 422 | `desktop_unsupported` | no | the template has no `desktop` capability |
| 409 | `desktop_not_ready` | yes | the sandbox is `ready`, but the `desktop` phase is not yet `ready` (session restart, waking); `Retry-After: 2` |
| 409 | `desktop_busy` | yes | another `Act` has been running for more than 10 s |
| 400 | `invalid_action` | no | `details {index, reason}` |
| 422 | `action_failed` | no | the action did not execute; `details {index, completed}` |
| 503 | `streamer_unavailable` | yes | the streamer did not start |
| 403 | `forbidden` | no | `public` with `publicDesktopEnabled` off (`details.reason: "public_disabled"`) |

- The sandbox state is as for commands (S7 §9.1): not `ready` → `409 sandbox_not_ready`.
- **Operator block** (S8 C3, s10-fix): `POST /links`, `PUT /access`, `POST /actions`, `PUT /clipboard` on a blocked sandbox → `403 forbidden` with `details.reason: "sandbox_blocked"`, like `exec` (an operator passes). Reading (`GET /desktop`, `GET /screenshot`, `GET /clipboard`) is allowed, like reading files; `DELETE /streams` is allowed (it only disconnects). The block itself sends `NOTIFY umiak_identity 'sandboxes:<id>'`; the `api` access monitor on it (and every 5 s) raises `authEpoch`, calls `EndStreams`, and marks `policy_revoked`, so issued tickets and cookies stop working, and the gateway route gets `blocked`. Lifting the block raises `authEpoch` again (s10-fix2): a ticket issued in the milliseconds while the block was being set could have received the block's epoch and would otherwise come alive after unblocking.
- The Sandbox resource (S7 §8.1): `endpoints.desktop = "https://<slug>-desktop.<umiak-domain>/"` for templates with the `desktop` capability (without a ticket).

### 13.3 Internal endpoints (internal listener, the gateway service token)

- `POST /internal/v1/gateway/desktop-auth/exchange {ticket, label}` → `{label, authEpoch, userId}` or `400 {"code": "invalid_ticket"}`. Atomic, like the SSO code exchange (S7 §12.1): `UPDATE desktop_tickets SET used_at = now() WHERE ticket_hash = $1 AND label = $2 AND used_at IS NULL AND expires_at > now() AND auth_epoch = <current> RETURNING …`.
- `POST /internal/v1/gateway/desktop/open {label}` → `Desktop/Open` at the agent → `{hostId, appId}`; `409 desktop_not_ready`, `503 streamer_unavailable`. Updates `last_api_call_at`.
- `GET /umiak-auth/authorize` (S7 §7.7) for labels with `kind = desktop` checks that the user is a member of the sandbox's team or an operator.

### 13.4 Lifecycle behavior

| Event | The desktop |
|---|---|
| create (a template with `desktop`) | a `sandbox_desktops` row with `access = token`, `authEpoch = 1` |
| stop | `authEpoch+1`; the stream is cut together with the VM |
| resume | TURN credentials again (§9.3); a new link is needed |
| fork | a new sandbox, a new slug, and a new row `access = token`. The source's access mode is not inherited |
| delete | the row is deleted together with the sandbox, the route gives `404` |

### 13.5 Tables

Schema `runtime`, the S10 migrations in `db/migrations/`: **0401–0405** inside the S8 block `0400–0499` by the master's decision (0400 is taken by S8 environments); the next free number in the block is 0406 (`docs/roadmap.md`):

```
sandbox_desktops(
  sandbox_id uuid pk,             -- runtime.sandboxes
  access text,                    -- token | sso | public
  auth_epoch int,
  turn_issued_at timestamptz null,
  turn_attempted_at timestamptz null, -- last renewal attempt (0405): failed guests go to the back
  pending_disconnect bool, policy_revoked bool,
  updated_at timestamptz)

desktop_tickets(
  ticket_hash bytea pk,           -- sha256 of the 32-byte ticket
  sandbox_id uuid, label text, user_id text, api_key_id text null,
  auth_epoch int,
  expires_at timestamptz,         -- now() + 10 min
  used_at timestamptz null, created_at timestamptz)
```

The block is only `runtime.sandboxes.blocked` (S8): the columns `sandbox_desktops.blocked/block_reason` were never written by anyone, `0404_desktop_drop_block.sql` drops them (s10-fix). The trigger on `sandbox_desktops` sends `NOTIFY umiak_routes '<slug>'`. S6 cleanup deletes tickets older than a day. The changes to `packages/core` (`SandboxService`: `desktopLink`, `setDesktopAccess`, `endDesktopStreams`, the `authEpoch+1` step in stop, the TURN step in claim and provision) are made by the S10 implementer, coordinating with the S6 track, like S7 (S7 §20.2).

## 14. Dashboard, CLI, SDK, MCP

### 14.1 Dashboard (the Desktop tab, S8 §8)

S8 left a stub; the tab is implemented by the S10 implementer.
- On opening the tab — `POST /api/v1/sandboxes/{id}/desktop/links`, then an iframe:

```html
<iframe src="{url}" allow="autoplay; fullscreen; clipboard-read; clipboard-write; keyboard-map"
        referrerpolicy="no-referrer" style="width:100%;aspect-ratio:16/9;border:0"></iframe>
```

- A new link on every mount of the tab and after the sandbox moves to `ready` (resume).
- Buttons: "open in a new tab" (a new link), full screen, access mode selection, "disconnect all viewers" (`DELETE /desktop/streams`).
- A sandbox that is not `ready` → a message and a Resume button. `desktop_not_ready` → "the desktop is starting", retry after 2 s.
- The S8 CSP already allows `frame-src https://*.<umiak-domain>`.

### 14.2 CLI

| Command | What |
|---|---|
| `umiak desktop [open] <id> [--fps 60] [--bitrate N] [--transport websocket] [--print]` | open the link in a browser (`--print` — only print) |
| `umiak desktop screenshot <id> [-o file.png] [--max-width N] [--max-height N] [--jpeg] [--quality N]` | a screenshot to a file or stdout |
| `umiak desktop act <id> [--file <path\|->]` | a list of actions from JSON; plus short forms `click X Y`, `type TEXT`, `key ctrl+c`, `scroll DY` |
| `umiak desktop clipboard <id> [get\|set TEXT]` | the clipboard |
| `umiak desktop access <id> token\|sso\|public` | the access mode |
| `umiak desktop end-streams <id>` | `DELETE /desktop/streams` |

The s10-fix implementation: the actions input is `--file <path|->` (`-f`), not `--json`, because the CLI's global `--json` is the output format (S7 §14.3) and intercepts the subcommand flag. `end-streams` is added for `DELETE /desktop/streams`. The first-pass commands `umiak screenshot|input|clipboard` and the options `umiak desktop --access/--end-streams` are kept as hidden synonyms.

The output contract is as for the rest of the CLI (S7 §14.3): JSON if stdout is not a TTY.

### 14.3 SDK (TS and Python)

Helpers on top of the generated client: `desktop.link()`, `desktop.screenshot()`, `desktop.click(x, y)`, `desktop.type(text)`, `desktop.key(...keys)`, `desktop.scroll(dy)`, `desktop.drag(path)`, `desktop.clipboard.get()/set()`, `waitForDesktop(sandbox)` (repeats `GET /desktop` until `state = ready`, repeating only on `retryable`).

### 14.4 What S11 (MCP) gets

- `desktop_url` → `POST /desktop/links`.
- `computer_screenshot` → `GET /desktop/screenshot` with `maxWidth=1280` by default, the response is MCP image content.
- `computer_click`, `computer_move`, `computer_drag`, `computer_scroll`, `computer_key`, `computer_type` → `POST /desktop/actions` with one action and the `coordinateSpace` of the last screenshot; the option `screenshot_after`.
- `computer_clipboard_read`, `computer_clipboard_write`.

In `docs/roadmap-phase2.md` §5.2 these tools are marked S29; after S10 they move to S11 (MVP). The roadmap edit is made by the master.

## 15. Sizes and cold creation

### 15.1 Sizes [S10]

| Size | vCPU | RAM | Where |
|---|---|---|---|
| `2gb` | 2 | 2048 | `linux` (exists) |
| `4gb` | 4 | 4096 | the default for `linux-desktop` and `windows` |
| `8gb` | 8 | 8192 | allowed for `linux-desktop` and `windows`; in the PoC takes the whole sandbox budget |

- `linux-desktop`: `defaultSize = 4gb`, `allowedSizes = [4gb, 8gb]`. On 2 GB, Chrome with several tabs and the desktop run into OOM.
- `windows`: the default size `4gb` now means 4 vCPU instead of 2 (S9 §9). `pve` has 24 cores, CPU is not limited, and x264 and Windows together on 2 vCPU give stutter. Only RAM is limited (S6 §8.1).
- Memory reserve for the streamer (roadmap-phase2 L18): Sunshine 150–250 MB and moonlight-web 30–60 MB during a stream. They have no separate `MemoryMin`: the streamer starts on demand, and its RAM is part of the sandbox size.

### 15.2 CPU and network

- x264 `superfast` + `zerolatency`, 1080p30: 0.7–1.5 vCPU expected during an active stream; 1080p60 — up to 2–3 vCPU. Without a stream the streamer does not run and CPU is not spent. Measurement §20, the numbers are in §24.
- Network per viewer: 8 Mbit/s by default, up to 20 Mbit/s. Through TURN (WebRTC) or through the gateway and tunnel (WebSocket).
- The bottleneck on a single node is the host CPU with several simultaneous streams. A quota on the number of simultaneous streams is not introduced in the MVP; the metrics (§18) show when it will be needed.

### 15.3 Cold creation (Ilia's decision 2026-10-31)

Warm and hibernated pools are not in the MVP for either Linux or Windows. Create: cold clone → boot → claim → Desktop/Configure → desktop ready. No pool targets, no pool machine preparation, no hibernate/resume-hint for the pool, and no ≤15 s target.

For `linux-desktop` 20–40 s is expected, up to ~1 min is allowed; for Windows up to 5 min is allowed. These are guidelines before measurements, not a measured result. Stop/resume of an ordinary sandbox stays in acceptance. The size `4gb` is the default, `8gb` is allowed; the total budget of running sandboxes on pve is 8 GB.

## 16. Security

- **The desktop = full control over `user`.** Therefore: a separate scope `desktop`; in `sso` mode only the team and operators; `public` is off globally by default (§10.2). The security decision was approved by the master 2026-10-29 (§26).
- **Ticket and cookie.** The ticket is one-time and lives 10 min, is stored as a hash, `_token`/`_ticket` are stripped from the URL by the first `302`, the query is not written to logs (S4 §12.2), `Referrer-Policy: no-referrer`. The cookie is `__Host-`, for one label, with `authEpoch`.
- **Revocation affects the stream through TURN**: `EndStreams` in the VM (§10.5). TURN credentials remain valid until expiry, but through TURN one cannot reach anything except its own allocations (§9.2).
- **TURN is not an open relay:** the peers are only its own relay addresses; quotas per user and session; `no-tcp-relay`; the secret only in `worker` and coturn.
- **The streamer is on loopback only.** Sunshine `bind_address = 127.0.0.1`, moonlight-web `127.0.0.1:47800`. The Sunshine and moonlight-web credentials are separate for each machine identity. Anything inside the VM can connect to them — this is within the trust boundary (the VM).
- **Forging the moonlight-web user** from outside is impossible: `X-Umiak-Desktop-User` is set only by the gateway and only after authorization, an incoming one is stripped. A preflight without authorization on a desktop label is not let through, otherwise `OPTIONS` would hand out TURN credentials (§10.2).
- **Screenshots** are not stored and not written to the logs of `api` and the agent. There may be secrets on the screen — this is the same access as `files:read`.
- **The clipboard** is not written to logs.
- **CSRF** on a desktop label — the `Origin` check (§10.2).
- **External STUN** is off: the VM and browser do not go to Google servers.
- **Artifact signatures.** cua-driver — sigstore, Sunshine and moonlight-web — sha256 from `versions.toml`, Chrome — the Google repository key.

## 17. Licenses

| Component | License | How it is used |
|---|---|---|
| Sunshine | GPL-3.0 | the upstream binary package unchanged, in template images |
| moonlight-web | GPL-3.0 | the upstream binary archive unchanged, in template images |
| coturn | BSD-3-Clause | an image in the cluster |
| cua-driver | MIT (the `cua-perception` extension is AGPL, not installed) | in template images |
| Google Chrome | Google Chrome Terms of Service | in the `linux-desktop` image (architecture decision §1) |
| openbox, LightDM, tint2, Xorg, PipeWire | GPL-2.0 / GPL-3.0 / MIT | Ubuntu packages |

GPL-3.0, when distributing binaries, requires offering the source code. We do not modify the code. The build manifest (S5 §11) records the version and source URL of each GPL component: this is enough for an offer of sources. The GPL-3.0 components are allowed by Ilia: the binaries are not modified, used only inside the company, and not distributed to third parties (§26). A non-GPL replacement on both OSes is Guacamole (Apache-2.0), but with worse latency and RDP problems on Windows (§4.1).

## 18. Observability

- **Agent:** `Desktop/Status`; the event `desktop.streaming_changed`; in `doctor --desktop` — versions, session state, streamer, pairing. The Sunshine and moonlight-web logs are in journald (Linux) and the service files (Windows), the agent does not forward them.
- **`api`:** metrics `umiak_api_desktop_links_total`, `umiak_api_desktop_actions_total{type, result}`, `umiak_api_desktop_screenshot_bytes` (histogram), `umiak_api_desktop_action_duration_seconds`.
- **Gateway:** the existing metrics with `access=desktop`; `umiak_gateway_desktop_open_total{result}`.
- **coturn:** the built-in Prometheus exporter (allocations, traffic, sessions). An S12 alert when `total-quota` is above 80%.
- **S6:** `desktopStreams` in activity — how many sandboxes are being watched now. Sandbox CPU during a stream comes from `System/Metrics`.

## 19. Spikes and implementation order

Spikes are the first implementation step, not part of this spec: no VMs were run on `pve` while writing it. Before starting a spike the implementation thread gets confirmation from the master that the host is free (the 8 GB budget is shared by other threads too, e.g. the `s1-fix` measurements).

### 19.1 Spike L (Linux) — first

On `pve` within the §3 constraints: one 4 GB VM (VMID 5xx), together with it other sandboxes — no more than 8 GB.
1. A VM from the S5 `linux` template (clone only; do not change the originals 597/598/599), the step `60-desktop` by hand through QGA.
2. Check the questions: pairing through the moonlight-web v3 and Sunshine API; behavior with a second viewer; how the agent learns about an active stream; whether coturn checks the credential expiry on `Refresh`.
3. The §20 measurements: CPU at 1080p30 and 1080p60, RAM, the streamer start time, glass-to-glass latency over WebSocket and WebRTC through TURN.
4. Measure cold create and an ordinary stop/resume; the hibernation part of the spike is excluded by Ilia's decision.

The browser opens the stream through the CT 590 gateway; addresses are set only in `infra/dev-cp/`. TURN is our own coturn in compose. Any firewall change is announced to the master beforehand and done only with a rollback timer (S1 §4.4). External tunnels and relay services are forbidden.

### 19.2 Spike W (Windows)

After the S9 merge and a message to the master, one 4 GB VM:
1. The video adapter (§7): `std`, `virtio` + `viogpudo`, an IddCx driver. `ddx` capture, a `BitBlt`/DXGI screenshot after a cold boot and an ordinary stop/resume.
2. Sunshine with `encoder = software` on Windows: the stream runs, CPU at 1080p30.
3. Whether an audio device is needed for the stream to start.
4. `SendInput` and `KEYEVENTF_UNICODE` from `umiak-session`: clicks, typing, clipboard.

### 19.3 Order

1. Spike L.
2. The proto `desktop.proto` and the `session.proto` messages; `umiak-session` on Linux; the `Desktop` service in the agent (screenshot, input, clipboard), the `desktop` phase, `desktop: true`, env.
3. The `linux-desktop` recipe with VMIDs `[595, 596]`, the `verify` profile, cold creation without a pool.
4. The streamer: supervisor, pairing, `Open`, `EndStreams`, `Configure`.
5. Gateway: `kind = desktop`, tickets, `GET /`, the header, `Origin`, the `Partitioned` cookie.
6. `api`: the §13 endpoints, tables, internal endpoints; `worker`: TURN credentials, `authEpoch` on stop, `desktopStreams`.
7. coturn: the config and manifest (handed to S12), the IPSet `umiak-turn` in the S1 runbook.
8. Spike W and the Windows integration.
9. The dashboard tab, CLI, SDK.
10. Acceptance §20, the numbers in §24.

## 20. Acceptance

Where tests run: unit (fakes of `umiak-session` and the streamer); kind/k3s (gateway, `api`, coturn, the agent process on a Linux runner with Xvfb for `umiak-session`); the `pve` stand with real VMs; the browser is Chrome on a Mac over Tailscale.

**Computer-use (Linux and Windows):**
1. A PNG and JPEG screenshot of 1920×1080; with `maxWidth=1280` — 1280×720 and `scale = 0.667`; `region` cuts the needed rectangle. p50 ≤ 300 ms for a full PNG.
2. `click` on a test page button in the browser — the handler fired; `count: 2` — `dblclick`; `right` — the context menu.
3. `type` of a string with ASCII, Cyrillic, emoji, and CJK into a text field — the value matches. `key ["ctrl","a"]`, `key ["ctrl","c"]` → `GetClipboard` returns the field's text.
4. `drag` moves an HTML5 drag-and-drop element; `scroll` scrolls the page.
5. `coordinateSpace` 1280×720: a click at coordinates from the scaled-down screenshot hits the same button.
6. Coordinates off screen → `400 invalid_action`, nothing executed. 101 actions → `400 validation`.
7. Repeating `actions` with the same `Idempotency-Key` does not type the text twice.
8. Two parallel `actions` run in turn, the input is not mixed.
9. Screenshots and actions work with the streamer stopped; the streamer is not started by them.
10. The latency of one action (`click`) through the API p50 ≤ 50 ms not counting the network to `api`.

**Stream:**
11. Dashboard: the Desktop tab shows the desktop in an iframe; the mouse and keyboard from the browser work. The time from opening the tab to the first frame ≤ 5 s with the streamer stopped.
12. WebRTC: in `chrome://webrtc-internals` the relay ↔ relay pair through our TURN is selected; there are no external STUN requests.
13. A browser with blocked UDP: the stream goes through TURN over TCP or TLS 443. With TURN blocked too — after 15 s the viewer switches to WebSocket, the stream goes through the gateway.
14. `transport=websocket` — the stream goes through the gateway.
15. Glass-to-glass latency (a clock on the VM screen versus a clock on the Mac): WebRTC p50 ≤ 150 ms, WebSocket p50 ≤ 250 ms over Tailscale in the home network. The numbers are in §24.
16. A gateway deploy during a WebRTC stream: the stream is not interrupted. During a WebSocket stream — interrupted no sooner than after 2 min.
17. A second viewer (a second tab): both see the screen and can control it; the first stream is not cut when a new link is issued. The CPU with two streams is recorded in §24.
18. The streamer stops after 15 min without a stream; the next opening starts it again.

**Access:**
19. Ticket: opens once; a second visit to the same link without a cookie → `401`; after 10 min → `401`; `_ticket` is neither in the address bar after the redirect nor in the access log.
20. `sso`: a team member signs in; a user of another team → refusal, even with `ssoPortPolicy = any`; an operator signs in.
21. `public` with `publicDesktopEnabled = false` → `403 route_blocked`; after turning it on — opens without login.
22. A mode change and `DELETE /desktop/streams`: the old cookie immediately gives `401`, and the active stream (including through TURN) is cut within 5 s at most.
23. Stop: the stream is cut; after resume the old cookie does not work.
24. A key without the scope `desktop` → `403` on all §13.2 endpoints except status.
25. A forged `X-Umiak-Desktop-User` from a client does not reach moonlight-web (an echo test).
26. A WebSocket upgrade and `POST` to a desktop label with a foreign `Origin` → `403 origin_forbidden`.
27. An iframe on another site (a test page on a separate domain) in Chrome: the stream works (partitioned cookie).

**TURN:**
28. With a sandbox's credentials the TURN client cannot create a permission to an external address (`8.8.8.8`), a node address, a cluster pod, or another VM — a 403 refusal. Relay ↔ relay works.
29. Expired credentials → `401` on `Allocate`. Renewal by the controller: the credentials of a `ready` sandbox are never older than 24 h.
30. Firewall: from the VM beyond the S1 rules only `umiak-turn` UDP 3478 is reachable; TCP and other ports of the TURN host are not.

**Template and cold create:**
31. The §6.6 and `windows-desktop` checks are green.
32. Cold create of `linux-desktop`: measure clone + boot + desktop start (guideline up to ~1 min), `desktop: ready`, the claim env is visible in the terminal. Windows — up to 5 min. The RAM of all sandboxes ≤ 8 GB, no pool.
33. A fork of a running `linux-desktop`: the fork has new Sunshine and moonlight-web credentials, pairing passes on the first opening; the Chrome profile is preserved.
34. Idle-stop: with a stream open through TURN and no other actions the sandbox is not stopped for 30 min (`desktopStreams` in `activity` and in `System/Activity`); after the stream is closed it is stopped after `idle_timeout_seconds`.
35. Revoking the key that issued a ticket, and removing a member from a team: the viewer's cookie gives `401` at once, the stream is cut no later than 5 s after `NOTIFY umiak_identity`.
36. `OPTIONS` to a desktop label without authorization → `401`; there are no `Link` headers with TURN credentials in the response.

## 21. Changes in neighboring areas

Made by the implementers of those areas per this spec (like S7 §20); agreement is through the master.

- **S1:** the IPSet `umiak-turn` and the UDP 3478 rule in `umiak-egress` (§9.2), a runbook step with a rollback timer.
- **S2 / `libs/tunnel`:** raise the Connect message size limit to 32 MiB for `umiak.agent.v1.Desktop/Screenshot` (if it is lower now).
- **S3:** the `Desktop` service; `umiak-session` on Linux and its socket; the `desktop` phase on Linux; `CommandSpec.desktop` on Linux; `DISPLAY`/`XAUTHORITY` in the platform env of templates with a desktop; session restart at claim and after secrets; the event `desktop.streaming_changed` and `desktopStreams` in `activity` and `System/Activity`; counting a stream in the idle flag; the socket `/run/umiak-session/`; the `resume-hint` subcommand on Linux; erasing the streamer state on identity change; the §11.1 error codes; capabilities.
- **S4:** the `kind` field in the route; for `kind = desktop` — tickets and exchange, `GET /` → `Open` → `302`, the header `X-Umiak-Desktop-User` only after authorization, no CORS preflight bypass, the `Origin` check, the cookie `m: "d"` with `SameSite=None; Partitioned`, the `desktop_starting` page; the streamer ports among the reserved ones (`UMIAK_GATEWAY_RESERVED_PORTS`).
- **S5:** `extends` (S5 §16 already provided for it), the `linux-desktop` recipe, the profile `verify: linux-desktop`, VMIDs `[595, 596]`; default size 4gb and allowed 4gb/8gb in the runtime seeds/config.
- **S6:** `desktopStreams` in `activity`, `System/Activity`, and idle-stop; the desktop's `authEpoch+1` in stop; `Desktop/Configure` in the `claim` and `provision` steps; the `desktop-turn` controller; the §13.5 tables through `packages/core`.
- **S7:** the scope `desktop`; the §13.2 and §13.3 endpoints; errors; `endpoints.desktop`; reserved streamer ports; the `sso` policy for `kind = desktop`; desktop access revocation in the `NOTIFY umiak_identity` handler (§10.5, an extension of S8 C9); TURN credentials are issued by `worker`, not `api` (an override of S4 §13); documentation (an env change does not change a running desktop, Safari and a third-party iframe).
- **S8:** `PlatformDefaults.publicDesktopEnabled` (default `false`) with `NOTIFY umiak_routes '*'`; the `linux-desktop` template seed (`capabilities` with `desktop`, `defaultSize: 4gb`); the seed of sizes `4gb` (4 vCPU) and `8gb`; the Desktop tab (§14.1) is done by the S10 implementer; the `desktop` scope in the key form.
- **S9:** the step `60-desktop` is extended with §7; `hw.vga` per spike W; `umiak-session` gets `Capture`, `Input`, `ClipboardGet/Set` and starts cua-driver; the default size of `windows` is `4gb` with 4 vCPU.
- **S11:** the §14.4 tools.
- **S12:** coturn (a Deployment `hostNetwork` on a labeled node or a UDP LB, the Secret `static-auth-secret`, the certificate `turn.<domain>`, DNS), the config `UMIAK_TURN_URLS` and `UMIAK_TURN_SECRET_FILE` for `worker`, an alert on the TURN quota; the TURN IP in the IPSet `umiak-turn`.

## 22. Code layout

```
proto/umiak/agent/v1/desktop.proto        Desktop service (§11.1)
proto/umiak/session/v1/session.proto      agent <-> umiak-session (S9 §13 + Capture, Input, Clipboard)
services/guest-agent/
  internal/desktop/                     Desktop service, streamer supervisor, pairing, TURN config
  internal/session/                     session socket server, shared by Linux and Windows
  cmd/umiak-session/                      helper: *_linux.go (X11), *_windows.go (Win32)
infra/templates/linux-desktop/          recipe, versions.toml, steps/60-desktop.sh, files/
infra/templates/_windows/steps/60-desktop.ps1   S10 additions (§7)
services/gateway/internal/desktopauth/  tickets, open redirect, header, Origin check
apps/api/src/routes/desktop.ts          public routes (§13.2); internal routes (§13.3)
packages/core/                          desktop methods, TURN credential issuing, controller desktop-turn
db/migrations/04xx_*.sql                §13.5
infra/turn/                             coturn config template (manifests: S12)
apps/web/                               Desktop tab
apps/cli/                               umiak desktop
```

The package structure inside is **[implementer]**.

## 23. Versions

The project rule: the latest stable versions, re-check before implementation. Sunshine, moonlight-web, coturn, and cua-driver were re-checked 2026-10-31 through the GitHub Releases API; Chrome is inherited from the current S5 pins.

| Component | Version | Note |
|---|---|---|
| Sunshine | v2026.914.233613 | the latest stable; only prereleases are newer. Deb `+ubuntu26.04`, an MSI for Windows |
| moonlight-web (`MrCreativ3001/moonlight-web-stream`) | v3.0.1 | linux-gnu and windows-gnu archives |
| coturn | 4.18.0 | the same as in S4 §18 |
| cua-driver (`trycua/cua`, tag `cua-driver-rs-v*`) | 0.38.0 | all releases are marked prerelease; we pin the latest non-nightly |
| Google Chrome stable (Linux) | 156.0.8078.79-1 | inherited from the Linux versions.toml; pinned in `versions.toml` at build time |
| Go modules | `github.com/jezek/xgb` and `golang.org/x/image` — the latest at implementation time | check with `go list -m -versions` |
| For comparison (§4.1) | KasmVNC 1.5.2, Selkies 2.1.0, noVNC 1.7.0, Guacamole 1.6.0, neko 3.2.0, TigerVNC 1.16.2, x11vnc 0.9.17 | not used |

## 24. Results

> Historical report predating R1; current names — `docs/specs/rename-umiak.md`.

State of 2026-10-31: `qm list` shows a running S9 Windows build in VM 598 (4096 MiB). S10 did not start VMs, did not change the firewall, templates, or CT 590. There are no desktop builds and measurements yet. SSH by IP uses the saved host key through the alias from `infra/dev-cp/README.md`.

Upstream metadata (GitHub asset digest, not the result of a local download/binary check):

| Artifact | SHA256 |
|---|---|
| [Sunshine ubuntu26.04 amd64](https://github.com/LizardByte/Sunshine/releases/tag/v2026.914.233613) `sunshine_2026.914.233613-1+ubuntu26.04_amd64.deb` | `b8a8ceeeb2b3f30a18a994ad268c94e0c91170f33a864c7aad31eed927ad7d47` |
| [moonlight-web linux x86_64](https://github.com/MrCreativ3001/moonlight-web-stream/releases/tag/v3.0.1) `moonlight-web-x86_64-unknown-linux-gnu.tar.gz` | `a46acb1f663faaff9cd97abd9671fe049dd525bfe955e95f7b9f753cc2b99f1a` |
| [cua-driver linux x86_64 binary](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0) `cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz` | `31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd` |

cua-driver 0.38.0 is the latest versioned release in the feed viewed (nightlies excluded); GitHub marks it prerelease, as already anticipated in §23. Download/hash and Sigstore verification are needed before the build. The coturn check: the latest tag `docker/4.18.0-r0`.

To be filled in during implementation: the numbers of spikes L and W (CPU, RAM, latencies, streamer start time, claim-to-ready), the chosen Windows video adapter, the cold create time of `linux-desktop` (no pool), the behavior of a second viewer, the way an active stream is detected.

## 25. Left to the implementer

- The structure of packages and interfaces in the agent, the helper, the gateway, and `api`.
- The input implementation on X11 (its own keycode rebinding or `xdotool` from the helper) and capture on Windows (`BitBlt` or DXGI).
- The exact moonlight-web and Sunshine API calls for pairing; the way an active stream is detected.
- Replacing LightDM with their own unit if the §6.6 checks pass.
- How the builder merges `extends`.
- The exact `turnserver.conf` keys (per the 4.18 documentation) and the TURN quotas from measurements.
- The timeout values (streamer start 20 s, stop after 15 min, `Act` wait 10 s) from the test results.

## 26. Master decisions and open questions

Review by the master session 2026-10-29: the spec is approved, the [S10] decisions are accepted.

1. **GPL-3.0 licenses** (Sunshine, moonlight-web) — **accepted by Ilia** (2026-10-29). Conditions: unmodified upstream binaries, links to the sources in the build manifest, use only inside the company, no distribution to third parties. Guacamole (§4.1, §17) remains only the description of an alternative.
2. **Desktop access policy — decided by the master** (2026-10-29): a separate scope `desktop`; `sso` lets in only members of the sandbox's team and operators; `public` exists but is off globally by default (`publicDesktopEnabled = false`) and is turned on by an operator (§10.2, §13.1, §16).
3. **Phase boundary — decided by the master:** the computer-use primitives are in the MVP. The edit of `docs/roadmap-phase2.md` (§2.9 D6, §4 S29, §5.2 the `computer_*` tools → S11) is made by the master.
4. **Reconciliation with the Keycloak authentication model** (S7 §7, made in parallel with S10) is a task for the implementation thread:
   - a person arrives with a Keycloak JWT, which has no scope; the `desktop` scope is checked only for the `umiak_` team keys;
   - a ticket issued from a JWT is bound to the user, not to `desktop_tickets.api_key_id`;
   - revocation on user deactivation goes through the S8 §20.1 path;
   - the error code for `public` with `publicDesktopEnabled` off must be one: §13 and the §22 checks currently say different things (`forbidden` and `route_blocked`).

5. **MVP without pools — Ilia's decision 2026-10-31:** warm and hibernated pools are excluded, including the Linux spike L; the claim ≤15 s target is dropped. Cold create: Linux up to ~1 min, Windows up to 5 min. An ordinary stop/resume stays.
6. **Network — Ilia's decision 2026-10-31:** the product is not tied to Tailscale, dev addresses only in `infra/dev-cp/`; cloudflared/ngrok/trycloudflare and external relay services are forbidden. TURN is our own, self-hosted in compose.
7. **Template slots — Ilia's decision 2026-10-31:** `linux-desktop` only `[595, 596]`, the dev-infra range 590–596; CT 590 stays. Do not change 597, 598, 599. Sandbox VMIDs 500–589; before starting check S9 and the total RAM ≤8 GB.

### S10 code pass 2026-10-31 (before pve spike)

Agent/worker/gateway/API/TS+Python SDK/CLI/MCP are implemented and verified on fakes. The Linux and Windows factories now connect the real Session/Streamer adapters; PendingStreamer remains only for an unsupported OS and explicitly unconnected test adapters. The secrets gate, OS helper bindings, private upstream state, pairing, process lifecycle, and observed viewers are implemented. Live acceptance on pve has not been done yet. Windows needs a rebase onto S9 (no merge in this pass), then checks on a real Win11.

The linux-desktop recipe now inherits Linux pins, adds pinned cosign3.1.4 for cua signature verification, and installs upstream-generated moonlight config. The release archive contains `package/web-server`; extraction strips `package/`. Sunshine/moonlight services are manual; config templates contain no credentials. Audio starts disabled pending the best-effort spike (§8.5). `linux-desktop` verification combines Linux baseline and desktop image checks; full screen/input/stream acceptance runs after real claim through `infra/dev-cp/e2e-desktop.sh`. No template build/version or latency result has been claimed yet.

### Adapter implementation choices (source-backed, 2026-10-31)

`umiak-session` is implemented as the `session --socket` subcommand of the signed
agent binary. This keeps helper and agent versions together across updates.
Its local transport is bounded HTTP/JSON over an ACL-protected AF_UNIX socket,
not a second public API; this replaces the proposed custom protobuf framing.
Linux uses X11/XTEST/XFixes directly (no xdotool/scrot dependency for API calls),
including Unicode keymap input and INCR clipboard transfers. systemd owns restarts.

Sunshine source at v2026.914.233613 has no REST session-count endpoint.
`/api/clients/list` lists paired certificates only. RTSP TCP requests are short-lived.
Linux counts recent ASSURED UDP 47999 (ENet control) conntrack flows as the primary
activity signal: the remaining TTL must be within 5 s of the guest's actual
`nf_conntrack_udp_timeout_stream`. Extended ipv4/ipv6 records are parsed by transport
token. Sunshine ENet CONNECTED/DISCONNECTED log transitions are a conservative fallback,
because a forced session end does not log DISCONNECT.
A failed observation never clears a previously active count. The agent also observes
already-running streamers after its own restart. Empty/no streamer is zero activity.

Sunshine password bootstrap uses POST/api/password and exact on-disk TLS certificate
pinning; pairing uses GET/api/pin and POST/api/pin with pairing_id. Moonlight v3.0.1
returns streamed NDJSON Pin then Paired. The proxy user umiak is a pre-created ordinary
User, cannot add hosts; only the generated private administrator manages pairing.
Source-derived wire fixtures are committed under internal/desktop/testdata/upstream;
they are not live pve recordings.

Windows implementation is based on local S9 d38ec62 (remote s9-impl was not yet
published). Its autologon/user creation stays in S9. S10 registers session and
cua-driver tasks after secrets/account readiness. Helper is the signed agent's
session subcommand; GDI, SendInput and clipboard operate in that user's console.
The upstream SunshineService owns Sunshine's console process. Moonlight runs in
an SCM wrapper under NT SERVICE\\umiak-moonlight-web. Installer overlay adds65-streamer;
Windows artifact pins are in windows/files/desktop-pins.json until the typed S9/S10
manifest integration. No Windows VM or slot598 is touched by this code-only pass.
Cua v0.38.0 defaults to stdio MCP; service/task explicitly launches serve.

The Linux Sunshine is started by the system unit `umiak-sunshine.service` with `User=user` and an explicit
session environment; the upstream user unit is disabled. This simplifies one controller
for the root agent without DBus calls into the user manager. Both Linux streamer units have
TimeoutStopSec 3. Revoke also cancels unfinished Open/pairing requests,
so that a disconnect does not wait for a 30 s HTTP handshake. The Windows Cua task starts serve
through a hidden wrapper; PowerShell 7.6.9 is pinned in mise, as in S9. The Windows POSIX
file modes are synthetic: private access is provided by the DACL and checked live.

S8 integration (2026-10-31): Desktop tab uses real SDK, fresh single-use tickets outside query cache, retry2s on desktop_not_ready, iframe/fullscreen/new-tab/access/disconnect/resume. Payload migration adds publicDesktopEnabled=false + route invalidation and desktop4gb/8gb seeds. Runtime desktop migrations moved to0401/0402 after S8 environments0400. Linux verify stops source clone before booting fork (one4GiB VM). Master permits S9≤4GiB + S10≤4GiB; total≤8GiB.

### Live Linux verification, 2026-10-31 (S10 after S8 merge)

- `linux-desktop 20261031.3`, slot596; agent0.1.0+20261031.ebe5ea8. Build704s,7.8GiB thin used. Slot595 previous failed verification build retired/deleted. Upstream pins unchanged (§24).
- `verify: linux-desktop`:109 checks,0FAIL; KVM available; first QGA9.606s, hardrestart9.441s. Sequential fork uses one4GiB VM; all clones/snapshot removed.
- Direct-agent live probe: cold clone+boot toQGA11.286s, claim→desktopready2.097s;1920x1080 screenshot, mouse/Unicode keyboard proof + pixel diff, clipboardUnicode/emoji, actual Sunshine/Moon pairing, stopstreamer; fork fresh streamercredentials and stop/resume verified. Resume desktopready1.057s. These are NOT public API create or gateway media timings.
- S8 Desktop tab implemented; Payload publicDesktopEnabled=false with route invalidation, catalog sizes4gb/8gb and verified build seeded. Worker waits actual desktop readiness on the same boot afterConfigure before create/resume finish.
- Migration0403 tracks policy revocation transition. Direct media is ended for blocked/public-disabled routes. Used grants of current ready epoch remain retained/rechecked beyond12h and1day until stop/revoke changes epoch; cleanup then removes them. Public views without ticket are covered by route monitor.
- Linux live acceptance passed on build 20261031.6 / VM 596; see "Linux live acceptance — 2026-11-01" below.

Dev TURN decision (master, 2026-11-01): CT 590 shares its address with the gateway.
Dev listener ports, TLS hostname and a narrow UDP relay range are configured only under
`infra/dev-cp`. The TLS leaf comes from the existing dev CA, with a hostname in its
permitted DNS namespace. A dedicated address with TLS 443, or SNI multiplexing, is a
production follow-up, not an MVP blocker. CT 590 RAM stays at most 6144 MiB.


Coturn Refresh policy (implementation, 2026-11-01): upstream4.18.0 intentionally
caches the password for an established allocation ([upstream REST documentation](https://github.com/coturn/coturn/blob/23c6c1d32a3d2b21a56cee65d3203bcc4ea82d2b/README.turnserver)). To satisfy expiry-on-Refresh, compose builds the same pinned source with
`deploy/compose/turn/refresh-auth.patch`: clear the cached key on the first Refresh
pass and use the existing async credential callback; preserve it on the resumed
pass. Source commit/archive SHA256 and patch are pinned in Dockerfile; no new auth
algorithm. Live wire regression: original expired Refresh succeeds (RED), patched
image rejects it while valid Refresh and UDP/TCP/TLS allocation succeed (GREEN).
This intentionally tightens upstream's session policy; API and TURN credential
format/TTL remain unchanged.


TURN channel compatibility (live, 2026-11-01): the pinned rtc-turn 0.21.1 from
moonlight-web 3.0.1 deletes the binding on 438 and creates a new channel number for the same
peer; coturn rightly answers 400. Confirmed by a live break after 10 min and by an
isolated wire fixture with nonce TTL 2 s (the same 400 after 3 s). For this version the
standard `stale-nonce=0` was chosen. The repeated HMAC/REST timestamp check of every Refresh
is kept by the patch; it does not disable the credential expiry. Nonce rotation can be restored
after the fixed upstream rtc-turn is updated and a long-idle acceptance is repeated.


TURN reconnect sizing (live, 2026-11-01): normal browser ICE allocations and leftovers of the
previous Moon peer on reconnect exhausted the initial user-quota 4 (486; there was no relay
candidate on the VM). A wire fixture with 6 simultaneous allocations of the same
REST principal reproduces 486. By measurement user-quota 16 and
max-allocate-lifetime 60 s were chosen: closed UDP allocations are freed within 1 min at most,
active ones are refreshed every ~30 s. rtc-turn 0.21.1 honors the issued LIFETIME.
Checked: 6 allocations, LIFETIME ≤ 60, valid/expired Refresh, peer 403, and UDP/TCP/TLS.
The 400 quota and per-session bandwidth remain; the peer allowlist was not widened.


### Linux live acceptance — 2026-11-01

Immutable `linux-desktop 20261031.6`, VM 596, agent `0.1.0+20261031.4865e13`.

- Clean recipe build 676 s, 7.8 GiB; `verify: linux-desktop` 109 checks, 0 FAIL;
  first QGA 9.9 s, hard-restart QGA 12.3 s.
- Public cold create (API to `running` with desktop ready): 18.4 s and 14.4 s on two runs.
- All MCP `computer_*` tools and `desktop_url` work against the real API; the
  "desktop unsupported" fallback is not used when the capability is advertised.
- PNG screenshot with cursor, Unicode keyboard proof, clipboard round-trip, WebSocket
  media and forced relay-to-relay WebRTC over UDP, TCP and TLS TURN: changed frames.
- 30 min hold with an open viewer and no API calls: 176 samples, `desktopStreams >= 1`,
  all other activity counters 0, last API call 1830 s ago; frames still change after the hold.
- Idle-stop with `idle_timeout = 60 s`: stopped 78.1 s after an explicit end-streams,
  98.8 s after a natural page close without EndStreams.
- Fork gets fresh streamer credentials; stop/resume with screenshot; old desktop
  cookie returns 401 after resume; delete cleans up clones and snapshots.
- After the runs only VM 596 remains in the S10 slots; 595 and all clones are removed.

The S8 Desktop tab and S11 API contract are unchanged by the live fixes.
Open: Windows desktop (§8) after S9; production TURN on TLS 443 (dedicated address or
SNI). Audio stays disabled; performance, glass-to-glass latency and multi-viewer
behaviour are not characterised by this acceptance.


### Windows desktop — implementation decisions (2026-11-01, after the S9 merge)

- **A separate template `windows-desktop`** (`extends: windows`, slot **595**), the master's decision
  2026-11-01. The `windows` template (598) stays headless and unchanged; §7 "S10 adds to
  `60-desktop`" is replaced by a separate step `65-streamer` of the child recipe (the shared
  `_windows` steps are unchanged). `linux-desktop` now takes one slot **596**; as with
  `windows`, rebuilding a single slot requires retiring the old template first.
- **The `agent.toml`** of the desktop recipe is rendered by `umiak-tpl` (`isDesktopRecipe`): `[desktop] enabled`,
  the `desktop` phase in `[readiness] required`, the streamer ports in `[ports] exclude`. The installer
  `desktop-install.ps1` no longer edits `agent.toml` with regular expressions.
- **Windows artifact pins** (Sunshine MSI, moonlight-web zip, cua-driver zip, cosign) are in
  `windows/files/desktop-pins.json` with sha256; cua-driver is additionally verified by
  `cosign verify-blob`. Moving to a typed `versions.toml [desktop]` for Windows is a follow-up.
- **Edge**: policies `HideFirstRunExperience`, `BrowserSignin=0`, `SyncDisabled`,
  `DefaultBrowserSettingEnabled=0`, no promos and recommendations.
- **Verify `windows-desktop`**: the whole base `windows/verify.ps1` plus the `desktop` group
  (streamer files, services Manual/Stopped and the account `NT SERVICE\umiak-moonlight-web`,
  the moonlight-web template on loopback without STUN, `agent.toml`, no streamer listeners before Open,
  Edge policies). The group is inserted before `# --- main ---` and registered through
  `$UmiakExtraGroups`; only this hook was added to `windows/verify.ps1`.
- **Activity on Windows**: there is no conntrack, and the Sunshine log does not write DISCONNECT on a
  forced termination. The main flag is the UDP sockets of the moonlight-web process
  (`web-server.exe`, `GetExtendedUdpTable` with the owner): there is an ENet channel to Sunshine for every
  stream with any browser transport, and without a stream moonlight-web has no UDP sockets. The number of
  streams is not determined, the agent reports `desktopStreams = 1` when sockets exist.
  A sampling error falls back to the Sunshine log (conservatively).
- **Session**: `register-session.ps1` registers the tasks `\umiak\session` and `\umiak\cua-driver`
  (Interactive, `user`, trigger AtLogOn) at every agent start; a start right away only if
  `user` is already logged in, otherwise the autologon trigger starts them.
- **Video (spike W, §19.2)**: `hw.vga: std` (Microsoft Basic Display Adapter), without changing the
  adapter. Its mode is set by the OVMF GOP, by default 1280×800, and `ChangeDisplaySettingsEx`
  does not change it. The step `65-streamer` writes the OVMF NVRAM variable `PlatformConfig`
  (GUID `7235c51c-…`, 1920×1080) into the efidisk of the build VM; the efidisk is copied into the template and clones,
  so every boot goes straight to 1920×1080. Verified on a clone: Basic Display Adapter
  1920×1080, the API screenshot 1920×1080, Sunshine `ddx` capture works. `vga: virtio` + `viogpudo`
  was tried and rejected: the driver takes the same 1280×800 mode, and changing the mode from the session
  hung. Verify checks `desktop_display` (1920×1080).
- **ACLs on Windows**: `icacls <dir> /inheritance:r /grant:r <sid>:(OI)(CI)F /T` leaves
  the files inside with an empty DACL (the inheritance flags for files are dropped), and even SYSTEM
  cannot read them. The agent and installer set inheritable rights only on the directory,
  the children are reset to inheritance (`icacls <child> /reset /T`).
- **Streamer start on Windows**: before listening Sunshine tests the encoders, the first
  `Open` takes ~16–20 s; the gateway meanwhile answers a retryable `503 desktop_starting`,
  the Desktop tab and `e2e-desktop.ts` retry with a fresh ticket after 2 s.
- The moonlight-web log on Windows: `state\desktop-moonlight\web-server.log` (the current run) and `web-server.log.1` (the previous one, s10-followups).

### Windows live acceptance — 2026-11-01

`windows-desktop 20261101.1`, VM 595, agent `0.1.0+20261101.a17c0d7b`, `hw.vga: std` +
OVMF `PlatformConfig` 1920×1080.

- The build took 31.8 min (build + the first verify), disk 17.1 GiB. `verify: windows-desktop`:
  110 checks, 0 FAIL (the S9 base profile + the `desktop` group, including `desktop_display`).
  The first verify of this build was interrupted by a QGA loss on the fork right after agent readiness
  (the S9 rename reboot, R16); a repeated `umiak-tpl verify` passed completely.
  In build 3 the same step passed the first time.
- A public cold create to `ready` with the `desktop` phase: 139 s and 146 s (the limit is 5 min).
  The first streamer opening: 22 s (the Sunshine encoder test), later ones < 1 s.
- A 1920×1080 screenshot, mouse and keyboard input changes the frame, Unicode text (Cyrillic and CJK) through
  `KEYEVENTF_UNICODE` in the Run window reaches pwsh, the clipboard there and back.
- All the MCP `computer_*` and `desktop_url` against the real API.
- A stream through the CT 590 gateway: WebSocket and relay↔relay WebRTC through TURN over UDP, TCP, and TLS,
  changing frames, once more after a hold.
- Holding a viewer for 3 min with no API calls: `desktopStreams = 1` for the whole interval (moonlight-web
  UDP sockets), the sandbox is not stopped. After the page was closed naturally, idle-stop
  (`idle_timeout = 60 s`) after 105 s.
- A fork gets new streamer credentials; stop/resume — desktop ready; the old cookie — 401;
  deletion cleans everything. The guest VM goes to TURN only over UDP 3478, TCP/TLS are closed.
- The Linux regression with the same scenario after the e2e edits: green, create 17.9 s.

Not claimed for Windows: a 30-minute hold (3 min checked; on Linux — 30 min),
performance and latency, several viewers, sound.

### Windows desktop after the rule fork/snapshot only from a stopped VM (2026-11-01)

A rebase onto `main` `743f112` (S9 §24.8–24.9, S6 §7.8–7.9, migration `0208`) without conflicts;
the S10 runtime migrations stay 0401–0403 and come after 0208.

- **Fork of a Windows desktop.** A running `windows-desktop` without `forceStop` →
  `409 snapshot_requires_stop` (checked live). A fork from a cleanly stopped source
  passes; the fork has new streamer credentials, a 1920×1080 screenshot, and all the MCP `computer_*` work
  on the fork. `forceStop` reuses the worker's `stopSteps`, so `authEpoch` grows and
  the source viewers' links are revoked; the source restart goes through `deliverProvision`
  with `Desktop/Configure` and waiting for the `desktop` phase. A live `forceStop` run for the desktop
  was not done: the source and the fork at the same time are 8 GB against the S10 budget of 4 GB; the common path
  was checked by S9 on template 598.
- **Desktop size after a reboot.** A live check found that on 20261101.1
  only a clone's first boot gave 1920×1080, while resume and fork gave the saved Windows
  1280×800, stretched to the 1920×1080 mode (`GraphicsDrivers\Configuration`, saved
  at build time before `PlatformConfig` was written). `65-streamer` now clears `Configuration` and
  `Connectivity`; the following boots of the build keep 1920×1080. Verify checks the
  saved size too, e2e a screenshot after resume and on the fork.
- **Build `windows-desktop 20261101.2`**, VM 595, agent `0.1.0+20261101.cbddbf59`:
  38 min with the whole verify, 16.5 GiB, verify 110 checks, 0 FAIL. Live on CT 590: create
  198 s, the first stream opening 22 s, WebSocket and relay UDP/TCP/TLS, the fork rule,
  `computer_*` on the fork, resume 1920×1080, cookie revocation, deletion — PASS.
- An observation: once on 20261101.1 an ordinary stop right after create did not finish within 300 s
  (hard stop, `clean_stop = false`, then fork → `snapshot_requires_clean_stop`). On
  20261101.2 the same scenario was clean in 39 s and could not be repeated. If it repeats —
  `forceStop` after resume or a repeated stop (the API message suggests this).

### Acceptance fixes s10-fix (2026-11-01)

The master's independent acceptance found 12 remarks; the rules are recorded in the sections above (marked s10-fix).

- **Operator block (H1).** The desktop endpoints that control the guest check the block like `exec` (§13.2). Live on CT 590 (`desktop-block-probe.ts`, `windows-desktop`): after the block, `exec`, `POST /actions`, `PUT /clipboard`, `POST /links`, `PUT /access` → `403 sandbox_blocked`; a screenshot is allowed; `authEpoch` 1→2, `EndStreams` done, the viewer's old cookie → 403; after unblocking the actions work again. MCP `computer_*` shows an error with the hint "do not retry".
- **TURN and ports of its own address (M3).** The table `inet umiak_turn` (§9.2). Live `verify-turn.py`: relay↔relay to a UDP, TCP, and TLS client works; a Send indication to `192.168.68.90:40123` and `:41641` does not arrive, the drop counter grows. Control: without the table the same probe reaches the listener `:40123` (`received 14`). turnserver runs as uid 3478 with only `CAP_NET_BIND_SERVICE`.
- **Screenshots in the request cache (M1).** Live (`desktop-cache-probe.ts`, `linux-desktop 20261101.2`): after 22 `Act` calls with 1920×1080 screenshots there are 0 PNG signatures in `state.db`, `-wal`, `-shm`; a repeat with the same `Idempotency-Key` returns the stored result and a fresh screenshot.
- **The `desktop-turn` controller (M2).** An error of one sandbox is logged and does not interrupt the others; the order is old credentials first, `id`; a batch of up to 100.
- **Quota with `forceStop` (B3).** The count was correct: the running source is already counted once, the fork adds its own size. With a quota of 6144 MB a 4 GB fork of a 4 GB source really does not fit (both run after the fork). The message now names what is used, what is requested, and the `forceStop` rule: `quota 'maxRamMb' exceeded (4096 MB in use + 4096 MB requested > limit 6144 MB); the source restarts after a forceStop fork…`, `details.requested`. Test: with a quota of 8192 the forced fork passes.
- **Windows SendInput (B2).** The cause by code: `SendInput` returns 0 inserted events (`ERROR_ACCESS_DENIED`) while the input desktop is not `Default` — a short login transition on a fresh fork after the S9 rename. The original error was not reproduced; the helper now repeats only the uninserted events for up to 2 s (§12.2) and names the input desktop in the error. Three full Windows `e2e-desktop` runs in a row on `20261101.3` without `action_failed`.
- **Streamer and idle (items 8–9).** Auto-stop after 15 min without a viewer and the 2 min window for observation errors (§8.4, §11.4), unit tests with controlled clocks. A long live check of 15 min was not done.
- **Streamer credentials (item 11).** Separate secrets and the moonlight-web administrator before the first start (§8.3); live: pairing and the stream pass on the new builds (`e2e-desktop`). coturn: `no-software-attribute`, `no-cli`.
- **CLI (item 10)** — §14.2; **migrations (item 12)** — `0401–0404` in the S8 block, `docs/roadmap.md`.
- **e2e on a Linux fork (B1).** The MCP keyboard check opens and focuses its own terminal on the fork.

Builds: `linux-desktop 20261101.2` (VM 596, verify 109 checks, 0 FAIL; the first verify attempt failed on the clone's `qmstop` by a VM lock after a hard restart — verify now retries the stop through `retryOnVmLock`, like the Windows verify), `windows-desktop 20261101.3` (VM 595, verify 110 checks, 0 FAIL), agent `0.1.0+20261101.fabc0b94`.

Live on CT 590 (`s10-fix`): Linux `e2e-desktop` fully green — create 17.3 s, the first stream opening 1.1 s, WebSocket and relay↔relay WebRTC UDP, MCP `computer_*` on the source and on the fork, stop/resume, cookie revocation. Windows `e2e-desktop` — three runs in a row green (43 checks each): create 187 s, 153 s, 123 s; the first stream opening ~22 s.

### Acceptance fixes s10-fix2 (2026-11-01)

The master's second independent acceptance accepted H1, M1, M2, B1–B3 and items 8–12 and found S1, S2, W1, N1, N2.

- **S1, S2 — TURN (§9.2).** coturn was moved into its own network namespace (the compose network `turn`): the TURN address is on `lo` inside, only 3478/udp, 3478/tcp, and TLS are published outward; on the host network the entrypoint refuses to start. The relay ports are 61000–65535 (dev 61000–61040), above `ip_local_port_range`, reserved by sysctl in the TURN namespace; an overlap is a start refusal. The entrypoint stays init and every 2 s compares the table `inet umiak_turn` with the one installed; on deletion or change init exits, turnserver dies together with the PID namespace, compose restarts it with a new table; the healthcheck does the same check. On CT 590 `nftables.conf` has no `flush ruleset` (`infra/dev-cp/README.md`).
  Live (`verify-turn.py`, `UMIAK_TURN_PROBE_GUARD=1`): relay↔relay to a UDP/TCP/TLS client works; host UDP listeners on `192.168.68.90:40123` and `:61039` (inside the relay range) receive nothing, `:41641` too, the drop counter grows; after `docker exec … nft delete table inet umiak_turn` relay stopped working after 0.5 s and recovered with the table after 2.7 s; `systemctl reload nftables` on CT 590 does not restart TURN and does not break port publishing. Forbidden peers (8.8.8.8, LAN, the VM network) — 403.
- **N1.** Lifting a policy ban (block, public) also raises `authEpoch` (§13.2); test: a ticket recorded with the block's epoch is not exchanged after unblocking.
- **N2.** `ctl-desktop-turn` marks an attempt (`turn_attempted_at`, migration `0405`) and picks the not-yet-tried first, then the oldest attempts: a full batch of unreachable guests no longer blocks the others; a test with a batch of 1.
- **W1 — Windows e2e.**
  - *Run A* (text did not arrive): Start opened at the moment Run was launched through `explorer.exe shell:::` on a fresh login and took the focus. The test now opens Run with a task in the `user` session, finds the input field (`FindWindow` + `GetWindowRect`, foreground rights are not needed), clicks into it twice with real input (the first click may only close Start), selects and types; success is judged by a proof file, up to 3 attempts with `Escape` between them (`apps/mcp/test/windows-run.ts`, shared by e2e and the MCP check). Verified with Start forced open. The product: desktop readiness is not delayed until the shell finishes its work after the first login — Start and toasts ("Searching for Display Driver" with the Basic Display Adapter) may appear later; computer-use agents, like the test, must focus a window by clicking and not rely on focus.
  - *Run B* (a black websocket viewer): the browser had not a single decoded frame, while Sunshine encoded 177 frames with 8 I-frames in 8 s (normally 2–4 — the client asked for IDR again). Not reproduced: 3 in a row on a warm VM, 3 after stop/resume, 7 full Windows `e2e-desktop` runs in a row (the last 4 on `s10-fix2` with the new TURN: 43 checks each, create 119–129 s, the first stream opening 24–27 s, the first WebSocket/WebRTC frame after 150–215 ms, Run on the first attempt). The cause is not established; a product bug is not proven. The test now distinguishes "no picture" (waits for the first frame up to 30 s) from "the frame did not change", changes the frame by moving the cursor (earlier — only by typing text, which is visible only with focus), and on a failure saves the browser console and the moonlight-web `web-server.log`.

Live on CT 590 (`s10-fix2`): `e2e.sh` 20/20, Linux `e2e-desktop` green (44 checks), Windows `e2e-desktop` 4 in a row green; pve after the runs — only templates.

### Follow-ups s10-followups (2026-11-02)

- **W1-B — a black WebSocket on Windows.** The cause and fix are in §8.6. Reproduction before the fix: on template `20261101.3` the very first Windows `e2e-desktop` is black, the probe `desktop-media-probe.ts` — 1 of 4 openings black on a warm VM. With the patched `web-server.exe` on the same VM — 18 of 18 with a picture; in the Sunshine log the video ping is first every time and from the video socket port, the audio ping ~25 ms later from another port. Build `windows-desktop 20261101.6` (VM 595, agent `0.1.0+20261101.b84f61b8`, verify 112 checks, 0 FAIL, including `desktop_moonlight_patch`). Windows `e2e-desktop` on `20261101.6`: 6 of 6 in a row green (44 checks each; create 117–130 s, the first stream opening 22–23 s, the first WebSocket frame after 148–174 ms, exactly one key frame per opening, Run on the first attempt; `pve` load during the build and runs 6–27). Linux `e2e-desktop` green (44 checks), `e2e.sh` 20/20.
- **The window after unblocking (§13.2).** `unblockSandbox` sends `umiak_identity 'sandboxes:<id>'`, and the access monitor fires at once. Until `policy_revoked` is cleared, the desktop route is considered blocked (`blockReason = policy_revoked`): ticket exchange, `open`, and the cookie are refused. Lifting a ban sets `pending_disconnect`, so a stream from the window (if there were one) is ended. Test: a ticket with the block's epoch right after unblocking — 401 (before the fix 200). Live (`desktop-block-probe.ts`): 403 right after unblocking without NOTIFY, the monitor raised the epoch and ended the streams, a fresh link opens.
- **The rename reboot after claim (S9 §11.2 item 8).** `rebootBoot` in `identity.json`: a boot that asked for a reboot does not become ready and asks for it again at every agent restart. The agent and `ident` tests fail on the old code (on the fourth start of the same boot the agent went on without a reboot) and pass on the new one. Live: every Windows `e2e-desktop` checks that the event 1074 "umiak identity changed" was before ready and `LastBootUpTime` did not change after claim. A slow reboot under load was not reproduced artificially.
- **TURN.** The watchdog and healthcheck check the TURN address on `lo` (§9.2). Live on CT 590: `ip addr del` in the TURN namespace → the healthcheck is 1 at once, init exited, the container restarted after 1.7 s with the address, `healthy`. The allocation's self-denial on a send to a forbidden port is documented (§9.2).
