import type { OrderView, Phase, PriceLevel } from './types';

const buys = new Set(['buy', 'finance', 'cover', 'marginBuy', 'marginCover']);
const cents = (price: number) => Math.round(price * 100);
export const continuousPhase = (phase: Phase) => phase === 'morning' || phase === 'afternoon';

/** Public, visible depth only. Never predicts hidden depth, future orders or an auction clearing price. */
export function previewBook(levels: PriceLevel[], side: 'buy' | 'sell', price: number, quantity: number) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity % 100) return null;
  let remaining = quantity, amount = 0;
  const fills: PriceLevel[] = [];
  for (const level of [...levels].sort((a, b) => side === 'buy' ? a.price - b.price : b.price - a.price)) {
    if (!remaining || (side === 'buy' ? cents(level.price) > cents(price) : cents(level.price) < cents(price))) break;
    const taken = Math.min(remaining, level.quantity);
    if (taken <= 0) continue;
    remaining -= taken; amount += cents(level.price) * taken;
    fills.push({ price: level.price, quantity: taken });
  }
  return { fills, filled: quantity - remaining, remaining, amount: amount / 100,
    averagePrice: quantity > remaining ? amount / (quantity - remaining) / 100 : null,
    lastPrice: fills.at(-1)?.price ?? null };
}

export function crossesOwnOrder(orders: OrderView[], side: 'buy' | 'sell', price: number) {
  return orders.some(o => (o.status === 'open' || o.status === 'partial') && buys.has(o.side) !== (side === 'buy')
    && (side === 'buy' ? cents(o.price) <= cents(price) : cents(o.price) >= cents(price)));
}

/** Presets fill the ticket only. Reserve at the limit price, as the server does. */
export function sweepTicket(levels: PriceLevel[], side: 'buy' | 'sell', depth: number, cash: number, available: number) {
  const selected = [...levels].sort((a, b) => side === 'buy' ? a.price - b.price : b.price - a.price).slice(0, depth);
  const price = selected.at(-1)?.price;
  if (!price || price <= 0) return null;
  const quantity = Math.floor(Math.min(selected.reduce((n, l) => n + l.quantity, 0), 10_000_000,
    side === 'buy' ? Math.floor(cents(cash) / cents(price)) : available) / 100) * 100;
  return quantity >= 100 ? { price, quantity } : null;
}
