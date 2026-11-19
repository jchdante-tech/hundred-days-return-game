import type { ActionResult, IpoFactors, IpoOfferView } from '../shared/types.js';
import type { Market } from './engine.js';
export type { IpoFactors, IpoOfferView } from '../shared/types.js';

export type IpoDemand = 'weak' | 'steady' | 'strong';
export interface IpoOffer {
  id: string; stockId: string; companyIndex: number; announcementDay: number; listingDay: number;
  issuePrice: number; fair: number; totalShares: number; offeredShares: number;
  factors: IpoFactors; lotterySeed: number;
  status: 'scheduled' | 'offered' | 'listed' | 'skipped' | 'cancelled'; playerQuotaQuantity: number;
  cancelReason: 'game-ended' | 'no-demand' | null;
  subscriptions: Record<string, number>; allocations: Record<string, number>; eligibleQuantity: number;
}
export interface IpoState {
  version: 1; initializedDay: number; rngState: number; offers: IpoOffer[];
  generationSeed?: number;
}
export interface IpoFinance {
  /** Amounts are cents. availableCash must exclude existing IPO reservations. */
  availableCash: (actorId: string) => number;
  equity: (actorId: string) => number;
}
export interface IpoEvent {
  kind: 'announcement' | 'listing' | 'cancelled'; offerId: string; stockId: string; name: string;
  /** Public amounts are yuan, like ledger entries. Released cash is not income. */
  playerAllocatedQuantity: number; playerPaidAmount: number; playerReleasedAmount: number;
}
export interface IpoReleaseEvent { offerId: string; name: string; releasedAmount: number }
type IpoMarket = Market & { ipoState?: IpoState };
type IpoStock = Market['stocks'][number] & { listedDay: number; issuePrice: number; ipoFactors: IpoFactors };

export const IPO_ISSUER_ID = 'ipo-issuer';
const PLAYER = 'player';
const QUOTA_CAP = 200_000_000; // 200 万元, in cents.
const DEMAND_FACTOR: Record<IpoDemand, number> = { weak: .85, steady: 1, strong: 1.15 };
const COMPANIES = [
  { name: '澄芯微纳', sector: '半导体', concepts: ['芯片设计', '端侧算力'], description: '开发低功耗边缘计算芯片，客户导入和量产成本影响盈利。' },
  { name: '曜川光芯', sector: '光通信', concepts: ['光模块', '硅光'], description: '研发光电集成器件，需求来自数据中心升级，验证周期和良率仍有不确定性。' },
  { name: '衡岳智储', sector: '电力', concepts: ['储能', '电网投资'], description: '供应储能控制系统，项目交付和客户回款决定利润兑现。' },
  { name: '清珩材料', sector: '半导体', concepts: ['电子材料', '先进封装'], description: '生产高纯封装材料，客户认证、原料采购和产能利用率影响收益。' },
] as const;
const lots = (quantity: number) => Math.max(0, Math.floor(quantity / 100) * 100);
const boundedCash = (amount: number) => Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const actorEligible = (id: string) => id === PLAYER || /^ai[0-5]$/.test(id) || /^crowd[0-2]$/.test(id);

