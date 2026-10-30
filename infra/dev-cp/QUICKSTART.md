# Быстрый старт: dev-стенд sbx

Стенд работает в CT 590 на `pve`. С Mac он доступен через tailnet; VPN и прочие туннели не нужны.

| Что | Адрес |
|---|---|
| API (CLI, SDK) | `https://sbx-dev-cp.tail0000.ts.net:8443` |
| Дашборд (S8 ещё нет; сейчас вход и `/api/v1/me`) | `https://sbx-dev-cp.tail0000.ts.net:8443/` |
| Keycloak (смена пароля, админка `/admin`) | `https://sbx-dev-cp.tail0000.ts.net:10000/` |
| Превью портов | `https://<slug>-<port>.sbx.100-64-10-7.sslip.io` |
| SSH | `ssh -p 2222 <slug>@sbx-dev-cp.tail0000.ts.net` |

## Вход

Логин — `ilia@example.com`. Временный пароль лежит в `~/.config/sbx/dev-cp/ilia-initial-password`; при первом входе Keycloak попросит задать свой. Команда — личная, роль owner.

```sh
pnpm --filter @sbx/cli build            # один раз: apps/cli/dist/sbx-darwin-arm64
alias sbx="$PWD/apps/cli/dist/sbx-darwin-arm64"

sbx login --api-url https://sbx-dev-cp.tail0000.ts.net:8443
sbx whoami
```

`sbx login` откроет браузер со страницей Keycloak: войти, подтвердить код и доступ. Токены хранятся в Keychain.

В браузере: `https://sbx-dev-cp.tail0000.ts.net:8443/api/v1/me` → вход в Keycloak → JSON с пользователем. Дашборд появится вместе с S8.

## Sandbox

```sh
sbx create --wait                       # Linux 2 GB, готова за ~15 s; печатает slug
sbx exec <slug> -- uname -a
sbx shell <slug>                        # терминал
sbx cp ./file <slug>:file               # и обратно: sbx cp <slug>:file ./file; каталог: -r
sbx stop <slug> / sbx resume <slug> --wait
sbx fork <slug> --wait
sbx snapshot save <slug> my-snap ; sbx create --from my-snap --wait
sbx rm <slug> --yes
```

Без активности sandbox останавливается сама через 15 min (`--idle` у `create`), `sbx resume` её поднимает. Лимит стенда: 3 активные sandbox на команду, но на `pve` одновременно держим не больше двух (2 × 2 GB).

## Превью порта

```sh
sbx exec <slug> --detach -- python3 -m http.server 3000
sbx port <slug> 3000                    # token: печатает ссылку с ?_token=...
sbx port <slug> 3000 --sso              # вход через Keycloak
sbx port <slug> 3000 --public           # без авторизации
```

Сертификат превью выпущен dev CA. Чтобы браузер ему доверял, один раз:

```sh
infra/dev-cp/trust-mac.sh               # добавляет CA в login keychain (спросит пароль macOS)
infra/dev-cp/trust-mac.sh --remove
```

Без этого — `curl --cacert ~/.config/sbx/dev-ca/ca.pem <url>`.

## SSH

```sh
sbx ssh <slug>                          # короткий сертификат, ключ не нужен
sbx ssh-keys add ~/.ssh/id_ed25519.pub  # для обычного ssh
ssh -p 2222 <slug>@sbx-dev-cp.tail0000.ts.net
sbx ssh-config <slug> >> ~/.ssh/config  # для VS Code Remote-SSH
```

Host key gateway CLI кладёт в `~/.config/sbx/known_hosts`; для обычного ssh при первом входе подтвердить отпечаток или взять строки оттуда.

## Если что-то не так

- Проверить стенд целиком: `infra/dev-cp/e2e.sh` (~10 min, своя учётка `e2e@example.com`, за собой убирает).
- Перевыкатить: `infra/dev-cp/deploy.sh`. Пользователи: `infra/dev-cp/dev-users.sh`.
- Логи: `ssh sbx@192.168.68.90`, `cd ~/boat-dev-clone/deploy/compose && docker compose logs -f api worker gateway`.
- Подробности: `infra/dev-cp/README.md`.
