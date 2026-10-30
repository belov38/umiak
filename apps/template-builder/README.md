# template-builder (`sbx-tpl`)

Builds Proxmox VM templates from the recipes in `infra/templates/` (spec: `docs/specs/s5-linux-template.md`).

## Image notes

Auto-update of the coding-agent CLIs is off through each vendor's system-wide config
(`infra/templates/linux/files/etc/`, installed by `40-coding-agents`). Versions change with a new
template build; a user can still update a CLI with `sudo`.

| CLI | File | Setting | Source |
|---|---|---|---|
| Claude Code | `/etc/claude-code/managed-settings.json` | `env.DISABLE_AUTOUPDATER = "1"` | code.claude.com docs (setup, managed settings) |
| Gemini CLI | `/etc/gemini-cli/settings.json` | `general.enableAutoUpdate`, `general.enableAutoUpdateNotification` = `false` | `docs/reference/configuration.md` in the npm package |
| OpenCode | `/etc/opencode/opencode.json` | `autoupdate: false` | opencode.ai/docs/config (managed config dir `/etc/opencode`) |
| Codex | `/etc/codex/config.toml` | `check_for_update_on_startup = false` | `codex-rs/core/config.schema.json` in openai/codex; system config path from the Codex docs |

All four have a system-wide switch. Not verified in a running image yet (Task 12): that OpenCode
reads `opencode.json` from `/etc/opencode` and Codex reads `/etc/codex/config.toml` at the pinned
versions; both paths are present in the release binaries.
