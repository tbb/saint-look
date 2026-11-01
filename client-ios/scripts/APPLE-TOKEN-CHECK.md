# Проверка ключа App Store Connect на своём компьютере

Нужны **Node.js 18+** и **curl**. Устанавливать npm-пакеты и клонировать проект не нужно:
достаточно файла `apple-token-check.mjs` рядом с вашим `.p8`. Ключ остаётся на компьютере.
Скрипт делает только `GET https://api.appstoreconnect.apple.com/v1/apps?limit=1` —
до одного запроса на каждый выбранный режим. Сертификаты и приложения не меняет.

Проверьте, что Key ID взят именно от этого файла. По одному `.p8` нельзя определить
его Key ID, владельца или сервис Apple. Название `AuthKey_XXXXXXXXXX.p8` даёт только подсказку.

## Если пока есть только файл и Key ID

```sh
node apple-token-check.mjs --key ./AuthKey_SNN92T6W52.p8 --key-id SNN92T6W52
```

Пример использует текущий переданный Key ID: замените его и путь, если проверяете
другой файл. Скрипт проверит Individual-схему, а Team-схему явно отметит как
неотправленную из-за отсутствующего Issuer ID.

## Если известен настоящий Issuer ID

```sh
node apple-token-check.mjs --key ./AuthKey_SNN92T6W52.p8 --key-id SNN92T6W52 --issuer-id ВСТАВЬТЕ_НАСТОЯЩИЙ_UUID
```

Скопируйте UUID из **App Store Connect → Users and Access → Integrations → Team Keys**.
Команда проверит **оба** варианта: Team с `iss`, затем Individual с `sub: "user"`
и без `iss`. Это два отдельных токена и два GET, а не перебор значений.

Для одного режима добавьте `--mode team` или `--mode individual`.
`--team-id 3JFB6R47R3` — необязательное справочное поле; оно никогда не попадает в JWT.
В Team-режиме строка из 10 символов вместо UUID не отправляется.

## Что переслать

Скрипт напечатает результат и создаст рядом `apple-token-report-<дата>.json`.
**Переслать нужно этот JSON-отчёт.** Он содержит Key ID, введённые публичные IDs,
отпечаток публичного ключа, поля JWT без подписи, HTTP-статусы и подсказки.
Приватного ключа, полного токена, списка приложений и сырого ответа Apple там нет.
Полный путь к `.p8` в JSON тоже не сохраняется.

Для собственного имени отчёта добавьте `--out check-1.json`; существующий файл
не перезаписывается. Можно сравнить два отчёта по `publicKeySHA256`, чтобы убедиться,
что проверялся один и тот же ключ. Отпечаток не доказывает связь ключа с Key ID у Apple.

- **200 / accepted** — этот запрос авторизован. Это не проверка подписи приложения
  или доступа к сертификатам; Individual keys не поддерживают provisioning endpoints.
- **401** — проверить тип/место создания ключа, пару Key ID + `.p8`, отзыв ключа,
  настоящий Issuer ID для Team и часы компьютера. Причину одного 401 определить нельзя.
- **403** — проверить API access и роль/права. Это не подтверждение прав на подпись.
- **not_sent** — локально не хватает корректного Issuer ID для Team.
- **transport_error** — проверить curl, сеть, proxy, TLS и часы. Сырой stderr скрыт.

`approximateClockSkewSeconds` сравнивает локальные часы с HTTP Date сервера;
небольшая разница из-за сети нормальна. JWT действует 5 минут. Exit code: 0 — хотя бы
один режим получил 200; 1 — ни один; 2 — ошибка локальных параметров/файла.

Authorization передаётся curl через stdin; `.curlrc`, redirects и retries отключены.
Произвольного адреса запроса нет. Оригинальный `.p8` не редактируется.

Источники: [форматы JWT Apple](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests),
[типы API-ключей](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api),
[curl config через stdin](https://curl.se/docs/manpage.html).
