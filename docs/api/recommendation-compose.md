# Автосборка существующей структуры (#71)

Authenticated `POST /v1/recommendations/compose` заполняет существующие места из
подготовленных представлений. Фотографии, JEV и encoder при запросе не вызываются.
Модуль использует тот же singleton worker, receipt validation и product policy,
что single; хранение гардероба и сохранение лука на сервере не добавляются.

Запрос содержит requestId/snapshotId (UUID), mode (`fillEmpty` или `rebuild`),
orderedSlots, pinnedSlotIds, excludedItemIds, items. Формат orderedSlots и items
совпадает с [single](recommendation-single.md), targetSlotId отсутствует. Ограничения:
300 items, 4MiB request, 8KiB representation, не более32 мест (400 context_too_large).
Только body допускает несколько мест; IDs и исходный порядок сохраняются.

`fillEmpty` фиксирует все занятые места и закрепления. `rebuild` фиксирует только
закрепления; остальные исходные вещи разрешены как кандидаты, обязательной смены
каждой вещи нет. Закреплённая пустота остаётся пустой. Исключения удаляют кандидатов,
но не фиксированные вещи. Все фиксированные занятые места должны иметь пригодный
packet; иначе constraints_conflict/preparation_required. Mutable legacy item без
packet допустим как исходная ссылка, но не как кандидат или контекст. Tombstone и
latest delivered receipt этой ссылки тоже проверяются. Ни один запрос не создаёт
или удаляет места, не переставляет слои и не разрешает дубли вещей.

## Ограниченный поиск

Beam width2, top2 на расширение; изменяемые места обходятся в исходном порядке.
Начальное состояние содержит фиксированные вещи, остальные места пусты. Для
каждой ветви отбираются кандидаты по зоне, исключениям, уникальности и общей
политике порядка слоёв. Контекст включает все занятые места ветви, в том числе
фиксированные будущие слои. Настоящий target head получает context0…31; пустой
контекст технически поддерживается checkpoint и не заменяется случайным seed.
Это не доказательство вкусового качества старта без контекста.

По scores cosine сохраняются до двух расширений. Если допустимых кандидатов нет,
пустое место остаётся в ветви. Из расширенных ветвей оставляются две: сначала
большее число занятых мест, затем большая сумма последовательных cosine, затем
лексикографические item IDs. Это наш ограниченный поиск поверх дополнения одного
места, а не встроенная оценка целого лука. Качество суммы не калибровано, глобальный
оптимум не обещается, порог хорошего вкуса отсутствует. При M<=32 изменяемых местах
не более2M−1<=63 rank calls. Каждый rank сериализуется существующей очередью worker;
конкурирующая подготовка может увеличить задержку.

Проверки receipts выполняются до и после каждого await rank, а перед ответом
повторно проверяются receipts и активное пространство/mode. Удаление, новая
публикация или смена пространства отменяют весь результат. Ошибки модели дают503,
не random, другой checkpoint или успешный пустой ответ.

Если поиск нашёл меньше занятых мест, чем в исходной композиции, он возвращает
unchanged/insufficient_improvement. Исходная композиция не теряется. Частичный
результат не доказывает отсутствие полного решения за пределами beam. Проверка
состояния клиента остаётся обязательной: server не знает локальных edit/undo.

## Ответ

Все200 содержат requestId, snapshotId, mode (echo fillEmpty/rebuild), **modelMode**
(real/controlled), outcome, nullable reason, nullable placements, spaceID,
policyVersion=outfit-placement-v1 и conflictingSlotIds (обычно[]).

- proposed: полный результат для всех изменяемых мест; placements — ВСЕ исходные
  места по порядку, `{slotId,itemId,publishedVersionId}`, включая null.
- partial/bounded_search_partial: изменённый результат с незаполненными изменяемыми
  местами, заполненность не ниже исходной. Закреплённые пустоты не делают его partial.
- unchanged: placements=null; all_pinned, nothing_to_fill, same_composition или
  insufficient_improvement. no_solution/no_candidates — тоже placements=null.
- constraints_conflict: placements=null; preparation_required, duplicate_item,
  fixed_category_mismatch или fixed_layer_order; conflictingSlotIds поясняет места.

400 invalid_request/invalid_prepared_item,409 snapshot_stale или
incompatible_representations,503 model_unavailable/model_failed соответствуют
single. All-pinned/nothing-to-fill не запускают rank. Клиент сверяет точный снимок,
полный набор и порядок мест, fixed значения, pins/exclusions и версии, затем
применяет весь результат одним изменением черновика и одним undo. Сохранение
остаётся явным; ошибка и поздний ответ ничего не меняют.

## Проверки и измерения

`node --test test/compose.test.mjs` — существующий HTTP backend, управляемые внешние
provider/ML границы. Проверены пустой старт без re-encode, fill/rebuild, 0/1/N pins,
закреплённая пустота, слои, partial/no solution, сохранность более полного текущего
лука, fixed conflicts, delete/commit race, ошибки модели, лимиты и63-call bound
при300 синтетических receipts/32 слоях. Это не вкусовая проверка.

Opt-in настоящий checkpoint, без ключей и сети при уже установленных assets:

```sh
SAINT_LOOK_REAL_MODEL_TEST=1 \
SAINT_LOOK_REAL_MODEL_PHOTOS_DIR=/path/to/client-ios/SaintLook/TrialPhotos \
SAINT_LOOK_MODEL_PYTHON=/path/to/venv/bin/python \
SAINT_LOOK_MODEL_ASSETS=/path/to/model-assets \
SAINT_LOOK_COMPOSE_EVIDENCE=/tmp/compose.json \
node --test test/real-compose.mjs
```

Harness проверяет SHA трёх публичных исходников, подготавливает реальные vectors
и явно вводит synthetic delivered receipts в остановленную тестовую SQLite.
Затем новый backend выполняет настоящий HTTP compose. Это не подтверждает
прохождение платного image pipeline. Проверяются empty-context finite ranking,
стабильный повторный выбор, fill с закреплённой футболкой и синтетический набор300:
299 копий двух body vectors + один jeans vector, восемь body places и bottom.
Восемь футболок в нагрузочном результате не представляются реалистичным луком.
maximumRankCalls в evidence — вычисленный верхний предел, не telemetry счётчик.

[Локальные результаты2026-10-29](recommendation-compose-measurements.json):
Xeon Cascadelake, Linux,4logicalCPU, model threads1. Первый HTTP compose84.57ms,
прогретый28.46ms, fill с pin19.59ms, synthetic300/9мест1379.24ms. Выбраны поло и
джинсы; это наблюдение модели, не пользовательская оценка. Fresh backend model-ready
10.697s измерен отдельно. Подготовка3фото19.027s включает startup10.890s;
первый encoder7.290s, следующие0.286/0.274s. Sampled RSS backend+worker324.43MiB,
preparation runner+worker1006.43MiB, sampling25ms; это не cgroup peak.

Файловый кеш прогрет подготовкой. CPU не ограничивался контейнером, одновременно
могли работать локальные controlled HTTP проверки. Замер включает JSON/upload/
validation/search/response по loopback, но не WAN, iPhone first paint или Fly.
Контекст сверх исходного training max_items8 требует отдельной оценки качества.
Физическая и вкусовая приёмка #71/#73 остаются открытыми.
