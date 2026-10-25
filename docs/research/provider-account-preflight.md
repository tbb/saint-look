# Аккаунты для первой пробы Photoroom и Jev

Текущий выбор пользователя от 25 октября 2026 — Photoroom + Jev. Это подготовка #10: 2–3 публичных фото одной вещи без человека. Аккаунты, ключи и фактические остатки не проверены; регистраций, покупок и вызовов обработки ещё не было. Первоначальный Gemini заменён в #22.

## Photoroom: публичные условия

Новый аккаунт получает 10 бесплатных production-вызовов Remove Background API без водяного знака; карта для пробы не нужна. Отдельные 1 000 sandbox-вызовов Image Editing API в месяц дают watermark и не заменяют выбранную пробу. Переход на платный Basic/Plus оформляется в API dashboard; наличие бесплатного предложения не подтверждает остаток конкретного аккаунта. [Тарифы и FAQ](https://www.photoroom.com/api/pricing).

В [Web App](https://app.photoroom.com/api-dashboard) администратор выбирает Space и включает API через `Enable the Photoroom API for free`. Затем `API dashboard → API keys` показывает отдельные Live и Sandbox keys. Для выбранной пробы нужен Live key. Это API-настройка Space, а не покупка мобильной подписки. [Включение API](https://help.photoroom.com/en/articles/15419402-enable-the-photoroom-api-web-app), [получение ключей](https://help.photoroom.com/en/articles/15419535-find-your-photoroom-api-keys-web-app), [независимость API-подписки](https://docs.photoroom.com/getting-started/pricing).

Остаток и историю расхода показывает API dashboard; документация также описывает `GET https://image-api.photoroom.com/v2/account` с `x-api-key` и полями `images.available`, `images.subscription`, `plan`. Этот запрос здесь не выполнялся. [Учёт квоты](https://docs.photoroom.com/getting-started/pricing). Вывод для нашей проверки: клиентский таймаут нельзя приравнивать к подтверждённой ошибке обработки у провайдера и гарантированно бесплатному вызову.

По обучению источники расходятся: текущая security-страница указывает обучение для self-serve API по умолчанию и opt-out в settings; Help Center от 20 октября 2025 утверждает, что API-фото не используются для обучения без отдельного запроса. Security-страница прямо отделяет app opt-out от API-условий. Поэтому переключатель приложения `Improve model for everyone` сам по себе не подтверждает API opt-out. Точный путь и название API-переключателя открытые страницы не устанавливают — нужно проверить применимые настройки API Space/условия аккаунта; если их нет, выяснить у поддержки до отправки фото. [Security](https://www.photoroom.com/platform/security), [Help Center: данные](https://help.photoroom.com/en/articles/8707489-permission-for-photoroom-to-use-your-data), [Help Center: обучение](https://help.photoroom.com/en/articles/10067660-does-the-ai-learn-from-your-images).

## Jev: аккаунт TypeSafe

Официальная [консоль TypeSafe](https://console.typesafe.ai/) предоставляет API key; ключ хранится как `TYPESAFE_API_KEY`. [Quick start](https://docs.typesafe.ai/introduction/quickstart) не описывает точный путь вкладок billing и создания ключа, поэтому их названия здесь не предполагаются. Проверьте организацию, доступность `jev-1.14.0` с experimental images, баланс и лимиты. [Models](https://docs.typesafe.ai/models), [Images](https://docs.typesafe.ai/images).

Цена — $0.042 за миллион входных токенов, выход бесплатен. Сумма минимального пополнения и бесплатные кредиты публично не подтверждены: сначала смотрим checkout. Автопополнение не включаем; неизвестную сумму не считаем согласованной. Фактический расход проверяется после пробы. По условиям нет обучения на клиентских запросах без согласия, но ZDR относится к enterprise; короткий стандартный срок хранения не обещан. [MCA](https://typesafe.ai/legal/mca), [Legal](https://docs.typesafe.ai/legal).

## Что проверить перед запуском

- Photoroom: правильный Space и Live key, остаток production Remove Background вызовов на 2–3 снимка, API opt-out. Для начала доступны заявленные 10 бесплатных вызовов; выбранный пользователем Basic стоит $20/месяц за 1000 вырезок. API-подписка ещё не оформлена; увеличение пакета не разрешено автоматически. [Pricing](https://www.photoroom.com/api/pricing).
- Jev: правильная организация и ключ, доступ к модели/изображениям, достаточно кредитов, сумма пополнения известна и согласована, автопополнение выключено. Первая страна пользователя — Финляндия; фактическую возможность регистрации и использования проверяем в аккаунте, не выводим её из региона Fly.
- В [GitHub Actions secrets](https://github.com/tbb/saint-look/settings/secrets/actions) сохраняются `TYPESAFE_API_KEY` и `PHOTOROOM_API_KEY`; ключи не передаются в чат, iOS или Git. CLI — `gh secret set TYPESAFE_API_KEY` и `gh secret set PHOTOROOM_API_KEY` с интерактивным вводом, без ключей в аргументах.
- До и после пробы записываются остатки, версия модели и результат без секретов. Только после проверки условий выставляется `AI_TRIAL_PREFLIGHT_VERIFIED=true`; сам флаг не ограничивает расходы. [Порядок пробы](../live-trial.md).

Это проверяемые условия проекта, не утверждения о состоянии пользовательских аккаунтов. Эмбеддинги и оценка луков не входят в текущую интеграцию.
