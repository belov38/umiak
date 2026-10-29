# S8. Web (Payload): админка, дашборд, пользователи и команды — спецификация

Статус: согласовано (master-сессия от имени Ильи), 2026-10-29; политика увольнения (§20) ждёт подтверждения Ильи. Область S8 из `docs/roadmap.md`. Архитектура: `docs/architecture.md` (§2, §10, §11). Опирается на `docs/specs/s7-public-api.md` (listener-ы, ключи, scopes, `IdentityStore`, §17.3, §22), `docs/specs/s6-control-plane.md` (§5.11 `ConfigReader`, §8.5 квоты, §13.1 секреты), `docs/specs/s4-gateway.md` (§6.1–6.2 маршруты и блокировки, §8.4 SSO, §14.1 cookie).

Ответы на Q1–Q3 и решения автора согласованы master-сессией от имени Ильи (2026-10-29). Пометка **[решение S8]** — решение автора спеки в рамках брифа (одобрено master-сессией); его можно менять при планировании, если причина записана. Пометка **[изменение S7]** / **[изменение S6]** — место, где S8 добавляет что-то в уже согласованную спеку; сводка — §17.

## 1. Зачем

S8 — человеческое лицо платформы. Операторы настраивают её в `/admin` (шаблоны, размеры, квоты, пул, пользователи, ключи). Пользователи в `/app` создают sandbox, смотрят логи, открывают терминал, работают с файлами и портами, выпускают API-ключи для агентов и CLI. Кроме того, S8 даёт `api` и `worker` два источника правды: кто пользователь и что он может (`IdentityStore`), и как настроена платформа (`ConfigReader`).

Что считается успехом:
1. Новый сотрудник открывает `https://app.<domain>`, входит через IdP и через минуту работает в терминале своей sandbox. Ни регистрации, ни оператора не нужно.
2. Изменение в `/admin` (выключен шаблон, снижена квота, отозван ключ, выключен `public`) действует на всех подах `api`, `worker` и gateway за секунды, без перезапуска.
3. Дашборд умеет всё то же, что CLI, по тому же публичному API. Отдельного пути к runtime-данным в обход API нет.
4. Ни одна учётная запись платформы не принимается по заголовку, пришедшему не от oauth2-proxy, а значение секрета нельзя прочитать ни из дашборда, ни из `/admin`.
5. Разработчик поднимает `apps/web` локально без IdP одной командой, и продовый код при этом не содержит обхода аутентификации.

## 2. Цели, не-цели, анти-цели

**Цели**
- `apps/web`: одно Next.js-приложение с Payload 3; `/admin` для операторов, `/app` для пользователей.
- `packages/payload`: конфиг Payload, коллекции, хуки, auth-стратегия, JIT, реализация `IdentityStore` (S7 §17.3) — импортируется из `api` и `worker` без Next.
- `PayloadConfigReader` в `packages/config` (S6 §5.11).
- Модель команд и ролей `owner`/`member`, личная команда при первом входе, приглашения по email.
- Environments команды (вторая очередь MVP) — хранение в `runtime`, ручки в `api` (§10).
- Раздел «Оператор» в `/app`: все sandbox всех команд, блокировки (§9.10).
- Локальная разработка без oauth2-proxy (§13), миграции схемы `payload` (§12), форма сборки и деплоя (§14).

**Не-цели (другие области)**
- Публичное API и его внутренности (S7), машины состояний и worker (S6), gateway (S4), рабочий стол (S10), MCP (S11), Helm-чарты и настройка IdP (S12), репозитории в environments (S13).
- Страница входа CLI (`/cli/*`) и SSO для портов (`/sbx-auth/*`): их отдаёт `api` (S7 §7.6–7.7), S8 только хранит данные, которые они читают.
- Биллинг, организации с кошельками, публичная регистрация.

**Анти-цели (провал, даже если всё работает)**
- `web` или `api` принял пользователя по `X-Auth-Request-*`, пришедшему не от oauth2-proxy.
- Значение секрета (env-секрет, secret-файл, секрет API-ключа после первого показа, токен порта после выдачи) видно в дашборде, в `/admin`, в REST Payload, в логах `web`.
- Пользователь без роли оператора прочитал или изменил что-то через REST Payload или server action в обход проверок.
- Дашборд показал runtime-данные, прочитанные из БД напрямую, а не через API (они разойдутся с тем, что видит CLI).
- После отзыва ключа, деактивации пользователя или выключения `public` старое поведение держится дольше, чем обещано в §11.
- Код заглушки аутентификации для разработки попал в продовый образ.

## 3. Ограничения

- Toolchain из `mise.toml` (Node 26.13.0, pnpm 12.16.1). Версии библиотек — §16, проверены 2026-10-29; при реализации перепроверить и взять последние стабильные (`CLAUDE.md`).
- Раскладка по `CLAUDE.md`: `apps/web`, `packages/payload`; тесты vitest и Playwright; линт biome.
- Postgres один (S6 §3): схема `payload` принадлежит S8. `runtime` S8 не читает и не пишет из `web` (§14.3); runtime-таблицы для environments и блокировок добавляются миграциями в диапазоне S8 (§17.3) и используются только `api`/`worker`.
- Внутренняя платформа компании; пользователи — только из IdP за oauth2-proxy.
- Интерфейсы `IdentityStore` и `ConfigReader` заданы S7/S6; S8 их реализует и расширяет только добавлениями (§17).

## 4. Обзор

```
 browser
   |  https://app.<domain>
   v
 ingress (TLS, HTTP/2) ──> oauth2-proxy (OIDC, cookie __Host-oauth2_proxy)
                              |  injects X-Auth-Request-Email/-User/-Groups/-Preferred-Username,
                              |  strips client-supplied copies
          ┌───────────────────┼───────────────────────────────┐
          | /api/* (strip /api), /cli/*, /sbx-auth/*           | everything else
          v                                                    v
   apps/api :8081 (proxied listener, S7)              apps/web :3000 (Next.js 16 + Payload 3)
     IdentityStore ── packages/payload ──┐              /admin   Payload admin (operators)
     ConfigReader ── packages/config ────┤              /app     dashboard (React, @sbx/sdk -> /api/v1)
                                         |              /cms-api Payload REST (operators only)
   apps/worker: ConfigReader ────────────┤              server actions: teams, members, settings
                                         v
                         Postgres: schema payload (S8)  <- Payload Local API (getPayload)
                                   schema runtime (S6/S7/S8 additions) <- only api, worker
                         NOTIFY sbx_identity, sbx_config, sbx_routes '*'
```

- Браузер говорит с `web` только за oauth2-proxy. `web` рендерит оболочку `/app` и формы управления командами (Payload Local API), а всё про sandbox, команды, файлы, порты, снапшоты, ключи, SSH-ключи и environments браузер берёт сам из `https://app.<domain>/api/v1/*` через `@sbx/sdk` (тот же origin, та же cookie oauth2-proxy).
- `web` не вызывает `api` со стороны сервера и не пробрасывает заголовки личности [решение S8]: так нет второго пути, где можно подделать пользователя.
- `api` и `worker` поднимают тот же конфиг Payload через `getPayload` (без Next) и читают/пишут коллекции через Local API.

### 4.1 Пакеты и приложения

| Путь | Имя | Что |
|---|---|---|
| `packages/payload` | `@sbx/payload` | `buildConfig` (без React-импортов; компоненты админки — по путям import map), коллекции и global, хуки `NOTIFY`, auth-стратегия `oauth2-proxy`, `resolveSession` (JIT), `PayloadIdentityStore`, миграции схемы `payload`, `getSbxPayload()` с кэшем экземпляра |
| `packages/config` | S6 | S8 пишет `PayloadConfigReader` поверх `@sbx/payload` (S6 §5.11) |
| `packages/auth` | S7 | Интерфейс `IdentityStore`, формат ключей, кодеки публичных ID; S8 добавляет общий контрактный набор тестов `IdentityStore` (§15) |
| `apps/web` | `@sbx/web` | Next.js-приложение: маршруты Payload (`/admin`, `/cms-api`), `/app`, server actions, `/healthz`; `dev/` — заглушка аутентификации (§13), в образ не входит |

## 5. Аутентификация

### 5.1 Цепочка доверия

