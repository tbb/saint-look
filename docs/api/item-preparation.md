# Полная подготовка вещи (#68)

Backend связывает готовую вырезку, иллюстрацию, её актуальные признаки и
представление настоящего encoder перед commit публикации. Это расширяет
[протокол публикации](item-publication.md), не создаёт серверный каталог.
Полные JSON-примеры: [item-preparation-examples.json](item-preparation-examples.json).

## Возможности

Authenticated `GET /v1/recommendations/config` возвращает protocolVersion=1,
publicationProtocol=`prepared-item-v1`, preparationRequired=true,
representationEncoding=`opaque-json-string-v1`, encoder (available, mode,
activeSpaceID, supportedSpaceIDs, reason), newItemPreparation, encoderRefresh,
recommendations. У двух последних capability-объектов available/reason;
recommendations остаётся false/not_enabled до #69.

Encoder mode: real, controlled или disabled. NewItemPreparation требует и
иллюстрации, и encoder. EncoderRefresh не зависит от доступности генерации.
Public `/health` дополнен encoderAvailable, preparationAvailable и
publicationProtocol; version/revision/deployment identity не меняют смысла.
Наличие assets проверяется по полному pinned manifest. Describe одного head
недостаточно. Отсутствующие/повреждённые веса делают encoder unavailable,
без случайного вектора или перехода к controlled.

Real runtime: SAINT_LOOK_MODEL_PROFILE=outfit-transformer-labse-v1,
SAINT_LOOK_MODEL_PYTHON (путь executable venv), SAINT_LOOK_MODEL_ASSETS,
SAINT_LOOK_MODEL_THREADS=1. Disabled — явный профиль disabled, также default.
NODE_ENV=test + SAINT_LOOK_TEST_MODEL_ORIGIN допускают только loopback HTTP
fixture. Live release запрещает test override. Запуск worker не скачивает веса.

## Подготовка

`POST /v1/items/:itemId/preparations` принимает operationId, revision,
photoVersionId, sourceSetVersionId, illustrationOperationId, cutoutOperationId,
spaceID, mode, imageBase64, features. Revision — отдельная монотонная серия
подготовки, не номер ingestion/illustration. Все IDs — UUID.
ImageBase64 содержит точный original upload.png, а не вырезку/иллюстрацию.
Features — `{type:<taxonomy ID>,colors:[<taxonomy ID>]}`. Цвета канонически
сортируются, пустой набор валиден. Признаки иллюстрации по-прежнему используют
отображаемые labels; backend сверяет их через shared taxonomy.

202 подтверждает durable pending; повтор идентичной операции возвращает 200.
Изменённые входы под тем же ID дают 409 identity_conflict; прежний revision —
409 stale_revision. Новая подготовка не публикует вещь, старый согласованный
пакет остаётся на клиенте. Новая подготовка/иллюстрация/фото делает прежний
незавершённый пакет superseded. DELETE побеждает поздние ответы.

Обычный JSON ≤8 MiB, original PNG ≤5 MiB, ≤16M pixels. Legacy import JSON
≤36 MiB; его cutout и illustration ≤10 MiB каждый. Admission сериализован,
одновременно допускается один pending legacy import и не более восьми pending
encoder jobs. Worker последовательно обрабатывает CPU-операции; это ограничение
памяти, не обещание времени подготовки. Подготовка безопасно восстанавливается
после рестарта; внешний платный этап автоматически не повторяется.

Режимы:

- `fromIllustration`: текущая ready иллюстрация, действующая ingestion receipt,
  неизменный original и совпадающие effectiveFeatures. Хеш вырезки сохраняется
  до обычного ingestion ack; ItemResponse содержит resultSHA256. Новые поля
  IllustrationResponse: resultSHA256, observedFeaturesSHA256,
  effectiveFeaturesSHA256; preparedSources дополняются sourceSHA256,
  preparedSHA256, versions.
- `reusePublication`: прежняя подтверждённая preparation receipt. Объект reuse
  содержит publicationId (= preparationOperationId прежнего commit) и artifacts
  (четыре SHA из ready). IDs, original и effective type/colors неизменны.
  Ни JEV, ни Photoroom, ни fal не вызываются. Это путь пересчёта encoder,
  включая смену пространства, а не новая генерация изображения.
- `legacyImport`: явный полный локальный пакет, описанный ниже.

`GET /v1/items/:itemId/preparations/:operationId` возвращает status
pending/ready/failed, все IDs/revision/spaceID, mode encoder, imageMode прежней
иллюстрации, provenance pipeline/reused/legacyImport, effectiveFeatures (IDs),
artifacts, input, representationJSON, representationSHA256, error. Pending/failed
не имеют representation/input. Artifacts могут быть известны ещё pending.
Encoder error = encoder_failed или encoder_unavailable. После cleanup GET=410;
superseded=409, удалённая вещь=410 item_deleted.

