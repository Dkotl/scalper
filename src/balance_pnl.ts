import dayjs from "dayjs";
import fs from "fs";
import { client } from "./client";
import { COINS_CONFIG } from "./config";

type SymbolStats = {
  symbol: string;
  buyVolume: number;
  sellVolume: number;
  buyQty: number;
  sellQty: number;
  tradesCount: number;
  currentPrice: number;
  simulatedVolume: number;
  actualSells: number;
  winTrades: number;
  pnl: number;
};

export function getActiveSymbols(): string[] {
  return COINS_CONFIG.map((c) => c.SYMBOL);
}

async function getBalancesMap() {
  const acc = await client.accountInfo();
  const map: Record<string, number> = {};
  for (const b of acc.balances) {
    const total = Number(b.free) + Number(b.locked);
    if (total > 0) {
      map[b.asset] = total;
    }
  }
  return map;
}

async function getPriceMap(symbols: string[]) {
  const tickers = await client.ticker24hr();
  const map: Record<string, number> = {};
  for (const t of tickers) {
    if (symbols.includes(t.symbol)) {
      map[t.symbol] = Number(t.lastPrice);
    }
  }
  return map;
}

async function getTradesLast12Hours(symbol: string): Promise<any[]> {
  let allTrades: any[] = [];
  let startTime = Date.now() - 12 * 60 * 60 * 1000;

  while (true) {
    try {
      const options: any = { limit: 1000, startTime: startTime };
      const trades = await client.accountTradeList(symbol, options);

      if (!Array.isArray(trades) || trades.length === 0) {
        break;
      }

      if (
        allTrades.length > 0 &&
        trades[0].id === allTrades[allTrades.length - 1].id
      ) {
        trades.shift();
      }

      if (trades.length === 0) break;

      allTrades.push(...trades);

      const lastTradeTime = Number(trades[trades.length - 1].time);
      if (isNaN(lastTradeTime) || lastTradeTime === startTime) {
        break;
      }

      startTime = lastTradeTime;

      if (trades.length < 1000) {
        break;
      }
    } catch (error) {
      console.error(`Ошибка загрузки сделок для ${symbol}:`, error);
      break;
    }
  }

  return allTrades;
}

async function calculateDailyPnl() {
  const symbols = getActiveSymbols();
  const prices = await getPriceMap(symbols);
  const balances = await getBalancesMap(); // Получаем реальные остатки на кошельке
  const result: Record<string, SymbolStats> = {};

  for (const symbol of symbols) {
    const trades = await getTradesLast12Hours(symbol);
    if (trades.length === 0) continue;

    const currentPrice = prices[symbol] || 0;
    const baseAsset = symbol.replace(/(USDT|USD|BUSD)$/, "");
    const realWalletBalance = balances[baseAsset] || 0; // Наш физический баланс монеты

    result[symbol] = {
      symbol,
      buyVolume: 0,
      sellVolume: 0,
      buyQty: 0,
      sellQty: 0,
      tradesCount: trades.length,
      currentPrice,
      simulatedVolume: 0,
      actualSells: 0,
      winTrades: 0,
      pnl: 0,
    };

    const earliestPrice =
      trades.length > 0 ? Number(trades[0].price) : currentPrice;

    let rollingBuyQty = 0;
    let rollingBuyVol = 0;

    // 1. СНАЧАЛА ВСЕ СУММИРУЕТСЯ (Сбор базовых исторических объемов за 12 часов)
    for (const t of trades) {
      const p = Number(t.price);
      const q = Number(t.qty);
      const value = p * q;

      if (t.isBuyer) {
        result[symbol].buyVolume += value;
        result[symbol].buyQty += q;
        rollingBuyQty += q;
        rollingBuyVol += value;
      } else {
        result[symbol].sellVolume += value;
        result[symbol].sellQty += q;
        result[symbol].actualSells += 1;

        const currentAvgBuyPrice = rollingBuyVol / (rollingBuyQty || 1);
        if (p > currentAvgBuyPrice) {
          result[symbol].winTrades += 1;
        }
      }
    }

    // 2. ПРИБАВЛЯЮТСЯ ОБЪЕМЫ ЗА ПРОДАЖУ ТЕКУЩИХ МОНЕТ
    // Имитируем продажу реального баланса кошелька по текущей рыночной цене
    const walletValue = realWalletBalance * currentPrice;
    
    let totalSellVolumeWithWallet = result[symbol].sellVolume + walletValue;
    let totalSellQtyWithWallet = result[symbol].sellQty + realWalletBalance;

    // 3. ПОСЛЕ ЭТОГО СЧИТАЕТСЯ ДЕЛЬТА (С учетом виртуально проданных монет)
    const qtyDelta = result[symbol].buyQty - totalSellQtyWithWallet;
    let historyAdjustment = 0;

    if (qtyDelta > 0) {
      // КУПИЛИ БОЛЬШЕ, ЧЕМ ПРОДАЛИ (с учетом кошелька)
      // Оставшийся бумажный избыток из-за пропущенной истории закрываем по самой ранней цене окна
      historyAdjustment = qtyDelta * earliestPrice;
    } else if (qtyDelta < 0) {
      // ПРОДАЛИ БОЛЬШЕ, ЧЕМ КУПИЛИ (с учетом кошелька)
      // Бумажный дефицит из-за пропущенной истории компенсируем (вычитаем затраты) по самой ранней цене окна
      const missingQty = Math.abs(qtyDelta);
      historyAdjustment = -(missingQty * earliestPrice);
    }

    // Итоговый PnL: Общие продажи (с кошельком) - Общие покупки + Историческая корректировка дисбаланса
    result[symbol].pnl = totalSellVolumeWithWallet - result[symbol].buyVolume + historyAdjustment;
    result[symbol].simulatedVolume = walletValue + historyAdjustment;
  }

  let totalSessionPnl = 0;

  const rows = Object.values(result).map((s) => {
    totalSessionPnl += s.pnl;
    return {
      symbol: s.symbol,
      pnl: s.pnl.toFixed(2),
      trades: s.tradesCount,
    };
  });

  console.clear();
  console.table(rows);
  console.log(`----------------------------------------`);
  console.log(`ОБЩИЙ PNL СЕССИИ (12ч): ${totalSessionPnl >= 0 ? "+" : ""}${totalSessionPnl.toFixed(2)} USDT`);
  console.log(`----------------------------------------`);
}

calculateDailyPnl();
