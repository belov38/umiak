# Быстрый старт: dev-стенд Umiak

Стенд работает в CT 590 на `pve`. С Mac dashboard, API и MCP доступны по LAN HTTP без входа (режим none).

| Что | Адрес |
|---|---|
| API (CLI, SDK) | `http://192.168.68.90:8080` |
| Дашборд | `http://192.168.68.90:4180/app` |
| MCP | `http://192.168.68.90:4180/mcp` |
| Превью портов | `https://<slug>-<port>.umiak.100-64-10-7.sslip.io` |
| SSH | `ssh -p 2222 <slug>@umiak-dev-cp.tail0000.ts.net` |

## Вход

Логин и OAuth-токены не нужны. Все разрешённые LAN-клиенты имеют полный контроль.

```sh
mise exec -- pnpm --filter @umiak/cli build
alias umiak="$PWD/apps/cli/dist/umiak-darwin-arm64"
umiak login --api-url http://192.168.68.90:8080
umiak whoami
```

В браузере: `http://192.168.68.90:4180/app`; операторская панель — `/admin`.

Переключение и откат с Mac:

```sh
UMIAK_DEVCP_AUTH_MODE=oidc mise exec -- bash infra/dev-cp/deploy.sh
```

После OIDC-отката dashboard/API снова доступны через
`https://umiak-dev-cp.tail0000.ts.net:8443`, Keycloak — `:10000`.
Сертификаты gateway и CA не меняются; Keycloak volume сохраняется.

## Sandbox

```sh
umiak create --wait                       # Linux 2 GB, готова за ~15 s; печатает slug
umiak exec <slug> -- uname -a
umiak shell <slug>                        # терминал
umiak cp ./file <slug>:file               # и обратно: umiak cp <slug>:file ./file; каталог: -r
umiak stop <slug> --wait
umiak resume <slug> --wait
umiak fork <slug> --wait
umiak snapshot save <slug> my-snap --wait
umiak create --from my-snap --wait
umiak rm <slug> --yes
```

Без активности sandbox останавливается сама через 15 min (`--idle` у `create`), `umiak resume` её поднимает. Лимит стенда: 3 активные sandbox на команду, общий предел sandbox RAM на `pve` — 8 GB. При проверках запускайте VM последовательно; перед fork остановите источник.

## Превью порта

```sh
umiak exec <slug> --detach -- python3 -m http.server 3000
umiak port <slug> 3000                    # token: печатает ссылку с ?_token=...
# sso недоступен в none; используйте token или public
umiak port <slug> 3000 --public           # без авторизации
```

Сертификат превью выпущен dev CA. Чтобы браузер ему доверял, один раз:

```sh
infra/dev-cp/trust-mac.sh               # добавляет CA в login keychain (спросит пароль macOS)
infra/dev-cp/trust-mac.sh --remove
```

Без этого — `curl --cacert ~/.config/umiak/dev-ca/ca.pem <url>`.

## SSH

```sh
umiak ssh <slug>                          # короткий сертификат, ключ не нужен
umiak ssh-keys add ~/.ssh/id_ed25519.pub  # для обычного ssh
ssh -p 2222 <slug>@umiak-dev-cp.tail0000.ts.net
umiak ssh-config <slug> >> ~/.ssh/config  # для VS Code Remote-SSH
```

Host key gateway CLI кладёт в `~/.config/umiak/known_hosts`; для обычного ssh при первом входе подтвердить отпечаток или взять строки оттуда.

## Если что-то не так

- Проверить стенд целиком: `mise exec -- bash infra/dev-cp/e2e.sh` (~4 мин, локальная команда, за собой убирает).
- Перевыкатить в OIDC: `UMIAK_DEVCP_AUTH_MODE=oidc mise exec -- bash infra/dev-cp/deploy.sh`. Пользователи Keycloak нужны только после OIDC-отката.
- Логи: `ssh umiak@192.168.68.90`, `cd ~/umiak/deploy/compose && docker compose logs -f api worker gateway`.
- Подробности: `infra/dev-cp/README.md`.
