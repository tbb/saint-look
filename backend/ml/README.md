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