function makeState(seed: number, initializedDay: number): IpoState {
  const state: IpoState = { version: 1, initializedDay, rngState: (seed ^ 0x49504f31) >>> 0, offers: [] };
  const random = () => {
    state.rngState = (Math.imul(state.rngState, 1664525) + 1013904223) >>> 0;
    return state.rngState / 0x1_0000_0000;
  };
  const companies = [0, 1, 2, 3];
  let listingDay = (initializedDay === 1 ? 5 : initializedDay + 5) + Math.floor(random() * 5);
  for (let index = 0; index < 4; index++) {
    if (index) listingDay += 12 + Math.floor(random() * 9);
    const companyIndex = companies.splice(Math.floor(random() * companies.length), 1)[0];
    const demand: IpoDemand = (['weak', 'steady', 'strong'] as const)[Math.floor(random() * 3)];
    const peerPe = 20 + Math.floor(random() * 20);
    const issuePe = Math.round(peerPe * (.78 + random() * .62));
    const earningsCents = 45 + Math.floor(random() * 65);
    const issuePrice = earningsCents * issuePe;
    // Issuance valuation and demand are independent public inputs. A hot issue
    // can be expensive, and a quiet one can be cheap; neither writes a price path.
    const fair = Math.round(issuePrice / issuePe * peerPe * DEMAND_FACTOR[demand]);
    const totalShares = [20, 24, 30, 40][Math.floor(random() * 4)] * 1_000_000;
    const offeredShares = [400_000, 600_000, 800_000, 1_000_000][Math.floor(random() * 4)];
    const lotterySeed = Math.floor(random() * 0x1_0000_0000) >>> 0;
    state.offers.push({ id: `ipo-${index + 1}`, stockId: `s${13 + index}`, companyIndex,
      announcementDay: listingDay - 1, listingDay, issuePrice, fair, totalShares, offeredShares,
      factors: { demand, issuePe, peerPe, offeredShares, floatRatio: offeredShares / totalShares }, lotterySeed,
      status: 'scheduled', cancelReason: null, playerQuotaQuantity: 0, subscriptions: {}, allocations: {}, eligibleQuantity: 0 });
  }
  return state;
}

/** Private schedule only. Does not change any actor, quote, order, or market RNG. */
export function initIpo(m: IpoMarket): IpoState {
  return m.ipoState ??= makeState(m.seed, m.day);
}

export function ipoReservedCash(m: IpoMarket, actorId = PLAYER): number {
  return (m.ipoState?.offers ?? []).reduce((sum, offer) => sum + (offer.status === 'offered'
    ? (offer.subscriptions[actorId] ?? 0) * offer.issuePrice : 0), 0);
}

function canSubscribe(m: IpoMarket, offer: IpoOffer) {
  return offer.status === 'offered' && m.day === offer.announcementDay
    && m.phase !== 'night' && m.phase !== 'ended';
}

export function subscribeIpo(m: IpoMarket, offerId: string, quantity: number, finance: IpoFinance): ActionResult {
  const offer = m.ipoState?.offers.find(item => item.id === offerId);
  if (!offer || !canSubscribe(m, offer)) return { ok: false, message: '当前不在这只新股的申购时段。' };
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity % 100) return { ok: false, message: '申购数量须为 100 股的正整数倍。' };
  if (quantity > offer.playerQuotaQuantity) return { ok: false, message: '申购数量超过本次新股额度。' };
  const previous = offer.subscriptions[PLAYER] ?? 0;
  const available = Math.min(m.actors.find(actor => actor.id === PLAYER)?.cash ?? 0,
    boundedCash(finance.availableCash(PLAYER)) + previous * offer.issuePrice);
  if (quantity * offer.issuePrice > available) return { ok: false, message: '可用现金不足，不能占用委托或保证金冻结资金。' };
  if (quantity === previous) return { ok: true, message: '已提交相同数量的申购，不会重复冻结。' };
  offer.subscriptions[PLAYER] = quantity;
  m.revision++;
  return { ok: true, message: `已申请 ${quantity.toLocaleString('zh-CN')} 股，资金预留至下一交易日配售；收盘前可以撤销。` };
}

export function cancelIpo(m: IpoMarket, offerId: string): ActionResult {
  const offer = m.ipoState?.offers.find(item => item.id === offerId);
  if (!offer || !canSubscribe(m, offer)) return { ok: false, message: '收盘后申购已截止，等待下一交易日配售。' };
  if (!offer.subscriptions[PLAYER]) return { ok: false, message: '这只新股没有待撤销的申购。' };
  delete offer.subscriptions[PLAYER]; m.revision++;
  return { ok: true, message: '申购已撤销，预留现金已释放。' };
}