- Весь `app.<domain>` закрыт oauth2-proxy в режиме reverse proxy (upstream) [решение S8; конфиг — S12]. Через alpha config `injectRequestHeaders` oauth2-proxy ставит upstream-у `X-Auth-Request-Email` (claim `email`), `X-Auth-Request-User` (claim **`sub`** — неизменяемый идентификатор IdP, а не логин или email), `X-Auth-Request-Groups` (claim групп), `X-Auth-Request-Preferred-Username` из claims и вырезает присланные клиентом копии (`preserveRequestValue: false`, значение по умолчанию). Неподтверждённый email не принимается (oauth2-proxy по умолчанию требует `email_verified`; `--insecure-oidc-allow-unverified-email` не включается).
- Требования к сессии oauth2-proxy (S12): `--cookie-refresh` не больше 5 min (при обновлении IdP заново проверяет пользователя и отдаёт актуальные группы), `--cookie-expire` не больше 12 h. Только так выключение пользователя и снятие группы в IdP доходят до `web` и `api` (§11). Маршрутизация по путям — тоже в alpha config: `/api/` → `api:8081` с `rewriteTarget` без `/api`, `/cli/` и `/sbx-auth/` → `api:8081`, остальное → `web:3000`. Если S12 выберет nginx-подобный `auth_request`, контракт для `web` и `api` тот же: эти четыре заголовка ставит только oauth2-proxy.
- Cookie oauth2-proxy — `__Host-oauth2_proxy`, host-only, `Secure`, без `--cookie-domain` (S4 §14.1).
- `web` доверяет заголовкам только потому, что к его порту пускает лишь oauth2-proxy (NetworkPolicy, S12), как `api :8081` (S7 §7.1). Отдельного секрета между oauth2-proxy и `web` нет [решение S8]: NetworkPolicy — та же граница, что у `api`, и второй механизм только усложнил бы dev.
- Пробы — **exec-пробы** внутри контейнера (`node healthcheck.js` → `http://127.0.0.1:3000/healthz`), а не HTTP-пробы kubelet [решение S8 по ревью]: тогда NetworkPolicy пускает на `:3000` только поды oauth2-proxy, без адресов нод (иначе любой hostNetwork-под или процесс ноды мог бы прислать поддельный `X-Auth-Request-*`). `/healthz` не требует заголовков и отдаёт только `200 ok` (Postgres, инициализация Payload, миграции §12).
- Запрос к любому другому пути `web` без `X-Auth-Request-Email` — `401` (простая HTML-страница «нет входа»). В проде так бывает только при ошибке конфигурации.

### 5.2 Разбор заголовков

- `email` — `X-Auth-Request-Email`, приводится к нижнему регистру и обрезается; обязателен, иначе `401`.
- `user` — `X-Auth-Request-User` (claim `sub`), обязателен; `preferredUsername` — `X-Auth-Request-Preferred-Username`, необязателен.
- `groups` — `X-Auth-Request-Groups`: oauth2-proxy может прислать одно значение через запятую или несколько значений; Node склеивает повторы через `, `. Разбор: split по `,`, trim, пустые выкидываются, дубликаты убираются. Группы с запятой в имени не поддерживаются (ограничение записывается в документацию S12).

### 5.3 JIT и `resolveSession`

`resolveSession({email, user, groups, preferredUsername})` живёт в `@sbx/payload` и используется дважды: auth-стратегией Payload в `web` и `PayloadIdentityStore.resolveSession` в `api` (S7 §7.4). Логика одна:

Идентичность привязана к `sub` (`idpSubject`, уникальный индекс); email — второй ключ для первого входа и приглашений [решение S8 по ревью]. `X-Auth-Request-User` обязателен (без него `401`).

1. Найти пользователя по `idpSubject = user`. Нашёлся:
   - email в заголовке другой (сменился в IdP) → обновить `email`, если он свободен. Если email занят заготовкой (§6.3) — перенести её членства на этого пользователя и удалить заготовку. Если занят другим пользователем, который уже входил, — `403` («email занят другой учётной записью, обратитесь к оператору»).
2. Не нашёлся — найти по `email`:
   - заготовка (`idpSubject` пуст) → привязать: записать `idpSubject`, `name`, создать личную команду, если её нет;
   - пользователь с другим `idpSubject` → `403` («учётная запись IdP сменилась, обратитесь к оператору»): новый человек с переиспользованным email не получает чужие команды и ключи. Оператор сбрасывает `idpSubject` в `/admin`.
3. Не нашёлся и по email — создать: `email`, `name` (`preferredUsername` → часть email до `@`), `idpSubject`, `active: true`. В той же транзакции — личная команда (§6.1) и членство `owner`; `defaultTeam` = личная команда. Гонку двух первых запросов решают уникальные индексы: проигравший перечитывает строку.
4. `active: false` — отказ: в `web` страница «учётная запись отключена» (`403`), в `api` — `403 forbidden` с `details.reason: "user_disabled"` [решение S8].
5. `isOperator` = пересечение `groups` с `SBX_OPERATOR_GROUPS` (список через запятую, имя группы задаёт S12/Илья). Записать `groups`, `isOperator`, `lastLoginAt`, если они изменились (не чаще раза в 60 s для `lastLoginAt`), чтобы обычный запрос не писал в БД.
6. Ответ — `SessionIdentity`: пользователь, `isOperator`, команды с ролями, `defaultTeamId`.

Кэш в процессе на 30 s по `sha256(email + groups + user)`, сброс по `LISTEN sbx_identity` (S7 §7.4 — то же поведение в `api`).

### 5.4 Payload: стратегия вместо паролей

- Коллекция `users`: `auth: { disableLocalStrategy: true, strategies: [{ name: "oauth2-proxy", authenticate }] }`. `authenticate({ headers, payload })` вызывает `resolveSession` и возвращает `{ user: { ...user, collection: "users", _strategy: "oauth2-proxy" } }` или `{ user: null }`.
- Паролей, логина, logout, JWT и cookie Payload нет: стратегия выполняется на каждом запросе по заголовкам. `admin.user = "users"`.
- `cookiePrefix` Payload — `__Host-payload` [решение S8]: служебные cookie админки (язык, тема) тоже host-only. Если Payload не сможет выставить их с этим префиксом, исполнитель фиксирует это в плане; эти cookie не дают доступа и не являются учётными данными.
- Выход из системы — ссылка на `/oauth2/sign_out` oauth2-proxy (с `rd` на страницу выхода IdP, настраивает S12).

### 5.5 Роль оператора

- Оператор — пользователь, у которого в текущей сессии есть группа из `SBX_OPERATOR_GROUPS`. Поле `users.isOperator` — только чтение в `/admin`, обновляется при каждом `resolveSession`.
- **Права оператора действуют только в браузерной сессии** [решение S8, изменение S7 C6]: у principal-а по API-ключу `isOperator = false`, даже если владелец ключа оператор. Так ключ, утёкший из CI, не даёт доступа ко всем командам, а снятие группы в IdP отнимает права при следующем обновлении сессии oauth2-proxy (§5.1, §11), а не после ручных действий.
- **SSH тоже без операторского исключения** [решение S8 по ревью, изменение S7 C6]: `ssh/authorize` пускает только участников команды sandbox; правило S7 §12.1 «или оператор» убирается. В сессии SSH нет свежих групп, а сохранённый флаг мог устареть. Оператору, которому нужен shell в чужой sandbox, хватает терминала в браузере (раздел «Оператор»).
- Сохранённое `users.isOperator` служит только для отображения в `/admin` и фильтров.

### 5.6 CSRF в `web`

