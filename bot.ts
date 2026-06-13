import { getChannelBounds } from "./src/strategy";
import { getAssetBalance } from "./src/wallet";
import {
  placeLimitOrder,
  placeMarketSell,
  cancelOrder,
  getOpenOrders,
} from "./src/orders";
import { COINS_CONFIG, type CoinConfig } from "./src/config";
import { sleep } from "./src/utils";

// Функция теперь принимает настройки конкретной монеты
export async function tradeLoop(config: CoinConfig) {
  const {
    SYMBOL,
    QUANTITY,
    PRICE_STEP,
    STOP_LOSS_PCT,
    MIN_NOTIONAL,
    ASSET_NAME,
    CHANNEL_TIME,
    INTERVAL_AFTER_STOPLOSS_MS,
    ORDER_TIMEOUT_MS,
    TRADE_INTERVAL_MS,
  } = config;

  console.log(`🚀 Робот запущен для пары ${SYMBOL} в Stateless-режиме.`);

  while (true) {
    try {
      // ==========================================
      // 1. СБОР СВЕЖИХ ДАННЫХ С СЕРВЕРА
      // ==========================================
      const channel = await getChannelBounds(SYMBOL, PRICE_STEP, CHANNEL_TIME);
      const { currentBuyOrder, currentSellOrder } = await getOpenOrders(SYMBOL);
      const { coinBalance, usdtBalance } = await getAssetBalance(ASSET_NAME);

      if (!channel || coinBalance === null || usdtBalance === null) {
        console.log(
          `⚠️ [${SYMBOL}] Не удалось собрать все данные с биржи. Пропускаем тик...`,
        );
        await sleep(TRADE_INTERVAL_MS);
        continue;
      }
      const currentPrice = channel.bestBid;
      const coinValueInUsdt = coinBalance * currentPrice;

      // ==========================================
      // 2. АНАЛИЗ СОСТОЯНИЯ И ПРИНЯТИЕ РЕШЕНИЙ
      // ==========================================
      if (currentBuyOrder) {
        const buyAgeMinutes = Date.now() - currentBuyOrder.time;
        if (buyAgeMinutes >= ORDER_TIMEOUT_MS) {
          console.log(
            `⏰ [${SYMBOL}] Ордер BUY висит больше 3 минут без полного налива. Отменяем.`,
          );
          await cancelOrder(currentBuyOrder.orderId, SYMBOL);
          continue;
        }
      }
      if (currentSellOrder) {
        const tpAgeMinutes = Date.now() - currentSellOrder.time;
        if (tpAgeMinutes >= ORDER_TIMEOUT_MS) {
          console.log(
            `⏰ [${SYMBOL}] ТР висит больше 3 минут. Отменяем для перестановки по новому каналу.`,
          );
          await cancelOrder(currentSellOrder.orderId, SYMBOL);
          continue;
        }
      }
      if (currentSellOrder) {
        const stopPrice = currentSellOrder.price * (1 - STOP_LOSS_PCT / 100);
        if (currentPrice <= stopPrice) {
          console.log(
            `🚨 [${SYMBOL}] СТОП-ЛОСС! Цена ${currentPrice} <= ${stopPrice}. Экстренно выходим по рынку.`,
          );
          if (currentSellOrder)
            await cancelOrder(currentSellOrder.orderId, SYMBOL);
          await placeMarketSell(coinBalance, SYMBOL);
          console.log(`😴 [${SYMBOL}] Пауза после стоп-лосса.`);
          await sleep(INTERVAL_AFTER_STOPLOSS_MS);
          continue;
        }
      }
      if (
        coinValueInUsdt >= MIN_NOTIONAL &&
        !currentBuyOrder &&
        !currentSellOrder
      ) {
        const sellOrder = await placeLimitOrder(
          "SELL",
          channel.targetSellPrice,
          coinBalance,
          SYMBOL,
          PRICE_STEP,
        );
        if (sellOrder?.orderId) {
          console.log(
            `💰 [${SYMBOL}] Выставлен Тейк-Профит на ${coinBalance} ${ASSET_NAME} по цене ${channel.targetSellPrice}`,
          );
        }
      }

      if (
        coinValueInUsdt < MIN_NOTIONAL &&
        !currentBuyOrder &&
        !currentSellOrder
      ) {
        if (
          usdtBalance >= QUANTITY * channel.targetBuyPrice &&
          QUANTITY * channel.targetBuyPrice >= MIN_NOTIONAL
        ) {
          const order = await placeLimitOrder(
            "BUY",
            channel.targetBuyPrice,
            QUANTITY,
            SYMBOL,
            PRICE_STEP,
          );
          if (order?.orderId) {
            console.log(
              `🛒 [${SYMBOL}] Выставили новый ордер BUY по цене ${channel.targetBuyPrice}`,
            );
          }
        } else {
          console.log(
            `❌ [${SYMBOL}] Недостаточно USDT для выставления ордера на покупку.`,
          );
        }
      }
    } catch (error) {
      console.error(`💥 Критическая ошибка в цикле тика для ${SYMBOL}:`, error);
    }

    await sleep(TRADE_INTERVAL_MS);
  }
}

// Главная функция для одновременного запуска всех монет
async function startMultiBot() {
  console.log(`Бот инициализирует торговлю для ${COINS_CONFIG.length} пар...`);

  // Запуск независимого цикла для каждой монеты параллельно
  const tradingPromises = COINS_CONFIG.map((coinConfig) =>
    tradeLoop(coinConfig),
  );

  await Promise.all(tradingPromises);
}

startMultiBot();
