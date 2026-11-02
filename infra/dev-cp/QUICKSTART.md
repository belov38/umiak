# Быстрый старт: dev-стенд Umiak

Стенд работает в CT 590 на `pve`. С Mac он доступен через tailnet; VPN и прочие туннели не нужны.

| Что | Адрес |
|---|---|
| API (CLI, SDK) | `https://umiak-dev-cp.tail0000.ts.net:8443` |
| Дашборд | `https://umiak-dev-cp.tail0000.ts.net:8443/app` |
| Keycloak (смена пароля, админка `/admin`) | `https://umiak-dev-cp.tail0000.ts.net:10000/` |
| Превью портов | `https://<slug>-<port>.umiak.100-64-10-7.sslip.io` |
| SSH | `ssh -p 2222 <slug>@umiak-dev-cp.tail0000.ts.net` |

## Вход

Логин — `ilia@example.com`. Временный пароль лежит в `~/.config/umiak/dev-cp/ilia-initial-password`; при первом входе Keycloak попросит задать свой. Команда — личная, роль owner.

```sh
pnpm --filter @umiak/cli build            # один раз: apps/cli/dist/umiak-darwin-arm64
alias umiak="$PWD/apps/cli/dist/umiak-darwin-arm64"

umiak login --api-url https://umiak-dev-cp.tail0000.ts.net:8443
umiak whoami
```

`umiak login` откроет браузер со страницей Keycloak: войти, подтвердить код и доступ. Токены хранятся в Keychain.

В браузере: `https://umiak-dev-cp.tail0000.ts.net:8443/app` → вход в Keycloak → дашборд личной команды (sandbox, снапшоты, ключи, окружения).

## Sandbox

```sh
umiak create --wait                       # Linux 2 GB, готова за ~15 s; печатает slug
umiak exec <slug> -- uname -a
umiak shell <slug>                        # терминал
umiak cp ./file <slug>:file               # и обратно: umiak cp <slug>:file ./file; каталог: -r
umiak stop <slug> / umiak resume <slug> --wait
umiak fork <slug> --wait
umiak snapshot save <slug> my-snap --wait ; umiak create --from my-snap --wait
umiak rm <slug> --yes
```

Без активности sandbox останавливается сама через 15 min (`--idle` у `create`), `umiak resume` её поднимает. Лимит стенда: 3 активные sandbox на команду, но на `pve` одновременно держим не больше двух (2 × 2 GB).

## Превью порта

```sh
umiak exec <slug> --detach -- python3 -m http.server 3000
umiak port <slug> 3000                    # token: печатает ссылку с ?_token=...
umiak port <slug> 3000 --sso              # вход через Keycloak
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

- Проверить стенд целиком: `infra/dev-cp/e2e.sh` (~5 мин, своя учётка `e2e@example.com`, за собой убирает).
- Перевыкатить: `infra/dev-cp/deploy.sh`. Пользователи: `infra/dev-cp/dev-users.sh`.
- Логи: `ssh umiak@192.168.68.90`, `cd ~/umiak/deploy/compose && docker compose logs -f api worker gateway`.
- Подробности: `infra/dev-cp/README.md`.
