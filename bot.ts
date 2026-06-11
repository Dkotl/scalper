import { getChannelBounds } from "./src/strategy";
import { getAssetBalance } from "./src/wallet";
import { placeLimitOrder, placeMarketSell, cancelOrder } from "./src/orders";
import { SYMBOL, QUANTITY, STOP_LOSS_PCT } from "./src/config";
import { client } from "./src/client";

export async function tradeLoop() {
  const ASSET_NAME = SYMBOL.replace("USDT", "");
  const MIN_NOTIONAL = 1.1; // Минимальная стоимость ордера в USDT для торговли (с запасом)

  // В памяти оставляем ТОЛЬКО таймстампы для отслеживания времени жизни ордеров
  let activeBuyTimestamp = 0;
  let activeSellTimestamp = 0;

  console.log("🚀 Робот запущен в Stateless-режиме.");

  while (true) {
    try {
      // ==========================================
      // 1. СБОР СВЕЖИХ ДАННЫХ С СЕРВЕРА (Каждый тик заново)
      // ==========================================
      const channel = await getChannelBounds();
      const ticker = await client.bookTicker(SYMBOL);
      const openOrders = await client.openOrders({ symbol: SYMBOL }); // Получаем все активные ордера по паре
      const coinBalance = await getAssetBalance(ASSET_NAME);
      const usdtBalance = await getAssetBalance("USDT");

      if (!channel || !ticker || !openOrders) {
        console.log("⚠️ Не удалось собрать все данные с биржи. Пропускаем тик...");
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      const currentPrice = parseFloat(ticker.bidPrice);
      const coinValueInUsdt = coinBalance * currentPrice;

      // Ищем ордера на бирже по факту их наличия
      const currentBuyOrder = openOrders.find(o => o.side === "BUY");
      const currentSellOrder = openOrders.find(o => o.side === "SELL");

      // ==========================================
      // 2. АНАЛИЗ СОСТОЯНИЯ И ПРИНЯТИЕ РЕШЕНИЙ
      // ==========================================

      // СЦЕНАРИЙ А: НА БАЛАНСЕ ЕСТЬ МОНЕТЫ (Мы в позиции, нужно продавать)
      if (coinValueInUsdt >= MIN_NOTIONAL) {
        
        // Предохранитель: Если мы в позиции, но на бирже почему-то висит BUY ордер — отменяем его
        if (currentBuyOrder) {
          console.log("🧹 Найдена позиция, но висит лишний ордер BUY. Отменяем.");
          await cancelOrder(currentBuyOrder.orderId);
          activeBuyTimestamp = 0;
        }

        // 1. Проверяем Стоп-Лосс по рынку (Берем цену из исполненного BUY или текущую как точку отсчета)
        // Примечание: Для идеального стопа цену входа можно брать из истории сделок (myTrades), 
        // но для простоты здесь используем базовый расчет.
        const stopPrice = channel.targetBuyPrice * (1 - STOP_LOSS_PCT / 100); 
        if (currentPrice <= stopPrice) {
          console.log(`🚨 СТОП-ЛОСС! Цена ${currentPrice} <= ${stopPrice}. Экстренно выходим по рынку.`);
          if (currentSellOrder) await cancelOrder(currentSellOrder.orderId);
          await placeMarketSell(coinBalance);
          activeSellTimestamp = 0;
          console.log("😴 Пауза 10 минут после стоп-лосса.");
          await new Promise((r) => setTimeout(r, 10 * 60 * 1000));
          continue;
        }

        // 2. Если Тейк-Профит еще не выставлен на бирже — выставляем
        if (!currentSellOrder) {
          const sellOrder = await placeLimitOrder("SELL", channel.targetSellPrice, coinBalance);
          if (sellOrder?.orderId) {
            activeSellTimestamp = Date.now();
            console.log(`💰 Выставлен Тейк-Профит на ${coinBalance} ${ASSET_NAME} по цене ${channel.targetSellPrice}`);
          }
        } 
        // 3. Если Тейк-Профит УЖЕ стоит — проверяем его тайм-аут (3 минуты)
        else {
          if (activeSellTimestamp === 0) activeSellTimestamp = Date.now(); // Защита при перезапуске бота
          
          const tpAgeMinutes = (Date.now() - activeSellTimestamp) / 1000 / 60;
          if (tpAgeMinutes >= 3) {
            console.log("⏰ ТР висит больше 3 минут. Отменяем для перестановки по новому каналу.");
            await cancelOrder(currentSellOrder.orderId);
            activeSellTimestamp = 0; // На следующем тике создастся новый ордер
          }
        }
      }

      // СЦЕНАРИЙ Б: МОНЕТ НА БАЛАНСЕ НЕТ (Мы без позиции, ищем точку входа)
      else {
        // Предохранитель: Если монет нет, но на бирже почему-то завис SELL ордер — отменяем
        if (currentSellOrder) {
          console.log("🧹 Монет нет, но висит лишний ордер SELL. Отменяем.");
          await cancelOrder(currentSellOrder.orderId);
          activeSellTimestamp = 0;
        }

        // 1. Если ордера BUY еще нет на бирже — проверяем баланс USDT и выставляем
        if (!currentBuyOrder) {
          if (usdtBalance >= (QUANTITY * channel.targetBuyPrice)) {
            const order = await placeLimitOrder("BUY", channel.targetBuyPrice, QUANTITY);
            if (order?.orderId) {
              activeBuyTimestamp = Date.now();
              console.log(`🛒 Выставили новый ордер BUY по цене ${channel.targetBuyPrice}`);
            }
          } else {
            console.log("❌ Недостаточно USDT для выставления ордера на покупку.");
          }
        } 
        // 2. Если ордер BUY УЖЕ стоит — проверяем его тайм-аут (1 минута)
        else {
          if (activeBuyTimestamp === 0) activeBuyTimestamp = Date.now(); // Защита при перезапуске
          
          // Дополнительно проверяем частичное исполнение, чтобы обновить таймер
          const currentExecutedQty = parseFloat(currentBuyOrder.executedQty || "0");
          
          // Проверяем возраст ордера
          const buyAgeMinutes = (Date.now() - activeBuyTimestamp) / 1000 / 60;
          if (buyAgeMinutes >= 1) {
            console.log("⏰ Ордер BUY висит больше минуты без полного налива. Отменяем.");
            await cancelOrder(currentBuyOrder.buyOrderId);
            activeBuyTimestamp = 0; // На следующем тике перевыставится по новому каналу
          }
        }
      }

    } catch (error) {
      console.error("💥 Критическая ошибка в цикле тика:", error);
    }

    // Интервал между тиками
    await new Promise((r) => setTimeout(r, 1500));
  }
}

tradeLoop();

