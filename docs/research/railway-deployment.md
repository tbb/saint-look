# Railway: проверенные условия dev-деплоя

Дата проверки: 2026-10-24. Контекст: issue #9, спецификация MVP и ADR 0002. Ниже факты из документации и исходников поставщиков; рекомендации для проекта помечены отдельно. Доступа к Railway workspace, его billing и реальному volume при исследовании не было: настройки аккаунта и удалённый smoke ещё не подтверждены.

## Выбранный commit и GitHub Actions

`workflow_dispatch` запускает workflow на выбранной ветке/tag; его `GITHUB_SHA` относится к этому ref, а не к произвольному input с SHA приложения. Workflow должен существовать в default branch, но dispatch возможен и для других ref. [GitHub: events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).

Рекомендация для проекта: deploy workflow разрешает запуск только с `refs/heads/main`, принимает полный 40-символьный SHA и до получения Railway secret проверяет, что commit входит в историю текущего `origin/main`. Workflow управления берётся с `main`; отдельный checkout приложения — строго на проверенный input SHA. Эти две версии нельзя смешивать.

Проверка CI должна обращаться к конкретному `ci.yml` и требовать `head_sha == selected SHA`, `head_branch == main`, `event == push`, `conclusion == success`, тот же repository. API поддерживает соответствующие фильтры; чтение runs требует `actions: read` для закрытых ресурсов. Успех PR-run не доказывает проверку нового merge/squash commit: нужен CI на push в `main`. Дополнительно проверяем, что обязательные jobs действительно завершились успешно, а не были пропущены. [GitHub: workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow).

