# CPU-адаптер OutfitTransformer-LaBSE

Настоящий fp32 inference без платных API. Это изолированная граница ML для #68/#69;
она сама не объявляет вещь полностью готовой и не проверяет места/слои/закрепления.
Пайплайн и HTTP-контракт интегрируются отдельно. Результат проверки настоящих весов:
[отчёт](../../docs/research/outfit-transformer-validation.md).

## Установка и артефакты

Linux CPU, Python3.12. `torch` и `torchvision` брать из CPU-индекса, чтобы не
устанавливать CUDA-библиотеки:

```sh
python3 -m venv /tmp/saint-look-ml
/tmp/saint-look-ml/bin/pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cpu
/tmp/saint-look-ml/bin/pip install -r backend/ml/requirements.txt
/tmp/saint-look-ml/bin/python backend/ml/fetch_assets.py /tmp/saint-look-weights
```

`assets.json` фиксирует URL с revision и SHA-256 каждого артефакта. Download —
только явный шаг сборки; runtime не скачивает веса и не исполняет удалённый код.
LaBSE safetensors ~1.88GB плюс ResNet18 ~47MB и head ~5MB; не класть веса в Git.
Не путать место на диске с RSS. Обычный CI не должен скачивать модель.

## Локальный private JSONL worker

```sh
/tmp/saint-look-ml/bin/python backend/ml/worker.py --assets /tmp/saint-look-weights --threads 1
```

Одна JSON-строка запроса → одна JSON-строка ответа с тем же `id`.
stdout только протокол; stderr содержит класс ошибки, без исходных путей/токенов.
Worker не открывает HTTP-порт. Доверенный backend задаёт путь к файлу временной
загрузки, выполняет auth/лимиты изображения, timeout/cancellation и очередность.

- `{"id":"a","operation":"describe"}` → `result.spaceID`, `result.descriptor`.
- `prepare`: поля `imagePath`, `photoVersionID`, `type` (ID таксономии),
  `colors` (ID таксономии). Возвращает envelope `schemaVersion`, `spaceID`,
  `photoVersionID`, `sourceSHA256`, `textSHA256`, `vector`.
- `query`: `context` — массив envelope, возвращает целевой `query`.
- `rank`: `context` и `candidates` — envelope, возвращает `scores` в исходном
  порядке кандидатов. Отбор категории, исключения и tie policy делает backend.

Новая модель/preprocessing/text-format меняет `spaceID`. Вещи из другого
пространства отклоняются, даже при одинаковой размерности. Вектор вещи128D
**ненормализован**, вектор запроса нормализован; ranking использует cosine из
опубликованного примера inference. Представление не является полным пакетом вещи:
при admission backend дополнительно проверяет текущие признаки и версию исходника,
а клиент атомарно публикует изображения, признаки и представление.

Фото — настоящий исходник, EXIF transpose → RGB → bilinear resize224×224 →
ImageNet normalization. Вырезка и иллюстрация не нужны encoder. Текст:
`type.replace('_', ' ') + '. Colors: ' + sorted(unique(colors)).join(', ') + '.'`.
Если colors пуст, текст — только тип с точкой, например `shirt.`. Это textFormat
v2-empty-colors-omitted. Предшествующее epoch пространство A имело spaceID
`5232e383c329cb71cea3217bfd78b7f36128b1abb6657c94e2909635b638a24b`.
В текущем локальном contract descriptor добавлен
`representationContractVersion: 2`: это пространство B,
`df268e5dab58fc14040ec8d5966455e546943406bf04380d24ee8ffcf4ca7e17`.
Epoch не меняет checkpoint, веса или алгоритм; он намеренно задаёт несовместимую
идентичность представлений. B подготовлен для упражнения миграции #72, но ещё
не выложен и не прошёл ручную приёмку. Непустые входы сохранили прежние байты.
Исторические benchmark-замеры сохраняют фактический A space; отдельного
benchmark-прогона B пока не было.
Нового JEV-вызова нет. LaBSE используется через `BertModel.pooler_output`, как в
опубликованном коде; не через SentenceTransformer Dense/Normalize.

Подбор использует сохранённые128D. Тяжёлые encoder загружаются только при первом
`prepare`; head живёт с запуска процесса. Один worker выполняет операции
последовательно: длинная подготовка может задержать следующий подбор. Интеграция
должна измерить это, прежде чем обещать2сек при конкурентной обработке.

