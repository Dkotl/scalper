import { getChannelBounds } from "./src/strategy";
import { getAssetBalance } from "./src/wallet";
import { placeLimitOrder, placeMarketSell, cancelOrder } from "./src/orders";
import { SYMBOL, STOP_LOSS_PCT } from "./src/config";
import { client } from "./src/client";

// Хранилище метаданных ордеров (Ключ: orderId)
// Позволяет боту помнить время создания ордера и цену, по которой он был выставлен
interface OrderMeta {
  price: number;
  timestamp: number;
}
const trackedOrders = new Map<number, OrderMeta>();

// Хранилище цен входа для активных позиций, чтобы правильно считать Стоп-Лосс
// Массив цен (например: [10.2, 10.2, 10.15]) — по одной цене на каждую пачку в $2
let activeEntryPrices: number[] = [];

// Таймер блокировки торговли после срабатывания стопа
let tradeBlockUntil = 0;

export async function tradeLoop() {
  const ASSET_NAME = SYMBOL.replace("USDT", "");
  const PART_USDT_SIZE = 2.0; // Размер одной части в USDT

  console.log(`🚀 Бот запущен. Режим: Каскадный закуп по $${PART_USDT_SIZE} с глобальным стопом.`);

  while (true) {
    // Проверяем, не находится ли бот на 10-минутной паузе после стоп-лосса
    if (Date.now() < tradeBlockUntil) {
      const timeLeftSeconds = Math.ceil((tradeBlockUntil - Date.now()) / 1000);
      console.log(`😴 Пауза после стопа. До возобновления торгов: ${timeLeftSeconds} сек.`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    try {
      // ==========================================
      // 1. СБОР СВЕЖИХ ДАННЫХ С СЕРВЕРА
      // ==========================================
      const channel = await getChannelBounds();
      const ticker = await client.bookTicker(SYMBOL);
      const openOrders = await client.openOrders({ symbol: SYMBOL });
      const coinBalance = await getAssetBalance(ASSET_NAME); // Должен возвращать общий баланс (Free + Locked)
      const usdtBalance = await getAssetBalance("USDT");

      if (!channel || !ticker || !openOrders) {
        console.log("⚠️ Не удалось собрать данные с биржи. Пропускаем тик...");
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      const currentPrice = parseFloat(ticker.bidPrice);
      const activeBuyOrders = openOrders.filter(o => o.side === "BUY");
      const activeSellOrders = openOrders.filter(o => o.side === "SELL");

      // ==========================================
// 2. СИНХРОНИЗАЦИЯ И ФИКСАЦИЯ ИСПОЛНЕНИЯ
// ==========================================
const currentOpenOrderIds = new Set(openOrders.map(o => o.orderId));

for (const [orderId, meta] of trackedOrders.entries()) {
  if (!currentOpenOrderIds.has(orderId)) {
    const isBuyOrder = activeBuyOrders.some(o => o.orderId === orderId) === false && 
                       activeSellOrders.some(o => o.orderId === orderId) === false;
    
    if (isBuyOrder) {
      activeEntryPrices.push(meta.price); // Добавляем цену новой купленной пачки
      console.log(`📥 BUY ордер #${orderId} исполнился. Записали цену входа: ${meta.price}`);
    }
    trackedOrders.delete(orderId);
  }
}

// ПРАВИЛЬНАЯ СИНХРОНИЗАЦИЯ МАССИВА ЦЕН:
// Считаем, сколько ПРИБЛИЗИТЕЛЬНО пачек сейчас реально находится в рынке
const currentPartCount = Math.round((coinBalance * currentPrice) / PART_USDT_SIZE);

// Если реальных пачек на балансе меньше, чем цен в массиве (значит, ТР исполнился)
while (activeEntryPrices.length > currentPartCount) {
  // Удаляем самую старую цену входа (или первую из массива), так как она продалась
  const removedPrice = activeEntryPrices.shift(); 
  console.log(`🧹 Тейк-профит исполнился. Удаляем цену входа ${removedPrice} из отслеживания стопов.`);
}

// Предохранитель на случай полной распродажи
if (coinBalance <= 0 || currentPartCount === 0) {
  activeEntryPrices = [];
}


      // ==========================================
      // 3. ПРОВЕРКА ГЛОБАЛЬНОГО СТОП-ЛОССА (Для любой из позиций)
      // ==========================================
      let triggerGlobalStop = false;
      for (const entryPrice of activeEntryPrices) {
        const stopPrice = entryPrice * (1 - STOP_LOSS_PCT / 100);
        if (currentPrice <= stopPrice) {
          console.log(`🚨 КРИТИЧЕСКИЙ СТОП! Текущая цена ${currentPrice} упала ниже стопа ${stopPrice} (вход: ${entryPrice})`);
          triggerGlobalStop = true;
          break; // Выходим из цикла проверки, достаточно одного триггера
        }
      }

      // Если сработал стоп — экстренно очищаем всё
      if (triggerGlobalStop) {
        console.log("💥 Активирована глобальная очистка: отменяем ВСЕ ордера и продаем ВСЕ монеты.");
        
        // Отменяем абсолютно все лимитки в стакане
        for (const order of openOrders) {
          try { await cancelOrder(order.orderId); } catch {}
        }
        
        // Запрашиваем финальный баланс монет для продажи по рынку
        const finalCoinBalance = await getAssetBalance(ASSET_NAME);
        if (finalCoinBalance > 0) {
          await placeMarketSell(finalCoinBalance);
          console.log(`🔴 Распродали весь баланс по рынку: ${finalCoinBalance} ${ASSET_NAME}`);
        }

        // Сбрасываем внутреннее состояние бота
        activeEntryPrices = [];
        trackedOrders.clear();
        
        // Включаем блокировку торговли на 10 минут
        tradeBlockUntil = Date.now() + 10 * 60 * 1000; 
        continue;
      }

      // ==========================================
      // 4. ЛОГИКА ПРОДАЖИ (Выставление Тейк-Профитов)
      // ==========================================
      // Считаем, сколько монет уже заблокировано в SELL-лимитках
      const coinsLockedInSell = activeSellOrders.reduce((sum, o) => sum + parseFloat(o.origQty), 0);
      const freeCoinsToSell = coinBalance - coinsLockedInSell;

      // Если появились свободные монеты (от исполнившихся BUY или частичных наливов)
      if (freeCoinsToSell * currentPrice >= 1.0) { 
        console.log(`🌓 Найдено свободного баланса на продажу: ${freeCoinsToSell} ${ASSET_NAME}`);
        
        const sellOrder = await placeLimitOrder("SELL", channel.targetSellPrice, freeCoinsToSell);
        if (sellOrder?.orderId) {
          trackedOrders.set(sellOrder.orderId, {
            price: channel.targetSellPrice,
            timestamp: Date.now()
          });
          console.log(`✈️ Выставили ТР ордер #${sellOrder.orderId} по цене ${channel.targetSellPrice}`);
        }
      }

      // Проверка 3-минутного тайм-аута для SELL ордеров (перестановка)
      for (const sellOrder of activeSellOrders) {
        const orderId = sellOrder.orderId;
        if (!trackedOrders.has(orderId)) {
          trackedOrders.set(orderId, { price: parseFloat(sellOrder.price), timestamp: Date.now() });
        }

        const sellAgeMinutes = (Date.now() - (trackedOrders.get(orderId)?.timestamp || Date.now())) / 1000 / 60;
        if (sellAgeMinutes >= 3) {
          console.log(`⏰ ТР ордер #${orderId} висит больше 3 минут. Снимаем для обновления цены.`);
          try { await cancelOrder(orderId); } catch {}
        }
      }

      // ==========================================
      // 5. ЛОГИКА ПОКУПКИ (Каскадный закуп без ограничения цены)
      // ==========================================
      // Если свободного USDT хватает на покупку еще одной части — покупаем (даже если цена совпадает со старой)
      if (usdtBalance >= PART_USDT_SIZE) {
        const targetBuyPrice = channel.targetBuyPrice;
        const calcQuantity = PART_USDT_SIZE / targetBuyPrice;

        const buyOrder = await placeLimitOrder("BUY", targetBuyPrice, calcQuantity);
        if (buyOrder?.orderId) {
          trackedOrders.set(buyOrder.orderId, {
            price: targetBuyPrice,
            timestamp: Date.now()
          });
          console.log(`🛒 Каскад: Выставили новый BUY ордер #${buyOrder.orderId} по цене ${targetBuyPrice}`);
        }
      }

      // Проверка 1-минутного тайм-аута для BUY ордеров
      for (const buyOrder of activeBuyOrders) {
        const orderId = buyOrder.orderId;
        if (!trackedOrders.has(orderId)) {
          trackedOrders.set(orderId, { price: parseFloat(buyOrder.price), timestamp: Date.now() });
        }

        const buyAgeMinutes = (Date.now() - (trackedOrders.get(orderId)?.timestamp || Date.now())) / 1000 / 60;
        if (buyAgeMinutes >= 1) {
          console.log(`⏰ BUY ордер #${orderId} устарел (1 мин). Отменяем.`);
          try { await cancelOrder(orderId); } catch {}
        }
      }

    } catch (error) {
      console.error("💥 Ошибка в основном цикле:", error);
    }

    await new Promise((r) => setTimeout(r, 1500));
  }
}

tradeLoop();