Для такого workflow достаточно разрешений `contents: read` и `actions: read`. Рекомендуются неизменяемые SHA внешних Actions, отдельный deploy job после проверки происхождения версии и одна concurrency group без отмены активного деплоя. GitHub рекомендует закреплять Actions полным commit SHA. [GitHub: secure use](https://docs.github.com/en/actions/reference/security/secure-use).

## CLI: загрузка, идентификатор, готовность

На дату исследования опубликован CLI **v5.71.0**. Закрепляем эту версию, например `npm install --global @railway/cli@5.71.0`, и проверяем `railway --version`; не используем `latest` или установочный shell-скрипт с плавающей версией. Для полной фиксации npm-зависимостей подходит отдельный lockfile с `npm ci`. [Официальный release](https://github.com/railwayapp/cli/releases/tag/v5.71.0), [установка CLI](https://docs.railway.com/cli).

Project token задаётся через `RAILWAY_TOKEN` и ограничен одним project/environment. Account/workspace token использует `RAILWAY_API_TOKEN`; он не нужен в deploy job. `up` загружает локальные файлы; `--path-as-root` делает выбранную папку корнем архива. Поэтому checkout SHA должен предшествовать upload. [Railway: deploying](https://docs.railway.com/cli/deploying).

Контракт команды для заранее созданного сервиса: `RELEASE_DIRECTORY` — изолированный `git archive` проверенного коммита с добавленным `backend/REVISION`, корневым `railway.json` и `backend/Dockerfile`. `--no-gitignore` применяется только к этому чистому архиву, чтобы включить сгенерированную версию; рабочий каталог с локальными файлами загружать так нельзя.

```bash
railway up "$RELEASE_DIRECTORY" --path-as-root --no-gitignore \
  --project "$RAILWAY_PROJECT_ID" \
  --environment "$RAILWAY_ENVIRONMENT_ID" \
  --service "$RAILWAY_SERVICE_ID" \
  --detach --json --message "$SELECTED_SHA"
```

В закреплённом исходнике существующего project этот режим возвращает JSON с `deploymentId` и `logsUrl` после загрузки. Это **не подтверждение готовности**. Сохранить ID, дождаться результата именно этой deployment через `railway deployment list --service … --environment … --json`, затем проверить публичный `/health` и совпадение SHA. Не выбирать просто последнюю deployment: возможны посторонние запуски. Документация описывает `--ci` как ожидание build; для однозначного поведения здесь выбран явный detach и отдельный контроль готовности. [CLI up](https://docs.railway.com/cli/up), [исходник v5.71.0](https://github.com/railwayapp/cli/blob/v5.71.0/src/commands/up.rs), [deployment list](https://docs.railway.com/cli/deployment).

`RAILWAY_GIT_COMMIT_SHA` гарантируется только при deployment из GitHub trigger. Для CLI upload рекомендация — включать проверенный SHA в release-файл внутри образа, читать его в `/health`; mutable service variable не доказывает версию образа. `RAILWAY_DEPLOYMENT_ID` позволяет дополнительно связать приложение с platform deployment. [Railway: variables](https://docs.railway.com/variables/reference).

## Persistent volume и перезапуск

Railway монтирует volume по заданному пути; для проекта это `/data` с SQLite и файлами. Один сервис поддерживает один volume, replicas с volume недоступны. Railway не допускает одновременно активные deployments с одним volume: обновление сопровождается коротким downtime даже с healthcheck. Поэтому здесь нельзя обещать zero-downtime. Hobby предоставляет volume до 5 GB, плата зависит от фактически занятого места, включая файловую metadata. [Railway: volume reference](https://docs.railway.com/volumes/reference).

Документация отдельно предупреждает о правах non-root image на volume и предлагает `RAILWAY_RUN_UID=0`, если возникают ошибки. `chmod /data` на этапе сборки образа не доказывает доступность поверх смонтированного диска. Для запуска от non-root нужен проверенный runtime-путь инициализации владельца и снижения прав; фактические UID/write/restart проверки остаются частью remote smoke. [Railway: volume permissions](https://docs.railway.com/volumes/reference).

Healthcheck допускает HTTP 2xx; timeout по умолчанию 300 секунд. Он проверяет готовность deployment, а не непрерывную работоспособность. Приложение должно слушать назначенный `PORT` на доступном интерфейсе и отвечать успешно после открытия базы/проверки схемы. При завершении Railway отправляет SIGTERM, затем SIGKILL; grace period по умолчанию нулевой, его меняет `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`. Рекомендация: дать процессу время закончить SQLite/worker операции. [Healthchecks](https://docs.railway.com/deployments/healthchecks), [deployment reference](https://docs.railway.com/deployments/reference).

## Откат приложения и SQLite

Нативный Rollback возвращает предыдущий image и его custom variables. На Hobby удалённые images удерживаются 72 часа. Это не восстановление содержимого attached volume. Повторная загрузка старого проверенного SHA через наш workflow — отдельный способ вернуть код с текущими данными, а не обещание платформенного image rollback. [Railway: deployment actions](https://docs.railway.com/deployments/deployment-actions), [rollback guide](https://docs.railway.com/guides/roll-back-bad-deploy).

Рекомендация: явно проверять совместимость формата SQLite при старте; несовместимая версия должна отказать до изменения данных. Проверка `N → N+1 → N` должна использовать один volume и подтверждать сохранность вещей/очереди/файлов. Если схема стала несовместимой, нельзя автоматически «откатить данные» или удалять базу: такой rollback требует отдельного плана. В issue #9 backups не входят.

## Бюджет, остановка и backups

Hobby стоит **$5/месяц с включёнными $5 usage**: при usage $7 базовый счёт $7, а не $12. Опубликованные ставки: RAM $10/GB·месяц, CPU $20/vCPU·месяц, egress $0.05/GB, volume $0.15/GB·месяц. Это оплата использования, а не фиксированная цена работающего сервиса. Например, постоянные 0.5 GB RAM уже стоят около $5 до CPU/storage/egress. [Railway: plans](https://docs.railway.com/pricing/plans).

Compute usage limit охватывает CPU, память, storage и egress; hard limit останавливает workloads, soft limit только уведомляет. Railway отправляет предупреждения на 75%, 90% и 100% hard limit. Railway Agent имеет отдельный лимит и отдельные расходы. Настройки доступны workspace admin в Usage → Set Usage Limits. [Railway: cost control](https://docs.railway.com/pricing/cost-control).

Официальный CLI позволяет прочитать текущие limits и выставить Compute soft/hard; минимумы составляют соответственно $5/$10. Значение hard=0 отключает ограничение. Рекомендация для бюджета проекта: soft $5, hard $10, отдельная проверка фактически сохранённых настроек и адресата уведомлений, без использования Railway Agent. Billing-доступ не следует добавлять deployment token ради этой разовой настройки. [Railway: usage CLI](https://docs.railway.com/cli/usage).

При остановке из-за usage volume сохраняется. Документация не даёт проверенной здесь гарантии, что итоговый invoice вместе с сохраняющимся storage, налогами и любыми отдельными услугами никогда не превысит $10. Возможное продолжение начисления за сохранённый диск — вывод из сохранения volume и его отдельной тарификации, а не подтверждённая проверка конкретного аккаунта. До запуска нужен фактический контроль billing; нельзя представлять hard limit как доказанный абсолютный предел всего счёта. [Railway: pricing FAQ](https://docs.railway.com/pricing/faqs), [volume billing](https://docs.railway.com/volumes/reference).

Backups бывают ручными и scheduled (daily/weekly/monthly), тарифицируются дополнительно как storage. Для принятого dev-режима не создавать backup и не включать расписание; проверить отсутствие уже существующих расписаний/backup в сервисе. Отсутствие локальной команды backup не доказывает состояние workspace. [Railway: backups](https://docs.railway.com/volumes/backups).

## Что остаётся проверить с доступом

Реальный workspace/plan, привязку project/environment/service, mounted `/data` и права записи, отсутствие backups, сохранённые лимиты/уведомления, регион/домен/TLS и секреты. Затем выполнить первый deploy выбранного CI SHA, remote smoke, restart, redeploy и совместимый code rollback на одном volume; сохранить ID deployments и подтверждения сохранности данных. Эти действия не выполнялись в рамках исследования.
