import { Spot } from "mexc-api-sdk";
import * as dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.MEXC_API_KEY || "";
const SECRET_KEY = process.env.MEXC_SECRET_KEY || "";

if (!API_KEY || !SECRET_KEY) {
  console.error(
    "❌ Ошибка: Укажите ключи MEXC_API_KEY и MEXC_SECRET_KEY в файле .env",
  );
  process.exit(1);
}

// Инициализируем клиент SDK
const client = new Spot(API_KEY, SECRET_KEY);

// Настройки торговой стратегии
const SYMBOL = "PLBUSDT";
const QUANTITY = 2; // Минимальный объем для тестов
const PRICE_STEP = 0.0001; // Шаг цены для монеты PLBUSDT
const STOP_LOSS_PCT = 0.05; // Защитный стоп-лосс в процентах

interface ChannelData {
  lowerBound: number;
  midPrice: number;
  targetBuyPrice: number;
  targetSellPrice: number;
}

// Расчет параметров канала
async function getChannelBounds(): Promise<ChannelData | null> {
  try {
    const endTime = Date.now();
    const startTime = endTime - 60000; // 15 секунд назад

    // ИСПРАВЛЕНО: client.bookTicker принимает СТРОКУ, а client.trades принимает (строку, объект)
    const [tradesData, tickerData] = await Promise.all([
      client.trades(SYMBOL, { limit: 100 }),
      client.bookTicker(SYMBOL),
    ]);

    if (!tradesData || !Array.isArray(tradesData) || !tradesData.length)
      return null;
    if (!tickerData || !tickerData.bidPrice || !tickerData.askPrice)
      return null;

    const bestBid = parseFloat(tickerData.bidPrice); // Лучший покупатель в стакане
    const bestAsk = parseFloat(tickerData.askPrice); // Лучший продавец в стакане

    // Отбираем трейды за последние 15 секунд
    const recentTrades = tradesData.filter(
      (trade: any) => trade.time >= startTime && trade.time <= endTime,
    );
    const tradesToAnalyze =
      recentTrades.length > 0
        ? recentTrades
        : [tradesData[tradesData.length - 1]];

    // ИСПРАВЛЕНО: Правильный обход массива объектов сделок
    let minPrice = parseFloat(tradesToAnalyze[0].price);
    let maxPrice = parseFloat(tradesToAnalyze[0].price);

    for (const trade of tradesToAnalyze) {
      const price = parseFloat(trade.price);
      if (isNaN(price)) continue;
      if (price < minPrice) minPrice = price;
      if (price > maxPrice) maxPrice = price;
    }

    // Логика: покупка от минимума + 1 шаг, продажа посередине
    let targetBuyPrice = minPrice + PRICE_STEP;
    const midPrice = (minPrice + maxPrice) / 2;
    let targetSellPrice = midPrice + PRICE_STEP; // Тейк-Профит чуть выше середины

    // Защита от Taker-исполнения: лимитка на покупку не должна быть на уровне или выше Ask
    if (targetBuyPrice >= bestAsk) {
      targetBuyPrice = bestBid;
    }

    // Гарантируем, что тейк-профит будет выше покупки хотя бы на 1 шаг цены
    if (targetSellPrice <= targetBuyPrice) {
      targetSellPrice = targetBuyPrice + PRICE_STEP;
    }

    return {
      lowerBound: minPrice,
      midPrice,
      targetBuyPrice,
      targetSellPrice,
    };
  } catch (error: any) {
    console.error(
      "⚠️ Ошибка при получении рыночных данных:",
      error.message || error,
    );
    return null;
  }
}

// Выставление лимитного ордера через SDK
async function placeOrder(
  side: "BUY" | "SELL",
  price: number,
  quantity: number,
) {
  const stepStr = PRICE_STEP.toString();
  const decimals = stepStr.includes(".") ? stepStr.split(".")[1]?.length : 0;
  const formattedPrice = price.toFixed(decimals);

  console.log(
    `[Ордер] Отправка ${side} по цене ${formattedPrice}, объем: ${quantity}`,
  );

  try {
    // Создание ордера через SDK
    const order = await client.newOrder(SYMBOL, side, "LIMIT", {
      quantity: quantity.toString(),
      price: formattedPrice,
      timeInForce: "GTC",
    });
    return order;
  } catch (error: any) {
    console.error(
      `❌ Ошибка при отправке ордера ${side}:`,
      error.message || error,
    );
    return null;
  }
}