Технически поддержан context0…32. В config исходника max_items8; качество на>8
не проверено. Пустой query-token вычислим, но стратегия старта полного лука —
логика приложения. Head не имеет целевой категории и оценки целого комплекта.

## Проверка

```sh
python3 -m unittest discover -s backend/ml -p test_contract.py
/tmp/saint-look-ml/bin/python backend/ml/fetch_public_dataset.py /tmp/saint-look-public
/tmp/saint-look-ml/bin/python backend/ml/validate_real.py \
  --assets /tmp/saint-look-weights --threads 1 \
  --dataset /tmp/saint-look-public/manifest.json \
  --reference-source /tmp/saint-look-public/reference-model.py \
  --output /tmp/real-model-validation.json
```

Последняя команда — отдельный opt-in прогон настоящих весов на публичных фото.
Reference source проверяется по SHA-256 до исполнения. Manifest имеет `items`,
у каждой вещи `id,type,colors,image,sha256,attribution`; `image` относительно manifest.
Источник закреплённого model.py — HF revision7eaf8d9 из отчёта. Никаких private
фото, ключей и оплачиваемых AI-вызовов. Проверки HTTP с управляемым ML адаптером
остаются основной автоматической границей продуктового поведения.

`fetch_public_dataset.py` воспроизводит16 изображений по опубликованным URL,
проверяет SHA-256 исходников и каждого преобразованного JPEG, сохраняет точный
manifest и проверенный reference-model.py. Проверено с Pillow11.1.0 и13.0.0.
При изменении источника или обработки команда останавливается, не меняя хеши.

## Воспроизведение совместного замера памяти1/2GiB

[measure_pipeline.py](measure_pipeline.py) — сохранённый сценарий, которым получены
`outfit-transformer-pipeline-memory.json` и `...-2g.json`. Он запускает настоящий
Node backend, существующий loopback fixture provider и настоящий ML worker.
Первая вещь проходит cold encoder; затем два HTTP-клиента обрабатывают все16 вещей
(загрузка → подготовка → иллюстрация → чтение результата), одновременно encoder
последовательно готовит оставшиеся15. `--threads 1`, HTTP concurrency2,
`SAINT_LOOK_STAGE_DELAY_MS=100`, timeout запроса30с, polling50мс, RSS polling20мс.
Счётчики cgroup снимаются до остановки процессов; stdout systemd после остановки
не заменяет сохранённый kernel `memory.peak`.

Это тот же workload, перенесённый из временного скрипта: абсолютные пути заменены
аргументами, добавлены проверки отдельного лимита cgroup/новой БД и cleanup при
ошибке. Прежние результаты не пересчитаны после переноса. Никаких внешних AI
запросов: credentials в сценарии — открытые dummy fixture-строки, оба origin
loopback. Секреты не требуются. Запуск вручную, не обычный CI и не UI-стенд.

Исторические версии: backend/fixture из `576591b5966c59f456646511a32856038b143a35`,
ML-код `000eabd54820b1fcdb8351437bb9f32f5f8bfda9`; Node24.21.0, controller
`/usr/bin/python3`3.12.3, worker Python3.12.14, зависимости из `requirements.txt`.
Именно прежний backend нужен для сравнения с сохранёнными числами; более поздний
backend будет новым измерением. Для повторения после изменения ML сохраните
копию этого сценария рядом с `worker.py` из указанного ML SHA: сценарий запускает
worker из собственного каталога. Этот PR содержит ту же версию ML.

После установки/скачивания модели и16 фото по командам выше:

```sh
git worktree add --detach /tmp/saint-look-memory-backend 576591b5966c59f456646511a32856038b143a35
npm ci --prefix /tmp/saint-look-memory-backend/backend
mkdir -p /tmp/saint-look-memory
```

Как в исходном прогоне, до измерения подготовьте PNG для HTTP: endpoint
иллюстраций принимает PNG, а encoder продолжает читать неизменные JPEG.
Копия весов имеет отдельные файлы; оба сравниваемых запуска переиспользуют её.

