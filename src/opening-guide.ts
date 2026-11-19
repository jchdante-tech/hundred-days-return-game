import type { MarketView, StockView } from '../shared/types';
import { OPENING_SCENARIO } from '../shared/opening-scenario';

export type OpeningStep = 'stock' | 'price' | 'quantity' | 'buy-start' | 'buy-submit'
  | 'impact' | 'follow' | 'locked' | 'overnight' | 'unlocked' | 'auction'
  | 'sell-side' | 'sell-ticket' | 'sell-start' | 'sell-submit' | 'done' | 'orders' | 'empty' | 'wait-book';

export type OpeningGuideContext = {
  market: MarketView;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
};

export function validOpeningSellOrder(stock: StockView, available: number, price: number, quantity: number) {
  return Number.isSafeInteger(quantity) && quantity > 0 && quantity % 100 === 0 && quantity <= available
    && Number.isFinite(price) && price >= stock.limitDown && price <= stock.limitUp
    && Math.abs(price * 100 - Math.round(price * 100)) < 1e-7;
}

/** A suggested limit order uses only today's visible, genuinely funded bids. */
export function openingSellTicket(stock: StockView, available: number) {
  let remaining = Math.floor(available / 100) * 100, quantity = 0, price = 0;
  for (const level of stock.bids) {
    const fill = Math.min(remaining, Math.floor(level.quantity / 100) * 100);
    if (fill > 0) { quantity += fill; remaining -= fill; price = level.price; }
    if (remaining === 0) break;
  }
  return quantity > 0 ? { quantity, price } : null;
}

/** Account state wins over a local instructional step, including after refresh or a skipped day. */
export function resolveOpeningStep(context: OpeningGuideContext, requested: OpeningStep): OpeningStep {
  const { market, price, quantity, side } = context;
  const scenario = market.openingScenario;
  if (!scenario) return 'empty';
  const position = market.positions.find(p => p.stockId === scenario.stockId);
  const stock = market.stocks.find(s => s.id === scenario.stockId)!;
  const resting = market.orders.some(o => o.stockId === scenario.stockId && ['open', 'partial'].includes(o.status));
  if (market.day >= 2 && scenario.soldQuantity > 0) return 'done';
  if (resting) return 'orders';
  if (market.day === 1) {
    if (['night', 'closing', 'ended'].includes(market.phase)) return 'overnight';
    if (scenario.stage === 'exit' || scenario.stage === 'complete') return requested === 'overnight' ? 'overnight' : 'locked';
    if (scenario.stage === 'following') return requested === 'follow' ? 'follow' : 'impact';
    if (market.phase === 'auction' || market.phase === 'lunch') return 'auction';
    if (!['stock', 'price', 'quantity', 'buy-start', 'buy-submit'].includes(requested)) return 'stock';
    if (['quantity', 'buy-start', 'buy-submit'].includes(requested) && price !== OPENING_SCENARIO.buyLimit) return 'price';
    if (['buy-start', 'buy-submit'].includes(requested) && quantity !== OPENING_SCENARIO.buyQuantity - scenario.boughtQuantity) return 'quantity';
    if (requested === 'buy-start' && !market.paused) return 'buy-submit';
    if (requested === 'buy-submit' && market.paused) return 'buy-start';
    return requested;
  }
  if (!position?.quantity) return 'empty';
  if (['night', 'ended', 'closing'].includes(market.phase)) return 'empty';
  if (!position.available) return 'empty';
  const sellingSteps: OpeningStep[] = ['unlocked', 'auction', 'sell-side', 'sell-ticket', 'sell-start', 'sell-submit', 'wait-book'];
  if (!sellingSteps.includes(requested)) return 'unlocked';
  if (requested === 'unlocked') return requested;
  if (['auction', 'lunch'].includes(market.phase)) return 'auction';
  if (requested === 'auction') return 'sell-side';
  if (requested === 'sell-side') return side === 'sell' ? 'sell-ticket' : requested;
  if (side !== 'sell') return 'sell-side';
  // A prepared limit order stays valid when the book moves while the player reads.
  // Let the exchange determine fills; do not move the spotlight off confirmation.
  if (requested === 'sell-start' || requested === 'sell-submit') {
    if (!validOpeningSellOrder(stock, position.available, price, quantity)) return 'sell-ticket';
    return market.paused ? 'sell-start' : 'sell-submit';
  }
  if (!openingSellTicket(stock, position.available)) return 'wait-book';
  if (requested === 'wait-book') return 'sell-ticket';
  return requested;
}
