# Gateway (S4) в локальном стеке

`gateway.yaml` добавляет к стеку из `compose.yaml` два сервиса:

- `gateway-secrets` — одноразовый, создаёт недостающие dev-секреты в `deploy/compose/secrets/gateway/`;
- `gateway` — образ `sbx-gateway:dev` из `services/gateway/Dockerfile`.

Кроме того, он дописывает в `worker` токен для внутреннего listener-а gateway.

## Подключение

`compose.yaml` включает `gateway.yaml` (`include: [gateway.yaml]` в начале), поэтому gateway поднимается
обычной командой:

```sh
docker compose -f deploy/compose/compose.yaml up -d --build
```

`secrets-init` зависит от `gateway-secrets`: токены `api`, login CA и host keys берутся из
`secrets/gateway/`. Сеть `sbx` объявлена в обоих файлах, конфликта нет: compose сливает объявления.
Дополнение сервиса `worker` тоже применяется. `gateway.yaml` можно использовать и отдельно, слоем `-f`
поверх `compose.yaml` без `include`.

```sh
docker compose -f deploy/compose/compose.yaml ps -a
# gateway-secrets: Exited (0), gateway: healthy
curl -i http://127.0.0.1:9190/readyz     # 200 ok
curl -s http://127.0.0.1:9190/metrics | grep '^sbx_gateway' | head
```

## Порты (только 127.0.0.1)

| Хост | Контейнер | Что | Переменная в `deploy/compose/.env` |
|---|---|---|---|
| 8443 | 8443 | TLS: `*.sbx.localhost` и `tunnel.localhost` (по SNI) | `GATEWAY_HTTPS_PORT` |
| 2222 | 2222 | SSH | `GATEWAY_SSH_PORT` |
| 7000 | 7000 | внутренний listener (peer, worker, api); для отладки | `GATEWAY_INTERNAL_PORT` |
| 9190 | 9090 | `/metrics`, `/healthz`, `/readyz` (9090 на хосте занят worker-ом) | `GATEWAY_METRICS_PORT` |

На macOS порт 7000 слушает AirPlay Receiver (`*:7000`). Публикация на `127.0.0.1:7000` при этом работает,
но если Docker не сможет его занять, поменяйте `GATEWAY_INTERNAL_PORT`.

## Секреты

`gateway-secrets` запускает `sbx-gateway dev-secrets -dir /secrets`. Каталог `deploy/compose/secrets/`
в `.gitignore`. Команда создаёт только отсутствующие файлы, поэтому её можно запускать на каждом `up`.
Исключение — два производных файла: `login-ca-keys` (из `ssh_login_ca`) и `worker-gateway-token`
(из `service-tokens.json`). Их команда переписывает, если они разошлись с источником.

| Файл | Права | Назначение |
|---|---|---|
| `ca.pem`, `ca.key` | 644 / 600 | dev CA. Ограничен name constraints: подписывает только `sbx.localhost`, `tunnel.localhost`, `ssh.localhost` и их поддомены |
| `sbx.pem`, `sbx.key` | 644 / 600 | сертификат `*.sbx.localhost` и `sbx.localhost` (397 дней) |
| `tunnel.pem`, `tunnel.key` | 644 / 600 | сертификат `tunnel.localhost` для агентов |
| `cookie-keys` | 600 | ключ cookie портов, `k1:<base64 32 байта>` |
| `ssh_host_ed25519_key`, `ssh_host_ecdsa_key` (+ `.pub`) | 600 / 644 | host keys SSH-gateway |
| `ssh_user_ca` (+ `.pub`) | 600 / 644 | CA, которым gateway подписывает сертификаты для sshd в VM. `.pub` нужен шаблону VM (`TrustedUserCAKeys`) |
| `ssh_login_ca` (+ `.pub`) | 600 / 644 | CA коротких login-сертификатов. Закрытый ключ — для `api` (S7, `SBX_SSH_LOGIN_CA_KEY_FILE`) |
| `login-ca-keys` | 644 | `ssh_login_ca.pub` в формате authorized_keys (`SBX_GATEWAY_SSH_LOGIN_CA_KEYS_FILE`) |
| `service-tokens.json` | 600 | токены, которые gateway принимает: `{"api":[..],"worker":[..],"gateway":[..]}`. `gateway[0]` gateway шлёт пирам |
| `api-token` | 600 | токен, с которым gateway ходит в `api` (`SBX_GATEWAY_API_TOKEN_FILE`) |
| `worker-gateway-token` | 600 | равен `service-tokens.json` → `worker[0]`. Worker читает его через `SBX_GATEWAY_SERVICE_TOKEN_FILE` |

Владельцы. `gateway-secrets` работает от root и отдаёт файлы пользователю gateway (distroless `nonroot`, 65532),
а `worker-gateway-token` — пользователю worker (`node`, 1000). Это делается на каждом запуске и для уже
существующих файлов. В Docker Desktop это не видно: на хосте файлы
принадлежат вам. На Linux-хосте закрытые файлы после этого читает только root. Если каталога нет, Docker создаст его
от root. Чтобы каталог остался вашим и файлы можно было удалять без `sudo`, создайте его заранее:

```sh
mkdir -p deploy/compose/secrets/gateway
```

Пересоздание. Удалите файл, и следующий `up` создаст его заново. Пары удаляются целиком: сертификат с ключом,
закрытый ключ SSH с `.pub`. Если осталась одна половина пары, `dev-secrets` откажется работать и назовёт файл.
При новом `ca.*` удалите и `sbx.*`, `tunnel.*`. Срок сертификатов — 397 дней (лимит браузеров и macOS); по
истечении удалите `sbx.*` и `tunnel.*`. После пересоздания нужен `up -d --force-recreate gateway`
(сертификаты gateway перечитывает сам, остальные секреты — только при старте).

