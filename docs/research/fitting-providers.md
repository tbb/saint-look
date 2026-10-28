# Поставщики для стилизованных вещей — #44

Проверено 27 октября 2026 по первичным источникам. Исследование только read-only: ключи и аккаунты не читались, реальные API не вызывались. Качество генерации, доступ конкретному аккаунту и фактическая скорость пока не измерены.

## Текущее решение пользователя

27 октября владелец изменил порядок: **Photoroom sandbox сначала удаляет фон → JEV извлекает признаки → Nano генерирует стилизованную вещь**. Для непрозрачного результата Nano используется та же Photoroom sandbox-вырезка. BRIA была ранним исследованным вариантом, **не входит в выбранный план, бюджет или fallback**.

Версия pipeline в плане — `photoroom-first-v2`; исходные фото, геометрия манекена и рубрика сохраняются. Каждый новый план фиксируется отдельным SHA и новым каталогом, старые результаты не перезаписываются. Подготовка #44 остаётся loopback-only. Бюджет реальной пробы #45 пока не согласован.

## Photoroom sandbox: подготовка и финальная вырезка

Sandbox использует тот же `POST https://sdk.photoroom.com/v1/segment`, что Basic production, но отдельный sandbox key с `sandbox_` prefix; результат имеет watermark. В #45 требуется dedicated sandbox environment variable: отсутствие sandbox-префикса — отказ до сети, без fallback на production и без изменения Fly secrets. [Sandbox](https://docs.photoroom.com/remove-background-api-basic-plan/sandbox-mode), [API keys](https://help.photoroom.com/en/articles/15419535-find-your-photoroom-api-keys-web-app).

