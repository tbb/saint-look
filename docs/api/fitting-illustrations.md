# Иллюстрации вещей: предварительный HTTP-контракт

Контракт `fitting-square-1024-v1` согласован для реализации #46/#47. Качество
реальной стилизации ещё не подтверждено (#45). По решению владельца от
28 октября 2026 это не блокирует продуктовую реализацию. С 30 октября генератор
подключён к прямому Gemini Interactions API; одной публичной фотографией
подтверждён формат JPEG 1K. Полная реальная подготовка с JEV и Photoroom sandbox
ещё требует проверки. Иллюстрации — отдельный цикл от обычной обработки вещей.

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
  "modelVersion": "gemini-3-pro-image",
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
Наблюдённые цвета отбираются по уверенности JEV: не более пяти основных цветов,
в порядке убывания уверенности; значения ниже порога не добавляются.

`GET .../{operationId}/result` возвращает PNG 1024×1024 с полезным alpha на
полном общем холсте; не обрезать и не центрировать отдельную вещь повторно.
409 `not_ready` — ещё нет результата. `POST .../{operationId}/ack` возвращает
204 только для актуальной готовой операции после надёжной локальной записи
candidate; сервер атомарно фиксирует фото и очищает временные источники и результат.
Клиент публикует candidate только после 204. Повторный ack доставленной операции
безопасен и подтверждает прежний commit; ack устаревшей/удалённой/просроченной
операции возвращает явный отказ. Через семь дней данные также очищаются.
Старый сохранённый клиентский результат остаётся при обновлении или ошибке.
После очистки GET статуса, изображения, подготовленных источников и повторный
POST той же операции возвращают 410 `result_delivered` или `result_expired`.
Очищенная операция не выдаётся как обычный ответ с пустыми признаками: клиент
завершает её доставку и при необходимости создаёт новую явную ревизию.

Готовый ответ содержит `preparedSources: [{photoId, preparedPath}]` для каждого
исходника. `GET /v1/items/{itemId}/illustrations/{operationId}/sources/{photoId}/prepared`
выдаёт точную подготовленную PNG-копию (до 10 MiB, с размерами оригинала).
Клиент надёжно сохраняет **и иллюстрацию, и все подготовленные копии до ack**.
При следующем явном запросе каждый `photos[]` может содержать `preparedBase64`:
так обновление ручных признаков не оплачивает повторную
вырезку уже подготовленных фото. Кэш привязан к неизменному photoId, хешу
оригинала и версиям контракта. Сервер после очистки хранит только хеши этих
копий, а не изображения. Полученный кэш обязан совпасть с ранее выданными
байтами; несовпадение даёт 409 `prepared_source_conflict`. Поле кэша не входит
в fingerprint операции, повторная доставка не создаёт новый запрос.

Суммарный JSON с кэшем всё ещё ограничен 16 MiB. Клиент проверяет полный размер;
нельзя молча отбросить кэш и повторно потратить квоту ради прохождения лимита.
409 `processing_in_progress` означает, что предыдущий запрос для того же
основного фото ещё выполняется: повторить явное действие после завершения.
До первой готовности замена основного фото завершает старую операцию как superseded и не блокирует
запрос новой версии. 409 `processing_unknown` запрещает новую платную попытку
до разбирательства с неизвестным исходом. Ошибка чтения Gemini interaction после
получения receipt (включая 401/403/429) не доказывает отказ генерации и остаётся
unknown.

## Конфигурация и миграция

Реальный путь требует явного `SAINT_LOOK_ILLUSTRATIONS_ENABLED=true`, серверных
`PHOTOROOM_SANDBOX_API_KEY` (только `sandbox_…`), `TYPESAFE_API_KEY`, `GEMINI_API_KEY`.
По умолчанию он отключён; этот документ не включает его и не разрешает новую
пробу. Цепочка: Photoroom sandbox → JEV → Gemini Nano Banana Pro → Photoroom sandbox
для снятия фона у непрозрачного JPEG. Оригинал и подготовленный ракурс идут
отдельными подписанными референсами; манекен передаётся только генератору.

CI использует `NODE_ENV=test` и `SAINT_LOOK_ILLUSTRATION_TEST_ORIGIN` с loopback
HTTP. Внешний адрес или отсутствие test-origin при NODE_ENV=test запрещает
доступность. Никакого перехода к реальному провайдеру при ошибке фикстуры нет.
Для нативных тестов `SAINT_LOOK_ILLUSTRATION_TEST_CONTROLLED=true` читает
доступность из локального provider `/health`: `/__control` включает
`illustrationMode: success|failed|unknown`, reset возвращает null/недоступно.

Формат серверных данных 3 мигрирует 1/2, сохраняя вещи и таблицы обработки.
Откат к коду форматов 1/2 запрещён: старый код не соблюдает фиксацию фотографий.
Согласованная публикация и неизменность полного набора после готовности описаны
в [контракте #67](item-publication.md).
Снижение SQLite user_version вручную не является допустимым откатом.

Удаление вещи охватывает все иллюстрации и исходники; tombstone запрещает
воскрешение поздним ответом. Допустимая замена до готовности делает прежнюю операцию
неактуальной. Неизвестный исход внешней операции не повторяется автоматически.

### Gemini trial accounting and recovery

The trial reserves $0.40 before each Gemini POST. This is a conservative ceiling,
not the observed unit price: the request caps combined output/thinking at 2048
tokens; the 65,536 input-token model limit at $2/M plus 2048 output tokens priced
entirely at the higher $120/M image rate totals $0.376832. No grounding tools are
enabled. The owner's total API ceiling is $10: the prepared server lifetime cap
is $8.80, leaving $1.20 for three earlier standalone Google probes outside this
ledger. The same-ID $4.50 → $8.80 policy migration preserves every reservation;
the 60/48/24 provider limits and rates stay unchanged. Historical fal reservations
remain in both the total spend and the 24-generation count after migration.
Downgrading the policy to $4.50 is permitted only while the entire reserved cost
fits; older backend budget code cannot accept $8.80 and must not be rolled back
without the compatible policy downgrade or a reviewed budget-code backport.

Gemini uses `store:true` so a saved interaction ID can be recovered with GET.
Google therefore stores the interaction, including uploaded photos. The current
trial uses public photos only; GET recovery does not submit another generation.
Sources: [pricing](https://ai.google.dev/gemini-api/docs/pricing),
[output/thinking cap](https://ai.google.dev/gemini-api/docs/thinking/).

## Посадка по типу вещи — v2

`category-front-anchors-v2` / `fitting-anchors-1024-v2` сохраняют общий квадрат
1024×1024 и координаты манекена. Генератор получает шаблон семейства вещи
(верх, брюки, шорты, юбка, длинная одежда, обувь, головной убор, аксессуары)
с целевым положением. Размеры и координаты проверяет `illustration-layout.mjs`;
после сегментации один равномерный масштаб и перенос регистрируют вещь по шаблону. Поиск границ использует непрозрачные пиксели; всё изображение, включая watermark, преобразуется тем же способом. Части одежды не вырезаются и не растягиваются по независимым осям. Раздельность штанин проверяется до и после размещения; прямоугольник или слитый силуэт не превращаются в брюки геометрическим искажением.

После финальной сегментации непрозрачная вещь должна находиться внутри своей
области с допуском 4% площади непрозрачных пикселей снаружи. Прозрачные края
и полупрозрачный watermark не используются для оценки посадки, но остаются
в PNG. Минимальная площадь защищает от почти пустого результата. Это проверка
размещения, а не семантическая гарантия качества вещи.

`illustration_geometry_invalid` — явный отказ готовности, без автоматического
платного повтора. `illustration_type_unsupported` просит выбрать известный тип
до генерации; неизвестный тип не расходует резерв Gemini.

Клиент читает сохранённые v1 и v2 пакеты, но на общий манекен накладывает только
v2. Старый результат доступен в карточке; «Обновить посадку» создаёт явную
новую попытку, сохраняя предыдущую публикацию до полного завершения. Кэш
исходной Photoroom-вырезки остаётся пригодным при совпадении сохранённого
хеша; смена шаблона не является причиной повторной сегментации исходника.
Новая вещь всегда сохраняет намерение автоматической подготовки, включая
временную недоступность провайдера и замену неудачного первого снимка.
