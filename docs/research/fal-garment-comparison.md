# fal.ai: сохранение вещи при расправлении и посадке

Проверено 2 ноября 2026 года по официальным страницам fal и FASHN.
Это план ограниченного сравнения; результатов платных проб в этом документе
пока нет. Исследование не вызывало inference API и не читало секреты.

## Вывод

Для первой пробы подходят три разных подхода: специализированный FASHN v1.6,
FLUX 3 Image Edit и GPT Image 2.5 Sunburst Edit. Приоритет конечного результата —
отдельный слой вещи с настоящей прозрачностью, расправленными рукавами/штанинами
и сохранёнными кроем, отношением ширины к длине, принтом и материалом.
Изображение одетого манекена полезно только для диагностики посадки.

| Endpoint | Роль в сравнении | Цена выбранной конфигурации | Прозрачный слой |
| --- | --- | --- | --- |
| `fal-ai/fashn/tryon/v1.6` | Специализированная примерка; проверка переноса вещи на нейтральную фигуру | $0.075 за генерацию | Не заявлен; PNG сам по себе не означает alpha |
| `blackforestlabs/flux-3/edit-image` | Редактирование оригинальной вещи с отдельным указанием позы | $0.048 за 1K, независимо от числа референсов | Нет параметра прозрачного фона; нужна проверка/финализация |
| `openai/gpt-image-2.5/sunburst/edit` | Редактирование оригинала с нативным запросом alpha | 1024×1536 high: $0.04116 output + reference/text tokens | `background: transparent` есть в схеме |

