import type { ActionResult, OrderInput } from '../shared/types.js';
import { limitPrices } from '../shared/market-rules.js';
import type { Market } from './engine.js';
import { expectedValue } from './news-arcs.js';
import { getChipSupply, getActorChipSupply } from './chips.js';
import { isOpeningScenarioStock, openingFollowReserve } from './opening-scenario.js';

export type AgentStyle = 'trend' | 'contrarian' | 'theme' | 'rotation' | 'swing' | 'value';
export type PlanState = 'observe' | 'build' | 'hold' | 'reduce' | 'cooldown';
export interface ActorPlan {
  style: AgentStyle; mainId: string; reserveId: string; startedDay: number;
  minimumDays: number; maximumDays: number; state: PlanState; cooldownUntil: number;
  budgetDay: number; dayBudget: number; daySpent: number; dayBuyIds: string[];
  peakPrice: number; lastActionTick: number;
}
export interface CrowdOpinion { bias: number; inventory: number }
export interface AgentSimulation {
  version: 1; preparedDay: number; plans: Record<string, ActorPlan>;
  crowdOpinions: Record<string, Record<string, CrowdOpinion>>;
}
type AgentMarket = Market & { agentSimulation?: AgentSimulation };
type Stock = Market['stocks'][number];
type Actor = Market['actors'][number];
export type AgentPlace = (actorId: string, input: OrderInput) => ActionResult;
export type AgentRandom = () => number;

