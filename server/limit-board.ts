import type { DailyBar, LimitBoardView } from '../shared/types.js';
import type { Market } from './engine.js';
import { limitPrices } from '../shared/market-rules.js';

type Stock = Market['stocks'][number];
type Order = Market['orders'][number];

const isSession = (bar: DailyBar) => bar.origin !== 'background' && bar.day > 0
  && bar.complete && bar.volume > 0;
const isActive = (order: Order) => (order.status === 'open' || order.status === 'partial')
  && Number.isSafeInteger(order.remaining) && order.remaining > 0 && order.remaining <= order.quantity;
const isBuy = (order: Order) => order.side === 'buy' || order.side === 'finance' || order.side === 'cover';

// Every price here is an integer number of cents. Background candles can supply
// day 1's prior close, but never count toward a run of player-session limit days.
function completedStreak(m: Market, stock: Stock, lastDay: number): number {
  const bars = stock.dailyBars ?? [];
  let streak = 0;
  for (let day = lastDay; day > 0; day--) {
    const bar = bars.find(item => item.day === day && isSession(item));
    if (!bar) break;
    const previous = bars.find(item => item.day === day - 1
      && (isSession(item) || day === 1 && item.origin === 'background' && item.complete));
    // The live stock retains yesterday's actual close even if an old save has
    // no previous-day candle. Earlier missing candles cannot be reconstructed.
    const previousClose = day === stock.listedDay ? stock.issuePrice : day === m.day ? stock.previousClose : previous?.close;
    if (!previousClose || bar.close !== limitPrices({ previousClose, listedDay: stock.listedDay }, day).high) break;
    streak++;
  }
  return streak;
}

/** Public observations only: never changes prices, plans, orders, or the RNG. */
export function buildLimitBoard(m: Market, stock: Stock): LimitBoardView {
  const limitUp = limitPrices(stock, m.day).high;
  const today = m.trades.filter(trade => trade.day === m.day && trade.stockId === stock.id && trade.quantity > 0);
  const closed = m.phase === 'night' || m.phase === 'ended';
  const bar = closed ? stock.dailyBars?.find(item => item.day === m.day && isSession(item)) : undefined;
  const touched = today.some(trade => trade.price === limitUp) || !!bar && bar.high === limitUp;
  const recordedVolume = today.reduce((sum, trade) => sum + trade.quantity, 0);
  const completeTape = recordedVolume === (bar?.volume ?? stock.volume);
  let breaks = 0;
  let wasAtLimit = false;
  for (const trade of today) {
    if (wasAtLimit && trade.price < limitUp) breaks++;
    wasAtLimit = trade.price === limitUp;
  }

  const actors = new Set(m.actors.map(actor => actor.id));
  const active = closed ? [] : m.orders.filter(order => order.stockId === stock.id
    && actors.has(order.actorId) && isActive(order));
  const buys = active.filter(order => isBuy(order) && order.price === limitUp);
  const queuedBuyQuantity = buys.reduce((sum, order) => sum + order.remaining, 0);
  const crossingSell = active.some(order => !isBuy(order) && order.price <= limitUp
    && buys.some(buy => buy.actorId !== order.actorId));
  const currentAtLimit = touched && stock.price === limitUp && stock.volume > 0;
  const closedAtLimit = !!bar && bar.close === limitUp;
  const continuous = m.phase === 'morning' || m.phase === 'afternoon';
  const upStreak = completedStreak(m, stock, closed ? m.day : m.day - 1);
  const status: LimitBoardView['status'] = closedAtLimit ? 'closed-limit'
    : currentAtLimit && continuous && queuedBuyQuantity > 0 && !crossingSell ? 'sealed'
      : touched && stock.price < limitUp ? 'opened'
        : touched ? 'touched' : 'none';

  return {
    status, upStreak, candidateStreak: !closed && currentAtLimit ? upStreak + 1 : 0,
    touched, breakCount: completeTape ? breaks : null,
    queuedBuyQuantity, queuedBuyAmount: queuedBuyQuantity * limitUp / 100,
  };
}
