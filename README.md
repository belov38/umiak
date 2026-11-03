# Umiak

Self-hosted платформа API-управляемых VM-sandbox для AI-агентов на Proxmox VE (аналог boat.dev). Guest templates: Linux (`linux`), Linux with desktop (`linux-desktop`), Windows 11 with desktop (`windows`). Windows Server Core is planned.

- С чего начать: [docs/getting-started.md](docs/getting-started.md)
- Архитектура: [docs/architecture.md](docs/architecture.md)
- Области работ и статус: [docs/roadmap.md](docs/roadmap.md)
- Спецификации: `docs/specs/`

## Windows template

Windows 11 uses the single `windows` template and includes the desktop (4gb by default; 8gb optional). Linux offers `linux` and `linux-desktop`. The legacy `windows-desktop` slug remains an input alias of `windows`; API responses return `windows`. Existing headless Windows sandboxes and saved snapshots retain their retired build until deleted.