// Бесконечный торговый цикл
async function tradeLoop() {
  let inPosition = false;
  let buyOrderId = null;
  let sellOrderId = null; // Добавляем ID ордера на продажу
  let entryPrice = 0;
  let buyOrderTimestamp = 0; // Время выставления ордера на покупку

  console.log("=== Бот на базе MEXC SDK успешно перезапущен ===");

  while (true) {
    const channel = await getChannelBounds();
    if (!channel || isNaN(channel.targetBuyPrice)) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    // 1. Попытка входа в сделку (если мы не в позиции и нет активных ордеров)
    if (!inPosition && !buyOrderId && !sellOrderId) {
      const targetBuyPrice = channel.targetBuyPrice;
      // Расчет ПРЕДПОЛАГАЕМОГО стоп-лосса, если мы зайдем по targetBuyPrice
      const expectedStopPrice = targetBuyPrice * (1 - STOP_LOSS_PCT / 100);

      console.log(
        `[Канал] 15с Мин: ${channel.lowerBound} | План покупки: ${targetBuyPrice} | План продажи: ${channel.targetSellPrice.toFixed(4)} | План Стопа: ${expectedStopPrice.toFixed(4)}`,
      );

      const order = await placeOrder("BUY", targetBuyPrice, QUANTITY);
      if (order && order.orderId) {
        buyOrderId = order.orderId;
        entryPrice = targetBuyPrice;
        buyOrderTimestamp = Date.now(); // Запоминаем точное время (миллисекунды)
        console.log(
          `Лимитный ордер на покупку успешно выставлен. ID: ${buyOrderId}`,
        );
      }
    }
    // БЛОК ЗАЩИТЫ: Проверка зависшего ордера на покупку
    if (buyOrderId && !inPosition) {
      const orderAgeSeconds = (Date.now() - buyOrderTimestamp) / 1000;
      const priceDeviation = channel.targetBuyPrice - entryPrice; // Насколько новая расчетная цена выше нашей лимитки

      // Условия отмены: ордеру больше 60 секунд ИЛИ цена ушла вверх больше чем на 2 шага
      if (orderAgeSeconds >= 60 || priceDeviation > PRICE_STEP * 10) {
        const reason =
          orderAgeSeconds >= 60
            ? `Таймаут 60 сек`
            : `Цена ушла вверх на ${priceDeviation.toFixed(4)}`;
        console.log(
          `⏳ Сброс зависшего ордера на покупку: ${reason}. Отмена ордера ${buyOrderId}...`,
        );

        try {
          await client.cancelOrder(SYMBOL, { orderId: buyOrderId });
          console.log(`Ордер ${buyOrderId} успешно отменен.`);
        } catch (e: any) {
          console.error(
            "Не удалось отменить ордер (возможно, он уже исполнился в этот миг):",
            e.message || e,
          );
        }

        // Сбрасываем ID ордера, чтобы на следующем круге рассчитать новые актуальные цены
        buyOrderId = null;
        continue; // Переходим к следующей итерации цикла
      }
    }
    // 2. Ожидание исполнения ордера на покупку
    if (buyOrderId && !inPosition) {
      try {
        const orderStatus = await client.queryOrder(SYMBOL, {
          orderId: buyOrderId,
        });

        if (orderStatus && orderStatus.status === "FILLED") {
          console.log(
            "🎉 Покупка ИСПОЛНЕНА. Автоматически выставляем Тейк-Профит.",
          );
          inPosition = true;
          buyOrderId = null;

          const takeProfitPrice = channel.targetSellPrice;
          const sellOrder = await placeOrder("SELL", takeProfitPrice, QUANTITY);

          if (sellOrder && sellOrder.orderId) {
            sellOrderId = sellOrder.orderId; // Запоминаем ID Тейк-Профита
            console.log(
              `Лимитный ордер на продажу (TP) выставлен. ID: ${sellOrderId}`,
            );
          }
        } else if (
          orderStatus &&
          (orderStatus.status === "CANCELED" ||
            orderStatus.status === "REJECTED")
        ) {
          console.log("Ордер на покупку был отменен или отклонен биржей.");
          buyOrderId = null;
        }
      } catch (e: any) {
        console.error(
          "Ошибка проверки статуса ордера на покупку:",
          e.message || e,
        );
      }
    }

    // 3. Ожидание исполнения Тейк-Профита
    if (sellOrderId && inPosition) {
      try {
        const orderStatus = await client.queryOrder(SYMBOL, {
          orderId: sellOrderId,
        });

        if (orderStatus && orderStatus.status === "FILLED") {
          console.log(
            "💰 Тейк-Профит ИСПОЛНЕН! Позиция полностью закрыта в плюс. Сбрасываем флаги для нового цикла.",
          );
          // ИСПРАВЛЕНИЕ: Полностью обнуляем состояние для следующего круга
          inPosition = false;
          sellOrderId = null;
          entryPrice = 0;
        } else if (
          orderStatus &&
          (orderStatus.status === "CANCELED" ||
            orderStatus.status === "REJECTED")
        ) {
          console.log(
            "🚨 Ордер Тейк-Профит был отменен вручную или отклонен биржей!",
          );
          inPosition = false;
          sellOrderId = null;
          entryPrice = 0;
        }
      } catch (e: any) {
        console.error(
          "Ошибка проверки статуса ордера на продажу:",
          e.message || e,
        );
      }
    }

    // 4. Контроль локального стоп-лосса (работает параллельно, пока висит Тейк-Профит)
    if (inPosition && sellOrderId) {
      const stopLossPrice = entryPrice * (1 - STOP_LOSS_PCT / 100);
      if (channel.midPrice <= stopLossPrice) {
        console.log(
          `🚨 СТОП-ЛОСС! Цена упала до ${channel.midPrice}. Сброс позиции по рынку.`,
        );

        try {
          // Отменяем активный лимитный Тейк-Профит перед выходом по стопу
          await client.cancelOrder(SYMBOL, { orderId: sellOrderId });
          console.log(`Предыдущий Тейк-Профит ${sellOrderId} успешно отменен.`);
        } catch (e) {
          console.error(
            "Не удалось отменить Тейк-Профит при стопе (возможно уже исполнился):",
            e,
          );
        }

        // Закрываем позицию быстрой лимиткой по цене спроса
        await placeOrder("SELL", channel.lowerBound, QUANTITY);

        // Сбрасываем флаги
        inPosition = false;
        sellOrderId = null;
        entryPrice = 0;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

tradeLoop();