RepresentationJSON — точная UTF-8 строка JSON. Клиент проверяет SHA256 её bytes
и сохраняет строку/Data без Float decode или повторной сериализации. Shapes и
метрика принадлежат ML adapter, не iOS. Server отдельно проверяет sourceSHA256,
textSHA256, photoVersionID, spaceID, finite/nonzero vector до ready.

SourceSHA256 — digest точных encoder input bytes. Ingestion source_digest —
другая величина, digest нормализованного PNG; проверяются оба. Encoder text
воспроизводится из типа/цветов без JEV. Для colors=[] текст `shirt.`; для
непустых colors прежний формат сохранён. textFormat v2-empty-colors-omitted
честно меняет spaceID; старые пространства нельзя смешивать с новым.

## Commit

Клиент скачивает и проверяет actual PNG/подготовленные исходники, сохраняет
opaque representation, атомарно сохраняет pendingPublication, затем вызывает
существующий `POST /v1/items/:itemId/illustrations/:illustrationOperationId/ack`:

```json
{"publicationProtocol":"prepared-item-v1","preparationOperationId":"<UUID>"}
```

Backend атомарно проверяет актуальную готовую preparation, фиксирует набор
источников, сохраняет digest receipt и очищает transient original/features/
representation/illustration. Только 204 разрешает переключить локальную
publishedVersion. Повтор committed preparation ack возвращает 204 после
рестарта/потерянного ответа; удаление побеждает повтор. Готовая иллюстрация
или preparation.ready сами по себе фото не фиксируют.

Bodyless ack новой undelivered операции даёт 409 preparation_required. Уже
доставленный legacy bodyless ack остаётся 204 для reconciliation старого
клиента, но не приписывает ему encoder readiness. Новый клиент выпускается
рядом с backend: старый клиент не может завершить новую публикацию.

SQLite dataVersion=4 мигрирует 1/2/3 аддитивно. Старые active artifacts получают
хеши из сохранившихся bytes; очищенным historical receipts выдуманные хеши не
присваиваются. Возврат к binary формата3 запрещён: он обходил бы обязательный
encoder. Понижать user_version вручную нельзя. Receipt хранит только identities,
версии/digests/mode; временные фото/признаки/representations очищаются после
commit, DELETE или семидневного TTL.

## Legacy import: осознанная граница доверия

Старый ack удалял result/effective/observed без digest. Историческое
криптографическое доказательство отсутствует. В single-owner архитектуре
локальный каталог — авторитет уже полученных файлов. Явный legacy import
принимает реальный пакет + matching delivered illustration receipt +
immutable originals; один boolean ready или filename недостаточен.

Legacy содержит cutout `{imageBase64,mode}`, illustration
`{imageBase64,response:<сохранённый полный IllustrationResponse>}` и
preparedPhotos — по каждой фотографии `{photoId,sourceSHA256,preparedSHA256,
versions:{modelVersion,templateVersion,geometryVersion}}`. Клиент до отправки
проверяет actual файлы/хеши. Сервер сверяет prepared metadata с прежними
receipts, UUID/source-set/версии/режим/PNG/геометрию иллюстрации и согласованность
признаков, выполняет настоящий encoder и создаёт новые digests.

Legacy controlled/test результат сохраняет режим и provenance legacyImport;
он не становится live. Если обязательного локального файла нет, вещь остаётся
legacy, пока отсутствующий этап не будет выполнен. Неизменные платные этапы
не повторяются ради исторически отсутствовавшего хеша.

## Ручное обновление признаков

POST illustrations допускает reuseObserved:
`{previousIllustrationOperationId,sourceSetVersionId,observedFeatures,
observedFeaturesSHA256}`. Digest вычисляется сервером над JSON с рекурсивно
сортированными ключами; клиент возвращает полученные digest+объект. Не нужно
воспроизводить canonical JSON в Swift. Проверяются source binding и валидная
структура traits; изменённые manual type/colors накладываются поверх observed.
Это не вызывает JEV повторно. Для historical digest-less delivered receipt
требуется explicit `legacyImport:true` и та же local-authority граница доверия.
PreparedBase64 с прежними digest/versions сохраняет Photoroom preparation.
Новая генерация запускается только для обновления зависимой иллюстрации;
пересчёт encoder uses reusePublication.

## Проверки и ограничения

Основная граница — HTTP backend с управляемыми image/model providers.
Проверяются full commit/restart, отсутствие encoder bypass, source/features
binding, несовместимый space, model failure/explicit retry, delete/stale races,
encoder-only refresh при выключенных иллюстрациях, legacy import и reuseObserved.
Это не доказательство качества модели. Отдельный opt-in
[real-preparation.mjs](../../backend/test/real-preparation.mjs) проходит настоящий
checkpoint на публичном фото через тот же HTTP путь без платных image calls.
Подробности и измеренный single-photo результат — в [ML README](../../backend/ml/README.md).
Полная настоящая генерация, приёмка на устройстве и модельные рекомендации
остаются критериями интеграции следующих задач; документ их не объявляет выполненными.