/** Engine-only terminal cleanup. Release reservations before calculating final repayment. */
export function releasePendingIpo(m: IpoMarket): IpoReleaseEvent[] {
  const released: IpoReleaseEvent[] = [];
  for (const offer of m.ipoState?.offers ?? []) {
    if (offer.status !== 'offered') continue;
    offer.status = 'cancelled'; offer.cancelReason = 'game-ended';
    released.push({ offerId: offer.id, name: COMPANIES[offer.companyIndex].name,
      releasedAmount: (offer.subscriptions[PLAYER] ?? 0) * offer.issuePrice / 100 });
  }
  if (released.length) m.revision++;
  return released;
}

function nextTradingDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  do { date.setUTCDate(date.getUTCDate() + 1); }
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6 || date.toISOString().slice(0, 10) === '2027-01-01');
  return date.toISOString().slice(0, 10);
}

function hasListingWindow(m: IpoMarket) {
  const remaining = (Date.parse(`${m.deadlineDate}T00:00:00Z`) - Date.parse(`${m.calendarDate}T00:00:00Z`)) / 86_400_000;
  return remaining > 2 && nextTradingDate(m.calendarDate) < m.deadlineDate;
}

function hashTicket(seed: number, actorId: string, ticket: number) {
  let hash = seed >>> 0;
  for (const character of actorId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  hash ^= Math.imul(ticket + 1, 0x9e3779b9);
  hash = Math.imul(hash ^ hash >>> 16, 0x85ebca6b);
  hash = Math.imul(hash ^ hash >>> 13, 0xc2b2ae35);
  return (hash ^ hash >>> 16) >>> 0;
}

function participates(m: IpoMarket, offer: IpoOffer, actorId: string): boolean {
  const { demand, issuePe, peerPe, floatRatio } = offer.factors;
  const peRatio = issuePe / peerPe, valueRatio = offer.fair / offer.issuePrice;
  const peers = m.stocks.filter(stock => stock.sector === COMPANIES[offer.companyIndex].sector);
  const sectorTrend = peers.reduce((sum, stock) => {
    const bars = (stock.dailyBars ?? []).filter(bar => bar.complete);
    const prior = bars[Math.max(0, bars.length - 4)]?.close ?? stock.previousClose;
    return sum + stock.previousClose / Math.max(1, prior) - 1;
  }, 0) / Math.max(1, peers.length);
  let qualifies = false, confidence = .7;
  switch (actorId) {
    // Before any listing-day prints, trend traders want strong demand at a
    // restrained issue valuation. Theme and value seats use different gates.
    case 'ai0': qualifies = demand === 'strong' && peRatio <= 1.08 && sectorTrend > -.015; confidence = .65; break;
    case 'ai1': qualifies = demand !== 'strong' && valueRatio >= 1.08; confidence = .8; break;
    case 'ai2': qualifies = demand === 'strong' && peRatio <= 1.27; confidence = .9; break;
    case 'ai3': qualifies = demand !== 'weak' && sectorTrend > .008 && peRatio <= 1.12; confidence = .7; break;
    case 'ai4': qualifies = peRatio <= .95 && floatRatio <= .04; confidence = .65; break;
    case 'ai5': qualifies = valueRatio >= 1.12 && peRatio <= 1; confidence = .85; break;
    case 'crowd0': qualifies = valueRatio >= .78 && peRatio <= 1.3; confidence = .9; break;
    case 'crowd1': qualifies = demand !== 'weak' && peRatio <= 1.15; confidence = .6; break;
    case 'crowd2': qualifies = valueRatio >= 1.03; confidence = .85; break;
  }
  // Stable public-state judgement, not a reroll on every API call. Some eligible
  // investors still wait for secondary-market evidence instead of subscribing.
  return qualifies && hashTicket(offer.lotterySeed, `${actorId}:participation`, 0) / 0x1_0000_0000 < confidence;
}

function npcSubscription(m: IpoMarket, offer: IpoOffer, actorId: string, finance: IpoFinance): number {
  if (!participates(m, offer, actorId)) return 0;
  const cash = Math.min(m.actors.find(actor => actor.id === actorId)?.cash ?? 0, boundedCash(finance.availableCash(actorId)));
  const preference = .65 + hashTicket(offer.lotterySeed, actorId, 0) / 0x1_0000_0000 * .7;
  const demand = { weak: .65, steady: 1, strong: 1.6 }[offer.factors.demand];
  const value = clamp(offer.fair / offer.issuePrice, .45, 1.6);
  const ratio = clamp((actorId.startsWith('crowd') ? .055 : .04) * preference * demand * value, .01, .18);
  const budget = Math.min(500_000_000, cash * ratio, boundedCash(finance.equity(actorId)) * .08);
  return lots(budget / offer.issuePrice);
}

function allot(offer: IpoOffer, subscriptions: Record<string, number>): Record<string, number> {
  const result = Object.fromEntries(Object.keys(subscriptions).map(actorId => [actorId, 0]));
  const total = Object.values(subscriptions).reduce((sum, quantity) => sum + quantity, 0);
  if (total <= offer.offeredShares) return { ...subscriptions };
  const tickets: { actorId: string; index: number; rank: number }[] = [];
  for (const [actorId, quantity] of Object.entries(subscriptions)) {
    for (let index = 0; index < quantity / 100; index++) tickets.push({ actorId, index, rank: hashTicket(offer.lotterySeed, actorId, index) });
  }
  tickets.sort((a, b) => a.rank - b.rank || a.actorId.localeCompare(b.actorId) || a.index - b.index);
  for (const ticket of tickets.slice(0, offer.offeredShares / 100)) result[ticket.actorId] += 100;
  return result;
}

function createStock(offer: IpoOffer): IpoStock {
  const company = COMPANIES[offer.companyIndex];
  return { id: offer.stockId, code: `虚${offer.stockId.slice(1).padStart(3, '0')}`, name: company.name,
    sector: company.sector, concepts: [...company.concepts], description: company.description,
    price: offer.issuePrice, previousClose: offer.issuePrice, open: 0, high: 0, low: 0, volume: 0, turnover: 0,
    fair: offer.fair, shares: offer.totalShares, pe: offer.factors.issuePe, financeEligible: false,
    lendTotal: 0, lendAvailable: 0, newsBias: 0, history: [], dailyBars: [], dailyHistoryStartDay: offer.listingDay,
    listedDay: offer.listingDay, issuePrice: offer.issuePrice, ipoFactors: { ...offer.factors } };
}

/** Only the opening boundary announces/settles. Return events for the engine's news and ledger. */
export function advanceIpo(m: IpoMarket, finance: IpoFinance): IpoEvent[] {
  if (!m.ipoState || m.phase !== 'auction' || m.phaseElapsed !== 0 || m.result) return [];
  const events: IpoEvent[] = [];
  for (const offer of m.ipoState.offers) {
    const company = COMPANIES[offer.companyIndex];
    if (offer.status === 'scheduled' && m.day === offer.announcementDay) {
      if (!hasListingWindow(m)) { offer.status = 'skipped'; continue; }
      const quota = Math.min(QUOTA_CAP, boundedCash(finance.equity(PLAYER)) * .1, boundedCash(finance.availableCash(PLAYER)));
      offer.playerQuotaQuantity = lots(quota / offer.issuePrice); offer.status = 'offered';
      events.push({ kind: 'announcement', offerId: offer.id, stockId: offer.stockId, name: company.name,
        playerAllocatedQuantity: 0, playerPaidAmount: 0, playerReleasedAmount: 0 });
    }
    if (offer.status !== 'offered' || m.day !== offer.listingDay) continue;
    if (m.stocks.some(stock => stock.id === offer.stockId)) throw new Error('IPO stock ID already exists before settlement');
    const requested = offer.subscriptions[PLAYER] ?? 0;
    const eligible: Record<string, number> = {};
    if (requested) eligible[PLAYER] = Math.min(requested, lots(Math.min(m.actors.find(actor => actor.id === PLAYER)?.cash ?? 0,
      boundedCash(finance.availableCash(PLAYER)) + requested * offer.issuePrice) / offer.issuePrice));
    for (const actor of m.actors) if (actor.id !== PLAYER && actorEligible(actor.id)) {
      const quantity = npcSubscription(m, offer, actor.id, finance);
      if (quantity) { offer.subscriptions[actor.id] = quantity; eligible[actor.id] = quantity; }
    }
    const eligibleQuantity = Object.values(eligible).reduce((sum, quantity) => sum + quantity, 0);
    if (eligibleQuantity === 0) {
      offer.status = 'cancelled'; offer.cancelReason = 'no-demand';
      events.push({ kind: 'cancelled', offerId: offer.id, stockId: offer.stockId, name: company.name,
        playerAllocatedQuantity: 0, playerPaidAmount: 0, playerReleasedAmount: requested * offer.issuePrice / 100 });
      continue;
    }
    const allocations = allot(offer, eligible);
    // Issuer keeps all unsold shares. It never supplies secondary-market orders.
    let issuer = m.actors.find(actor => actor.id === IPO_ISSUER_ID);
    if (!issuer) { issuer = { id: IPO_ISSUER_ID, name: '新股发行账户', cash: 0, positions: {} }; m.actors.push(issuer); }
    const issuedQuantity = Object.values(allocations).reduce((sum, quantity) => sum + quantity, 0);
    issuer.positions[offer.stockId] = { quantity: offer.totalShares - issuedQuantity, today: 0, financed: 0, cost: 0 };
    for (const [actorId, quantity] of Object.entries(allocations)) {
      if (!quantity) continue;
      const actor = m.actors.find(item => item.id === actorId)!;
      const paid = quantity * offer.issuePrice;
      if (paid > actor.cash) throw new Error('IPO allocation exceeds actor cash');
      actor.cash -= paid; issuer.cash += paid;
      // Primary allotments are available on listing day. Normal fills still
      // increase position.today in the matching engine and remain T+1.
      actor.positions[offer.stockId] = { quantity, today: 0, financed: 0, cost: paid };
    }
    offer.allocations = allocations; offer.eligibleQuantity = eligibleQuantity;
    offer.status = 'listed';
    m.stocks.push(createStock(offer));
    const playerAllocatedQuantity = allocations[PLAYER] ?? 0;
    events.push({ kind: 'listing', offerId: offer.id, stockId: offer.stockId, name: company.name,
      playerAllocatedQuantity, playerPaidAmount: playerAllocatedQuantity * offer.issuePrice / 100,
      playerReleasedAmount: (requested - playerAllocatedQuantity) * offer.issuePrice / 100 });
  }
  return events;
}

export function ipoForView(m: IpoMarket, _finance?: IpoFinance): IpoOfferView[] {
  return (m.ipoState?.offers ?? []).filter(offer => ['offered', 'listed', 'cancelled'].includes(offer.status)).map<IpoOfferView>(offer => {
    const company = COMPANIES[offer.companyIndex], listed = offer.status === 'listed', cancelled = offer.status === 'cancelled';
    const finished = listed || cancelled;
    const subscribedQuantity = offer.subscriptions[PLAYER] ?? 0, allocatedQuantity = offer.allocations[PLAYER] ?? 0;
    return { id: offer.id, stockId: offer.stockId, name: company.name, sector: company.sector,
      description: company.description, concepts: [...company.concepts], announcementDay: offer.announcementDay,
      listingDay: offer.listingDay, status: cancelled ? 'cancelled' : listed ? 'listed' : canSubscribe(m, offer) ? 'subscribing' : 'awaiting-listing',
      ...(cancelled ? { cancelReason: offer.cancelReason! } : {}),
      issuePrice: offer.issuePrice / 100, totalShares: offer.totalShares,
      ...offer.factors, quotaQuantity: offer.playerQuotaQuantity, quotaAmount: offer.playerQuotaQuantity * offer.issuePrice / 100,
      subscribedQuantity, reservedAmount: finished ? 0 : subscribedQuantity * offer.issuePrice / 100,
      allocatedQuantity: finished ? allocatedQuantity : null, allocatedAmount: finished ? allocatedQuantity * offer.issuePrice / 100 : null,
      refundAmount: finished ? (subscribedQuantity - allocatedQuantity) * offer.issuePrice / 100 : null,
      subscriptionRate: listed ? offer.eligibleQuantity / offer.offeredShares : offer.cancelReason === 'no-demand' ? 0 : null,
      issuedQuantity: finished ? Object.values(offer.allocations).reduce((sum, quantity) => sum + quantity, 0) : null };
  }).reverse();
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** Day-two continuation replaces only an unpublished, unreserved private schedule. */
export function randomizeOpeningIpo(m: Market, seed: number): void {
  const previous = m.ipoState;
  if (!previous || m.day !== 2 || !m.openingScenario || previous.generationSeed !== undefined
    || previous.offers.some(offer => offer.status !== 'scheduled' || Object.keys(offer.subscriptions).length)) return;
  m.ipoState = { ...makeState(seed, previous.initializedDay), generationSeed: seed };
}

const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const quantity = (value: unknown): value is number => nonnegative(value) && value % 100 === 0;
const sameFactors = (value: unknown, expected: IpoFactors) => hasKeys(value, Object.keys(expected))
  && Object.keys(expected).every(key => value[key] === expected[key as keyof IpoFactors]);

/** Restore validation includes immutable schedule, issuer custody, and offer/account identities. */
export function validateIpoState(value: unknown, m: Market): value is IpoState {
  const seeded = !!value && typeof value === 'object' && Object.hasOwn(value, 'generationSeed');
  if (!hasKeys(value, ['version', 'initializedDay', 'rngState', 'offers', ...(seeded ? ['generationSeed'] : [])]) || value.version !== 1
    || !nonnegative(value.initializedDay) || value.initializedDay < 1 || value.initializedDay > m.day
    || !Array.isArray(value.offers) || value.offers.length !== 4) return false;
  const state = value as unknown as IpoState;
  if (seeded && (!m.openingScenario || m.day < 2 || state.generationSeed !== m.openingScenario.continuationSeed)) return false;
  const expected = makeState(state.generationSeed ?? m.seed, state.initializedDay);
  if (state.rngState !== expected.rngState) return false;
  const actorIds = new Set(m.actors.map(actor => actor.id));
  let issuerProceeds = 0, listingCount = 0;
  for (let index = 0; index < state.offers.length; index++) {
    const raw = state.offers[index], template = expected.offers[index];
    if (!hasKeys(raw, Object.keys(template))) return false;
    const offer = raw as unknown as IpoOffer;
    for (const key of ['id', 'stockId', 'companyIndex', 'announcementDay', 'listingDay', 'issuePrice', 'fair', 'totalShares', 'offeredShares', 'lotterySeed'] as const) {
      if (offer[key] !== template[key]) return false;
    }
    if (!sameFactors(offer.factors, template.factors)) return false;
    if (!['scheduled', 'offered', 'listed', 'skipped', 'cancelled'].includes(offer.status)
      || !quantity(offer.playerQuotaQuantity) || offer.playerQuotaQuantity * offer.issuePrice > QUOTA_CAP
      || !quantity(offer.eligibleQuantity)) return false;
    if (offer.status === 'cancelled' ? !['game-ended', 'no-demand'].includes(offer.cancelReason ?? '') : offer.cancelReason !== null) return false;
    for (const record of [offer.subscriptions, offer.allocations]) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length > 10
        || Object.entries(record).some(([id, value]) => !actorIds.has(id) || !actorEligible(id) || !quantity(value))) return false;
    }
    if ((offer.subscriptions[PLAYER] ?? 0) > offer.playerQuotaQuantity
      || Object.entries(offer.allocations).some(([id, q]) => q > (offer.subscriptions[id] ?? 0))) return false;
    const listedStock = m.stocks.find(stock => stock.id === offer.stockId) as IpoStock | undefined;
    if (offer.status === 'scheduled' || offer.status === 'skipped') {
      if (offer.playerQuotaQuantity !== 0 || Object.keys(offer.subscriptions).length || Object.keys(offer.allocations).length
        || offer.eligibleQuantity || listedStock || offer.status === 'skipped' && m.day < offer.announcementDay
        || offer.status === 'scheduled' && m.day > offer.announcementDay) return false;
    } else if (offer.status === 'cancelled') {
      const validReason = offer.cancelReason === 'game-ended' ? m.phase === 'ended' && !!m.result : m.day >= offer.listingDay;
      if (!validReason || m.day < offer.announcementDay || listedStock || offer.eligibleQuantity
        || Object.keys(offer.allocations).length || Object.keys(offer.subscriptions).some(id => id !== PLAYER)) return false;
    } else if (offer.status === 'offered') {
      if (m.day < offer.announcementDay || m.day > offer.listingDay || listedStock || offer.eligibleQuantity
        || Object.keys(offer.allocations).length || Object.keys(offer.subscriptions).some(id => id !== PLAYER)) return false;
    } else {
      listingCount++;
      const allocated = Object.values(offer.allocations).reduce((sum, q) => sum + q, 0);
      const requested = Object.values(offer.subscriptions).reduce((sum, q) => sum + q, 0);
      if (m.day < offer.listingDay || !listedStock || allocated > offer.offeredShares || allocated > offer.eligibleQuantity
        || offer.eligibleQuantity > requested || allocated !== Math.min(offer.eligibleQuantity, offer.offeredShares)
        || listedStock.listedDay !== offer.listingDay || listedStock.issuePrice !== offer.issuePrice
        || listedStock.shares !== offer.totalShares || listedStock.fair !== offer.fair
        || !sameFactors(listedStock.ipoFactors, offer.factors)) return false;
      const issuer = m.actors.find(actor => actor.id === IPO_ISSUER_ID);
      if (!issuer || issuer.positions[offer.stockId]?.quantity !== offer.totalShares - allocated
        || issuer.positions[offer.stockId]?.today !== 0 || issuer.positions[offer.stockId]?.financed !== 0
        || issuer.positions[offer.stockId]?.cost !== 0
        || m.actors.reduce((sum, actor) => sum + (actor.positions[offer.stockId]?.quantity ?? 0), 0) !== offer.totalShares) return false;
      if ((listedStock.dailyBars ?? []).some(bar => bar.day < offer.listingDay || bar.origin === 'background')) return false;
      issuerProceeds += allocated * offer.issuePrice;
    }
  }
  const issuers = m.actors.filter(actor => actor.id === IPO_ISSUER_ID);
  if (m.stocks.filter(stock => stock.listedDay !== undefined).length !== listingCount) return false;
  return listingCount === 0 ? issuers.length === 0 : issuers.length === 1 && issuers[0].cash === issuerProceeds
    && Object.keys(issuers[0].positions).length === listingCount
    && !m.orders.some(order => order.actorId === IPO_ISSUER_ID)
    && !m.trades.some(trade => trade.buyerId === IPO_ISSUER_ID || trade.sellerId === IPO_ISSUER_ID);
}