```sh
/tmp/saint-look-ml/bin/python - <<'PY'
import json
import shutil
from pathlib import Path
from PIL import Image, ImageOps

public = Path('/tmp/saint-look-public')
png = Path('/tmp/saint-look-memory/png')
png.mkdir(parents=True, exist_ok=True)
for item in json.loads((public / 'manifest.json').read_text())['items']:
    with Image.open(public / item['image']) as image:
        ImageOps.exif_transpose(image).convert('RGB').save(png / (item['id'] + '.png'))
assets = Path('/tmp/saint-look-weights')
copy = Path('/tmp/saint-look-memory/assets')
for source in assets.rglob('*'):
    if source.is_file():
        target = copy / source.relative_to(assets)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
PY
```

Используется Linux cgroupv2 и доступный systemd user manager. Команды ниже создают
**отдельные** transient units; общий лимит хоста и Fly не меняется. `RuntimeMaxSec`
ограничивает зависший эксперимент; запуск по1разу на каждом лимите, без автоматических
повторов. После ошибки сначала выяснить её причину. Новая БД обязательна для каждого
запуска. Абсолютный Node path нужен, поскольку PATH systemd отличается от shell.

```sh
run_memory_case() {
  systemd-run --user --unit="saint-look-memory-$1" \
    --property="MemoryMax=$2" --property=MemorySwapMax=0 \
    --property=RuntimeMaxSec=180 --wait --pipe \
    --working-directory="$PWD" \
    /usr/bin/python3 "$PWD/backend/ml/measure_pipeline.py" \
    --backend-repo /tmp/saint-look-memory-backend \
    --assets /tmp/saint-look-memory/assets \
    --dataset /tmp/saint-look-public/manifest.json \
    --png-directory /tmp/saint-look-memory/png \
    --output "/tmp/saint-look-memory/$1/result.json" \
    --data-dir "/tmp/saint-look-memory/$1/database" \
    --node "$(command -v node)" --python /tmp/saint-look-ml/bin/python \
    --memory-mib "$3"
}
run_memory_case 1g 1G 1024
run_memory_case 2g 2G 2048
```

Исторически файлы весов были скопированы внутри предыдущего idle1GiB unit, затем
переиспользованы сравнительными прогонами. Здесь подготовка копии показана отдельно:
это не обещание одинакового page-cache accounting. Ни прежний, ни повторяемый
прогон не очищает page cache ОС и не включает ОС в лимит. Для сравнения сохраняйте
условия, kernel counters и показатели всех процессов; одинаковые времена/пики
на другом хосте не ожидаются. Сумма RSS повторно считает shared pages и не равна
`memory.current`. При лимите1GiB допускается ошибка/OOM — это результат измерения,
а не повод повторять до успешного исхода.


## Opt-in проверка интеграции HTTP с настоящим checkpoint

Обычный `npm test` не загружает веса и использует управляемую ML-границу.
Отдельный тест использует существующий HTTP backend и те же image-provider
fixtures: настоящая публичная фотография → illustration (controlled) → real
worker preparation → полный ack → повтор квитанции. Тест также проверяет
валидный пустой набор цветов. Он не доказывает качество изображения/вкуса.

Из корня проекта, после установки assets/runtime и получения публичного набора:

```sh
SAINT_LOOK_REAL_MODEL_TEST=1 \
SAINT_LOOK_REAL_MODEL_PHOTO=/tmp/saint-look-public/images/white-tee.jpg \
SAINT_LOOK_MODEL_PYTHON=/opt/saint-look-ml/bin/python \
SAINT_LOOK_MODEL_ASSETS=/opt/saint-look-model \
node --test backend/test/real-preparation.mjs
```

В образе backend находится в `/app/backend`: команда оттуда —
`node --test test/real-preparation.mjs`. Фото монтируется отдельно; тест работает
с `--network none` (loopback fixtures), не скачивает данные и не использует API keys.
JSON evidence печатает SHA исходного файла/encoder input, spaceID, hash/размер
representation, время POST preparation→ready и `committed:true`.
Локальная проверка 29 октября 2026: white-tee public SHA
`3aa6d547cca9a7cd3bd2782e98485dbadfd892a35b8d99c31d8134379e5ba49f`,
6 891 ms preparation, 2 864 bytes representation, full commit/replay успешны.
Это один cold CPU/1-thread вызов, не измерение рекомендаций на 300 вещах.
