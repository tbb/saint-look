# Saint Look через внутренний TestFlight

Задача [#103](https://github.com/tbb/saint-look/issues/103). Этот путь позволяет
устанавливать последующие сборки с iPhone. Сборка и подпись выполняются на
GitHub-hosted Mac; сертификат создаётся на облачном runner. Локальный Mac не нужен.
Подписку Apple Developer Program, проверку личности и условия Apple оформляет
сам владелец аккаунта. [Инструкция Apple](https://developer.apple.com/help/account/membership/enrolling-in-the-app).

Подготовленная автоматизация ещё не доказывает успешную доставку: нужны активная
подписка, доступ API, настоящая подпись, обработка сборки Apple и установка на
телефон. Пока эти шаги не выполнены, не считать приложение доступным в TestFlight.

## Один раз после активации аккаунта

1. В Safari открыть [App Store Connect](https://appstoreconnect.apple.com/),
   принять предлагаемые соглашения. В Users and Access → Integrations →
   App Store Connect API запросить доступ, если показан Request Access.
   Apple рассматривает такой запрос отдельно; оплата подписки сама по себе
   не означает готовность API. После допуска создать **Team Key**, имя
   `Saint Look CI`, роль **Admin**: первоначальная настройка создаёт distribution
   certificate и provisioning profile. Individual Key для этого сценария не подходит.
   [Инструкция по API-ключам](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api).
2. Сохранить скачанный `.p8` в приватном месте. В
   [GitHub → Settings → Secrets and variables → Actions](https://github.com/tbb/saint-look/settings/secrets/actions)
   добавить **secret** `ASC_PRIVATE_KEY`: полное текстовое содержимое файла,
   включая BEGIN/END PRIVATE KEY. Не добавлять его в issue, комментарий, репозиторий
   или чат. При работе с телефона этот единственный перенос секрета требует
   возможности открыть `.p8` как текст; пароль Apple Account и коды 2FA не нужны CI.
3. В **Variables** добавить `ASC_KEY_ID` и `ASC_ISSUER_ID` со страницы Team Keys,
   `IOS_TEAM_ID` из Apple Developer → Account → Membership details.
   `IOS_TESTFLIGHT_BUNDLE_ID` по умолчанию `com.saintlook.dev`.
   Перед изменением идентификатора проверить переход с уже установленной IPA:
   Sideloadly мог изменить bundle ID и использует другую команду подписи.
4. Оператор проверяет доступ к закрытому age-ключу, соответствующему существующей
   переменной `IOS_IPA_AGE_RECIPIENT`, затем ставит `IOS_TESTFLIGHT_ENABLED=true`.
   Это отметка готовности аккаунта и конфигурации; она не заменяет Apple membership.
5. В [Actions → Internal TestFlight](https://github.com/tbb/saint-look/actions/workflows/ios-testflight.yml)
   запустить `prepare-signing` из **main**, один раз. Workflow создаст CSR и private
   key, зарегистрирует bundle ID при необходимости, создаст один Apple Distribution
   certificate и один IOS_APP_STORE profile. Существующие сертификаты не отзывает.
   Если ID занят другой командой, сначала решить вопрос ID, затем повторять setup.
6. Оператор скачивает **только зашифрованный** артефакт `TestFlight-signing-<run id>`
   (хранится 3 дня), расшифровывает его существующим age-ключом в приватную временную
   папку. Проверяет `receipt.json`: `state=ready-for-github-secrets`, нужный bundle ID.
   Сохраняет в GitHub Secrets через stdin, без вывода значений:

   | Secret | Содержимое из архива |
   | --- | --- |
   | `IOS_DISTRIBUTION_P12_BASE64` | base64 файла `distribution.p12`, одной строкой |
   | `IOS_DISTRIBUTION_P12_PASSWORD` | файл `p12-password.txt` |
   | `IOS_APP_STORE_PROFILE_BASE64` | base64 файла `app.mobileprovision`, одной строкой |

   Приватную копию ключа/сертификата сохранить в защищённом хранилище для
   восстановления; рабочую расшифрованную папку удалить. Пользователю не нужно
   импортировать сертификат на телефон или экспортировать его из Keychain на Mac.
7. В App Store Connect → Apps → `+` → New App создать карточку: iOS,
   название `Saint Look` (если доступно), основной язык Russian, bundle ID
   из настройки выше, SKU `saint-look-ios`. API setup регистрирует bundle ID,
   но **не создаёт карточку приложения**.
   [Создание карточки](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/).

## Выпустить сборку

В том же workflow выбрать `upload` из **main**. Перед подписью проверяется
успешный полный iOS CI ровно этого коммита из push или ручного запуска: все 11
обязательных заданий должны пройти в одном прогоне, пропущенные задания не
считаются успехом. Более поздняя узкая диагностика не отменяет уже пройденный
полный CI и сама не даёт допуска к выпуску. При ещё работающем CI дождаться результата
и начать новый dispatch. Номер сборки — `run_number.run_attempt`, версия — из Info.plist.

Workflow создаёт Release archive arm64, проверяет team/bundle/expiry/type profile
и соответствие сертификату, подписывает и экспортирует с
`testFlightInternalTestingOnly=true`, затем один раз отправляет через `altool`.
Ни archive, ни персональная IPA не публикуются как GitHub artifacts. Токен dev-backend
встраивается **до** подписи и не меняется в готовом пакете. Исходный Info.plist не редактируется.
Этот выпуск не выкладывает backend; существующая доставка IPA через Sideloadly остаётся доступна.

Успешная команда upload означает только приём загрузки. В App Store Connect →
Saint Look → TestFlight дождаться окончания обработки, проверить версию/номер
сборки и отсутствие блокирующих сообщений. В Internal Testing создать группу
для владельца, добавить свою учётную запись App Store Connect и обработанную сборку.
Workflow не создаёт группы, не рассылает приглашения и не отправляет приложение
на публикацию в App Store. [Внутренние тестеры](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/).

Установить из TestFlight на iPhone и проверить открытие существующего гардероба,
доступ к backend, добавление вещи и сборку лука. **Не удалять прежнее приложение**
для перехода: вещи хранятся локально, а смена bundle ID/team может нарушить доступ
к контейнеру и Keychain. При несовпадении идентичности сначала определить способ
переноса; сохранность данных до проверки на устройстве не обещать.

Это персональная внутренняя сборка с owner token. Не подключать других тестеров
и не переходить к внешнему TestFlight/App Store с общим токеном: для этого нужна
отдельная авторизация пользователей. Internal-only export ограничивает канал
распространения, но сам по себе не ограничивает внутреннюю группу одним владельцем.

## Проверки и восстановление

`check` и PR запускают Python/Node policy tests и настоящий unsigned Release
archive с фиктивными настройками подключения. Apple API и owner secret недоступны
этим заданиям. Проверяются provenance, build number, arm64, отсутствие debug-ресурсов
и поддержка internal-only export установленным Xcode. Проверяется упаковка privacy
manifest с причинами чтения app-local UserDefaults и timestamps локальных изображений,
а также четыре ориентации iPad (iPhone остаётся портретным). Отдельная проверка на Mac
импортирует одноразовый self-signed сертификат из OpenSSL 3 PKCS#12 в временную keychain.
Это проверка совместимости формата, а не настоящей подписи Apple.

```sh
python3 client-ios/scripts/tests/test-testflight.py
node --test client-ios/scripts/tests/testflight-signing.test.mjs
# На macOS с Homebrew OpenSSL 3:
node --test client-ios/scripts/tests/testflight-keychain.test.mjs
```

При сбое prepare-signing не нажимать Re-run jobs: повторная попытка заблокирована,
а новый dispatch может создать лишний сертификат. Сначала скачать encrypted recovery
artifact и проверить receipt/API: ответ на POST мог потеряться после создания.
Checkpoint сохраняет private key до первого запроса и IDs сразу после ответов.
Если сертификат уже создан, использовать его с сохранённым private key и получить
недостающий profile; не отзывать чужие сертификаты и не создавать дубликаты вслепую.
После настройки signing secrets повторный setup также блокируется.

При неопределённом исходе upload сначала проверить сборку в App Store Connect.
Скрипт не повторяет загрузку автоматически. Подробный вывод инструментов подписи
не публикуется: он может содержать секреты; stage сообщает, какой шаг не прошёл.

Временная signing keychain и установленные профили удаляются в finally, предыдущий
список keychain восстанавливается. Профиль, уже существующий на runner, не заменяется.
Runner одноразовый. Сертификат/profile проверяются перед каждым выпуском; продление
истёкших материалов — отдельная операция, автоматического отзыва нет.

PKCS#12 использует совместимые с macOS Security PBE-SHA1-3DES и SHA-1 MAC;
за конфиденциальность recovery artifact отвечает внешнее шифрование age,
а пароль PKCS#12 генерируется случайно. [Параметры OpenSSL](https://docs.openssl.org/3.2/man1/openssl-pkcs12/).

Сборка указывает `ITSAppUsesNonExemptEncryption=false`: текущий клиент использует
системные HTTPS/Keychain и SHA-256 для хеширования, собственной реализации шифрования
нет. При изменении криптографии пересмотреть декларацию по
[документации Apple](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/).
