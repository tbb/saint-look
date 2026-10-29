# Замена одной вещи при сборке (#69)

Authenticated `POST /v1/recommendations/single` заменяет или заполняет одно место
по непустому контексту. Endpoint означает complement, а не визуальную похожесть.
[JSON-примеры](recommendation-single-examples.json) фиксируют wire format.
Все остальные места остаются неизменными независимо от закрепления. Backend
не сохраняет лук или запрос; клиент меняет только актуальный черновик, затем
пользователь явно сохраняет его существующей командой.

## Снимок запроса

requestId, snapshotId, targetSlotId — UUID. orderedSlots содержит существующие
slotId/zone/itemId/publishedVersionId в исходном порядке; null/отсутствующие
nullable поля означают пустое место. pinnedSlotIds и excludedItemIds — массивы
уникальных UUID. UUID принимаются без учёта регистра и возвращаются lowercase.
Слоты уникальны, зоны head/body/bottom/shoes; повторяется только body.

items — до300 подготовленных локальных пакетов. Каждый содержит itemId,
publishedVersionId (= committed preparation operation ID), photoVersionId,
sourceSetVersionId, features с canonical taxonomy IDs, точную representationJSON
строку и её representationSHA256. Строка не пересериализуется на клиенте и
проверяется по bytes. Никаких фотографий, encoder/JEV вызовов или генерации
при рекомендации. JSON<=4MiB, representation<=8KiB; превышение body даёт413
request_too_large, числа вещей —400 too_many_items.

Клиент всегда исключает target original из items. Он нужен только как
orderedSlots.itemId/publishedVersionId для exclusion/freshness, не как вход
модели. Неиспользуемый старый space target поэтому не блокирует complement.
Для legacy target без публикации publishedVersionId может быть null; он никогда
не становится кандидатом/контекстом. Все occupied non-target места обязаны
иметь подготовленный packet с точно совпадающей опубликованной версией.

## Проверка опубликованной версии

Подтверждённая preparation receipt связывает item/photo/sourceSet IDs,
representation digest, effective features digest, source/text digests, space и
mode. Shape/finite/nonzero validation принадлежит model adapter. Permanent
server wardrobe и сохранение запросов не добавляются.

Используется latest DELIVERED receipt, а не более новая pending/failed обработка.
Новая подготовка не отнимает предыдущую опубликованную версию. После commit
новой версии старый автоматический снимок получает409 snapshot_stale, даже если
клиент потерял ack response. Он сверяет публикацию; ручное использование прежнего
полного пакета остаётся доступным. Для target-only known receipt тоже проверяются
latest/version/item и tombstone; space его отсутствующего вектора не сравнивается.

Перед model.rank и после его await повторяется проверка всего принятого снимка
(до300 receipts), tombstones, latest delivered и активного space. Удалённая вещь
или новая публикация не заменяются молча следующим кандидатом. Устаревший ответ
не возвращается как успешное предложение. Локальных несохранённых правок сервер
не видит — они обязательно проверяются клиентом перед применением.

## Продуктовые ограничения

Общие правила для будущих single/similar/compose находятся в
recommendation-policy.mjs; policyVersion=outfit-placement-v1. Они действуют
только для автоматического подбора, не запрещают ручную сборку.

| Место | Допустимые type IDs |
|---|---|
|head|headwear|
|body|t_shirt,polo,shirt,blouse,top,sweater,cardigan,sweatshirt,hoodie,vest,blazer,jacket,coat,raincoat|
|bottom|jeans,trousers,shorts,skirt|
|shoes|sneakers,shoes,boots,sandals,slippers|

Остальная таксономия (включая dress/jumpsuit/accessories/unknown) не получает
выдуманных новых мест. Для body порядок внутри→снаружи неубывает:
0=t_shirt/polo/shirt/blouse/top;1=sweater/cardigan/sweatshirt/hoodie/vest;
2=blazer/jacket;3=coat/raincoat. Одинаковый rank разрешён, пустые места
пропускаются. Vest объединяет разные конструкции в текущей таксономии; rank1 —
грубая явно заданная политика, не универсальное утверждение о вкусе.

Target original удаляется из проверки фиксированного контекста — неправильную
целевую вещь можно заменить. Инверсия среди остальных body slots, несовместимая
категория, дубли или закреплённый target дают constraints_conflict. Они не
исправляются молча. Исключения касаются кандидатов, а не фиксированного контекста.

Кандидат должен подходить зоне и порядку слоёв. Исходная вещь, все занятые ID и
явные исключения убираются до ML. Если кандидатов нет, состав не изменяется.
Произвольного порога вкусового качества нет: даже лучший отрицательный score
остаётся допустимым предложением. При exact tie выбирается меньший UUID
лексикографически, не random и не порядок массива клиента.

## Модель

Один существующий Python worker разделён с подготовкой. Rank получает только
сохранённые projected vectors. Query L2-normalized, item projections хранятся
без нормализации, scorer — cosine опубликованного inference example.
Target category не является входом checkpoint и проверяется продуктовым модулем.
Оценку целого лука checkpoint не имеет. В response/UI score не выдаётся за вкус.