- Все небезопасные запросы к `web` (server actions, REST Payload, загрузки в админке) требуют `Origin == SBX_APP_ORIGIN`; иначе `403`. Проверка — в `proxy.ts` Next 16 (бывший middleware) для всех путей, кроме `/healthz`. Server actions Next дополнительно сверяют `Origin` с `Host` сами; `serverActions.allowedOrigins` не расширяется.
- `csrf` Payload = `[SBX_APP_ORIGIN]`.
- Ответы `web`: `Content-Security-Policy` с `frame-ancestors 'self'`, `default-src 'self'`; `connect-src 'self'` (дашборд ходит только на свой origin, WebSocket — `wss://app.<domain>`); `frame-src https://*.<sbx-domain>` для превью портов и рабочего стола (S10). `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. Точный список — исполнителю, Payload admin может потребовать `'unsafe-inline'` для стилей.

## 6. Команды и роли [решение Q1]

### 6.1 Модель

- **Личная команда.** Создаётся при первом входе: `name` = имя пользователя, `personal: true`, единственный участник — пользователь (`owner`). Её нельзя удалить, переименовать можно; приглашать в неё других нельзя [решение S8]: «личная» должна оставаться личной, для совместной работы есть общие команды.
- **Общая команда.** Создаёт любой пользователь в `/app` (создатель — `owner`). Ограничение — не больше 3 общих команд, где пользователь `owner` [решение S8; значение `maxOwnedTeamsPerUser` в `PlatformDefaults`, оператор может поменять]. Новая общая команда получает квоту `newSharedTeamQuota` из `PlatformDefaults` (по умолчанию равна `defaultQuota`; оператор может поставить нули, тогда команда работает только после того, как оператор выдаст квоту).
- **Квоты — справедливость, а не ёмкость** [решение S8 по ревью]: от превышения RAM ноды защищает admission S6 (§8.2, `out_of_capacity`), а не квоты. Пользователь с несколькими командами может занять больше одной квоты; это осознанный компромисс внутренней платформы, рычаги — `maxOwnedTeamsPerUser`, `newSharedTeamQuota` и квоты отдельных команд.
- **Команда по умолчанию** (`users.defaultTeam`) — та, что используется без `Sbx-Team` (S7 §7.4); по умолчанию личная, пользователь меняет её в настройках. Если пользователь вышел из команды по умолчанию, она снова становится личной.
- Синхронизация команд из групп IdP — фаза 2 (§18).

### 6.2 Роли

| Действие | `member` | `owner` | Оператор |
|---|---|---|---|
| Все sandbox команды в пределах scopes (S7 §7.5): создать, смотреть, exec, файлы, порты, stop/resume/fork/delete, снапшоты | да | да | да (любая команда) |
| Свои API-ключи в команде, свои SSH-ключи | да | да | да |
| Использовать environments команды при create | да | да | да |
| Создавать, менять, удалять environments команды | нет | да | да |
| Видеть и отзывать API-ключи других участников команды | нет | да | да |
| Приглашать, удалять участников, менять роли | нет | да | да (в `/admin`) |
| Переименовать команду | нет | да | да |
| Выйти из команды | да | да, если останется другой `owner` | — |
| Удалить общую команду | нет | нет | да (§6.4) |
| Квота команды | только смотреть | только смотреть | менять (`/admin`) |

- У команды всегда есть хотя бы один `owner`: снять роль или удалить последнего `owner` нельзя (проверка в server action и в хуке `beforeChange`/`beforeDelete` коллекции `memberships`, чтобы и `/admin` не обошёл).
- Удаление участника не трогает sandbox команды (они принадлежат команде); его ключи в этой команде перестают работать сразу (S7 §7.2, `NOTIFY sbx_identity`).

### 6.3 Приглашение по email

- `owner` вводит email. Пользователь с таким email есть → создаётся членство с выбранной ролью. Нет → создаётся **заготовка**: `users` с этим email, `active: true`, `lastLoginAt: null`, без личной команды; и членство. При первом входе JIT достраивает её (§5.3 п. 3).
- Письма не отправляются [решение S8]: на внутренней платформе ссылку на дашборд передают сами; на странице команды заготовка видна как «ещё не входил».
- Email не проверяется против домена компании: войти всё равно можно только через IdP. Заготовка, в которую никто не вошёл 90 дней, — кандидат на удаление оператором (список в `/admin`, фильтр `lastLoginAt is null`).

### 6.4 Удаление команды

Удаляет только оператор в `/admin` [решение S8]: у `web` нет доступа к runtime, а удалить команду с живыми sandbox нельзя. Порядок: оператор в разделе «Оператор» (`/app/operator`, §9.10) видит sandbox и снапшоты команды и удаляет их; кнопка удаления команды в `/admin` (custom action) перед удалением вызывает из браузера оператора `GET /v1/sandboxes?allTeams=true&teamId=…&limit=1` и `GET /v1/snapshots` с `Sbx-Team` и отказывает, если что-то есть. Environments команды оператор тоже удаляет заранее (`DELETE /v1/environments/...`), проверка их учитывает. Между проверкой и удалением возможна гонка (кто-то успел создать sandbox); она не опасна: `api` больше не найдёт членств в команде, и такая sandbox доступна только оператору (раздел «Оператор»), который её удаляет. Это известное ограничение. При удалении команды хук `beforeDelete` удаляет её членства и ставит `revokedAt` всем её ключам (с `NOTIFY sbx_identity`).

## 7. Коллекции Payload (схема `payload`)

Общие правила:
- Адаптер `@payloadcms/db-postgres`: `schemaName: "payload"`, `idType: "uuidv7"` (S7 §17.3: UUID), `push: false`, миграции — §12. Публичные ID (`usr_`, `team_`, `key_`, `sshk_`) — кодеки `packages/auth` поверх этих UUID.
- Имена таблиц Payload не должны совпадать с таблицами схем `runtime`, `tunnel`, `pgboss` (ограничение `schemaName` в адаптере помечено experimental). Поэтому коллекции не называются `snapshots`, `nodes`, `queue`, `job` и т.п.; тест сверяет списки таблиц всех схем после миграций (§15).
- Многозначные поля (`groups`, `scopes`, `allowedSizes`, `capabilities`) — `json` или `select` с `hasMany`, без `array`-полей с отдельными таблицами, где это не мешает админке [решение S8]: меньше таблиц и проще хуки.
- GraphQL выключен (`graphQL: { disable: true }`). REST Payload перенесён с `/api` на `/cms-api` (`routes.api`), потому что `/api/*` на `app.<domain>` принадлежит `api` (S7 §5.1).
- Доступ (`access`) всех коллекций и global: чтение и запись — только оператор (`req.user?.isOperator`), если в таблице ниже не сказано иное. `api`, `worker` и server actions `web` работают через Local API с `overrideAccess: true` и сами проверяют права (§9.11).
- Хуки `afterChange` и `afterDelete` шлют `NOTIFY` (§8).

| Коллекция | Поля | Заметки |
|---|---|---|
| `users` | `email` (unique, lower), `name`, `idpSubject` (`sub`, unique, null у заготовок), `preferredUsername`, `groups` (json, последние из IdP), `isOperator` (read-only), `active`, `defaultTeam` → teams, `personalTeam` → teams, `lastLoginAt`, `createdAt` | auth-коллекция (§5.4). Удаление запрещено всем [решение S8]: строки нужны для `created_by` в runtime и аудита; вместо удаления — `active: false`. Исключение — заготовки без входа и без членств |
| `teams` | `name` (1–64), `personal` (bool), `createdBy` → users, `quota` (group: `maxActiveSandboxes`, `maxRamMb`, `maxSavedSnapshots`; пустое — значение по умолчанию), `createdAt` | `quota` меняет только оператор. Удаление — §6.4 |
| `memberships` | `user` → users, `team` → teams, `role` (`owner` \| `member`), `invitedBy` → users, `createdAt` | unique (`user`, `team`); правило последнего `owner` (§6.2) |
| `api-keys` | по S7 §17.3: `name`, `user`, `team`, `secretHash` (unique, скрыто в админке), `prefix`, `last4`, `scopes` (json), `expiresAt`, `revokedAt`, `revokedBy` → users, `lastUsedAt`, `createdVia` | создание в админке запрещено (ключи выпускает только `api` через `packages/auth`, S7 §17.3). Оператор может только отозвать (кнопка ставит `revokedAt`, `revokedBy`) |
| `ssh-keys` | по S7 §17.3: `user`, `name`, `publicKey`, `fingerprint` (unique), `type`, `lastUsedAt`, `createdAt` | оператор может удалить |
| `templates` | `slug` (unique, `[a-z0-9-]{1,40}`), `name`, `description`, `os` (`linux` \| `windows`), `enabled`, `defaultSize` (slug), `allowedSizes` (slugs), `loginUser` (по умолчанию `user`), `capabilities` (`exec`, `files`, `ssh`, `desktop`), `sortOrder` | S6 §5.11, S7 §13. Валидация: `defaultSize ∈ allowedSizes`, slug размеров существуют. Slug не меняется после создания (его хранят `template_builds` и `sandboxes`) |
| `sizes` | `slug` (unique, например `2gb`), `vcpu`, `memoryMb`, `sortOrder` | slug не меняется; удалить размер, указанный в шаблоне или цели пула, нельзя |
| `pool-targets` | `template` (slug), `size` (slug), `providerId` (uuid, необязательно, S6 `providers`), `target` (0–50), `maxAgeHours` | unique (`template`, `size`, `providerId`). `providerId` вводится как текст: топология живёт в runtime, список провайдеров — `sbx-admin` до фазы 2 |
| global `platform-defaults` | S6: `ttlSeconds` (null), `maxTtlSeconds`, `idleTimeoutSeconds` (900), `stoppedRetentionDays` (null), `errorRetentionDays` (7), `recoverMinIntervalSeconds` (600); S7: `defaultTemplate`, `publicPortsEnabled` (true), `ssoPortPolicy` (`any`), `rateLimits {requestsPerSecond, burst, startsPerMinute}`; S8: `defaultQuota {maxActiveSandboxes, maxRamMb, maxSavedSnapshots}` (для личных команд и пустых полей), `newSharedTeamQuota` (копируется в `teams.quota` при создании общей команды), `maxOwnedTeamsPerUser` (3), `apiKeyOwnerInactivityDays` (30, `null` выключает, §20), `ssoPolicyEpoch` (только чтение, §8) | значения по умолчанию — первая миграция-сид. Квота PoC: 3 sandbox, 6144 MB, 10 снапшотов [решение S8, из бюджета 8 GB] |

`ConfigReader.teamQuota(teamId)` = поля `teams.quota`, где пусто — `defaultQuota` [изменение S6 S3]. Удалённая или несуществующая команда → квота из нулей (create отказывает `quota_exceeded`).

## 8. Инвалидация кэшей (`NOTIFY`)

| Канал | Payload | Кто шлёт | Кто слушает |
|---|---|---|---|
| `sbx_identity` | `'<collection>:<id>'` | хуки `users`, `teams`, `memberships`, `api-keys`, `ssh-keys` | `api` (кэш сессий и ключей, S7 §7.2, §7.4), `web` (кэш `resolveSession`) |
| `sbx_config` | `'<collection-or-global>:<id>'` | хуки `templates`, `sizes`, `pool-targets`, `teams` (квота), global `platform-defaults` | `api`, `worker` (`ConfigReader`, S6 §5.11) |
| `sbx_routes` | `'*'` | хук `platform-defaults`, если изменились `publicPortsEnabled` или `ssoPortPolicy` | gateway (S4 §6.2, S7 O7) |

- `NOTIFY` выполняется **в транзакции запроса Payload** (через сессию адаптера для `req.transactionID`), поэтому Postgres доставляет его только после коммита: слушатель, получив уведомление, читает уже новые данные. Если транзакции нет (вызов Local API без `req`), хук открывает свою короткую транзакцию после записи. Ошибка `NOTIFY` откатывает запись [решение S8]: тихо устаревший кэш хуже явной ошибки.
- **Порядок для `public`.** Gateway по `'*'` сразу перезапрашивает маршруты у `api`, а `api` мог ещё не обработать `sbx_config`; любой кэш в `api` здесь даёт гонку, после которой gateway закэширует старый ответ. Поэтому `routes.lookup` читает `publicPortsEnabled`, `ssoPortPolicy` и `ssoPolicyEpoch` **без кэша**: одна строка global из Payload на промах кэша gateway [изменение S7 C7]. Нагрузка мала (gateway кэширует маршруты), а приёмка S4 «`403` не позже чем через 1 s» выполняется.
- **Смена `ssoPortPolicy`.** При переходе `any` → `team` старые cookie `sso` посторонних пользователей должны перестать действовать. Хук увеличивает `PlatformDefaults.ssoPolicyEpoch`, а `routes.lookup` для маршрутов `sso` отдаёт `authEpoch = hosted_ports.auth_epoch + ssoPolicyEpoch` (то же значение пишется в `port_auth_codes`) [изменение S7 C7]. Сумма растёт монотонно, gateway сравнивает её с эпохой в cookie (S4 §8.2) и ничего не меняет у себя.
- `api` при отзыве ключа по API шлёт `sbx_identity` сам (S7 §7.2) — это тот же хук: `api` пишет через Local API.

## 9. Дашборд `/app`

### 9.1 Технология [решение S8, одобрено]

- Next.js 16 App Router в том же приложении, что Payload. Маршрутная группа `(app)` рядом с `(payload)`.
- Серверная часть `/app` только рендерит оболочку: `layout` получает пользователя через `payload.auth({ headers })` (та же стратегия) и отдаёт клиенту `{user, teams, isOperator}`. Страницы — клиентские компоненты.
- Данные о sandbox, командах, файлах, портах, снапшотах, ключах, SSH-ключах, environments, лимитах — `@sbx/sdk` в браузере, `baseUrl = "/api"` (тот же origin), заголовок `Sbx-Team` на каждый запрос. Кэш, повторы и фоновое обновление — TanStack Query.
- Команды и участники, переименование команды, команда по умолчанию — server actions на Payload Local API (§9.11).
- UI: Tailwind CSS 4 + shadcn/ui (компоненты копируются в `apps/web/src/components/ui`). Терминал и вывод команд — xterm.js 6.
- Порядок соединений: ingress обязан отдавать HTTP/2 (S12), иначе браузер упрётся в 6 соединений на origin. Дашборд держит не больше одного long-poll и двух NDJSON-стримов на вкладку; остальное закрывается при уходе со страницы.

### 9.2 URL и команда

- Команда — часть пути: `/app/t/<teamId>/...`, где `teamId` — публичный `team_...`. Ссылки, которыми обмениваются коллеги, открываются в нужной команде. `/app` перенаправляет на команду по умолчанию.
- Команда не из списка пользователя (и он не оператор) — страница «нет доступа к команде».
- Браузер не умеет ставить заголовки на WebSocket и на обычную ссылку скачивания. Для этих двух случаев proxied listener принимает команду в query `team=team_...` [изменение S7 C4].

### 9.3 Карта экранов

```
/app/t/<team>/                       Sandboxes (list)            [default]
/app/t/<team>/sandboxes/new          Create sandbox
/app/t/<team>/sandboxes/<slug>       Sandbox detail, tabs: Overview | Terminal | Commands | Files | Ports | SSH | Env | Desktop*
/app/t/<team>/snapshots              Saved snapshots
/app/t/<team>/environments           Environments (wave 2)
/app/t/<team>/keys                   API keys
/app/t/<team>/settings               Team: name, members, roles, invite, quota and usage, leave
/app/account                         SSH keys, default team, profile (from IdP, read-only), sign out
/app/teams/new                       Create shared team
/app/operator                        Operator: all sandboxes, blocks (operators only)
* Desktop — only when the template has the `desktop` capability
```

Общая рамка:

```
+--------------------------------------------------------------------------------+
| sbx   [Team: platform-dev v]   Sandboxes  Snapshots  Environments  Keys  Team   |
|                                              [Operator] [Admin]   ilia@... (v) |
+--------------------------------------------------------------------------------+
| <page>                                                                          |
```

`[Operator]` и `[Admin]` видны только операторам. Переключатель команды меняет `<team>` в пути.

### 9.4 Список sandbox

```
Sandboxes                                   2 of 3 active · 4096 of 6144 MB   [+ New sandbox]
[search name/slug] [state: all v] [label: k=v]
+--------------------+----------+--------+-------+---------+-----------+--------------+
| name / slug        | template | size   | state | health  | activity  | created      |
+--------------------+----------+--------+-------+---------+-----------+--------------+
| ci-run-42          | linux    | 2gb    | ready | ok      | busy      | 5 min ago by |
| quiet-otter-lamp   | 2026.10.29-1      |       |         |           | ilia         |
|                    |          |        |       |         |  [Stop] [...] menu: resume, |
|                    |          |        |       |         |  fork, terminal, delete      |
+--------------------+----------+--------+-------+---------+-----------+--------------+
```

- `GET /v1/sandboxes` с фильтрами (S7 §8.2) и бесконечной прокруткой по `nextCursor`; квота и использование — `GET /v1/limits`.
- Обновление — опрос каждые 5 s, пока вкладка видима, и сразу после действия. `deleted` не показываются.
- Переходные состояния (`creating`, `starting`, `stopping`, `deleting`) — со спиннером и шагом активной операции (`activeOperation.kind`). `error` — красным, с `error.message` во всплывающей подсказке. `degraded` — жёлтым, с `healthReason`. Заблокированная оператором — значок замка с причиной.
- Действия строки: Stop / Resume (по состоянию), Fork, Open terminal, Delete (подтверждение вводом slug).

### 9.5 Создание sandbox

```
New sandbox
 Template   (o) linux — Ubuntu 24.04         ( ) windows — Windows 11 (disabled by operator: hidden)
 Size       [2gb · 2 vCPU · 2048 MB v]        (only allowedSizes of the template)
 From       (o) template  ( ) saved snapshot [web-stack v]
 Name       [ci-run-42        ]   Slug [auto: three words   ]  (optional, live validation)
 Environment [default: base v | none]                           (wave 2)
 Labels     [k=v] [+]
 Env vars   [KEY] [value] [+]        Secrets [KEY] [value •••] [+]   Secret files [upload] (name, mode, link path)
 Lifetime   TTL [none v]   Idle stop after [15 min v]
                                                              [Cancel] [Create]
```

- Каталог — `GET /v1/templates`, `GET /v1/sizes`, снапшоты — `GET /v1/snapshots`.
- `POST /v1/sandboxes` с `Idempotency-Key` (SDK ставит сам) → переход на страницу sandbox, где виден ход операции. Ошибки (`quota_exceeded`, `out_of_capacity`, `slug_taken`, `template_unavailable`) — понятным текстом у формы, `out_of_capacity` — с предложением повторить.
- Секреты в форме не попадают ни в URL, ни в `localStorage`, ни в логи клиента; поля — `type=password` с кнопкой «показать».

### 9.6 Страница sandbox

Заголовок: имя, slug (с кнопкой переименования, `PATCH slug`), состояние, здоровье, активность, шаблон и версия, размер, `origin`, labels, TTL/дедлайн, idle-таймаут, кнопки Stop/Resume/Fork/Recover/Extend/Save snapshot/Delete. Активная операция — полоска с `kind` и `step`; `error` — блок с кодом, сообщением и кнопкой Recover, если применимо.

Живое состояние: цикл long-poll `GET /v1/sandboxes/{slug}?waitFor=<все состояния, кроме текущего>&waitSeconds=30` (S7 §5.10); здоровье и активность long-poll не будят, поэтому ещё и опрос раз в 10 s. Операция, запущенная кнопкой, ждётся через `waitForOperation`.

**Overview.** Свойства, endpoints (`portUrlTemplate`, SSH-команда), последние 10 команд, опубликованные порты.

**Terminal.**
- Кнопка «New terminal» → `POST /ptys {cols, rows}` (`Idempotency-Key`), затем WebSocket `wss://app.<domain>/api/v1/sandboxes/{sb}/ptys/{cmd}/connect?team=…` с subprotocol `sbx.pty.v1` (S7 §10.2) через `sb.pty()` SDK.
- xterm.js 6 + `addon-fit` (размер по контейнеру, `resize` кадром), `addon-web-links`, `addon-search`; копирование и вставка средствами браузера.
- Вкладки терминалов внутри страницы. Открытые PTY sandbox — `GET /commands?mode=pty&status=running`; после перезагрузки страницы дашборд переподключается к ним с `tailBytes = 64 KiB`. PTY без клиента закрывается агентом через 10 min (S7 §10.1) — об этом подсказка у кнопки закрытия вкладки («Detach» оставляет процесс, «Close» шлёт `exit` через `kill`).
- Переподключение — SDK (по offset); во время паузы — полоска «reconnecting…». Коды закрытия `4409`/`4503` — понятный текст и кнопка повтора.

**Commands.**
- Таблица `GET /commands` (статус, команда, код выхода, длительность, кто запустил, tags); фильтр по статусу.
- «Run command»: строка команды, cwd, user, env, таймаут → `sb.start()` (detached, `Idempotency-Key`), затем вывод.
- Просмотр вывода — xterm.js в режиме только чтения (ANSI-цвета, большой объём): `cmd.follow({ from: "start" | tail })` по NDJSON, stdout и stderr в одном окне, stderr подсвечен (переключатель «только stdout/stderr»). Кадры `truncated` показываются строкой «… начало вывода вытеснено». Для завершённых команд — `follow=false`. Ссылка «Download stdout/stderr» ведёт на `/output?stream=…&offset=…&limit=4194304&team=…` (S7 §9.4) и отдаёт кусок до 4 MiB с выбранного offset (по умолчанию — последние 4 MiB); полного файла вывода одной ссылкой в v1 нет [решение S8].
- Kill / Signal для запущенных.

**Files.**

```
/home/user/my-app                                   [Upload] [New folder] [Refresh]
 ..
 [d] src/             -          2026-10-29 12:00   drwxr-xr-x  user
 [f] package.json     1.2 KB     2026-10-29 11:58   -rw-r--r--  user   [Download] [Rename] [Delete]
```

- `GET /files/list` (с пагинацией), хлебные крошки, переход по каталогам, показ скрытых файлов.
- Просмотр текстового файла до 1 MiB: `GET /files/content` с `Range: bytes=0-1048575`, отображается как текст в `<pre>` (никогда как HTML или через `<iframe>`); бинарный или больший — только скачивание. Редактирования в v1 нет (фаза 2).
- Скачивание — ссылка на `/api/v1/sandboxes/{sb}/files/content?path=…&team=…` (S7 отдаёт `Content-Disposition: attachment`).
- Загрузка: drag-and-drop или кнопка; файлы до 64 MiB — `PUT /files/content`, больше — `sb.files.upload()` чанками с прогрессом и докачкой. Каталоги целиком не загружаются (подсказка про `sbx push`).
- Mkdir, Move/Rename, Delete (рекурсивно — с подтверждением).

**Ports.**

```
Hosted
 3000  https://quiet-otter-lamp-3000.sbx.example.com   access [token v]  [Copy URL] [Rotate token] [Unpublish]
Listening (not published)
 5173  node (vite)  127.0.0.1                                              [Publish...]
```

- `GET /ports`; публикация `PUT /ports/{port}` с выбором `access` (`token`, `sso`, `public`) и `hostRewrite`; `public` недоступен с подсказкой, если `publicPortsEnabled` выключен (`403 public_disabled`).
- Токен и `urlWithToken` показываются **один раз** в диалоге после публикации или ротации (с кнопкой копирования и пояснением, что потом его не увидеть). Заблокированный порт — замок и причина.
- Ссылка «Open» открывает URL в новой вкладке. Встраивание превью в iframe — не в v1.

**SSH.** `GET /sandboxes/{sb}/ssh`: команда подключения, строки `known_hosts` с кнопкой копирования, `hasKeys: false` — ссылка на SSH-ключи аккаунта.

**Env.** `GET /env`: таблица env (значения видны), имена секретов (значения — «•••», никогда не приходят), secret-файлы (имя, режим, путь). Правка — построчно через `PATCH /env` с merge-семантикой [изменение S7 C2]: изменить или удалить один секрет, не зная остальных. Ответ `delivered: false` → подсказка «применится при следующем запуске».

**Desktop** (только при capability `desktop`): заглушка «рабочий стол появится в S10» с местом под iframe; контракт iframe задаёт S10.

### 9.7 Saved snapshots

Таблица `GET /v1/snapshots` (имя, состояние, источник, шаблон и версия, размер, согласованность, создан); «Create sandbox from» → форма create с выбранным снапшотом; Delete. Сохранение — со страницы sandbox (имя, предупреждение о замене снапшота с тем же именем, S7 §13). Шаринга между командами в фазе 1 нет [решение S8, одобрено].

### 9.8 API-ключи

```
API keys (team platform-dev)                                           [+ New key]
 name           prefix…last4    scopes      created via  expires      last used   
 cli: ilia-mbp  sbx_a1B2…9xYz   full        cli          2027-01-27   2 min ago   [Rotate] [Revoke]
```

- `GET /v1/api-keys`; `owner` переключает «мои / все ключи команды» (`?all=true`, [изменение S7 C5]).
- Создание: имя, пресет (`read-only`, `ci`, `full`) или выбор scopes галочками, срок (по умолчанию 90 дней, максимум 365, S7 §7.2). Секрет — один раз в диалоге с копированием и примерами `export SBX_API_KEY=…` и `sbx login --key-stdin`.
- Rotate (новый секрет в том же диалоге), Revoke (подтверждение). Отозванные и просроченные — свёрнуты внизу.

### 9.9 Аккаунт и команда

- **SSH-ключи** (`/app/account`): `GET/POST/DELETE /v1/ssh-keys`; добавление — вставка публичного ключа, ошибки `ssh_key_in_use`, неподдерживаемый тип — текстом.
- **Команда по умолчанию** — server action.
- **Команда** (`/app/t/<team>/settings`): имя (переименовать — `owner`), участники (email, имя, роль, «ещё не входил», последний вход), пригласить по email с ролью, сменить роль, удалить, выйти; квота и использование (`/v1/limits`). `member` видит список участников без действий.
- **Новая общая команда** (`/app/teams/new`): имя → server action → переход в неё.

### 9.10 Раздел «Оператор» [решение Q3]

`/app/operator`, только `isOperator` сессии:
- Все sandbox всех команд: `GET /v1/sandboxes?allTeams=true` с фильтрами `teamId`, `state`, `q` [изменение S7 C3]; колонка команды (имя команды берётся из Payload в серверном `layout`, список команд передаётся клиенту).
- Действия: Block / Unblock sandbox (причина `operator` или `abuse` и заметка), Block / Unblock отдельного порта, Stop, Delete (с `Sbx-Team` команды sandbox, S7 §7.4). Переход в страницу sandbox любой команды.
- Ссылка на `/admin` для конфигурации.
- Состояние пула и нод — фаза 2; до тех пор `sbx-admin pool status` (S6 §15.3).

### 9.11 Server actions

| Action | Кто | Что |
|---|---|---|
| `createTeam(name)` | любой, лимит `maxOwnedTeamsPerUser` | team + membership `owner` |
| `renameTeam(teamId, name)` | `owner`, оператор | |
| `inviteMember(teamId, email, role)` | `owner`, оператор; не в личную команду | user-заготовка при необходимости + membership |
| `setRole(membershipId, role)` | `owner`, оператор | правило последнего `owner` |
| `removeMember(membershipId)` / `leaveTeam(teamId)` | `owner`, оператор / сам участник | правило последнего `owner`; личную команду покинуть нельзя |
| `setDefaultTeam(teamId)` | сам пользователь, команда из его списка | |

Каждое действие: пользователь — из `payload.auth({ headers })` (та же стратегия), права проверяются по `memberships` в той же транзакции, вход валидируется zod, запись — Local API с `overrideAccess: true` и `req` (чтобы хуки `NOTIFY` шли в транзакции). Ответ — `{ok}` или `{error: {code, message}}` с кодами `forbidden`, `not_found`, `validation`, `last_owner`, `team_limit`, `already_member`.

## 10. Environments (вторая очередь MVP) [решение Q2]

### 10.1 Смысл

Environment — именованный набор настроек команды, который новая sandbox получает при создании: `env`, `secrets`, `secretFiles` (те же три набора, что у sandbox, S7 §8.3). Позже сюда же добавятся репозитории и учётные данные git (S13).

- У команды может быть одна environment по умолчанию.
- При create (`POST /v1/sandboxes`) поле `environment`: имя → эта environment; отсутствует → environment команды по умолчанию, если есть; `null` → никакой [изменение S7 C1].
- Значения **копируются** в `sandbox_secrets` при create; поверх каждого набора накладываются значения из самого запроса (тот же ключ — побеждает запрос; secret-файлы — по имени). Лимиты S7 §8.3 проверяются на результате слияния.
- Версий и автообновления, как у boat, нет [решение S8]: изменение environment действует только на новые sandbox. Sandbox помнит, из какой environment и какой ревизии создана (`environment: {id, name, revision}` в ресурсе Sandbox), дашборд показывает «environment изменилась после создания». Применить заново — фаза 2.
- Fork наследует env и секреты источника (S6 §7.7), а не environment. Create из saved snapshot берёт environment как обычный create.
- Удаление environment не трогает sandbox, созданные из неё.
- **От участников команды секреты environment не скрыты** [решение S8 по ревью, как у boat]: любой, кто может создать sandbox и выполнить в ней команду, прочитает `env` внутри. Роль `owner` для записи защищает целостность (кто меняет, что получат все), а не конфиденциальность. Environment по умолчанию применяется ко всем create команды, включая create по API-ключам агентов и CI: в этом её смысл (агент получает нужные ключи без передачи в каждом запросе). Для существующих клиентов поведение не меняется, пока `owner` не назначит environment по умолчанию; клиент, которому она не нужна, передаёт `environment: null`.

### 10.2 API [изменение S7 C1]

| Метод и путь | Что | Scope |
|---|---|---|
| `GET /v1/environments` | список команды: `{id, name, isDefault, revision, envKeys, secretKeys, secretFiles[{name, mode, linkPath, sizeBytes}], createdAt, updatedAt, updatedBy}` | `sandboxes:read` |
| `GET /v1/environments/{environment}` | то же + значения `env` (не секретов) | `sandboxes:read` |
| `POST /v1/environments` | `{name, isDefault?, env?, secrets?, secretFiles?}` → `201` | `environments:write` + роль `owner` |
| `PATCH /v1/environments/{environment}` | `{name?, isDefault?, env?, secrets?, secretFiles?}`; наборы — merge, `null` удаляет ключ (как `PATCH /env`, C2); `revision+1` | `environments:write` + `owner` |
| `DELETE /v1/environments/{environment}` | `204` | `environments:write` + `owner` |

- `{environment}` — ID (`env_...`) или имя; имя `^[a-z0-9][a-z0-9-]{0,62}$`, уникально в команде.
- Новый scope `environments:write` входит только в пресет `full`. Роль `member` получает `403 forbidden` (`details.reason: "role"`), даже если scope есть: роль проверяется для сессий и для ключей.
- Значения секретов не отдаются никогда; логгер `api` вырезает `env`, `secrets`, `secretFiles` (как S7 §8.3).
- CLI (`sbx env-sets list|show|create|set|unset|rm`, `sbx create --environment`) и SDK получают это из OpenAPI; имена команд CLI — исполнителю S7/S8.

### 10.3 Хранение [изменение S6 S1]

```
environments(                       -- schema runtime, migration in the S8 range (§17.3)
  id uuid pk,                       -- uuidv7, public env_...
  team_id uuid, name text,
  is_default bool,
  revision int,                     -- +1 on every change
  env_keys text[], secret_keys text[], secret_files jsonb,  -- names and metadata only, for listing
  key_version int, nonce bytea, ciphertext bytea,           -- AES-256-GCM blob {env, secrets, secretFiles}, S6 §13.1
  created_by uuid, updated_by uuid,
  created_at, updated_at, deleted_at null)
unique (team_id, name) where deleted_at is null
unique (team_id) where is_default and deleted_at is null
```

- Шифрование и кольцо ключей — как `sandbox_secrets` (S6 §13.1), AAD = `environment:<id>:v<keyVersion>`; ротация ключа перешифровывает и эти строки (тот же контроллер cleanup).
- Сервис — `EnvironmentService` в `packages/core` (`list`, `get`, `create`, `patch`, `delete`, `resolveForCreate(teamId, name|undefined|null)`); `SandboxService.create` вызывает `resolveForCreate` и сливает наборы до шифрования `sandbox_secrets`.
- Значения не попадают в `operations.request`, `idempotency_keys.response`, логи и метрики (S6 §13.1). Hash идемпотентности create считается от тела запроса (с именем environment, без её значений).
- В `sandboxes` добавляются `environment_id uuid null`, `environment_revision int null`.

## 11. Сроки распространения изменений

| Изменение | Где действует | Срок |
|---|---|---|
| Отзыв ключа, удаление участника, деактивация пользователя в `/admin` | новые запросы `api` | сразу по `NOTIFY`, не позже 30 s (S7 §7.2) |
| То же | уже открытые стримы и PTY `api` | закрываются по `NOTIFY` (кадр `error` `unauthorized` / close `4401`) [изменение S7 C9] |
| То же | SSH-сессии gateway | живут до конца (до 15 min при деплое, иначе до разрыва); новые входы отклоняются сразу. Принудительный разрыв — фаза 2 |
| Деактивация пользователя в `/admin` | `web`, сессии `api` | сразу по `NOTIFY`, не позже 30 s |
| Деактивация пользователя | `sso`-порты | до 12 h (cookie gateway, S4 §8.4); немедленный отзыв — фаза 2 (§18) |
| Выключение пользователя или снятие группы в IdP | браузер (`web`, `api`) | не позже `cookie-refresh` (5 min) + 30 s кэша (§5.1) |
| Выключение пользователя в IdP | API-ключи | после деактивации оператором в `/admin` — сразу; без неё — через `apiKeyOwnerInactivityDays` (30 дней) без браузерной сессии (§20, ждёт подтверждения Ильи) |
| Шаблоны, размеры, квоты, цели пула, `PlatformDefaults` | `api`, `worker` | сразу по `NOTIFY`, не позже 10 s (S6 §5.11) |
| `publicPortsEnabled`, `ssoPortPolicy` | gateway | ≤ 1 s (§8) |
| Блокировка sandbox или порта оператором | gateway, SSH | сразу (триггер `sbx_routes`, S4 §6.2) |

## 12. Миграции схемы `payload`

- Миграции Payload (`payload migrate:create`) лежат в `packages/payload/src/migrations` и коммитятся; `push: false` везде, в dev тоже [решение S8]: схема в dev и в проде одинаковая, а drift ловит CI (`payload migrate:create --skip-empty` без изменений → пусто).
- Первая миграция создаёт схему `payload`, таблицы, сид `platform-defaults`, сид шаблона `linux` и размера `2gb` (PoC, S6 §9.1), цель пула `linux/2gb = 1`.
- Миграции применяет **один** Kubernetes Job (`web-migrate`, образ `web`, команда `payload migrate`) до выката `web`, `api`, `worker` (Helm hook или шаг пайплайна, S12). Адаптер Payload не берёт advisory-блокировку, поэтому миграции при старте подов не выполняются (`prodMigrations` не используются). Порядок с миграциями runtime (`db/migrations`, раннер S6) любой: схемы не ссылаются друг на друга внешними ключами.
- **Expand/contract** [решение S8 по ревью]: миграция не ломает предыдущую версию кода (новые столбцы — nullable или с default; удаление и переименование — отдельным релизом после того, как старый код ушёл). Поэтому при rolling deploy старые поды продолжают работать на новой схеме.
- `api`, `worker` и `web` при старте и в readiness проверяют, что **все миграции, известные их коду, применены** (более новые, неизвестные коду, допустимы); иначе `/readyz` (`/healthz` у `web`) отвечает ошибкой: новый под не принимает трафик до Job миграций.
- Роли Postgres [решение S8, настраивает S12]: Job миграций — отдельная роль `sbx_payload_migrate` (DDL в `payload`). `sbx_web` — DML в `payload`, кроме `INSERT` в таблицы `api_keys` и `ssh_keys` (`web` их никогда не создаёт), без доступа к `runtime`, `tunnel`, `pgboss`. `api` и `worker` — DML в `payload` (Local API пишет ключи, SSH-ключи, пользователей).

## 13. Локальная разработка

- **Dev-прокси** `apps/web/dev/auth-proxy.ts` (Node, без зависимостей сверх `node:http`) изображает ingress + oauth2-proxy:
  - слушает только `127.0.0.1:3000` (отказывается от других адресов);
  - на каждом запросе вырезает присланные `X-Auth-Request-*` и ставит их из dev-cookie `sbx_dev_identity`;
  - `/__dev/login` — страница выбора личности: email, имя, группы (готовые кнопки «user», «second user», «operator»); `/__dev/logout`;
  - маршруты как в проде (§5.1): `/api/*` → `127.0.0.1:8081` без `/api`, `/cli/*` и `/sbx-auth/*` → `127.0.0.1:8081`, остальное → `next dev` на `127.0.0.1:3001`; WebSocket upgrade проксируется.
- В `web` и `api` нет ни флагов, ни веток кода «dev auth»: они получают те же заголовки, что в проде. Каталог `dev/` исключён из сборки образа (`.dockerignore`, проверка в CI, что в `.next/standalone` нет `auth-proxy`).
- `pnpm --filter @sbx/web dev` поднимает `next dev` и прокси; Postgres — из общего dev-окружения S6 (docker compose или testcontainers); `api` с `PayloadIdentityStore` — по инструкции S7. Без `api` работают `/admin` и страницы команд, дашборд sandbox показывает «API недоступен».
- `SBX_OPERATOR_GROUPS` в dev — `sbx-operators`.

## 14. Сборка и деплой (форма; детали — S12)

### 14.1 Образ

- Next `output: "standalone"`, образ `sbx-web` (Node 26 slim, непривилегированный пользователь). В том же образе — CLI Payload для Job миграций.
- Конфигурация через env: `DATABASE_URL`, `PAYLOAD_SECRET` (Payload требует, хотя JWT не используются), `SBX_APP_ORIGIN`, `SBX_OPERATOR_GROUPS`, `SBX_SBX_DOMAIN` (для CSP `frame-src`), `SBX_API_PUBLIC_URL` (подсказки в UI). Секретов данных (`SBX_DATA_KEYS_FILE`) у `web` нет.

### 14.2 Kubernetes

- Deployment `web`: 2 реплики, exec-пробы readiness/liveness на `/healthz` (§5.1), `terminationGracePeriodSeconds: 30`.
- Job `web-migrate` (§12).
- NetworkPolicy: вход в `web :3000` — только от подов oauth2-proxy (без адресов нод); выход — Postgres.
- `api` и `worker` подключают `@sbx/payload` как библиотеку; им нужны `DATABASE_URL`, `PAYLOAD_SECRET`, `SBX_OPERATOR_GROUPS` (`api`).
- oauth2-proxy: upstream-режим, alpha config (§5.1), `--cookie-name=__Host-oauth2_proxy`, `--upstream-timeout ≥ 660s` (S7 §17.6), WebSocket. Ingress: HTTP/2, буферизация ответа выключена для NDJSON (S7 §17.6).

### 14.3 Граница данных `web`

`web` читает и пишет только схему `payload`. Runtime-данные он получает только из браузера пользователя через `api`. Это правило архитектуры («с sandbox работает только через `apps/api`») и ограничение ущерба: у `web` нет ключей данных и доступа к `runtime`, поэтому из него нельзя массово выгрузить зашифрованные секреты sandbox и environments. Полной изоляции нет, и это записано честно: скомпрометированный `web` может записать себе членство в любой команде, а дальше через API получить доступ к её sandbox (в том числе прочитать env изнутри). Запрет `INSERT` в `api_keys`/`ssh_keys` (§12) лишь не даёт ему выпустить ключ в обход `api`.

## 15. Тесты и приёмка

**Unit (vitest):**
- разбор заголовков (§5.2): регистр email, группы через запятую и повторами, пустые значения;
- `resolveSession`: создание, заготовка → полноценный пользователь, деактивированный, смена `idpSubject`, группы → `isOperator` и обратно, отсутствие лишних записей на повторных запросах;
- права server actions по таблице §6.2, правило последнего `owner`, лимит команд, приглашение в личную команду запрещено;
- слияние environment с запросом create и лимиты после слияния (в `packages/core`).

**Интеграционные** (Postgres 18, Payload с миграциями, без Next):
- одновременные первые запросы одного пользователя (10 параллельных) → один пользователь, одна личная команда;
- **контрактный набор `IdentityStore`** в `packages/auth` — один набор тестов, который проходят `StaticIdentityStore` (S7) и `PayloadIdentityStore`; аналогично для `ConfigReader` (`StaticConfigReader` и `PayloadConfigReader`);
- `NOTIFY`: слушатель получает уведомление только после коммита и читает новые данные; откат записи — уведомления нет; изменение `publicPortsEnabled` даёт `sbx_config` и `sbx_routes '*'`;
- доступ к REST Payload (`/cms-api/*`): пользователь без группы оператора получает `403` на чтение и запись каждой коллекции и global; создание `api-keys` в админке запрещено всем;
- таблицы схемы `payload` не пересекаются по именам с `runtime`, `tunnel`, `pgboss` после всех миграций;
- миграции: чистая БД → последняя версия; повторный запуск ничего не делает; дрейф схемы в CI.

**E2E** (Playwright: dev-прокси, `web`, `api` с `PayloadIdentityStore`, `packages/core` с фейком worker и фейковый агент S7 §16):
- вход новым пользователем → личная команда → create → `ready` → терминал: эхо, resize, перезагрузка страницы и переподключение без потери вывода;
- команда: запуск, живой вывод, kill; файлы: загрузка 100 MiB чанками, скачивание, просмотр текста, переименование, удаление;
- порт: публикация `token` (токен виден один раз), ротация, `public` при выключенном переключателе — понятная ошибка;
- API-ключ: создание → `curl https://…/v1/me` с ним работает → отзыв → `401`;
- команды: `owner` приглашает email → второй пользователь входит и видит sandbox команды; `member` не видит кнопок управления, а прямой вызов server action даёт `forbidden`;
- оператор: видит sandbox чужой команды, блокирует её → маршрут gateway (фейк или S4) получает `blocked`; владелец получает `sandbox_blocked` на exec, fork, save snapshot, resume, rename и может только читать, остановить, удалить; снять и заново опубликовать заблокированный порт нельзя; не-оператор получает `403` на `/app/operator`, `/admin` и `GET /v1/sandboxes?allTeams=true`; API-ключ оператора не даёт операторских прав;
- `ssoPortPolicy` `any` → `team`: старая `sso`-cookie постороннего пользователя перестаёт действовать (эпоха выросла); выключение `public` → `routes.lookup` сразу отдаёт `blocked`;
- отзыв ключа при открытом стриме и PTY → стрим получает `error unauthorized`, PTY закрывается `4401`;
- вход: смена email в IdP при том же `sub` обновляет пользователя; чужой `sub` с занятым email → `403`;
- environments (вторая очередь): создание `owner`-ом, create с ней, значения в госте (фейковый агент получил наборы), `member` не может изменить, значения секретов нигде в ответах.

**Безопасность:**
- запрос к `web` без `X-Auth-Request-Email` → `401`; присланный клиентом `X-Auth-Request-Email` вырезается прокси (dev-прокси повторяет поведение oauth2-proxy; в стенде S12 — тот же тест против настоящего oauth2-proxy);
- server action и `POST /cms-api/*` с чужим `Origin` → `403`;
- ни один ответ `web` и `/cms-api` не содержит `secretHash`, значений секретов, токенов портов (поиск по ответам E2E);
- образ `sbx-web` не содержит `auth-proxy`.

**Критерий готовности S8 (MVP, первая очередь):** unit, интеграционные и E2E-тесты проходят; `api` работает с `PayloadIdentityStore` и `worker`/`api` — с `PayloadConfigReader` на стенде `pve`; сценарий «новый пользователь → терминал за минуту» проходит вручную через настоящий oauth2-proxy и IdP (S12).

## 16. Библиотеки

Проверено 2026-10-29 (`npm view`, релизы GitHub); при реализации перепроверить.

| Назначение | Библиотека | Версия |
|---|---|---|
| CMS и админка | `payload`, `@payloadcms/next`, `@payloadcms/ui` | 3.92.1 |
| Postgres-адаптер (`idType: "uuidv7"`, `schemaName`) | `@payloadcms/db-postgres` (внутри `drizzle-orm` 0.45.2, `pg` 8.20.0) | 3.92.1 |
| Фреймворк (peer Payload: `>=16.3.3 <17`) | `next` | 16.4.3 |
| UI | `react`, `react-dom` | 19.3.1 |
| Стили и компоненты | `tailwindcss` / `shadcn` (CLI) | 4.3.3 / 4.23.0 |
| Данные на клиенте | `@tanstack/react-query` | 5.105.0 |
| Терминал и вывод | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-search` | 6.0.0, 0.11.0, 0.12.0, 0.16.0 |
| Клиент API | `@sbx/sdk` (S7) | workspace |
| Валидация | `zod` | как в S7 (4.6.7) |
| E2E | `@playwright/test` | 1.64.1 |
| Unit | `vitest` | 5.0.5 |
| Прокси аутентификации (S12) | oauth2-proxy | v7.15.5 |

Версии `drizzle-orm` и `pg` внутри адаптера Payload (0.45.2, 8.20.0) отстают от выбранных S6 (0.45.4, 8.23.1); одна мажорная линия, конфликта нет, pnpm держит обе. Исполнитель сверяет при реализации.

Отвергнуто:
- Auth.js / NextAuth в `web`: второй вход рядом с oauth2-proxy, своя cookie на основном домене; oauth2-proxy уже нужен `api` и SSO портов.
- Локальная стратегия Payload (пароли) и JWT-cookie Payload: лишняя учётная запись и cookie, которую пришлось бы защищать по S4 §14.1.
- UI-компоненты Payload (`@payloadcms/ui`) для `/app`: они рассчитаны на админку и тянут её контекст; shadcn/ui проще кастомизировать.
- Monaco для просмотра файлов и логов: тяжёлый; для v1 хватает `<pre>` и xterm.js.

## 17. Изменения в других спеках

### 17.1 S7 (`apps/api`, `packages/auth`, SDK, CLI)

| # | Что | Подробно |
|---|---|---|
| C1 | Environments: ручки `/v1/environments`, scope `environments:write` (в пресете `full`), поле `environment` в `POST /v1/sandboxes`, поле `environment {id, name, revision}` в ресурсе Sandbox, префикс ID `env_` | §10.2 |
| C2 | `PATCH /v1/sandboxes/{sandbox}/env` — merge по ключам (`{env?: {K: v \| null}, secrets?: {K: v \| null}, secretFiles?: {name: file \| null}}`, `null` удаляет), ответ как у `PUT /env`. `PUT /env` остаётся | §9.6 Env |
| C3 | Операторские ручки, только для сессии оператора (`403 forbidden` для остальных и для любых API-ключей): `GET /v1/sandboxes?allTeams=true[&teamId=]`; `POST /v1/sandboxes/{sandbox}/block {reason: "operator" \| "abuse", note?}` и `/unblock`; `POST /v1/sandboxes/{sandbox}/ports/{port}/block {reason, note?}` и `/unblock`. В ресурсах Sandbox и HostedPort — `blocked`, `blockReason`. Снять блокировку может только оператор. Заметка — в `sandbox_events`. Семантика — ниже | §9.10 |
| C4 | Proxied listener принимает команду в query `team=team_...` для `GET`/`HEAD` и WebSocket upgrade (браузер не ставит заголовки). Если есть и заголовок, и query, они должны совпадать (`400 validation`) | §9.2 |
| C5 | `GET /v1/api-keys?all=true` и `DELETE /v1/api-keys/{key}` для чужого ключа той же команды разрешены `owner` команды (а не только оператору) | §9.8 |
| C6 | `Principal.isOperator = true` только для браузерной сессии; у principal-а по API-ключу — всегда `false`. `ssh/authorize` пускает только участников команды sandbox (правило «или оператор» из S7 §12.1 убирается) | §5.5 |
| C7 | `routes.lookup` читает `publicPortsEnabled`, `ssoPortPolicy`, `ssoPolicyEpoch` без кэша; для `sso`-маршрутов `authEpoch = hosted_ports.auth_epoch + ssoPolicyEpoch`, то же значение — в `port_auth_codes` и проверке SSO (S7 §7.7) | §8 |
| C8 | `resolveSession` у деактивированного пользователя → `403 forbidden` (`details.reason: "user_disabled"`), а не JIT; у `SessionIdentity` есть `defaultTeamId`; `X-Auth-Request-User` (`sub`) обязателен, поиск — §5.3 | §5.3 |
| C9 | `api` ведёт реестр открытых NDJSON-стримов и PTY WebSocket по `(userId, apiKeyId, teamId)` и по `NOTIFY sbx_identity` закрывает те, чей principal больше не проходит проверку (ключ отозван, участник удалён, пользователь деактивирован): кадр `error` с `code: unauthorized`, `retryable: false` / close `4401` | §11 |

**Семантика блокировки (C3)** [решение S8 по ревью]:
- **Sandbox заблокирована:** все её маршруты приходят gateway с `blocked: true` и её `blockReason` (S4 §6.1); `ssh/authorize` отказывает. Для всех, кроме оператора, разрешены только чтение (get, list, operations, список команд, вывод команд, чтение и список файлов, `GET /env`, `GET /ports`) и `stop`, `delete`. Остальное — `403 forbidden` с `details.reason: "sandbox_blocked"`: exec и PTY, запись файлов, публикация и смена режима портов, `resume`, `fork`, `recover`, `extend`, save snapshot, `PUT`/`PATCH /env`, `PATCH` (в том числе slug). Так блокировку нельзя обойти через fork, снапшот или переименование.
- **Порт заблокирован:** gateway получает `blocked: true`. Для всех, кроме оператора, `PUT /ports/{port}`, `rotate-token` и `DELETE /ports/{port}` этого порта — `403 forbidden` (`details.reason: "port_blocked"`): блокировка переживает попытку снять и заново опубликовать порт.
- Оператор может всё; `unblock` снимает ограничения сразу (триггер `sbx_routes`).

| C10 | Проверка ключа: если `users.lastLoginAt` владельца старше `apiKeyOwnerInactivityDays` (`PlatformDefaults`; `null` выключает) — `401 unauthorized` с `details.reason: "owner_inactive"`; CLI и SDK показывают подсказку войти в дашборд. Ждёт подтверждения Ильи (§20) | §20 |

Исполнитель: изменения C1–C10 вносит исполнитель S8 в `apps/api` (по прецеденту S7 §20.2), согласуя с треком `s7-impl`; если `s7-impl` ещё не слит — передаёт ему как дополнения к замороженному интерфейсу. OpenAPI регенерируется, `oasdiff` не должен находить ломающих изменений (всё — добавления). C6 и семантика блокировки — уточнения поведения, а не формы API.

### 17.2 S6 (`packages/core`, `db/migrations`)

| # | Что |
|---|---|
| S1 | Таблица `runtime.environments` и `EnvironmentService` (§10.3); в `sandboxes` — `environment_id`, `environment_revision`; `create` принимает `environment` и сливает наборы до шифрования; ротация ключей данных перешифровывает и `environments` |
| S2 | `patchEnv(p, id, patch)` — merge по ключам внутри `core` (расшифровать, слить, зашифровать), с доставкой агенту как у `updateEnv` |
| S3 | `teamQuota(teamId)` = `teams.quota` с подстановкой `PlatformDefaults.defaultQuota` для пустых полей; несуществующая команда → нули |
| S4 | Блокировки: столбцы и триггер уже входят в добавление S7 §20.2 п. 3 (`hosted_ports.blocked`, `block_reason`, «блокировка sandbox оператором»); S8 их не дублирует, а уточняет: в `sandboxes` — `blocked bool`, `block_reason text null`, `blocked_at`, `blocked_by uuid null`; триггер `sbx_routes` (S7 O7) срабатывает и на изменение этих полей; `routes.lookup` отдаёт `blocked` = блокировка порта ИЛИ блокировка sandbox ИЛИ `public` при выключенном `publicPortsEnabled`, причина — в этом порядке; проверки семантики блокировки (§17.1) в `SandboxService`; `list` с `allTeams` для операторов. Кто первый реализует (S7 или S8) — по готовности треков, второй использует |
| S5 | `ConfigReader.defaults()` возвращает и поля S7/S8 `PlatformDefaults` (§7) |

### 17.3 Миграции runtime

По прецеденту S7 §20.2: изменения таблиц S6 (`sandboxes.environment_*`, `sandboxes.blocked*`, триггеры) — миграциями в диапазоне S6 **0200–0299**, согласованно с `s6-impl`. Новые таблицы S8 (`environments`) — в диапазоне **0400–0499** [решение S8, продолжение S6 §5.12 / S7 O6].

В Payload блокировок нет [уточнение S7 §17.3]: блокировки — runtime-данные, их пишет `api` по операторским ручкам C3. В Payload живёт только глобальный `publicPortsEnabled`.

### 17.4 S4

Нет изменений: `blockReason` уже содержит `operator`, `public_disabled`, `abuse` (S4 §6.1); `'*'` в `sbx_routes` шлёт хук S8 (§8).

### 17.5 S12

oauth2-proxy в upstream-режиме с alpha config (§5.1): заголовки из claims (`X-Auth-Request-User` = `sub`), маршрутизация по путям, `--cookie-refresh` ≤ 5 min, `--cookie-expire` ≤ 12 h, только подтверждённый email; HTTP/2 на ingress; Job миграций Payload до выката; роли Postgres (§12); exec-пробы и NetworkPolicy для `web` только от oauth2-proxy (§5.1, §14.2); группа операторов (`SBX_OPERATOR_GROUPS`) в IdP.

### 17.6 `docs/architecture.md`

§3: environments команды хранятся в `runtime` зашифрованными, конфигурационные коллекции перечислены полнее; §10: роль оператора действует только в браузерной сессии, oauth2-proxy маршрутизирует `/api/*` в `api` и остальное в `web`.

## 18. Фазы

| Фаза | Что входит |
|---|---|
| **MVP, первая очередь** | `packages/payload` (коллекции, стратегия, JIT, хуки), `PayloadIdentityStore`, `PayloadConfigReader`, миграции и Job; `/admin`; `/app`: список и создание sandbox, страница sandbox (overview, terminal, commands, files, ports, ssh, env, заглушка desktop), снапшоты, API-ключи, SSH-ключи, команды и участники, раздел «Оператор»; изменения S7 C2–C10 и S6 S2–S5; dev-прокси; образ и форма деплоя |
| **MVP, вторая очередь** | Environments: S7 C1, S6 S1, страница `/app/t/<team>/environments`, выбор при create |
| **Фаза 2** | Синхронизация пользователей и команд с IdP (автоматическая деактивация уволенных, группы → команды); принудительный разрыв SSH-сессий при отзыве; состояние пула и нод в разделе «Оператор»; немедленный отзыв `sso`-сессий пользователя (`authEpoch+1` на его маршрутах); повторное применение environment к живой sandbox; редактор файлов; превью порта в iframe; полный файл вывода команды; рабочий стол (S10); репозитории в environment (S13); аудит действий в `/admin` |

## 19. Оставлено исполнителю

- Раскладка файлов в `apps/web` и `packages/payload`; вёрстка и визуальный стиль `/app` (без внешних шрифтов и CDN, всё с своего origin).
- Точный список директив CSP с учётом требований админки Payload.
- Как именно выполнить `NOTIFY` в транзакции запроса через API адаптера Payload (сессия по `req.transactionID`); если API адаптера изменится — эквивалентный способ с тем же свойством «только после коммита».
- Как стратегия отличает запросы Payload admin от `/app` для страницы «нет доступа» (кастомный view `unauthorized`).
- Работают ли `cookiePrefix: "__Host-payload"` и служебные cookie админки с этим префиксом (§5.4).
- Имена команд CLI для environments.
- Метрики `web` (минимум): запросы по маршруту и статусу, отказы аутентификации по причине, длительность `resolveSession`, ошибки server actions по коду.

## 20. Открытые вопросы

- **Увольнение и выключение в IdP — текущее решение, ждёт подтверждения Ильи.** В MVP:
  1. процесс увольнения включает шаг «деактивировать пользователя в `/admin`» (ключи сразу перестают работать, S7 §7.2);
  2. страховка: API-ключи пользователя перестают работать, если у него не было браузерной сессии через oauth2-proxy дольше `apiKeyOwnerInactivityDays` (30 дней, `platform-defaults`; `lastLoginAt` обновляет `resolveSession`, §5.3). Ответ — `401 unauthorized` с `details.reason: "owner_inactive"`; CLI и SDK показывают «войдите в дашборд, чтобы снова включить ключи» [изменение S7 C10]. Вход в браузер сразу возвращает ключам силу (если их срок не истёк).

  Браузерный доступ выключенного в IdP пользователя пропадает за ~5 min (§5.1). Синхронизация с IdP (SCIM или опрос) — фаза 2.
- Имя группы операторов в IdP и сам IdP — S12 / Илья (architecture §13).
- Квота по умолчанию для команды (PoC: 3 sandbox, 6144 MB, 10 снапшотов) — пересмотреть после замеров S6 и появления второй ноды.
