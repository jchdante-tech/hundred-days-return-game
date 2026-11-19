import type { Market } from './engine.js';

type Stock = Market['stocks'][number];
type Actor = Market['actors'][number];

export interface ActorChipSupply {
  quantity: number;
  /** Shares released by T+1, before ordinary order reservations. */
  available: number;
  profitRatio: number;
  /** An estimated holding preference, never a prohibition on selling. */
  retention: number;
  sellFactor: number;
}

export interface ChipSupply {
  /** Physical shares participating in this game, including unborrowed broker stock. */
  floatShares: number;
  largeHolderShares: number;
  playerShares: number;
  concentration: number;
  playerRatio: number;
  t1LockedShares: number;
  /** Estimated willing inventory, not an executable quote or promised fill. */
  estimatedSupply: number;
  /** Weighted profitable old-share overhang, between zero and one. */
  profitPressure: number;
  depthFactor: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const isSeat = (id: string) => /^ai[0-5]$/.test(id);
const isCrowd = (id: string) => /^crowd[0-2]$/.test(id);
const active = (o: Market['orders'][number]) => o.remaining > 0 && (o.status === 'open' || o.status === 'partial');
const profitStrength = (gain: number) => clamp((gain - .03) / .25, 0, 1);
const longSale = (o: Market['orders'][number]) => active(o) && ['sell', 'creditSell', 'marginSell'].includes(o.side);

/** Reads the physical position only: credit and margin are sub-ledgers of it. */
export function getActorChipSupply(m: Market, s: Stock, a: Actor): ActorChipSupply {
  const offered = m.orders.reduce((sum, o) => sum + (o.actorId === a.id && o.stockId === s.id && longSale(o) ? o.remaining : 0), 0);
  return actorSupply(m, s, a, offered);
}

function actorSupply(m: Market, s: Stock, a: Actor, posted: number): ActorChipSupply {
  const p = a.positions[s.id];
  const quantity = Math.max(0, p?.quantity ?? 0);
  const available = Math.max(0, quantity - (p?.today ?? 0));
  const profitRatio = quantity && p!.cost > 0 ? s.price * quantity / p!.cost - 1 : 0;
  const profit = profitStrength(profitRatio);
  if (a.id === 'ipo-issuer') return { quantity, available: 0, profitRatio, retention: 1, sellFactor: 0 };
  if (a.id === 'player') {
    // No prediction of the human's intention: only their actual long-side sell
    // orders are offered. Short-sale orders borrow a different physical pool.
    const offered = Math.min(available, posted);
    return { quantity, available, profitRatio, retention: available ? 1 - offered / available : 1, sellFactor: 1 };
  }
  if (isCrowd(a.id)) {
    // Each crowd account aggregates many small investors; its size must never
    // be interpreted as one concentrated holder. Profit-taking still matters.
    return { quantity, available, profitRatio, retention: 0, sellFactor: 1 + profit * .35 };
  }
  const plan = isSeat(a.id) ? m.agentSimulation?.plans[a.id] : undefined;
  let retention = 0;
  if (plan && (s.id === plan.mainId || s.id === plan.reserveId)) {
    retention = { observe: .3, build: .7, hold: .72, reduce: .05, cooldown: 0 }[plan.state];
    if (plan.state !== 'reduce' && plan.state !== 'cooldown') {
      if (m.day - plan.startedDay < plan.minimumDays) retention += .08;
      if (plan.style === 'value') retention += .08;
      // A profitable or deteriorating position gradually releases supply.
      // The seat's existing entry/exit rules still decide actual orders.
      retention -= profit * .5 + clamp(-s.newsBias * 4, 0, .25);
    }
  }
  retention = clamp(retention, 0, .9);
  // A willingness estimate cannot hide shares already offered to the market.
  if (available) retention = Math.min(retention, 1 - Math.min(available, posted) / available);
  return { quantity, available, profitRatio, retention,
    sellFactor: clamp(.7 + (1 - retention) * .6 + profit * .3, .65, 1.6) };
}

/**
 * Pure, deterministic inventory analysis. No RNG, writes, mark-price changes,
 * or duplicate shares from collateral, financing, margin or short liabilities.
 */
export function getChipSupply(m: Market, s: Stock): ChipSupply {
  let heldShares = 0, largeHolderShares = 0, playerShares = 0, t1LockedShares = 0;
  let estimatedSupply = 0, profitableSupply = 0;
  const posted = new Map<string, number>();
  for (const o of m.orders) if (o.stockId === s.id && longSale(o)) {
    posted.set(o.actorId, (posted.get(o.actorId) ?? 0) + o.remaining);
  }
  for (const a of m.actors) {
    if (a.id === 'ipo-issuer') continue;
    const p = actorSupply(m, s, a, posted.get(a.id) ?? 0);
    heldShares += p.quantity;
    t1LockedShares += p.quantity - p.available;
    if (a.id === 'player' || isSeat(a.id)) largeHolderShares += p.quantity;
    if (a.id === 'player') playerShares = p.quantity;
    estimatedSupply += p.available * (1 - p.retention);
    profitableSupply += p.available * profitStrength(p.profitRatio);
  }
  // A borrowed sale moves shares out of lendAvailable into the buyer's physical
  // holding; covering makes the reverse transfer. Neither changes this float.
  const floatShares = heldShares + Math.max(0, s.lendAvailable);
  const supplyRatio = heldShares ? estimatedSupply / heldShares : 0;
  // Leave ordinary low-concentration liquidity almost unchanged. As willing
  // inventory disappears, both sides get thinner: accumulating is easier, but
  // liquidating a concentrated holding also meets less funded depth.
  const depthFactor = clamp(1 - Math.max(0, .85 - supplyRatio) * .75, .4, 1);
  return { floatShares, largeHolderShares, playerShares,
    concentration: floatShares ? largeHolderShares / floatShares : 0,
    playerRatio: floatShares ? playerShares / floatShares : 0,
    t1LockedShares, estimatedSupply: Math.round(estimatedSupply),
    profitPressure: floatShares ? profitableSupply / floatShares : 0, depthFactor };
}