Цены и назначение: [FASHN](https://fal.ai/models/fal-ai/fashn/tryon/v1.6),
[FLUX 3](https://fal.ai/models/blackforestlabs/flux-3/edit-image),
[Sunburst](https://fal.ai/models/openai/gpt-image-2.5/sunburst/edit).
Заявления поставщиков о сохранении деталей — основание проверить кандидатов,
а не доказательство качества на наших трёх вещах.

## Почему не product-to-model или «извлечение одежды»

В проверенных каталоге и документации fal найден FASHN v1.6; отдельный fal endpoint
для FASHN Product to Model, Try-On Max или гарантированной garment-to-garment
нормализации не подтверждён. Это ограничение поиска, а не утверждение об
отсутствии любых частных endpoints. [Каталог fal](https://fal.ai/explore).

У самого FASHN Product to Model принимает `product_image` и создаёт человека
в этой вещи; `image_prompt` направляет сцену/позу, `face_reference` — личность.
Для сохранения существующей позы/фона FASHN направляет к Try-On Max с
`model_image`. Это другая служба: `POST https://api.fashn.ai/v1/run`,
`{model_name, inputs}`, отдельная авторизация и биллинг. Разблокированный fal
аккаунт не подтверждает доступ к ней. [Product to Model](https://docs.fashn.ai/api-reference/product-to-model).

Документация FASHN описывает `model_image` как фотографию человека;
flat-lay/ghost mannequin относится к источнику `garment_image`. Поэтому наш
нейтральный манекен как **цель** — проверяемая экстраполяция, а не обещанная
возможность. Даже удачная примерка не возвращает автоматически изолированную
вещь. [FASHN v1.6](https://docs.fashn.ai/api-reference/tryon-v1-6),
[руководство параметров](https://docs.fashn.ai/guides/tryon-parameters-guide).

## Точные входы для запуска

Ниже JSON — тело REST-запроса. Плейсхолдеры заменяются URL/data URI фактических
изображений. `PROMPT` — фиксируемая экспериментальная инструкция, не имя поля
поставщика. Все три модели возвращают массив `images` с `url`.

### FASHN v1.6

```json
{
  "model_image": "MANNEQUIN_URL_OR_DATA_URI",
  "garment_image": "ORIGINAL_URL_OR_DATA_URI",
  "category": "tops",
  "mode": "quality",
  "garment_photo_type": "flat-lay",
  "num_samples": 1,
  "segmentation_free": true,
  "output_format": "png",
  "seed": 42
}
```

Для брюк `category: bottoms`. `flat-lay` применять к соответствующему исходнику;
для вещи на человеке использовать `model`. Результат — 864×1296.

Обязательные строки: `model_image`, `garment_image`. Остальные поля:

| Поле | Тип / значения | Default |
| --- | --- | --- |
| `category` | `auto`, `tops`, `bottoms`, `one-pieces` | `auto` |
| `mode` | `performance`, `balanced`, `quality` | `balanced` |
| `garment_photo_type` | `auto`, `model`, `flat-lay` | `auto` |
| `moderation_level` | `none`, `permissive`, `conservative` | `permissive` |
| `seed` | integer | Не указан |
| `num_samples` | integer | `1` |
| `segmentation_free` | boolean | `true` |
| `sync_mode` | boolean | Не указан |
| `output_format` | `png`, `jpeg` | `png` |
| `enable_safety_checker` | boolean | `true` |

`segmentation_free` отключает human parsing цели; это разумный первый режим
для объёмного худи. Собственного текстового prompt здесь нет.
Параметры модерации оставляем стандартными.
[Схема fal FASHN](https://fal.ai/models/fal-ai/fashn/tryon/v1.6/api).

### FLUX 3 Image Edit

```json
{
  "prompt": "PROMPT",
  "image_urls": ["ORIGINAL_URL_OR_DATA_URI", "MANNEQUIN_URL_OR_DATA_URI"],
  "aspect_ratio": "2:3",
  "resolution": "1k",
  "enable_prompt_expansion": false,
  "output_format": "png"
}
```

Обязательны `prompt: string`, `image_urls: string[]`.
До 10 референсов, каждый ≥256 px по обеим осям; большие изображения уменьшаются
до 4 MP с сохранением пропорций. Порядок соответствует image 1…10.

| Необязательное поле | Значения / тип | Default |
| --- | --- | --- |
| `aspect_ratio` | `auto`, `21:9`, `2:1`, `16:9`, `3:2`, `7:5`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `5:7`, `2:3`, `9:16`, `1:2` | `auto`, по первому изображению |
| `resolution` | `768sq`, `1k`, `1.5k`, `2k`, `4k` | `1k` |
| `enable_prompt_expansion` | boolean | Не указан в API-схеме |
| `safety_tolerance` | integer 0…4 | `2` |
| `output_format` | `jpeg`, `png` | `jpeg` |
| `sync_mode` | boolean | Не указан |
| `version` | string | `latest` |

Seed и alpha-параметр в схеме не заявлены.
[Схема FLUX 3](https://fal.ai/models/blackforestlabs/flux-3/edit-image/api).
Маркетинговая таблица перечисляет `512sq`, а API-схема — `1.5k`; проба использует
совпадающий `1k`. Утверждение о target mannequin отсутствует; роли задаёт prompt.
[Страница FLUX 3](https://fal.ai/models/blackforestlabs/flux-3/edit-image).

### GPT Image 2.5 Sunburst Edit

```json
{
  "prompt": "PROMPT",
  "image_urls": ["ORIGINAL_URL_OR_DATA_URI", "MANNEQUIN_URL_OR_DATA_URI"],
  "image_size": {"width": 1024, "height": 1536},
  "background": "transparent",
  "quality": "high",
  "num_images": 1,
  "output_format": "png"
}
```

Обязательны `prompt: string`, `image_urls: string[]` (максимум 16).

| Необязательное поле | Значения / тип | Default |
| --- | --- | --- |
| `mask_url` | string; белое редактируется, чёрное сохраняется | Нет |
| `image_size` | `{width,height}` либо `auto`, `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` | `auto` |
| `background` | `auto`, `transparent`, `opaque` | `auto` |
| `quality` | `auto`, `low`, `medium`, `high`, `xhigh`, `max` | `high` |
| `num_images` | integer | `1` |
| `output_format` | `jpeg`, `png`, `webp` | `png` |
| `output_compression` | integer 0…100, только JPEG/WebP | Не указан |
| `sync_mode` | boolean | Не указан |
| `enable_safety_checker` | boolean | `true` |

Seed и `input_fidelity` здесь отсутствуют: не переносить параметры GPT Image 1.5.
Маску в первой пробе не используем, поскольку требуется менять положение частей
вещи. Нативная прозрачность требует последующей проверки alpha и содержимого.
[Схема Sunburst](https://fal.ai/models/openai/gpt-image-2.5/sunburst/edit/api).

## Асинхронный протокол и учёт затрат

Отправка: `POST https://queue.fal.run/{полный endpoint}`,
`Authorization: Key …`, `Content-Type: application/json`; тело — сам JSON выше,
без REST-обёртки `input`. Сохранить `request_id`, `status_url`, `response_url`
до polling. Использовать возвращённые URLs: status/result содержат owner/app,
а не полный путь модели; самостоятельное добавление `/edit/requests/…`
может дать 405. `GET status_url` отслеживает `IN_QUEUE`, `IN_PROGRESS`,
`COMPLETED`; после завершения `GET response_url` получает результат.
Проверить ошибку даже при `COMPLETED`. CDN-файлы сохранять локально.
Для ограниченной пробы отключить автоматический server retry заголовком
`X-Fal-No-Retry: 1`; неизвестный исход не заменять новым submit.
[Официальный Queue API](https://fal.ai/docs/documentation/model-apis/inference/queue).

Sunburst тарифицирует text tokens по $5 input / $10 output за миллион,
image tokens по $8 input / $30 output; ≤1024×1024 reference добавляет примерно
$0.008. Для двух таких референсов и короткого prompt портрет high оценивается
примерно в $0.058, а не фиксированные $0.04116. Большие inputs и длинные prompts
меняют сумму. [Тариф Sunburst](https://fal.ai/models/openai/gpt-image-2.5/sunburst/edit).

Расчёт первой серии: FASHN 3×$0.075 + FLUX 3 3×$0.048 + Sunburst
3×≈$0.058 ≈ **$0.54**, без вырезки фона и прочих стадий. Это оценка по
опубликованным ставкам, не жёсткий provider-side потолок. Максимум три повтора
одного победившего кандидата добавят примерно $0.14–0.23. Не использовать
`max`, 4K, batches или автоматические retries в первой серии.

## Протокол сравнения и критерии приёмки

Первая серия — исходные худи, свободная футболка и широкие полосатые брюки
× три endpoints, по одному результату. Для редакторов image 1 всегда оригинал
и единственный источник дизайна; image 2 задаёт только позу/опорные точки
нейтрального манекена. Инструкция должна требовать отдельную вещь, естественно
расправленные части, сохранение наблюдаемой ширины корпуса/полной длины,
рисунка и ткани. Манекен не является источником ширины или кроя.
Для FLUX просить однотонный фон, для Sunburst — прозрачный; сохранять raw
до любой финализации. Это экспериментальные рекомендации, не гарантии API.

Сравнение выполнять по одинаковым независимым критериям:

1. **Идентичность:** форма капюшона/ворота/манжет/подола, реальные швы,
   текст, рисунок, полосы, фактура. Хорошая посадка не компенсирует их замену.
2. **Пропорции:** для устойчивого видимого корпуса использовать существующее
   отношение ширины к центральному подолу; не включать расправленные манжеты
   в длину. Для неоднозначных брюк не придумывать надёжное численное сравнение.
3. **Посадка:** манжеты действительно в запястьях, рукава отделены от корпуса,
   обе штанины раскрыты; нет лишних конечностей/рукавов, обрезанных краёв,
   перекрытия принта или искусственного прямоугольного торса.
4. **Пригодность слоя:** только вещь, полный контур, alpha, отсутствие тела
   и фона. Whole-person VTON отмечать отдельно и не объявлять подготовленной вещью.
5. **Повторяемость:** максимум три повтора того же кандидата после просмотра
   первой серии; фиксировать inputs, prompt, параметры, request IDs, latency,
   стоимость и отказы. Один удачный результат не доказывает устойчивость.

Эти критерии следуют из уже обнаруженных в проекте отказов: худи могло сохранить
корпус, но не попасть манжетами на запястья; хорошая посадка могла сопровождаться
заужением. [Предыдущая проверка fidelity](garment-fidelity-v4.md).

Существующие Gemini + Photoroom остаются baseline. Исследование не меняет
production-провайдер, подготовленные версии вещей или пороги качества.
Любая будущая интеграция обязана публиковать согласованную полностью готовую
версию и сохранять предыдущую при неудаче новой обработки.
[ADR 0004](../adr/0004-complete-item-readiness.md).