Контекст1…32; больше —400 context_too_large, ручное число слоёв не ограничивается.
Контекст>8 вне исходного training max_items8; численная работоспособность не
доказывает качество. Empty context — business outcome без вызова модели;
стратегия старта полного лука принадлежит #71. Очередь worker ограничена8
операциями и deadline120s; длинная подготовка может задержать ranking. Цель2s
не обещается без измерения HTTP и отображения в приложении.

## Ответы

Каждый HTTP200 содержит requestId/snapshotId/targetSlotId, outcome, proposal,
spaceID, mode(real|controlled), policyVersion, nullable reason и conflictingSlotIds
(по умолчанию[]). Proposal — только выбранные itemId+publishedVersionId;
остальные placements сервер не переписывает.

- proposed: ровно одно целевое предложение, reason=null.
- no_alternative: proposal=null; no_category_candidates, excluded_or_occupied
  или layer_constraints.
- constraints_conflict: proposal=null; target_pinned, duplicate_item,
  fixed_category_mismatch или fixed_layer_order; conflictingSlotIds указывает
  конфликтующие места.
- empty_context: proposal=null, reason=context_required.

400 invalid_request/invalid_features/invalid_prepared_item означает ошибку
пакета/его binding;409 snapshot_stale — устаревшие опубликованные IDs/удаление.
409 incompatible_representations добавляет activeSpaceID в error envelope.
503 model_unavailable/model_failed отличает сбой от отсутствия альтернатив.
Ни одна ошибка не подменяется random, zero-vector или другим model mode.

GET /v1/recommendations/config теперь включает recommendations.available по
готовности worker, даже когда image providers отключены. strategies=[single],
policyVersion и limits дополняют capability; encoder availability сохраняется.

## Применение и проверка

Клиент повторно сверяет request/snapshot token, slots/пины/исключения, локальные
ID+published версии всего доступного снимка, target и выбранную вещь. Новая
команда, undo, изменение слоёв/закреплений, удаление или новая публикация отменяют
старый ответ. Правится только target draft slot одной undo-операцией; имя и
сохранённый лук не изменяются до явного Save. Ошибка/нет альтернатив оставляют
состав нетронутым.

HTTP-тесты создают реальные публикации backend с управляемыми provider/ML
границами. Проверяются условия допуска, отсутствие повторного encoder, слои,
ошибки, deterministic ties и race delete/commit. Отдельный нагрузочный fixture
из300 синтетических receipts проверяет лимиты; он не доказывает качество и не
является live-ready гардеробом. Настоящий rank по публичным подготовленным
представлениям измеряется отдельно; backend roundtrip не равен времени первого
отрисованного предложения в iOS. Ручная приёмка #69/#73 остаётся отдельной.

### Opt-in проверка настоящего HTTP rank

Из `backend` при уже установленных pinned assets (см. `backend/ml/README.md`):

```sh
SAINT_LOOK_REAL_MODEL_TEST=1 \
SAINT_LOOK_REAL_MODEL_PHOTOS_DIR=/path/to/client-ios/SaintLook/TrialPhotos \
SAINT_LOOK_MODEL_PYTHON=/path/to/venv/bin/python \
SAINT_LOOK_MODEL_ASSETS=/path/to/model-assets \
SAINT_LOOK_RANK_EVIDENCE=/tmp/single-rank.json \
node --test test/real-recommendation.mjs
```

Требуются `manifest.json`, `photo-1.png`, `photo-2.jpg`, `photo-3.jpg` из
закоммиченного TrialPhotos, без скачивания и API-ключей. Проверяются исходные SHA,
реальные фото преобразуются в PNG не более1024px как вход encoder. Один настоящий
worker подготавливает футболку/джинсы/поло и завершается. Delivered receipts явно
вводятся fixture-ом в существующую SQLite-схему остановленного тестового backend;
это не утверждение о прохождении paid image pipeline. Новый backend использует
настоящий worker и тот же публичный HTTP endpoint: джинсы в контексте, футболка
и поло — две допустимые альтернативы пустого body. Проверяются успешное предложение
и стабильный выбор при повторе, затем300 пакетов с повторёнными двумя векторами.

JSON evidence раздельно показывает подготовку, process listening/model-ready,
первый rank свежего worker при уже прогретом файловом кеше, повторный rank,
объём JSON и synthetic300. Замер HTTP включает сериализацию/upload/validation/
rank/response по loopback. Память — sampled sum RSS дерева процессов каждые25ms,
не cgroup peak. CPU/OS/Node фиксируются; threads=1. Проверка не измеряет WAN,
первую отрисовку на iPhone, разнообразие300 настоящих вещей или оценку вкуса.

Локальный прогон2026-10-29: [полный JSON](recommendation-single-measurements.json).
Xeon Cascadelake, один model thread: первый HTTP rank51.30ms, повтор22.76ms;
synthetic300 —152.58ms, payload980915B. Fresh backend model-ready9.807s отдельно
от запроса. Подготовка трёх фотографий17.821s, включая startup10.966s;
первый encoder5.929s, следующие0.245/0.313s. Sampled RSS backend+rank worker
310.86MiB; offline preparation test-runner+encoder973.85MiB. Выбрана футболка
из футболки/поло при контексте джинсов; наблюдение не заменяет пользовательскую
оценку вкуса. Эти числа относятся к локальному Linux, не к Fly или iPhone.
