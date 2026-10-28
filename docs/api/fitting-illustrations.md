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
весь JSON до 16 MiB. Первый снимок — единственный `front`, остальные `back`
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
  "resultPath": null, "error": null
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

Удаление вещи охватывает все иллюстрации и исходники; tombstone запрещает
воскрешение поздним ответом. Замена основного фото делает прежнюю операцию
неактуальной. Неизвестный исход внешней операции не повторяется автоматически.
