# Issue tracker: GitHub

Задачи и спецификации живут в GitHub Issues репозитория
`tbb/saint-look`. Используй CLI `gh`.

## Основные операции

- Создать: `gh issue create --title "..." --body-file <file>`.
- Прочитать: `gh issue view <number> --json number,title,body,labels,comments`.
- Найти: `gh issue list --state open --json number,title,labels`;
  при необходимости добавь фильтры.
- Изменить описание: `gh issue edit <number> --body-file <file>`.
- Добавить комментарий: `gh issue comment <number> --body-file <file>`.
- Добавить или снять лейбл: `gh issue edit <number> --add-label "..."`
  или `--remove-label "..."`.
- Закрыть: `gh issue close <number> --comment "..."`.

Команды запускай из клона репозитория или добавляй
`--repo tbb/saint-look`. Для многострочных текстов используй
UTF-8 файл и `--body-file`.

«Опубликовать в трекере» означает создать GitHub issue.
«Получить соответствующий тикет» означает прочитать GitHub issue.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Связи задач и wayfinder

- Карта работы — issue с лейблом `wayfinder:map`, содержащая
  заметки, принятые решения и открытые вопросы.
- Дочерние задачи связывай с картой через GitHub sub-issues.
  Если они недоступны, используй список задач в карте
  и строку `Part of #<map>` в дочерней задаче.
- Тип дочерней задачи задавай лейблом `wayfinder:<type>`:
  `research`, `prototype`, `grilling` или `task`.
- Блокировки отражай через GitHub issue dependencies.
  Если они недоступны, используй строку `Blocked by: #<number>`.
- Следующая задача — первая по порядку карты открытая задача
  без исполнителя и открытых блокирующих задач.
- При взятии задачи назначь себя: `gh issue edit <number> --add-assignee @me`.
- При завершении добавь результат в комментарий, закрой задачу
  и внеси краткий вывод со ссылкой в решения карты.
