import { getKlines } from "./get_clines";

export interface MarketRegime {
  anchor: number;
  range: number;
  minPrice: number;
  maxPrice: number;
  currentPrice: number;
  rangePct: number;
  driftPct: number;
  trendFactor: number;
  isSideways: boolean;

  // НОВЫЕ ПОЛЯ ДЛЯ КРАТКОСРОЧНОГО СГЛАЖИВАНИЯ ЦЕН (1 МИНУТА)
  localMinPrice: number;
  localMaxPrice: number;
  localRange: number;
}

export async function analyzeMarket(
  symbol: string,
  lookbackMinutes: number = 5,
): Promise<MarketRegime | null> {
  try {
    // 1. Берём свечи 1m за последние 15 минут
    const klines = await getKlines(symbol, "1m", lookbackMinutes);
    if (!klines || klines.length === 0) return null;

    let minPrice = Infinity;
    let maxPrice = 0;

    // 2. Находим глобальный диапазон за 15 минут для определения режима рынка
    for (const k of klines) {
      const high = Number(k[2]);
      const low = Number(k[3]);

      if (isNaN(low) || isNaN(high)) continue;

      if (low < minPrice) minPrice = low;
      if (high > maxPrice) maxPrice = high;
    }

    if (minPrice === Infinity || maxPrice === 0) return null;

    const anchor = (minPrice + maxPrice) / 2;
    const range = maxPrice - minPrice;

    // 3. Текущая цена (последняя свеча close)
    const lastCandle = klines[klines.length - 1];
    const currentPrice = Number(lastCandle[4]);
    if (isNaN(currentPrice)) return null;

    // 4. Логика цен входа/выхода на основе ПОСЛЕДНЕЙ минуты
    const localHigh = Number(lastCandle[2]); // High последней минуты
    const localLow = Number(lastCandle[3]);  // Low последней минуты
    
    // Защита на случай, если минутный диапазон равен нулю
    const localMinPrice = !isNaN(localLow) ? localLow : currentPrice;
    const localMaxPrice = !isNaN(localHigh) ? localHigh : currentPrice;
    const localRange = localMaxPrice - localMinPrice;

    // 5. Расчет метрик для определения флета (по 15-минутным данным)
    const rangePct = ((maxPrice - minPrice) / anchor) * 100;
    const driftPct = (Math.abs(currentPrice - anchor) / anchor) * 100;
    const trendFactor = rangePct > 0 ? driftPct / rangePct : 0;

    // Режим рынка (сигнал) по-прежнему зависит от 15-минутной истории
    const isSideways = rangePct > 0.05 && rangePct < 1 && trendFactor < 0.4;

    return {
      anchor,
      range,
      minPrice,
      maxPrice,
      currentPrice,
      rangePct,
      driftPct,
      trendFactor,
      isSideways,
      
      // Возвращаем локальные уровни
      localMinPrice,
      localMaxPrice,
      localRange,
    };
  } catch (e: any) {
    console.error("analyzeMarket error:", e.message || e);
    return null;
  }
}
