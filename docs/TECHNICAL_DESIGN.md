TECHNICAL DESIGN DOCUMENT

**Общая классификация архитектуры**

Проект представляет собой монолитное приложение со слоистой (Layered) архитектурой и процедурным стартом:

- Точка входа: [bot.ts](bot.ts) — запускает параллельные торговые циклы `tradeLoop` из `src/strategy.ts`.
- Система не разделена на отдельные микросервисы; компоненты напрямую импортируют и используют глобальный `client`.

**Как слои взаимодействуют**

- Orchestration: `bot.ts` вызывает `tradeLoop` для каждой пары из `COINS_CONFIG`.
- Бизнес-логика: `tradeLoop` в `src/strategy.ts` собирает данные (через `analyzeMarket`, `getOpenOrders`, `getAssetBalance`), принимает торговые решения и вызывает ордерные операции.
- Интеграции: `client` (обёртка `mexc-api-sdk`) в `src/client.ts` используется напрямую в `src/orders.ts` и `src/wallet.ts`.
- Утилиты: `src/get_clines.ts` (HTTP fetch), `src/analize_market.ts` (анализ свечей), `src/utils.ts` (sleep).

**Карта пакетов и модулей (файлы и зоны ответственности)**

- `bot.ts` — orchestrator: запускает параллельные экземпляры `tradeLoop`.
- `src/config.ts` — конфигурация: экспорт `COINS_CONFIG`, `CoinConfig`, валидация env (выполняет `process.exit(1)` при отсутствии ключей).
- `src/client.ts` — инициализация `Spot` клиента (`mexc-api-sdk`).
- `src/get_clines.ts` — публичный HTTP-запрос к MEXC `klines`.
- `src/analize_market.ts` — расчёт рыночного режима: anchor, range, rangePct, driftPct, trendFactor, isSideways.
- `src/strategy.ts` — `tradeLoop(config: CoinConfig)`: core logic (сбор данных, принятие решений, выставление/отмена ордеров).
- `src/orders.ts` — обёртки ордерных операций (`placeLimitOrder`, `placeMarketSell`, `cancelOrder`, `getOpenOrders`).
- `src/wallet.ts` — получение балансов (`getAssetBalance`).
- `src/utils.ts` — вспомогательные функции (`sleep`).

**Data Flow & Request Lifecycle (пошагово)**

1. `bot.ts` читает `COINS_CONFIG` и запускает `tradeLoop` для каждой пары.
2. В итерации `tradeLoop`:
   - `analyzeMarket(SYMBOL, lookback)` → `getKlines` (HTTP GET к `https://api.mexc.com/api/v3/klines`) → получает свечи.
   - `getOpenOrders(SYMBOL)` → `client.openOrders(symbol)` (через `src/orders.ts`).
   - `getAssetBalance(ASSET_NAME)` → `client.accountInfo()` (через `src/wallet.ts`).
   - Логика: стоп-лосс, таймауты ордеров, выставление TP (sell) и входа (buy) согласно метрикам `market`.
   - Отправка ордеров: `placeLimitOrder` / `placeMarketSell` → `client.newOrder(...)`.
3. Результаты ордеров возвращаются в `tradeLoop`, логируются и влияют на последующие итерации.

**Ключевые механизмы и логика**

- Market Regime Detection (`src/analize_market.ts`):
  - Собирает N последних 1m свечей, вычисляет `minPrice`, `maxPrice`, `anchor`, `range`.
  - Вычисляет `rangePct`, `driftPct`, `trendFactor` и флаг `isSideways = rangePct > 0.05 && rangePct < 2 && trendFactor < 0.4`.
- Торговая логика (`src/strategy.ts`):
  - Stop-loss: если существует sell-order и `currentPrice <= sellOrder.price * (1 - STOP_LOSS_PCT/100)` — отмена buy-ордеров и market sell.
  - Timeout: ордера, висящие дольше `ORDER_TIMEOUT_MS`, отменяются.
  - Take-Profit: если `coinValueInUsdt >= MIN_NOTIONAL` — выставляется limit SELL по `market.minPrice + market.range * 0.7`.
  - Entry: если `usdtBalance >= MIN_NOTIONAL && market.isSideways` — выставляется limit BUY по `market.minPrice + market.range * 0.2`.
- Интеграции: прямые вызовы `mexc-api-sdk` через `client` в `src/client.ts`.

**Выводы по дизайну**

- Архитектура минимально достаточна для прототипа: простая, понятная и аккуратно разделена на модули по функциям.
- Отсутствие абстракций (DI, интерфейсы), твёрдый хардкод порогов и бесконечные циклы мешают тестированию, масштабированию и устойчивости в продакшене.