const STYLES: AgentStyle[] = ['trend', 'contrarian', 'theme', 'rotation', 'swing', 'value'];
const STATES: PlanState[] = ['observe', 'build', 'hold', 'reduce', 'cooldown'];
const CROWD_IDS = ['crowd0', 'crowd1', 'crowd2'];
const active = (o: Market['orders'][number]) => o.remaining > 0 && (o.status === 'open' || o.status === 'partial');
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
const lots = (quantity: number) => Math.max(0, Math.floor(quantity / 100) * 100);
const position = (actor: Actor, stockId: string) => actor.positions[stockId] ??= { quantity: 0, today: 0, financed: 0, cost: 0 };
const stock = (m: Market, id: string) => m.stocks.find(s => s.id === id)!;
const actor = (m: Market, id: string) => m.actors.find(a => a.id === id)!;
const netWorth = (m: Market, a: Actor) => a.cash + m.stocks.reduce((sum, s) => sum + (a.positions[s.id]?.quantity ?? 0) * s.price, 0);
const reservedCash = (m: Market, id: string) => openingFollowReserve(m, id) + m.orders.reduce((sum, o) => sum + (o.actorId === id && active(o) ? o.frozenCash : 0), 0);
const reservedStock = (m: Market, id: string, stockId: string) => m.orders.reduce((sum, o) => sum + (o.actorId === id && o.stockId === stockId && o.side === 'sell' && active(o) ? o.remaining : 0), 0);
function limits(m: Market, s: Stock, price: number) {
  const { low, high } = limitPrices(s, m.day);
  return clamp(Math.round(price), low, high);
}
function momentum(s: Stock, length = 4) {
  const bars = (s.dailyBars ?? []).filter(b => b.complete);
  const previous = bars[Math.max(0, bars.length - length)]?.close ?? s.previousClose;
  return s.price / previous - 1;
}
function sectorStrength(m: Market, s: Stock) {
  const peers = m.stocks.filter(x => x.sector === s.sector);
  return peers.reduce((sum, x) => sum + momentum(x, 3), 0) / peers.length;
}
function valuation(m: Market, s: Stock) {
  // Earnings reference is updated by the event engine. PE changes the value
  // investor's required yield; prices still move only when orders match.
  const currentPe = s.pe * s.price / Math.max(1, expectedValue(m, s));
  return { gap: expectedValue(m, s) / s.price - 1, yield: 1 / Math.max(1, currentPe), pePremium: currentPe / Math.max(1, s.pe) - 1 };
}
function depth(s: Stock) {
  // Market capitalisation is a depth proxy, not a direct price-change rule.
  return clamp(Math.sqrt(s.shares * s.price / 90_000_000_000), .55, 2.2);
}
function offeringOpinions(s: Stock) {
  const f = s.ipoFactors;
  return f ? { demand: { weak: -1, steady: 0, strong: 1 }[f.demand],
    valuation: clamp((f.issuePe / Math.max(1, f.peerPe) - 1) * 2, -1, 1),
    floatTightness: clamp((.2 - f.floatRatio) / .15, -1, 1) }
    : { demand: 0, valuation: 0, floatTightness: 0 };
}
function publishedCatalyst(m: Market, s: Stock) {
  const expectation = m.storyState?.expectations[s.id];
  const article = m.news.find(n => n.stockIds?.includes(s.id));
  const listing = s;
  if (listing.listedDay !== undefined && listing.issuePrice && listing.ipoFactors
    && m.day >= listing.listedDay && m.day - listing.listedDay <= 3 && article?.sentiment === 'positive') {
    const f = offeringOpinions(s), disclosedDiscount = s.fair / listing.issuePrice - 1;
    // A new issue competes with existing stories for the same attention. These
    // are disclosed prospectus/offer factors, not a forecast of future prices.
    return clamp(.045 + f.demand * .1 + f.floatTightness * .035 - f.valuation * .06 + disclosedDiscount * .4, 0, .3)
      / (1 + (m.day - listing.listedDay) * .45);
  }
  if (!expectation || !article || article.day === undefined || article.sentiment !== 'positive' || m.day - article.day > 3
    || expectation.premium < .075) return 0;
  // The primary company competes for a finite pool of attention. Related
  // suppliers are not automatically treated as identical beneficiaries.
  const exposure = article.stockIds?.[0] === s.id ? 1 : .22;
  return Math.min(.3, expectation.premium) * (.5 + expectation.conviction)
    * exposure / (1 + (m.day - article.day) * .45);
}
function featuredCatalyst(m: Market) {
  // Rank on published information rather than today's price: a price rise must
  // not automatically send this attention to every other stock in succession.
  const ranked = m.stocks.map(s => ({ id: s.id, score: publishedCatalyst(m, s) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return ranked[0]?.score >= .075 ? ranked[0].id : '';
}
function attention(m: Market, s: Stock, focusId: string) {
  if (s.id !== focusId) return 0;
  const expectation = m.storyState?.expectations[s.id];
  if (!expectation) return 0;
  const gap = expectedValue(m, s) / s.price - 1;
  const evidence = volumeConfirmed(m, s) && s.price > s.previousClose * 1.008 ? .18 : 0;
  // A limited speculative premium is possible after real volume confirms the
  // move. Once that room is spent, fresh buyers lose conviction instead of
  // receiving an unconditional "keep rising" instruction.
  return clamp((gap + .035 + evidence * .2) * 6 + Math.max(0, s.newsBias) * 4, 0, 1)
    * clamp(publishedCatalyst(m, s) / .13, 0, 1);
}
function score(m: Market, s: Stock, style: AgentStyle) {
  const v = valuation(m, s), trend = momentum(s), today = s.price / s.previousClose - 1;
  const liquid = Math.log2(1 + depth(s)) * .008;
  switch (style) {
    case 'trend': return trend * .8 + s.newsBias * .15 + liquid - Math.max(0, v.pePremium - .2) * .1;
    case 'contrarian': return v.gap * .8 - trend * .25 + liquid - Math.max(0, -s.newsBias) * .25;
    case 'theme': return s.newsBias * 1.8 + v.gap * .3 + publishedCatalyst(m, s) * .8 + trend * .12 - liquid * .2;
    case 'rotation': return sectorStrength(m, s) * .75 + today * .3 + s.newsBias * .6 + liquid;
    case 'swing': return v.gap * .3 - trend * .55 + today * .3 + liquid;
    case 'value': return v.gap * .7 + v.yield * .25 - Math.max(0, -s.newsBias) * .5 + liquid;
  }
}
function choosePlan(m: Market, style: AgentStyle, random: AgentRandom, old?: ActorPlan): ActorPlan {
  const ranked = m.stocks.map(s => ({ id: s.id, score: score(m, s, style) + (random() - .5) * .018 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  // Six styles share public information, but do not share a mandatory target.
  // Mild, seeded judgement differences break ties without random stock churn.
  const mainId = ranked[0].id;
  const reserveId = ranked.find(row => row.id !== mainId && (style !== 'rotation' || stock(m, row.id).sector !== stock(m, mainId).sector))?.id ?? ranked[1].id;
  const minimumDays = { trend: 2, contrarian: 3, theme: 2, rotation: 2, swing: 2, value: 5 }[style];
  const maximumDays = { trend: 8, contrarian: 12, theme: 6, rotation: 6, swing: 7, value: 18 }[style];
  return { style, mainId, reserveId, startedDay: m.day, minimumDays, maximumDays,
    state: 'observe', cooldownUntil: 0, budgetDay: m.day, dayBudget: 0, daySpent: 0,
    dayBuyIds: [], peakPrice: stock(m, mainId).price, lastActionTick: old?.lastActionTick ?? -100 };
}
function movePosition(from: Actor, to: Actor, stockId: string, quantity: number) {
  const src = position(from, stockId), dst = position(to, stockId);
  const q = Math.min(quantity, src.quantity);
  if (!q) return;
  const cost = q === src.quantity ? src.cost : Math.floor(src.cost * q / src.quantity);
  const today = Math.min(q, src.today), financed = Math.min(q, src.financed);
  src.quantity -= q; src.cost -= cost; src.today -= today; src.financed -= financed;
  dst.quantity += q; dst.cost += cost; dst.today += today; dst.financed += financed;
}
function canCancel(m: Market) { return m.phase !== 'closing' && !(m.phase === 'auction' && m.phaseElapsed >= 22.5); }
function cancelNpcOrders(m: Market, predicate: (o: Market['orders'][number]) => boolean) {
  for (const o of m.orders) if (o.actorId !== 'player' && active(o) && !isOpeningScenarioStock(m, o.stockId) && predicate(o)) {
    o.status = 'cancelled'; o.frozenCash = 0; o.restrictedClaim = 0;
  }
}

/** Called once for a fresh game, or at the next opening for an older save. */
export function initializeAgents(m: AgentMarket, options: { legacy: boolean }, random: AgentRandom): void {
  if (m.agentSimulation) return;
  cancelNpcOrders(m, () => true);
  const plans = Object.fromEntries(STYLES.map((style, index) => [`ai${index}`, choosePlan(m, style, random)]));
  const crowd = CROWD_IDS.map((id, index): Actor => ({ id, name: ['普通资金 · 分散配置', '普通资金 · 流动需求', '普通资金 · 估值交易'][index], cash: 0, positions: {} }));
  for (const [index, style] of STYLES.entries()) {
    const a = actor(m, `ai${index}`), plan = plans[a.id];
    if (style === 'rotation') a.name = '南湾路 · 轮动资金';
    // Split existing NPC wealth into independently funded cohorts. No new cash
    // or shares are created; no player balance, borrowing or market data changes.
    const transferredCash = Math.floor(a.cash * .8);
    a.cash -= transferredCash;
    crowd.forEach((c, i) => { c.cash += Math.floor(transferredCash / 3) + (i < transferredCash % 3 ? 1 : 0); });
    for (const s of m.stocks) {
      const p = position(a, s.id);
      const keep = options.legacy ? lots(p.quantity * .4)
        : Math.min(p.quantity, s.id === plan.mainId ? 120_000 : s.id === plan.reserveId ? 50_000 : 0);
      let remaining = p.quantity - keep;
      for (let i = 0; i < 3; i++) {
        const amount = i === 2 ? remaining : lots(remaining / (3 - i));
        movePosition(a, crowd[(index + i) % 3], s.id, amount); remaining -= amount;
      }
    }
  }
  m.actors.push(...crowd);
  const crowdOpinions = Object.fromEntries(crowd.map(c => [c.id, Object.fromEntries(m.stocks.map(s => [s.id, {
    bias: (random() - .5) * .025, inventory: position(c, s.id).quantity,
  }]))]));
  m.agentSimulation = { version: 1, preparedDay: 0, plans, crowdOpinions };
  prepareAgentDay(m, random);
}

/** Called after actual IPO allocations, before daily preparation and seeding. */
export function initializeListedStock(m: AgentMarket, s: Stock): void {
  if (!m.agentSimulation) return;
  const f = offeringOpinions(s);
  for (const [index, id] of CROWD_IDS.entries()) {
    const opinions = m.agentSimulation.crowdOpinions[id];
    const bias = index === 0 ? f.demand * .018 - f.valuation * .008 + f.floatTightness * .01
      : index === 1 ? f.demand * .002 - f.valuation * .003 - f.floatTightness * .002
        : f.demand * .004 - f.valuation * .025 + f.floatTightness * .002;
    opinions[s.id] ??= { bias: clamp(bias, -.04, .04), inventory: actor(m, id).positions[s.id]?.quantity ?? 0 };
  }
}

function planHasShares(m: Market, a: Actor) { return m.stocks.some(s => (a.positions[s.id]?.quantity ?? 0) > 0); }
/** Refresh plans only once per trading day, after T+1 lots have been released. */
export function prepareAgentDay(m: AgentMarket, random: AgentRandom): void {
  const simulation = m.agentSimulation;
  if (!simulation || simulation.preparedDay === m.day) return;
  const focusId = featuredCatalyst(m);
  for (const [id, old] of Object.entries(simulation.plans)) {
    const a = actor(m, id);
    const finished = !planHasShares(m, a) && (old.state === 'reduce' || old.state === 'cooldown');
    if (finished && old.state !== 'cooldown') { old.state = 'cooldown'; old.cooldownUntil = m.day + 1; }
    const staleObservation = old.state === 'observe' && m.day - old.startedDay >= 3 && !planHasShares(m, a);
    if ((old.state === 'cooldown' && m.day >= old.cooldownUntil) || staleObservation) {
      simulation.plans[id] = choosePlan(m, old.style, random, old);
    }
    const p = simulation.plans[id];
    // A new public story can enter a vacant reserve slot at the next opening.
    // Existing holdings and the main plan still have to be managed and exited.
    if (focusId && ['theme', 'trend', 'rotation'].includes(p.style) && p.mainId !== focusId
      && (a.positions[p.reserveId]?.quantity ?? 0) === 0 && p.state !== 'reduce' && p.state !== 'cooldown') p.reserveId = focusId;
    p.budgetDay = m.day; p.daySpent = 0; p.dayBuyIds = [];
    // Risk budget is explicit and survives saves. Unfilled orders also reserve it.
    const conviction = Math.max(attention(m, stock(m, p.mainId), focusId), attention(m, stock(m, p.reserveId), focusId));
    const responsive = ['theme', 'trend', 'rotation'].includes(p.style) ? conviction : 0;
    const riskFraction = (p.style === 'value' ? .14 : p.style === 'theme' ? .26 : .21) + responsive * .2;
    p.dayBudget = Math.floor(Math.min(a.cash * (.45 + responsive * .25), netWorth(m, a) * riskFraction));
    if (m.day - p.startedDay >= p.maximumDays && p.state !== 'cooldown') p.state = 'reduce';
    if (p.state === 'build') p.state = 'hold';
  }
  for (const c of CROWD_IDS) for (const s of m.stocks) {
    const opinion = simulation.crowdOpinions[c][s.id];
    // Inventory targets are anchored at the initial finite allocation. Today's
    // demand may differ, but purchases do not create a fresh daily sell inventory.
    opinion.bias = clamp(opinion.bias * .55 + (random() - .5) * .022, -.04, .04);
  }
  simulation.preparedDay = m.day;
}

function placeFunded(m: Market, a: Actor, s: Stock, side: 'buy' | 'sell', quantity: number, price: number, place: AgentPlace) {
  const limit = limits(m, s, price);
  const p = position(a, s.id);
  const capacity = side === 'buy' ? (a.cash - reservedCash(m, a.id)) / limit
    : p.quantity - p.today - reservedStock(m, a.id, s.id);
  const q = lots(Math.min(quantity, capacity));
  if (q < 100) return false;
  return place(a.id, { stockId: s.id, side, quantity: q, price: limit / 100 }).ok;
}

/** Patient five-level depth, backed entirely by the ordinary funds. */
export function seedBackgroundBook(m: AgentMarket, place: AgentPlace): void {
  if (!m.agentSimulation) return;
  for (const [i, s] of m.stocks.entries()) {
    if (isOpeningScenarioStock(m, s.id)) continue;
    const supply = getChipSupply(m, s);
    for (let level = 0; level < 5; level++) {
      const q = lots((5_000 + level * 3_000) * depth(s) * supply.depthFactor);
      const spread = Math.max(1, Math.round(s.price * .0007)) + level * Math.max(1, Math.round(s.price * .0013));
      const buyer = actor(m, CROWD_IDS[(i + level) % 3]), seller = actor(m, CROWD_IDS[(i + level + 1) % 3]);
      const buyPrice = limits(m, s, s.price - spread), held = position(seller, s.id);
      // Replenishing depth cannot freeze the whole portfolio or an IPO's small
      // float. Existing reservations count toward this allowance on every pulse.
      const buyCapacity = Math.max(0, buyer.cash * .25 - reservedCash(m, buyer.id)) / buyPrice;
      const sellCapacity = Math.max(0, (held.quantity - held.today) * .25 - reservedStock(m, seller.id, s.id));
      placeFunded(m, buyer, s, 'buy', Math.min(q, buyCapacity), buyPrice, place);
      const sellFactor = getActorChipSupply(m, s, seller).sellFactor;
      placeFunded(m, seller, s, 'sell', Math.min(q * sellFactor, sellCapacity), s.price + spread, place);
    }
  }
}

function volumeConfirmed(m: Market, s: Stock) {
  const bars = (s.dailyBars ?? []).filter(b => b.complete).slice(-5);
  const typical = bars.length ? bars.reduce((sum, b) => sum + b.volume, 0) / bars.length : 200_000;
  const elapsed = m.phase === 'auction' ? .04 : m.phase === 'morning' ? .04 + m.phaseElapsed / 180 * .46
    : m.phase === 'afternoon' ? .5 + m.phaseElapsed / 180 * .47 : .98;
  return s.volume >= Math.max(10_000, typical * elapsed * 1.05);
}
function tradingMinute(time: string) {
  if (!/^\d{2}:\d{2}$/.test(time)) return null;
  const [hour, minute] = time.split(':').map(Number);
  if (hour > 23 || minute > 59) return null;
  const absolute = hour * 60 + minute;
  if (absolute <= 570) return 0;
  if (absolute <= 690) return absolute - 570;
  return 120 + Math.max(0, Math.min(120, absolute - 780));
}
function currentTradingMinute(m: Market) {
  if (m.phase === 'auction') return 0;
  if (m.phase === 'morning') return Math.floor(Math.min(1, m.phaseElapsed / 180) * 120);
  if (m.phase === 'lunch') return 120;
  if (m.phase === 'afternoon') return 120 + Math.floor(Math.min(1, m.phaseElapsed / 180) * 117);
  if (m.phase === 'closing') return 237 + Math.floor(Math.min(1, m.phaseElapsed / 15) * 3);
  return 240;
}
function observedFlow(m: Market, s: Stock) {
  // Only executed public price/volume enters this signal. Large displayed
  // orders, the buyer's identity and unpublished stories cannot trigger it.
  if (!s.volume || !m.trades.some(t => t.day === m.day && t.stockId === s.id && t.quantity > 0)) return 0;
  const now = currentTradingMinute(m);
  const points = s.history.filter(p => {
    const minute = tradingMinute(p.time);
    return p.volume > 0 && minute !== null && minute <= now && now - minute <= 10;
  }).slice(-4);
  if (!points.length) return 0;
  const recentVolume = points.reduce((sum, p) => sum + p.volume, 0);
  const bars = (s.dailyBars ?? []).filter(b => b.complete).slice(-5);
  const typical = bars.length ? bars.reduce((sum, b) => sum + b.volume, 0) / bars.length : 200_000;
  const threshold = Math.max(100_000, typical * .25);
  if (recentVolume < threshold * .5) return 0;
  const index = s.history.indexOf(points[0]);
  const reference = index > 0 ? s.history[index - 1].price : s.previousClose;
  const drift = points[points.length - 1].price / Math.max(1, reference) - 1;
  // This is a small follower cohort, not a new source of unlimited buying.
  const age = now - tradingMinute(points[points.length - 1].time)!;
  return clamp(drift * 2, -.035, .035) * clamp(recentVolume / threshold, 0, 1) * Math.pow(.5, age / 4);
}
function entrySignal(m: Market, s: Stock, plan: ActorPlan, heat = 0) {
  const v = valuation(m, s), trend = momentum(s), today = s.price / s.previousClose - 1;
  switch (plan.style) {
    case 'trend': return trend > .009 && today > -.008 && v.pePremium < .3 && volumeConfirmed(m, s);
    case 'contrarian': return v.gap > .028 && s.newsBias > -.035 && today > -.065;
    case 'theme': return (s.newsBias > .012 || (expectedValue(m, s) / s.fair > 1.035 && v.gap > .018) || heat > .2) && v.pePremium < .24;
    case 'rotation': return sectorStrength(m, s) > m.stocks.reduce((sum, x) => sum + momentum(x, 3), 0) / m.stocks.length + .003
      && (today > .002 || s.newsBias > .018);
    case 'swing': return trend < -.012 && today > -.025 && v.gap > -.06 && s.low > 0 && s.price > s.low * 1.004;
    case 'value': return v.gap > .045 && v.yield > .017 && s.newsBias > -.04;
  }
}
function shouldExit(m: Market, s: Stock, a: Actor, plan: ActorPlan) {
  const p = position(a, s.id), cost = p.quantity ? p.cost / p.quantity : s.price;
  const gain = s.price / Math.max(1, cost) - 1, age = m.day - plan.startedDay;
  const mature = age >= plan.minimumDays;
  const stop = plan.style === 'value' ? -.12 : plan.style === 'theme' ? -.07 : -.085;
  if (gain < stop || (s.newsBias < -.035 && expectedValue(m, s) < cost * .96)) return true;
  if (plan.state === 'reduce' || (s.id !== plan.mainId && s.id !== plan.reserveId)) return true;
  switch (plan.style) {
    case 'trend': return mature && (momentum(s, 2) < -.025 || (s.id === plan.mainId && s.price < plan.peakPrice * .94));
    case 'contrarian': return mature && (s.price > expectedValue(m, s) * 1.035 || gain > .12);
    case 'theme': return mature && (s.newsBias < -.012 || gain > .18);
    case 'rotation': return mature && sectorStrength(m, s) < -.01;
    case 'swing': return mature && (gain > .065 || momentum(s, 2) > .05);
    case 'value': return mature && (s.price > expectedValue(m, s) * 1.12 || gain > .25);
  }
}
function runSeat(m: AgentMarket, a: Actor, plan: ActorPlan, random: AgentRandom, place: AgentPlace, focusId: string) {
  const main = stock(m, plan.mainId);
  plan.peakPrice = Math.max(plan.peakPrice, main.price);
  // Reconcile against executed trades, not attempted orders. A restored save
  // therefore cannot get an extra spending allowance from a process restart.
  const buys = m.trades.filter(t => t.day === m.day && t.buyerId === a.id);
  plan.daySpent = buys.reduce((sum, t) => sum + t.price * t.quantity, 0);
  plan.dayBuyIds = [...new Set(buys.map(t => t.stockId))];
  if (plan.state === 'cooldown') return;
  const exits = m.stocks.filter(s => position(a, s.id).quantity > 0 && shouldExit(m, s, a, plan));
  // Exits can include older positions outside the new watch list; limiting buys
  // must never prevent a risk reduction or a legacy holding from being sold.
  if (exits.length) {
    const s = exits[Math.floor(random() * exits.length)], p = position(a, s.id);
    if (s.id === plan.mainId) plan.state = 'reduce';
    if (random() < .7) {
      const supply = getActorChipSupply(m, s, a);
      const q = lots(Math.min(p.quantity * (plan.state === 'reduce' ? .22 : .12), 25_000 * depth(s)) * supply.sellFactor);
      const price = s.price * (1 - (plan.state === 'reduce' ? .006 : .002));
      if (placeFunded(m, a, s, 'sell', Math.max(100, q), price, place)) plan.lastActionTick = m.tickCount;
    }
    if (plan.state === 'reduce') {
      if (canCancel(m)) cancelNpcOrders(m, o => o.actorId === a.id && o.side === 'buy');
      return;
    }
  }
  if (plan.state === 'reduce') {
    if (canCancel(m)) cancelNpcOrders(m, o => o.actorId === a.id && o.side === 'buy');
    if (!planHasShares(m, a)) { plan.state = 'cooldown'; plan.cooldownUntil = m.day + 2; }
    return;
  }
  const watchHeat = Math.max(attention(m, main, focusId), attention(m, stock(m, plan.reserveId), focusId));
  const responsive = ['theme', 'trend', 'rotation'].includes(plan.style);
  if (random() > .35 + (responsive ? watchHeat * .35 : 0) || m.tickCount - plan.lastActionTick < 8) return;
  const mainChance = plan.reserveId === focusId && watchHeat > .35 ? .4 : .78;
  const s = stock(m, random() < mainChance ? plan.mainId : plan.reserveId), heat = attention(m, s, focusId);
  if (!entrySignal(m, s, plan, heat)) return;
  if (plan.dayBuyIds.length >= 2 && !plan.dayBuyIds.includes(s.id)) return;
  const pending = m.orders.filter(o => active(o) && o.actorId === a.id && o.side === 'buy');
  const reservedBudget = pending.reduce((sum, o) => sum + o.remaining * o.price, 0);
  const budgetLeft = Math.max(0, plan.dayBudget - plan.daySpent - reservedBudget);
  const equity = netWorth(m, a), p = position(a, s.id);
  const established = m.day - plan.startedDay >= plan.minimumDays;
  const weight = (s.id === plan.mainId ? (established ? .42 : .23) : .14) + (responsive ? heat * .2 : 0);
  const desired = Math.max(0, equity * weight - p.quantity * s.price
    - pending.filter(o => o.stockId === s.id).reduce((sum, o) => sum + o.remaining * o.price, 0));
  const conviction = (plan.style === 'theme' ? .006 : plan.style === 'trend' ? .004 : .0015) + (responsive ? heat * .035 : 0);
  const price = limits(m, s, s.price * (1 + conviction));
  const q = lots(Math.min(budgetLeft / price, desired / price, (3_000 + random() * 10_000) * (1 + (responsive ? heat * 5 : 0)) / Math.sqrt(depth(s))));
  if (q && placeFunded(m, a, s, 'buy', q, price, place)) { plan.state = 'build'; plan.lastActionTick = m.tickCount; }
}

function runBackground(m: AgentMarket, random: AgentRandom, place: AgentPlace, focusId: string) {
  const sim = m.agentSimulation!;
  // Each second brings small independent household intents across the market.
  // Featured seats retain their separate, slower planning cadence below.
  for (const s of m.stocks) {
    if (isOpeningScenarioStock(m, s.id)) continue;
    const v = valuation(m, s), heat = attention(m, s, focusId), flow = observedFlow(m, s);
    const chipDepth = getChipSupply(m, s).depthFactor;
    for (let k = 0; k < CROWD_IDS.length; k++) {
      const a = actor(m, CROWD_IDS[k]), opinion = sim.crowdOpinions[a.id][s.id];
      const p = position(a, s.id), inventoryGap = (opinion.inventory - p.quantity) / Math.max(100_000, opinion.inventory);
      const newsWeight = [.32, -.1, .08][k], fairWeight = [.16, .04, .3][k];
      const belief = clamp(v.gap * fairWeight + s.newsBias * newsWeight + opinion.bias + inventoryGap * .025, -.07, .07);
      // Households may need cash or rebalance independently of the headline.
      const confirmed = volumeConfirmed(m, s) && s.price > s.previousClose * 1.008;
      const follow = k === 0 ? heat * (confirmed ? .25 : .1) + flow : k === 2 ? heat * .08 : 0;
      const buyChance = clamp(.5 + belief * 4 + inventoryGap * .16 + follow, .2, .87);
      const side = random() < buyChance ? 'buy' : 'sell';
      // The former twelve-second stock rotation must not apply its full
      // direction/quote step every second. Only the small-order frequency rises.
      const urgency = (random() - .4) * .002;
      // Optimistic holders can demand a higher selling price, while cash-needs
      // and value accounts still offer stock. Only crossed, funded orders print.
      const expectationQuote = heat * (k === 0 ? .022 : k === 2 ? .012 : .002) + (k === 0 ? flow * .025 : 0);
      const profit = p.quantity ? Math.max(0, s.price / Math.max(1, p.cost / p.quantity) - 1) : 0;
      const profitSupply = k === 2 ? clamp(profit * 2, 0, .7) : 0;
      const quote = s.price * (1 + belief * .02 + expectationQuote + (side === 'buy' ? urgency : -urgency));
      const participation = side === 'buy' ? 1 + follow * 3 : k === 0 ? 1 - heat * .55 + Math.max(0, -flow) * 4 : 1 + profitSupply;
      const chipSelling = side === 'sell' ? getActorChipSupply(m, s, a).sellFactor : 1;
      const q = lots((450 + random() * 950) * depth(s) * participation * chipDepth * chipSelling);
      // A changed intent first withdraws this account's conflicting old quote.
      // The matcher still rejects self-trades; other accounts keep their place.
      const newLimit = limits(m, s, quote);
      if (canCancel(m)) cancelNpcOrders(m, o => o.actorId === a.id && o.stockId === s.id && o.side !== side
        && (side === 'buy' ? newLimit >= o.price : newLimit <= o.price));
      placeFunded(m, a, s, side, q, quote, place);
    }
  }
}

/** Engine calls each active simulation second; featured seats act every four. */
export function runMarketAgents(m: AgentMarket, random: AgentRandom, place: AgentPlace): void {
  if (!m.agentSimulation || !['auction', 'morning', 'afternoon', 'closing'].includes(m.phase)) return;
  prepareAgentDay(m, random);
  // Auction no-cancel windows apply to NPCs too. Orders expire at the next
  // cancellable interval rather than being silently removed from the auction.
  if (canCancel(m)) {
    // Near quotes refresh quickly; farther quotes provide patient funded depth
    // for larger orders instead of disappearing with every small-order pulse.
    cancelNpcOrders(m, o => m.tickCount - o.createdTick > (o.actorId.startsWith('crowd') ? (Math.abs(o.price / stock(m, o.stockId).price - 1) >= .0015 ? 24 : 2) : 32));
  }
  // Inactive NPC orders have no remaining economic effect. Preserve the full
  // execution tape and every player order while keeping book scans bounded.
  m.orders = m.orders.filter(o => o.actorId === 'player' || active(o));
  const focusId = featuredCatalyst(m);
  // Replenish genuine patient depth separately from the fresh small intents.
  if (m.tickCount % 12 === 0) seedBackgroundBook(m, place);
  runBackground(m, random, place, focusId);
  if (m.tickCount % 4 === 0) for (const [id, plan] of Object.entries(m.agentSimulation.plans)) runSeat(m, actor(m, id), plan, random, place, focusId);
}

/** Validate persisted private strategy state without mutating or consuming RNG. */
export function validateAgentSimulation(value: unknown, m: Market): value is AgentSimulation {
  if (!value || typeof value !== 'object') return false;
  const v = value as AgentSimulation, integer = (n: unknown, min = 0) => Number.isSafeInteger(n) && (n as number) >= min;
  if (v.version !== 1 || !integer(v.preparedDay) || v.preparedDay > m.day || !v.plans || !v.crowdOpinions) return false;
  const hasIpoState = !!(m as Market & { ipoState?: unknown }).ipoState;
  const hasIssuer = m.actors.some(a => a.id === 'ipo-issuer');
  if (hasIssuer && !hasIpoState) return false;
  const expected = ['player', ...STYLES.map((_, i) => `ai${i}`), ...CROWD_IDS, ...(hasIssuer ? ['ipo-issuer'] : [])];
  if (m.actors.length !== expected.length || new Set(m.actors.map(a => a.id)).size !== expected.length
    || expected.some(id => !m.actors.some(a => a.id === id))) return false;
  if (m.orders.some(o => o.actorId === 'ipo-issuer' && active(o))) return false;
  if (Object.keys(v.plans).length !== 6 || Object.keys(v.crowdOpinions).length !== 3) return false;
  const stockIds = new Set(m.stocks.map(s => s.id));
  for (const [index, style] of STYLES.entries()) {
    const p = v.plans[`ai${index}`];
    if (!p || p.style !== style || !stockIds.has(p.mainId) || !stockIds.has(p.reserveId) || p.mainId === p.reserveId
      || !STATES.includes(p.state) || !integer(p.startedDay, 1) || p.startedDay > m.day
      || !integer(p.minimumDays, 1) || !integer(p.maximumDays, p.minimumDays) || p.maximumDays > 100
      || !integer(p.cooldownUntil) || !integer(p.budgetDay, 1) || p.budgetDay > m.day
      || !integer(p.dayBudget) || !integer(p.daySpent) || !integer(p.peakPrice, 1)
      || !Number.isSafeInteger(p.lastActionTick) || p.lastActionTick < -100 || p.lastActionTick > m.tickCount
      || !Array.isArray(p.dayBuyIds) || p.dayBuyIds.length > 2 || new Set(p.dayBuyIds).size !== p.dayBuyIds.length
      || p.dayBuyIds.some(id => id !== p.mainId && id !== p.reserveId)) return false;
  }
  for (const id of CROWD_IDS) {
    const opinions = v.crowdOpinions[id];
    if (!opinions || Object.keys(opinions).length !== stockIds.size) return false;
    for (const stockId of stockIds) {
      const o = opinions[stockId];
      if (!o || !Number.isFinite(o.bias) || Math.abs(o.bias) > .1 || !integer(o.inventory)) return false;
    }
  }
  return true;
}
