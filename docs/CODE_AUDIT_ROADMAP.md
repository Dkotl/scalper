CODE AUDIT & ENGINEERING ROADMAP

**Архитектурные недостатки и антипаттерны (с привязкой к файлам/функциям)**

- Tight Coupling: `client` экспортируется из `src/client.ts` и используется напрямую в `src/orders.ts` и `src/wallet.ts` (`client.newOrder`, `client.accountInfo`) — сложность мокирования и замены клиента.
- God Object / Blended Responsibility: `tradeLoop` в `src/strategy.ts` выполняет сбор данных, анализ и исполнение ордеров — нужно разделить на UseCases/Services.
- Контроль через `process.exit`: `src/config.ts` делает `process.exit(1)` при отсутствии ключей — это блокирует тестирование и гибкие сценарии запуска.
- Хардкод бизнес-параметров: множители `0.7` / `0.2`, пороги `isSideways` и т.д. захардкожены в `src/analize_market.ts` и `src/strategy.ts`.
- Отсутствие graceful shutdown: `tradeLoop` использует `while(true)` без обработки сигналов.

**Производительность, надёжность и безопасность (конкретные риски)**

- Rate-limit/Throttling: частые запросы — `getKlines`, `openOrders`, `accountInfo` в каждом цикле (~3000ms по умолчанию) на каждую пару — риск превышения лимитов биржи.
- Нет retry/backoff/timeout для сетевых вызовов: `src/get_clines.ts` использует `fetch` без таймаута/ретраев — возможны подвисания.
- Нет валидации ответов API: `analyzeMarket` доверяет формату свечей, `wallet`/`orders` доверяют структурам ответов `mexc-api-sdk`.
- Логирование: `console` — нет уровней, структурированных логов и метрик.
- Секреты: API ключи читаются из env; рекомендуется хранение в секрет-менеджере и запрет на логирование ключей.

**Testability (оценка и приоритеты тестирования)**

- Текущее покрытие: отсутствуют тесты.
- Проблемы для тестирования:
  - Прямой импорт `client` затрудняет unit-тестирование `orders.ts` и `wallet.ts`.
  - `tradeLoop` — бесконечный цикл — нужно выносить логику в чистые функции и тестировать их.
- Приоритетные тесты:
  1. Unit tests для `analyzeMarket` с симулированными наборами свечей (граничные случаи, пустой набор, NaN).
  2. Unit tests для решений `tradeLoop`: `shouldTriggerStopLoss`, `shouldCancelStaleOrder`, `computeEntryAndTpPrices` (вынести эти функции из `tradeLoop`).
  3. Integration tests с мокнутым `exchangeClient` для `orders.ts` и `wallet.ts`.

**Дорожная карта развития (конкретно и по этапам)**

Краткосрочный (Quick Wins, 1–3 дня):

- Внедрить таймаут и retry для `getKlines` (`src/get_clines.ts`).
- Изменить `src/config.ts` — не вызывать `process.exit`; бросать ошибку или возвращать объект ошибки.
- Поддержать graceful shutdown: перехват SIGINT/SIGTERM в `bot.ts` и корректный разрыв циклов `tradeLoop`.
- Минимальный DI: позволить `orders.ts` и `wallet.ts` принимать `client` через аргументы функций или экспорт фабрики — облегчает мокирование.
- Подключить структурированное логирование (`pino`) и базовую метрику (latency/requests).

Среднесрочный (2–6 недель):

- Рефакторинг `tradeLoop`: вынести сбор данных, оценку и исполнение в 3 отдельных сервиса/функции:
  - `collectMarketAndAccountState()`
  - `evaluateStrategy()`
  - `executeActions()`
- Добавить rate-limiter (например, `bottleneck`) вокруг вызовов к бирже (`client`) и централизовать retry/backoff.
- Внедрить схемную валидацию ответов API (`zod`/`io-ts`) для `getKlines` и ответов `mexc-api-sdk`.
- Кэширование/агрегация свечей: общий процесс, который обновляет klines и предоставляет данные всем `tradeLoop`.
- Развернуть unit и integration тесты (CI), покрыть критические модули.

Долгосрочный (3–6 месяцев — Scalability):

- Разделить ответственность: выделить Executor service и Strategy service:
  - Strategy генерирует сигналы (делает расчёты), публикует их в очередь (Rabbit/Kafka).
  - Executor читает сигналы и делает `newOrder/cancelOrder` с управлением retry/compensation.
- Dockerize и k8s-ready deployment, добавить Helm/manifests и readiness/liveness probes.
- Настроить CI/CD pipeline (lint, typecheck, unit, integration, deploy to staging).
- Secrets management: integrate Vault / AWS Secrets Manager.
- HA и sharding: гарантия, что одна пара торгуется только одним инстансом (leader-election), либо назначение пар на конкретные workers.

**Конкретные изменения в коде (patch-подсказки)**

- `src/client.ts`: экспортировать фабрику `createClient(apiKey, secret)` вместо глобального `client`.
- `src/orders.ts` / `src/wallet.ts`: сделать функции принимать `client` как аргумент или получать через DI-фабрику.
- `src/get_clines.ts`: добавить таймаут, retry и валидацию возвращаемого массива.
- `src/strategy.ts`: заменить `while(true)` на цикл с флагом `running` и поставить `await sleep(TRADE_INTERVAL_MS)` в конце; вывести чистые функции для принятия решений.
- `src/config.ts`: вернуть конфиг-объект или бросить исключение вместо `process.exit`.

**Приоритетная последовательность работ (минимальный план действий)**

1. Quick fixes: таймаут/retry, DI для client, graceful shutdown, убрать process.exit.
2. Рефакторинг стратегии: выделить чистые функции, покрыть тестами `analyzeMarket` и логикой принятия решений.
3. Надёжность: rate-limiter, retry/backoff, структурированное логирование, мониторинг.
4. Масштабирование: очереди, выделение executor, CI/CD и контейнеризация.

**Готов предложить PR с Quick Wins**: если подтверждаете, сделаю PR, который:

- добавит таймаут/ретраи в `src/get_clines.ts`,
- заменит `process.exit` в `src/config.ts` на исключение,
- вынес `client` в фабрику и обновит `orders.ts`/`wallet.ts` к DI,
- добавит простую обработку SIGINT/SIGTERM в `bot.ts`.
