# Иллюстрации вещей: предварительный HTTP-контракт

Контракт `fitting-square-1024-v1` согласован для реализации #46/#47. Качество
реальной стилизации ещё не подтверждено (#45). По решению владельца от
28 октября 2026 это не блокирует продуктовую реализацию; настоящие вызовы fal
пока отложены. Иллюстрации — отдельный цикл от обычной обработки вещей.

`GET /health` возвращает `illustrationAvailable: boolean`. По умолчанию false:
готовый гардероб продолжает работать, фиктивная иллюстрация не создаётся.
Остальные маршруты требуют существующий bearer владельца.

## Запрос

`POST /v1/items/{itemId}/illustrations`

```json
{
  "operationId": "UUID",
  "photoVersionId": "UUID текущего основного фото",
  "sourceSetVersionId": "UUID набора фото",
  "revision": 1,
  "photos": [{"id": "UUID фото", "role": "front", "imageBase64": "PNG"}],
  "manualType": "Худи",
  "manualColors": ["Чёрный"]
}
```

`revision` — отдельный монотонный счётчик запросов иллюстрации, начиная с 1.
Все UUID возвращаются lowercase. От одного до трёх PNG, до 5 MiB каждый,
весь JSON до 16 MiB, включая base64 оригиналов и подготовленных копий.
Первый снимок — единственный `front`, остальные `back`
или `detail`. Это ракурсы той же вещи, а не разные вещи. Исходники передаются
явно: обычная обработка могла уже очистить временную копию после ack.

Ручные поля необязательны, null равнозначен отсутствию. Тип и цвета — русские
значения `shared/wardrobe-taxonomy.json`; пустой массив ручных цветов допустим.
Повтор того же operationId с тем же содержимым возвращает текущую операцию;
изменение содержания с прежним ID даёт 409 `identity_conflict`.

503 `illustration_unavailable` означает, что запрос не поставлен в очередь.
Новый принятый запрос возвращает 202, повтор — 200.

## Ответ операции

`GET /v1/items/{itemId}/illustrations/{operationId}` и POST возвращают:

```json
{
  "itemId": "UUID", "operationId": "UUID", "photoVersionId": "UUID",
  "sourceSetVersionId": "UUID", "revision": 1,
  "status": "pending", "mode": "live",
  "processing": {"preparation":"pending", "attributes":"pending", "generation":"pending", "finalization":"pending"},
  "observedFeatures": null, "effectiveFeatures": null,
  "manualType": null, "manualColors": null,
  "modelVersion": "fal-ai/nano-banana-pro/edit",
  "templateVersion": "front-360x560-proposed-v1",
  "geometryVersion": "fitting-square-1024-v1",
  "preparedSources": [], "resultPath": null, "error": null
}
```

Статус: `pending|ready|failed`. Стадии: `pending|in_flight|done|skipped|failed|unknown|cleared`.
Режим `test` допускается только с локальным HTTP-провайдером при NODE_ENV=test;
для настоящего адаптера режим `live`. Фикстуры не включаются в production.

После JEV оба features имеют форму:

```json
{"version":"fitting-observable-v2-photoroom-sandbox", "type":"Худи", "colors":["Чёрный"],
 "traits":{"silhouette":"relaxed", "body_length":"regular", "sleeves":"long",
 "pattern":"unknown", "pattern_location":"unknown", "pattern_size":"unknown",
 "neckline":"hood", "fastening":"none", "surface":"unknown", "hood":"yes",
 "kangaroo_pocket":"unknown", "patch_pockets":"unknown", "dropped_shoulders":"unknown",
 "contrast_cuffs":"unknown", "lettering":"unknown"}}
```

Неуверенные признаки сохраняются как `unknown`, тип — `Не определён`, цвета —
пустой массив. `effectiveFeatures.type/colors` используют ручные исправления;
наблюдённые признаки не перезаписываются. Новые ручные правки сами запросов не
создают. Клиент сверяет identity, ручные значения и версии перед публикацией.

`GET .../{operationId}/result` возвращает PNG 1024×1024 с полезным alpha на
полном общем холсте; не обрезать и не центрировать отдельную вещь повторно.
409 `not_ready` — ещё нет результата. `POST .../{operationId}/ack` возвращает
204 только после надёжной локальной записи; временные источники и результат
очищаются. Повторный ack безопасен. Через семь дней данные также очищаются.
Старый сохранённый клиентский результат остаётся при обновлении или ошибке.

Готовый ответ содержит `preparedSources: [{photoId, preparedPath}]` для каждого
исходника. `GET /v1/items/{itemId}/illustrations/{operationId}/sources/{photoId}/prepared`
выдаёт точную подготовленную PNG-копию (до 10 MiB, с размерами оригинала).
Клиент надёжно сохраняет **и иллюстрацию, и все подготовленные копии до ack**.
При следующем явном запросе каждый `photos[]` может содержать `preparedBase64`:
так обновление ручных признаков или добавление ракурса не оплачивает повторную
вырезку уже подготовленных фото. Кэш привязан к неизменному photoId, хешу
оригинала и версиям контракта. Сервер после очистки хранит только хеши этих
копий, а не изображения. Полученный кэш обязан совпасть с ранее выданными
байтами; несовпадение даёт 409 `prepared_source_conflict`. Поле кэша не входит
в fingerprint операции, повторная доставка не создаёт новый запрос.

Суммарный JSON с кэшем всё ещё ограничен 16 MiB. Клиент проверяет полный размер;
нельзя молча отбросить кэш и повторно потратить квоту ради прохождения лимита.
409 `processing_in_progress` означает, что предыдущий запрос для того же
основного фото ещё выполняется: повторить явное действие после завершения.
Замена основного фото завершает старую операцию как superseded и не блокирует
запрос новой версии. 409 `processing_unknown` запрещает новую платную попытку
до разбирательства с неизвестным исходом. Ошибка чтения fal после получения
receipt (включая 401/403/429) не доказывает отказ генерации и остаётся unknown.

## Конфигурация и миграция

Реальный путь требует явного `SAINT_LOOK_ILLUSTRATIONS_ENABLED=true`, серверных
`PHOTOROOM_SANDBOX_API_KEY` (только `sandbox_…`), `TYPESAFE_API_KEY`, `FAL_KEY`.
По умолчанию он отключён; этот документ не включает его и не разрешает новую
пробу. Цепочка: Photoroom sandbox → JEV → fal Nano Banana → Photoroom sandbox
только если итог пока непрозрачный. Оригинал и подготовленный ракурс идут
отдельными подписанными референсами; манекен передаётся только генератору.

CI использует `NODE_ENV=test` и `SAINT_LOOK_ILLUSTRATION_TEST_ORIGIN` с loopback
HTTP. Внешний адрес или отсутствие test-origin при NODE_ENV=test запрещает
доступность. Никакого перехода к реальному провайдеру при ошибке фикстуры нет.
Для нативных тестов `SAINT_LOOK_ILLUSTRATION_TEST_CONTROLLED=true` читает
доступность из локального provider `/health`: `/__control` включает
`illustrationMode: success|failed|unknown`, reset возвращает null/недоступно.

Формат серверных данных повышен до 2: явная миграция 1→2 сохраняет обычные
вещи и добавляет независимые таблицы. Откат к коду версии данных 1 запрещён,
поскольку тот код не очищает новые артефакты при удалении вещи и retention.
Снижение SQLite user_version вручную не является допустимым откатом.

Удаление вещи охватывает все иллюстрации и исходники; tombstone запрещает
воскрешение поздним ответом. Замена основного фото делает прежнюю операцию
неактуальной. Неизвестный исход внешней операции не повторяется автоматически.