Multipart: `image_file`, `format=png`, `channels=rgba`, `size=full`, `crop=false`, `despill=false`; без `bg_color`. В ответе binary PNG. `despill=false` сохраняет исходные цвета предмета от этой дополнительной обработки. Это синхронный API без описанного queue receipt/poll/cancel. [Basic OpenAPI](https://docs.photoroom.com/getting-started/api-reference-openapi.md#remove-background-basic-plan), [Quickstart](https://docs.photoroom.com/remove-background-api-basic-plan/quickstart-guide).

Документация указывает 1000 бесплатных sandbox-вызовов в месяц и 100 в день; считать 100/day общим консервативным потолком, не обещать отдельный пул для Basic и Image Editing. Текущее потребление аккаунта не проверено. Действуют также rate limits; при исчерпании/429 остановиться, а не переходить на live. Бесплатные production trial calls в этот опыт не входят. [Sandbox](https://docs.photoroom.com/remove-background-api-basic-plan/sandbox-mode), [Pricing](https://docs.photoroom.com/getting-started/pricing), [FAQ](https://docs.photoroom.com/getting-started/frequently-asked-questions).

Для каждого уникального SHA исходного фото вырезка выполняется один раз и переиспользуется между single/multi и A/B. Пока подготовка фото не завершена валидным результатом, связанные JEV/Nano не запускаются. Неизвестный исход бесплатного вызова тоже занимает quota slot и не повторяется автоматически.

Sandbox watermark — артефакт обработки, а не признак одежды. JEV и Nano получают оригинал вместе с вырезкой, роли различаются явно. Оригинал остаётся источником достоверных принтов/надписей/цветов. Watermark нельзя считать брендом или переносить в описание; отдельная операция его удаления не вводится. Это ограничение опыта, не обещание clean production output.

## Кандидаты генератора

| Endpoint | Проверенные свойства | Оценка применимости |
| --- | --- | --- |
| `fal-ai/nano-banana-pro/edit` | Prompt, до 14 reference images, 1K/2K $0.15 за изображение; 4K $0.30. PNG/JPEG/WebP. Web search отдельно оплачивается. | Основной кандидат пробы: фиксированная цена и multi-reference. Качество позы/принтов/alpha не подтверждено. |
| `fal-ai/qwen-image-edit-2511` | Prompt + image_urls, custom image_size и seed; $0.03/MP. | Исследованная более дешёвая альтернатива, не автоматический fallback и не второй опыт в согласуемом бюджете. |
| `fal-ai/flux-2-pro/edit` | До 9 reference images / 9 MP total input; $0.03 за первый output MP, доплата за дополнительные input/output MP. | Цена зависит от размера входов, не считать плоской ставкой $0.03 для нескольких фото. |

Источники: [Nano model/pricing](https://fal.ai/models/fal-ai/nano-banana-pro/edit), [Nano schema](https://fal.ai/models/fal-ai/nano-banana-pro/edit/api), [Qwen](https://fal.ai/models/fal-ai/qwen-image-edit-2511), [Qwen API](https://fal.ai/models/fal-ai/qwen-image-edit-2511/api), [FLUX](https://fal.ai/models/fal-ai/flux-2-pro/edit), [FLUX API](https://fal.ai/models/fal-ai/flux-2-pro/edit/api). Выбирать по точному endpoint ID, не по похожим маркетинговым названиям.

В A и B одинаковые `original_i, cutout_i` плюс один общий template: **2k+1 references**. Для одного фото 3, двух 5, максимальных трёх 7 — меньше лимита 14. Роли переда/спинки сохраняются; только B получает блок валидированных признаков. `num_images=1`, разрешение1K, `enable_web_search=false`, фиксированные seed/параметры. Seed не обещает битовой воспроизводимости hosted-модели. Наличие PNG не означает usable alpha.

Nano может вернуть квадратный canvas. Общая геометрия манекена 360×560 требует подтверждённого aspect ratio либо единой обратимой letterbox-нормализации. Нельзя растягивать или индивидуально случайно обрезать результаты ради красивого наложения. Это проверяется в #45.

## JEV: признаки, а не свободное описание

Текущий pin `jev-1.14.0`, POST `https://api.typesafe.ai/v1/systemone`, $0.042/M input tokens, output бесплатный; обычный context 64k/request и 32k/question. Фото входят в token usage, публичного точного image-token estimator нет. [Models](https://docs.typesafe.ai/models).

Images экспериментальны и требуют `TypeSafe-Danger-Zone-Images:true`. Несколько labeled images поддержаны: каждый asset имеет отдельную ссылку и появляется в state один раз. PNG/JPEG, стороны 280–1568px, файл≤16MiB, request/expanded images≤32MiB. EXIF API не применяет: нормализовать пиксели до отправки. Оригинал+вырезка увеличивает размер/токены; проверять лимит после раскрытия пар. Style/mannequin в извлечение признаков не отправлять. [Images](https://docs.typesafe.ai/images).

JEV возвращает `Choice`/`Noul`/`Score`, не произвольное свободнотекстовое описание. Choice даёт confidence/probabilities; Noul — вероятность yes без отдельной confidence. Box не является маской ткани. [Primitives](https://docs.typesafe.ai/primitives), [Box](https://docs.typesafe.ai/primitives/box).

Начальный словарь для проверки: наблюдаемый силуэт fitted/straight/relaxed/unknown; длина корпуса и рукавов; горловина/воротник; застёжка; рисунок plain/stripes/checks/graphic/mixed/unknown; наличие капюшона, кармана-кенгуру, контрастных манжет и спущенных плеч; основные цвета и расположение деталей по конечным зонам; smooth/knitted/fuzzy/glossy/unknown. Для каждого применимого признака нужны unknown/visibility gate, а не принудительное угадывание. Точный состав ткани, текст неразборчивой надписи и оверсайз на конкретном человеке не выводятся из фото. Не учитывать фон, вешалку, тень и sandbox watermark. Ручной тип/цвет имеет приоритет. Конкретная полезность этого словаря ещё не измерена.

## Конкретный план #45

Текущая выборка: **10 вещей, 12 уникальных фото, 12 input-set** (10 single + 2 multi), 24 baseline генерации. Текущий mock консервативно проходит final cutout после каждого результата; live сможет пропустить его, только подтвердив пригодную alpha.

| Стадия | Baseline | Явный максимум | Резерв на вызов |
| --- | ---: | ---: | ---: |
| Photoroom initial sandbox |12|12|$0, но quota slot занят |
| JEV |12|14 (2 дополнительных слота)|2753microUSD |
| Nano1K |24|28 (4 дополнительных слота)|150000microUSD |
| Photoroom final sandbox |до24|до28|$0, но quota slot занят |
| Итого |до72|до82|$3.633036 baseline; $4.238542 максимум |

Максимум Photoroom — **40 sandbox calls**:12 initial + 28 final. Не расходовать оставшийся дневной пул без проверки доступности. Дополнительные generation/JEV слоты не разрешают повторную initial-вырезку. $5 общего потребления — только предложенный cap, ещё не разрешение на реальные вызовы и не команда израсходовать остаток. Покупка credits/налоги отдельно. Бюджет другого эксперимента не переносится сюда.

JEV резерв = ceil(65536×$0.042/M) в microUSD, **не flat price**. Фактическую стоимость писать из usage.input_tokens; missing usage/unknown не освобождает резерв. Нулевой денежный резерв Photoroom не означает неограниченные calls. Локальный ledger ограничивает dispatch по pinned rates, не гарантирует абсолютный provider-side hard cap при изменении тарифа. Перед реальной пробой перепроверить ставки, quota и доступ endpoint аккаунту.

## Ограничения будущего live-adapter

Только после допуска: долговечный reserve → один dispatch → receipt/результат → проверка/сохранение. Для Nano queue receipt сохранять до polling; после потери receipt — unknown без повторного submit. Для синхронного Photoroom обрыв после отправки тоже unknown quota slot. Повторный запуск переиспользует лишь полностью проверенные и сохранённые артефакты. Ошибка alpha/disk full не делает вызов бесплатным.

На Nano-submit нужны `X-Fal-No-Retry:1`, `x-app-fal-disable-fallback:true`; отключить SDK retries. Queue timeout клиента не доказывает отмену обработки. Не брать произвольные response URLs для отправки ключа; exact host/path allowlist, redirect запрещён, CDN-download без provider auth, bounded streaming и настоящее декодирование PNG. [Queue](https://fal.ai/docs/documentation/model-apis/inference/queue), [Common parameters](https://fal.ai/docs/documentation/model-apis/common-parameters), [Reliability](https://fal.ai/docs/documentation/model-apis/inference/reliability).

Длительность пока не измерена. Проба должна отдельно записывать ожидание очереди, время обработки, число запросов и ошибки; задержка не является разрешением платить повторно. Photoroom и Nano результаты сохраняются отдельно, включая raw generation и итоговый watermarked слой.

## Данные и доступность

Для fal публичная документация указывает default 90 дней IO-retention. `X-Fal-Store-IO:0` отключает request-history payload, lifecycle expiration 3600 ограничивает generated CDN files; это не ZDR и не удаление app-owner logs. До live проверить account terms и обозначение Excluded Models: договорное no-training имеет исключения. Не обещать EU-only обработку. [API Services](https://fal.ai/legal/api-services), [Retention](https://fal.ai/docs/documentation/model-apis/media-expiration), [Privacy](https://fal.ai/legal/privacy-policy).

TypeSafe запрещает обучение весов на Customer Data без предварительного согласия, но это не ZDR. [MCA](https://typesafe.ai/legal/mca), [DPA](https://typesafe.ai/legal/data-processing). FAQ Photoroom заявляет отсутствие сохранения API images и обработку в Eastern USA; не выдавать это за независимо проверенную end-to-end ZDR-гарантию. [FAQ](https://docs.photoroom.com/getting-started/frequently-asked-questions).

Применяются публичные лицензированные fixtures с сохранёнными атрибуциями и SHA. Права на фото не заменяют бюджет, доступ аккаунта и проверку условий поставщика. Никаких личных фото пользователя или live-секретов в публичном репозитории.
