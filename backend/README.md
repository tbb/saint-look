# Backend локального среза #2

Node.js 24 LTS (минимум 24.13), встроенные HTTP и SQLite, одна runtime-зависимость `sharp` для безопасного декодирования и удаления метаданных. SQLite хранит исходник, задание и результат в одном приватном каталоге, без внешней инфраструктуры. Это выбор реализации #2; он не меняет согласованный будущий Railway-стенд.

```bash
npm --prefix backend ci --ignore-scripts
export SAINT_LOOK_OWNER_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export SAINT_LOOK_PROVIDER=demo
node backend/src/server.mjs
```

Тот же токен задайте в настройках приложения. Не сохраняйте его в Git, командной строке URL или логах. Сервер пишет только локальный адрес и `mode: demo`, не запросы. Рабочие данные по умолчанию `.data/wardrobe.sqlite`, исключены из Git; права новых файлов ограничены `umask 077`. `SAINT_LOOK_DATA_DIR` меняет каталог; `PORT` — порт (8787), `HOST` — интерфейс (127.0.0.1). Для очистки локального демо остановите процесс и удалите только выбранный каталог данных.

`SAINT_LOOK_PROVIDER=demo` обязателен. Синтетическая футболка с прозрачностью не зависит от загруженной фотографии и не подтверждает качество AI. `SAINT_LOOK_DEMO_DELAY_MS` управляет задержкой (1500 мс по умолчанию), `SAINT_LOOK_DEMO_OUTCOME=fail` даёт управляемый отказ для тестов. Ключей провайдера и внешних AI-запросов нет.

```bash
npm --prefix backend test
npm --prefix backend run check
```

Тесты запускают реальный сервер отдельным процессом, работают только через HTTP и используют временное настоящее SQLite-хранилище. Фото генерируются в памяти; приватных файлов и реального AI нет. [Контракт](../docs/api/local-ingestion.md), [iOS-клиент](../client-ios/README.md).
