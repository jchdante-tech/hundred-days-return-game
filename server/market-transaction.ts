import type { Market } from './engine.js';

function immutableRecord<T extends object>(record: T): T {
  // Historical records contain only scalar values. Freeze once so a future
  // engine change cannot accidentally mutate a previously committed market.
  return Object.isFrozen(record) ? record : Object.freeze(record);
}

/**
 * Copy a market for an engine transaction. Executed trades and completed daily
 * bars are append-only records; intraday history only edits its newest point.
 * Keep their arrays independent while reusing those immutable historical rows.
 * Orders, portfolios, active simulations, and the newest point stay private to
 * the candidate, which can still be discarded after any engine/storage failure.
 */
export function cloneForTransaction(market: Market): Market {
  const candidate: Market = structuredClone({
    ...market,
    trades: [],
    stocks: market.stocks.map(({ history: _history, dailyBars: _dailyBars, ...stock }) => ({ ...stock, history: [] })),
  });

  candidate.trades = market.trades.map(immutableRecord);
  for (let index = 0; index < market.stocks.length; index += 1) {
    const source = market.stocks[index];
    const stock = candidate.stocks[index];
    stock.history = source.history.map((point, pointIndex) => pointIndex === source.history.length - 1
      ? { ...point }
      : immutableRecord(point));
    if (source.dailyBars !== undefined) stock.dailyBars = source.dailyBars.map(immutableRecord);
  }
  return candidate;
}