## Токен worker-а

`gateway.yaml` монтирует каталог секретов в worker (`/run/sbx-gateway`, только чтение) и задаёт
`SBX_GATEWAY_SERVICE_TOKEN_FILE=/run/sbx-gateway/worker-gateway-token`. Монтируется каталог, а не файл: Docker
создал бы на месте ещё не существующего файла каталог раньше, чем отработает `gateway-secrets`. Worker находит
gateway через реестр (`tunnel.gateway_instances`, `internal_url = http://gateway:7000`) и вызывает на нём `rotate-token`.

## api

По умолчанию `SBX_GATEWAY_API_URL=http://api:8082` (внутренний listener `api`, S7). Через него gateway
ищет маршруты preview-адресов, проверяет SSH-ключи и сертификаты и шлёт события агентов.
`secrets-init` берёт токены из `secrets/gateway/`: `api-token` попадает в `api/service-tokens.json` под
ключом `gateway`, а `service-tokens.json` → `api[0]` становится токеном `api` для внутреннего listener
gateway (`api/gateway-token`). Если файлы `gateway-secrets` пересоздали, перезапустите `api` и `gateway`
(`up -d --force-recreate api gateway`).

Стек без `api`: задайте в `deploy/compose/.env` `SBX_GATEWAY_API_URL=none`. Все preview-адреса тогда
отвечают `503 route_lookup_unavailable`, SSH-логины отклоняются, события агентов пишутся в лог и
отбрасываются. Туннели агентов, реестр и внутренний listener работают.

## HTTPS: доверие dev CA и имена

`*.localhost` браузеры сами резолвят в loopback; системный резолвер и curl — не всегда. Gateway разбирает
метку только из Host без порта (или с `:443`, спецификация §4.2), поэтому `https://demo-3000.sbx.localhost:8443/`
ответит `404 route_not_found`.

curl, порт 8443: `--connect-to` подменяет адрес, а Host и SNI оставляет как есть:

```sh
curl --cacert deploy/compose/secrets/gateway/ca.pem \
  --connect-to demo-3000.sbx.localhost:443:127.0.0.1:8443 \
  https://demo-3000.sbx.localhost/
# 404 {"error":{"code":"route_not_found",...}} от api (без api: 503 route_lookup_unavailable)
```

Браузер: задайте `GATEWAY_HTTPS_PORT=443` в `deploy/compose/.env` (Docker Desktop и Linux-docker умеют
публиковать порт 443) и добавьте `ca.pem` в доверенные:

```sh
# macOS
security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db deploy/compose/secrets/gateway/ca.pem
# Linux (Debian/Ubuntu); Firefox и Chrome на Linux держат своё хранилище (certutil из libnss3-tools)
sudo cp deploy/compose/secrets/gateway/ca.pem /usr/local/share/ca-certificates/sbx-dev-ca.crt && sudo update-ca-certificates
```

Name constraints у CA не дают ему подписать чужие имена, даже если `ca.key` утечёт. Удалить доверие:
`security delete-certificate -c "sbx dev CA <id>"` (точное имя показывает `openssl x509 -in ca.pem -noout -subject`).

С `GATEWAY_HTTPS_PORT=443` curl-у хватает `--resolve demo-3000.sbx.localhost:443:127.0.0.1` (или строки в `/etc/hosts`).

## SSH

```sh
printf '[127.0.0.1]:2222 %s\n' "$(cut -d' ' -f1,2 deploy/compose/secrets/gateway/ssh_host_ed25519_key.pub)" > /tmp/sbx_known_hosts
ssh -p 2222 -o UserKnownHostsFile=/tmp/sbx_known_hosts <slug>@127.0.0.1
```

Авторизация ключа и сертификата идёт через `api` (внутренний listener); без `api` SSH-логин всегда отклоняется.

## Остановка и drain

`stop_grace_period: 960s`, как `terminationGracePeriodSeconds` пода (спецификация §10.5). По SIGTERM gateway
сразу отдаёт `/readyz 503`, ещё 5 s принимает соединения, затем дренирует. HTTP-потокам даётся 2 мин, SSH-сессиям
15 мин; весь drain ограничен 950 s. Без открытых сессий `docker compose stop gateway` занимает около 5 s.
Повторный сигнал (Ctrl-C дважды при `up` без `-d`) останавливает процесс сразу.

Для локальных прогонов есть две переменные окружения gateway (в `environment:` сервиса или через override):

- `SBX_GATEWAY_ENDPOINT_WAIT` — пауза перед закрытием listener-ов (по умолчанию 5s);
- `SBX_GATEWAY_DRAIN_TIMEOUT` — общий предел drain (по умолчанию бюджет drain + 30 s = 950 s, больше 950 s не принимается).

`docker compose stop -t 10 gateway` прервёт долгий drain через 10 s (SIGKILL).

## Образ

```sh
docker build -f services/gateway/Dockerfile -t sbx-gateway:dev --build-arg VERSION=$(git rev-parse --short HEAD) .
docker run --rm sbx-gateway:dev version
```

Сборка идёт из корня репозитория. `services/gateway/Dockerfile.dockerignore` заменяет корневой `.dockerignore`
и оставляет в контексте только `libs/proto`, `libs/tunnel`, `services/gateway`. Модуль собирается с `GOWORK=off`
через свои `replace`. Итоговый образ — `gcr.io/distroless/static-debian13:nonroot`. В нём нет shell, поэтому
healthcheck вызывает `sbx-gateway healthcheck`.
