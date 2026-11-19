import type {
  ActionResult, MarginOpenInput, MarginCloseInput, MarginAddInput, MarginView, CollateralTransferInput, CreditView, MarketView, OrderInput, OrderSide, OrderCancelReason, OrderExecutionView, Phase, NewsView, NewsImpact, LedgerView, LeaderboardView, DailyBar, PostCloseReport, IpoFactors,
} from '../shared/types.js';
import { BASE_STOCKS, LEGACY_BASE_STOCK_COUNT, STOCK_UNIVERSE_VERSION, baseStockById, type BaseStockDefinition } from './stock-catalog.js';
import { GAME_START_DATE, OPENING_HISTORY_LENGTH, OPENING_HISTORY_VERSION, generateOpeningHistory, openingHistoryDates } from './opening-history.js';
import { buildPostCloseReport, validPostCloseReport } from './post-close.js';
import { initializeAgents, initializeListedStock, prepareAgentDay, seedBackgroundBook, runMarketAgents, validateAgentSimulation, type AgentSimulation } from './market-agents.js';
import { initNewsArcs, advanceNewsArcs, validateStoryState, type StoryState } from './news-arcs.js';
import { limitPrices } from '../shared/market-rules.js';
import { buildLimitBoard } from './limit-board.js';
import { getChipSupply } from './chips.js';
import { OPENING_SCENARIO } from '../shared/opening-scenario.js';
import { OPENING_SCENARIO_SEED, installOpeningScenario, recordOpeningFill, advanceOpeningScenario, continueOpeningMarket, isOpeningScenarioStock, openingScenarioForView, validateOpeningScenario, type OpeningScenarioState } from './opening-scenario.js';
import { randomizeOpeningIpo, initIpo, advanceIpo, ipoReservedCash, subscribeIpo, cancelIpo, ipoForView, validateIpoState, releasePendingIpo, type IpoState } from './ipo.js';

type Position = { quantity: number; today: number; financed: number; cost: number };
type ShortPosition = { quantity: number; today: number; proceeds: number; margin: number };
type Actor = { id: string; name: string; cash: number; positions: Record<string, Position> };
type Stock = {
  id: string; code: string; name: string; sector: string; concepts: string[]; description: string;
  price: number; previousClose: number; open: number; high: number; low: number; volume: number;
  turnover: number; fair: number; shares: number; pe: number; financeEligible: boolean;
  lendTotal: number; lendAvailable: number; newsBias: number;
  history: { time: string; price: number; volume: number }[];
  // Optional only for version-1 saves created before daily recording existed.
  // Stored prices and turnover use cents, like the rest of the engine.
  dailyBars?: DailyBar[]; dailyHistoryStartDay?: number; openingHistoryVersion?: number;
  coverageStartDay?: number;
  listedDay?: number; issuePrice?: number; ipoFactors?: IpoFactors;
};
type Order = {
  id: string; actorId: string; stockId: string; side: OrderSide; quantity: number; remaining: number;
  price: number; status: 'open' | 'filled' | 'cancelled' | 'partial'; time: string; sequence: number;
  createdTick: number; frozenCash: number; restrictedClaim: number; forced?: boolean;
  marginAccountId?: string; marginPositionId?: string; marginReservePrice?: number;
  day?: number; cancelReason?: OrderCancelReason;
  // Immutable submission receipt; monetary values and prices are stored in cents.
  // Missing on old orders, auction submissions and non-ordinary order sides.
  execution?: Omit<OrderExecutionView, 'averagePrice'>;
};
type Trade = {
  id: string; stockId: string; price: number; quantity: number; time: string; day: number;
  buyerId: string; sellerId: string; buyerName: string; sellerName: string; playerSide?: OrderSide;
};
// Version-1 saves may predate explicit impact metadata; reading a view never rewrites them.
type StoredNews = Omit<NewsView, 'impacts'> & {
  impacts?: NewsImpact[]; eventId?: string; eventDay?: number; templateHeadline?: string;
};
type NewsTemplate = Pick<NewsView, 'headline' | 'body' | 'impacts'> & { followUp: string };
type NewsEventState = { id: string; day: number; round: number; applied: boolean };
type MarginPosition = { id: string; stockId: string; direction: 'long' | 'short'; leverage: 1 | 2 | 3;
  quantity: number; today: number; cost: number; loan: number; proceeds: number; principal: number };
type MarginAccount = { id: string; mode: 'isolated' | 'cross'; cash: number; interest: number; interestRemainder: number;
  contributedPrincipal: number; positions: MarginPosition[] };
export interface Market {
  formatVersion: 1; seed: number; rngState: number; revision: number; sequence: number;
  phase: Phase; phaseElapsed: number; tickCount: number; day: number; elapsedDays: number;
  calendarDate: string; deadlineDate: string; paused: boolean; speed: 1 | 4 | 12;
  stocks: Stock[]; actors: Actor[]; orders: Order[]; trades: Trade[];
  shorts: Record<string, ShortPosition>; principal: number; interest: number; interestRemainder: number;
  brokerCash: number; news: StoredNews[]; ledger: LedgerView[]; leaderboard: LeaderboardView[];
  result: null | 'won' | 'default'; marginCallDay: number | null;
  // Optional for older saved contracts. Values are cents; paid records cash received by the external creditor.
  challenge?: { target: number; paid: number; startingCapital: number };
  // Sub-ledger of the player's existing cash and holdings; never additional assets.
  creditAccount?: { version: 1; cash: number; positions: Record<string, { quantity: number; today: number }>; migrationNotice?: string };
  marginState?: { version: 1; accounts: MarginAccount[] };
  knownNews?: string[];
  newsEvents?: Record<string, NewsEventState>;
  // Completed-day public summary, in yuan. Kept before the full AI executions are pruned.
  postClose?: PostCloseReport;
  postCloseHistory?: PostCloseReport[];
  // Missing on existing saves: switch rules only at the next trading-day boundary.
  simulationVersion?: 1 | 2;
  // Absent on old saves: expand only at the next opening, never in the middle of a session.
  stockUniverseVersion?: 1;
  agentSimulation?: AgentSimulation;
  storyState?: StoryState;
  ipoState?: IpoState;
  openingScenario?: OpeningScenarioState;
}

const PLAYER = 'player';
export const CREDIT_UNLOCK_DAY = 20;
const RATE = 0.085;
const BORROW_RATE = 0.105;
// Fictional broker contract terms, not a reproduction of every real broker's rules.
const FINANCE_LIMIT = 200_000_000; // cents; aggregate outstanding + pending principal
const SHORT_LIMIT = 50_000_000; // cents; marked-to-market exposure + pending orders
const FINANCE_MARGIN = 1;
const SHORT_MARGIN = 1;
const NEWS_BIAS_CAP = .08;
const NEWS_DECAY_PER_SECOND = Math.pow(.5, 1 / 45);
// Different seats can discount the same public news or take the other side.
// This changes orders only; it does not require the market to reverse.
const AI_NEWS_RESPONSE = [.75, -.45, 1, .15, .4, -.15];
const PHASES: Phase[] = ['auction', 'morning', 'lunch', 'afternoon', 'closing', 'night'];
const DURATIONS: Record<Phase, number> = { auction: 45, morning: 180, lunch: 30, afternoon: 180, closing: 15, night: 150, ended: 1 };
const LABELS: Record<Phase, string> = { auction: '开盘集合竞价', morning: '上午连续竞价', lunch: '午间休市', afternoon: '下午连续竞价', closing: '收盘集合竞价', night: '盘后复盘', ended: '百日结算' };
const NEWS_TEMPLATES: Record<string, [NewsTemplate, NewsTemplate]> = {
  半导体: [
    {
      headline: '本土产线启动新一轮设备验证',
      body: '两家晶圆厂增加国产设备测试批次，配套材料也进入验证名单。正式采购量还没定，先看后续订单。',
      followUp: '本轮又有一批产线公布了新的设备、材料验证名单，采购规模尚未确定。',
      impacts: [{ sector: '半导体', direction: 'positive', reason: '设备、材料的订单预期改善，带动产业链情绪；进入验证还不等于拿到订单。' }],
    },
    {
      headline: '晶圆厂调整设备验收节奏',
      body: '部分晶圆厂将设备验收推后一个月，相关回款也可能顺延。设备、材料公司受到的影响更直接。',
      followUp: '另一批设备的验收排期也被推后，新增项目的回款预期随之延迟。',
      impacts: [{ sector: '半导体', direction: 'negative', reason: '验收和回款推迟，资金对产业链的短期预期降温；直接受影响的主要是设备、材料环节。' }],
    },
  ],
  光通信: [
    {
      headline: '算力园区启动光互联升级招标',
      body: '新算力园区开始采购高速光模块和连接器，预计分批招标。谁能拿到订单，还要看报价和交付能力。',
      followUp: '另一座算力园区公布了独立的采购批次，光模块、连接器企业将参加新一轮投标。',
      impacts: [{ sector: '光通信', direction: 'positive', reason: '光模块、连接器及配套光纤的采购机会增加；能否转成收入还要看中标和交付。' }],
    },
    {
      headline: '海外客户推迟部分光模块交付',
      body: '几家海外客户调整排期，部分光模块交付推迟。订单暂未取消，但收入确认和回款可能后移。',
      followUp: '又有客户推迟了新的交付批次，新增延迟可能进一步影响当期收入和回款。',
      impacts: [{ sector: '光通信', direction: 'negative', reason: '光模块的短期收入、回款预期承压，拖累板块情绪；光纤和连接器未必受到同等影响。' }],
    },
  ],
  电力: [
    {
      headline: '区域负荷上升，电网更新项目提速',
      body: '多地工业用电负荷上升，一批输配电更新项目启动。发电量和设备订单有望改善，成本与来水仍会影响利润。',
      followUp: '最新用电数据继续走高，另一批电网更新项目开始招标，形成新的需求线索。',
      impacts: [{ sector: '电力', direction: 'positive', reason: '用电增长支撑发电需求，更新项目增加设备订单机会；各公司的成本、来水和项目进度仍有差异。' }],
    },
    {
      headline: '用电预期转弱，能源项目排期放缓',
      body: '工业用电预期回落，部分输配电和储能项目调整建设排期。发电、设备环节的短期需求预期一起降温。',
      followUp: '新一轮需求评估再次下调，另外一批输配电、储能项目延后建设排期。',
      impacts: [{ sector: '电力', direction: 'negative', reason: '用电需求与项目进度同时转弱，发电和设备链条的短期预期承压；影响程度取决于各公司业务。' }],
    },
  ],
};
const NEWS_SECTORS = Object.keys(NEWS_TEMPLATES);
const LEGACY_NEWS_IMPACTS = new Map<string, NewsImpact[]>([
  ...Object.values(NEWS_TEMPLATES).flat().map(template => [template.headline, template.impacts] as [string, NewsImpact[]]),
  ['来水与燃料成本出现分化', [{
    sector: '电力', direction: 'negative',
    reason: '来水走弱、部分火电成本上升，板块短线情绪偏弱；电网和储能并非直接利空，个股影响有差异。',
  }]],
]);

function newsForView(news: StoredNews): NewsView {
  const source = Array.isArray(news.impacts) ? news.impacts
    : LEGACY_NEWS_IMPACTS.get(news.templateHeadline ?? canonicalNewsHeadline(news.headline)) ?? [];
  const impacts = source.filter(impact => impact && BASE_STOCKS.some(s => s.sector === impact.sector)
    && (impact.direction === 'positive' || impact.direction === 'negative') && typeof impact.reason === 'string')
    .map(impact => ({ ...impact }));
  return { id: news.id, time: news.time, headline: news.headline, body: news.body,
    sector: news.sector, sentiment: news.sentiment, impacts,
    ...(Number.isSafeInteger(news.day) && news.day! > 0 ? { day: news.day } : {}),
    ...(news.storyId ? { storyId: news.storyId, stage: news.stage } : {}),
    ...(news.stockIds ? { stockIds: [...news.stockIds] } : {}) };
}

function canonicalNewsHeadline(headline: string) {
  return headline.replace(/^(消息回顾｜|第\d+轮新增进展｜)/, '');
}
function rememberKnownNews(m: Market) {
  if (m.newsEvents) return;
  m.newsEvents = {};
  for (const news of m.news) {
    const headline = news.templateHeadline ?? canonicalNewsHeadline(news.headline);
    if (!LEGACY_NEWS_IMPACTS.has(headline) || m.newsEvents[headline]) continue;
    m.newsEvents[headline] = {
      id: news.eventId ?? `known:${headline}`, day: news.eventDay ?? m.day,
      round: Number(news.headline.match(/^第(\d+)轮新增进展｜/)?.[1] ?? 1), applied: true,
    };
  }
  for (const headline of m.knownNews ?? []) if (!m.newsEvents[headline] && LEGACY_NEWS_IMPACTS.has(headline)) {
    m.newsEvents[headline] = { id: `known:${headline}`, day: m.day, round: 1, applied: true };
  }
  // Old saves used to permanently compound this private valuation on every headline.
  // Restore only the AI's fixed earnings reference, never price, cash or inventory.
  m.stocks.forEach(s => {
    const definition = baseStockById(s.id);
    if (definition) s.fair = cents(definition.price);
    s.newsBias = Math.max(-NEWS_BIAS_CAP, Math.min(NEWS_BIAS_CAP, s.newsBias));
  });
}
function digestNews(m: Market, seconds = 1) {
  const decay = Math.pow(NEWS_DECAY_PER_SECOND, seconds);
  for (const s of m.stocks) {
    s.newsBias *= decay;
    if (Math.abs(s.newsBias) < .00001) s.newsBias = 0;
  }
}

const cents = (value: number) => Math.round(value * 100);
const yuan = (value: number) => value / 100;
const ok = (message: string): ActionResult => ({ ok: true, message });
const fail = (message: string): ActionResult => ({ ok: false, message });
const active = (o: Order) => o.remaining > 0 && (o.status === 'open' || o.status === 'partial');
const buySide = (side: OrderSide) => ['buy', 'finance', 'cover', 'marginBuy', 'marginCover'].includes(side);
const player = (m: Market) => m.actors[0];
const stockBy = (m: Market, id: string) => m.stocks.find(s => s.id === id)!;
function ensureDailyHistory(m: Market) {
  for (const s of m.stocks) {
    if (s.dailyBars === undefined) {
      s.dailyBars = []; s.dailyHistoryStartDay = m.day;
      // Older snapshots retain all of today's executions, but seeded high/low
      // with the previous close. Recover actual extremes without inventing past days.
      const trades = m.trades.filter(t => t.stockId === s.id && t.day === m.day);
      if (trades.length && trades.reduce((sum, t) => sum + t.quantity, 0) === s.volume) {
        s.open = trades[0].price;
        s.high = trades.reduce((high, t) => Math.max(high, t.price), s.open);
        s.low = trades.reduce((low, t) => Math.min(low, t.price), s.open);
      } else if (!s.volume) s.open = s.high = s.low = 0;
      if (m.phase === 'night') {
        const bar = currentDailyBar(m, s);
        if (bar) s.dailyBars.push(bar);
      }
    }
    if (!s.listedDay && (s.openingHistoryVersion !== OPENING_HISTORY_VERSION
      || !s.dailyBars.some(bar => bar.origin === 'background'))) {
      // Recalibrate only the fictional pregame world. Preserve its final close
      // so the first played day keeps its price/return basis, even in old saves.
      const priorAnchor = s.dailyBars.find(bar => bar.origin === 'background' && bar.day === 0)?.close;
      const anchor = priorAnchor ?? (m.day === 1 ? s.previousClose : cents(baseStockById(s.id)?.price ?? s.fair / 100));
      const recorded = s.dailyBars.filter(bar => bar.origin !== 'background');
      s.dailyBars = [...generateOpeningHistory(m.seed, s.id, s.sector, anchor), ...recorded];
      s.openingHistoryVersion = OPENING_HISTORY_VERSION;
    }
  }
}
function currentDailyBar(m: Market, s: Stock): DailyBar | null {
  if (!s.volume || !s.open || m.phase === 'ended') return null;
  return { day: m.day, date: m.calendarDate, open: s.open, high: s.high, low: s.low,
    close: s.price, volume: s.volume, turnover: s.turnover, complete: m.phase === 'night' };
}
function finalizeDailyBars(m: Market) {
  ensureDailyHistory(m);
  for (const s of m.stocks) {
    if (s.dailyBars!.some(bar => bar.day === m.day)) continue;
    const bar = currentDailyBar(m, s);
    if (bar) s.dailyBars!.push({ ...bar, complete: true });
  }
}
function dailyBarsForView(m: Market, s: Stock): DailyBar[] {
  const bars = [...s.dailyBars!];
  const current = currentDailyBar(m, s);
  if (current && !bars.some(bar => bar.day === m.day)) bars.push(current);
  return bars.map(bar => ({ ...bar, open: yuan(bar.open), high: yuan(bar.high),
    low: yuan(bar.low), close: yuan(bar.close), turnover: yuan(bar.turnover) }));
}
function position(a: Actor, id: string): Position {
  return a.positions[id] ??= { quantity: 0, today: 0, financed: 0, cost: 0 };
}
function shortPosition(m: Market, id: string): ShortPosition {
  return m.shorts[id] ??= { quantity: 0, today: 0, proceeds: 0, margin: 0 };
}
function random(m: Market) {
  let v = m.rngState | 0;
  v ^= v << 13; v ^= v >>> 17; v ^= v << 5;
  m.rngState = v >>> 0;
  return m.rngState / 4294967296;
}
function id(m: Market, prefix: string) { return `${prefix}${++m.sequence}`; }
function limits(s: Stock, day: number) { return limitPrices(s, day); }
function clock(m: Market): string {
  const fraction = Math.min(1, m.phaseElapsed / DURATIONS[m.phase]);
  const ranges: Partial<Record<Phase, [number, number]>> = { auction: [555, 565], morning: [570, 690], lunch: [690, 780], afternoon: [780, 897], closing: [897, 900], night: [1080, 1260], ended: [1260, 1260] };
  const [from, to] = ranges[m.phase]!;
  const mins = Math.floor(from + (to - from) * fraction);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
function isTradingDate(calendarDate: string) {
  const weekday = new Date(`${calendarDate}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && calendarDate !== '2027-01-01';
}
function followingTradingDate(calendarDate: string) {
  const date = new Date(`${calendarDate}T00:00:00Z`);
  do { date.setUTCDate(date.getUTCDate() + 1); } while (!isTradingDate(date.toISOString().slice(0, 10)));
  return date.toISOString().slice(0, 10);
}
function ledger(m: Market, kind: string, description: string, amount = 0) {
  m.ledger.unshift({ id: id(m, 'l'), day: m.day, time: clock(m), kind, description, amount: yuan(amount) || 0 });
  if (m.ledger.length > 300) m.ledger.length = 300;
}
export function ensureCreditAccount(m: Market): void {
  if (m.creditAccount !== undefined) return;
  const hasCredit = m.principal > 0 || m.interest > 0 || Object.values(m.shorts).some(p => p.quantity > 0)
    || Object.values(player(m).positions).some(p => p.financed > 0)
    || m.orders.some(o => active(o) && o.actorId === PLAYER && ['finance', 'short', 'cover'].includes(o.side));
  const account: NonNullable<Market['creditAccount']> = { version: 1, cash: 0, positions: {} };
  if (hasCredit) {
    const reserved = m.orders.filter(o => active(o) && o.actorId === PLAYER && o.side === 'buy')
      .reduce((sum, o) => sum + o.frozenCash, 0) + ipoReservedCash(m);
    account.cash = Math.max(0, player(m).cash - marginCash(m) - reserved);
    for (const [stockId, p] of Object.entries(player(m).positions)) if (p.quantity) {
      const mp = marginShares(m, stockId);
      account.positions[stockId] = { quantity: p.quantity - mp.quantity, today: p.today - mp.today };
    }
    for (const o of m.orders) if (active(o) && o.actorId === PLAYER && o.side === 'sell') o.side = 'creditSell';
    account.migrationNotice = '旧存档已有信用负债：原担保现金与持仓已转入信用账户，未改变总资产和负债。普通买单及打新预留仍留在普通账户；可在满足担保要求后取回资产。';
  }
  m.creditAccount = account;
}
function creditLedger(m: Market) { ensureCreditAccount(m); return m.creditAccount!; }
function creditPosition(m: Market, stockId: string) {
  const a = creditLedger(m);
  return a.positions[stockId] ??= { quantity: 0, today: 0 };
}
function frozenQuantity(m: Market, actorId: string, stockId: string, credit = false) {
  return m.orders.filter(o => active(o) && o.actorId === actorId && o.stockId === stockId
    && o.side === (credit ? 'creditSell' : 'sell')).reduce((n, o) => n + o.remaining, 0);
}
function frozenCash(m: Market, actorId = PLAYER) {
  return m.orders.filter(o => active(o) && o.actorId === actorId).reduce((n, o) => n + o.frozenCash, 0);
}
function liquidCash(m: Market) {
  const pending = m.orders.filter(o => active(o) && o.actorId === PLAYER && o.side === 'cover')
    .reduce((sum, o) => sum + o.frozenCash, 0);
  return Math.max(0, creditLedger(m).cash - pending);
}
function ordinaryAvailable(m: Market, stockId: string) {
  const p = position(player(m), stockId), cp = creditPosition(m, stockId);
  return Math.max(0, p.quantity - cp.quantity - marginShares(m, stockId).quantity - (p.today - cp.today - marginShares(m, stockId).today) - frozenQuantity(m, PLAYER, stockId));
}
function creditAvailable(m: Market, stockId: string) {
  const cp = creditPosition(m, stockId);
  return Math.max(0, cp.quantity - cp.today - frozenQuantity(m, PLAYER, stockId, true));
}
function collateralRatio(m: Market, s: Stock) {
  if (s.listedDay !== undefined) return m.day - s.listedDay < 5 ? 0 : .5;
  return .6;
}
type CreditProjection = { stockId: string; price: number; order?: Order; quantity?: number };
function creditAccount(m: Market, projection?: CreditProjection) {
  const p = player(m);
  const markedPrice = (s: Stock) => s.id === projection?.stockId ? projection.price : s.price;
  const filled = projection?.quantity ?? 0;
  const financedValue = projection?.order?.side === 'finance' ? projection.price * filled : 0;
  const shortedValue = projection?.order?.side === 'short' ? projection.price * filled : 0;
  const collateralPositions = m.stocks.map(s => {
    const pos = p.positions[s.id];
    // Borrowed purchases cannot create another layer of borrowing capacity.
    // Credit sales keep assets inside this account; proceeds replace shares on fill.
    const quantity = Math.max(0, creditPosition(m, s.id).quantity - (pos?.financed ?? 0));
    const marketValue = quantity * markedPrice(s), ratio = collateralRatio(m, s);
    return { stockId: s.id, quantity, marketValue, ratio, collateralValue: Math.floor(marketValue * ratio) };
  }).filter(row => row.quantity > 0);
  const cash = liquidCash(m);
  const stockValue = collateralPositions.reduce((sum, row) => sum + row.collateralValue, 0);
  const orders = m.orders.filter(o => active(o) && o.actorId === PLAYER);
  const remaining = (o: Order) => o === projection?.order ? o.remaining - filled : o.remaining;
  const financePending = orders.filter(o => o.side === 'finance').reduce((sum, o) => sum + o.price * remaining(o), 0);
  // A sell may execute above its limit: reserve using today's highest allowed price.
  const shortPending = orders.filter(o => o.side === 'short')
    .reduce((sum, o) => sum + limits(stockBy(m, o.stockId), m.day).high * remaining(o), 0);
  const shortUsed = m.stocks.reduce((sum, s) => sum + (m.shorts[s.id]?.quantity ?? 0) * markedPrice(s), 0) + shortedValue;
  const financeUsed = m.principal + financedValue;
  const occupied = Math.ceil(financeUsed * FINANCE_MARGIN + shortUsed * SHORT_MARGIN) + m.interest;
  const pending = Math.ceil(financePending * FINANCE_MARGIN + shortPending * SHORT_MARGIN);
  const available = cash + stockValue - occupied - pending;
  return { cash, stockValue, collateralPositions, financeUsed, financePending, shortPending, shortUsed, occupied, pending, available };
}
function freeCash(m: Market) {
  const pending = m.orders.filter(o => active(o) && o.actorId === PLAYER && o.side === 'buy')
    .reduce((sum, o) => sum + o.frozenCash, 0);
  return Math.max(0, player(m).cash - creditLedger(m).cash - marginCash(m) - pending - ipoReservedCash(m));
}
function totals(m: Market) {
  const p = player(m);
  const stockValue = m.stocks.reduce((n, s) => n + position(p, s.id).quantity * s.price, 0);
  const restricted = Object.values(m.shorts).reduce((n, s) => n + s.proceeds, 0);
  const shortLiability = m.stocks.reduce((n, s) => n + (m.shorts[s.id]?.quantity ?? 0) * s.price, 0);
  const margin = marginTotals(m);
  const assets = p.cash + stockValue + restricted + margin.restricted;
  const debt = m.principal + m.interest + shortLiability;
  const accountAssets = creditLedger(m).cash + restricted + m.stocks.reduce((sum, s) => sum + creditPosition(m, s.id).quantity * s.price, 0);
  return { assets, debt, shortLiability, restricted, accountAssets, totalDebt: debt + margin.debt, margin, equity: assets - debt - margin.debt, maintenance: debt ? accountAssets / debt * 100 : 999 };
}
function financeCapacity(m: Market) {
  const credit = creditAccount(m);
  return Math.max(0, Math.floor(Math.min(FINANCE_LIMIT - m.principal - credit.financePending - marginTotals(m).loan - marginPending(m).loan,
    m.brokerCash - credit.financePending - marginPending(m).loan, credit.available / FINANCE_MARGIN)));
}
function creditForView(m: Market): CreditView {
  const credit = creditAccount(m), account = creditLedger(m), t = totals(m);
  const withdrawalBudget = Math.max(0, Math.min(credit.available, t.debt ? t.accountAssets - t.debt * 1.65 : Infinity));
  const unlocked = m.day >= CREDIT_UNLOCK_DAY && !m.result && totals(m).maintenance >= 150;
  const shortCapacity = Math.max(0, Math.floor(Math.min(SHORT_LIMIT - credit.shortUsed - credit.shortPending - marginTotals(m).shortValue - marginPending(m).short,
    credit.available / SHORT_MARGIN)));
  const canOpenShort = unlocked && followingTradingDate(m.calendarDate) < m.deadlineDate;
  const requiredRepay = Math.max(0, Math.ceil((t.debt * 1.65 - t.accountAssets) / .65));
  return {
    debt: yuan(t.debt), financingDebt: yuan(m.principal), interest: yuan(m.interest),
    dailyInterest: yuan(Math.floor((m.principal * RATE + t.shortLiability * BORROW_RATE) / 365)),
    ordinaryCash: yuan(freeCash(m)), cashBalance: yuan(account.cash), cashAvailable: yuan(credit.cash),
    withdrawableCash: yuan(Math.floor(Math.min(credit.cash, withdrawalBudget))),
    accountAssets: yuan(t.accountAssets), maintenance: t.maintenance, migrationNotice: account.migrationNotice ?? null,
    transferablePositions: m.stocks.map(s => ({ stockId: s.id, quantity: ordinaryAvailable(m, s.id),
      ratio: collateralRatio(m, s), marketValue: yuan(ordinaryAvailable(m, s.id) * s.price) })).filter(p => p.quantity > 0 && p.ratio > 0),
    positions: m.stocks.map(s => {
      const p = position(player(m), s.id), cp = creditPosition(m, s.id);
      const pledged = Math.max(0, cp.quantity - p.financed), available = creditAvailable(m, s.id);
      const haircutBudget = collateralRatio(m, s) ? Math.max(0, credit.available) / collateralRatio(m, s) : Infinity;
      const assetBudget = t.debt ? Math.max(0, t.accountAssets - t.debt * 1.65) : Infinity;
      return { stockId: s.id, quantity: cp.quantity, available, todayBought: cp.today, financedQuantity: p.financed,
        pledgedQuantity: pledged, withdrawableQuantity: Math.floor(Math.min(pledged, available,
          haircutBudget / s.price, assetBudget / s.price) / 100) * 100, marketValue: yuan(cp.quantity * s.price) };
    }).filter(p => p.quantity > 0),
    risk: { level: t.maintenance < 145 ? 'margin-call' : t.maintenance < 165 ? 'warning' : 'normal',
      warningLine: 165, callLine: 145, restoreLine: 150, targetLine: 165, marginCallDay: m.marginCallDay,
      topUpAmount: yuan(Math.max(0, Math.ceil(t.debt * 1.65 - t.accountAssets))),
      // Cash repayment reduces assets and debt together; borrowing costs are part of debt.
      repayAmount: requiredRepay <= m.principal + m.interest && t.accountAssets >= t.debt ? yuan(requiredRepay) : 0 },
    financeLimit: yuan(FINANCE_LIMIT), financeUsed: yuan(m.principal), financePending: yuan(credit.financePending),
    financeAvailable: unlocked ? yuan(financeCapacity(m)) : 0,
    shortLimit: yuan(SHORT_LIMIT), shortUsed: yuan(credit.shortUsed), shortPending: yuan(credit.shortPending),
    shortAvailableAmount: canOpenShort ? yuan(shortCapacity) : 0,
    collateralCash: yuan(credit.cash), collateralStockValue: yuan(credit.stockValue),
    collateralTotal: yuan(credit.cash + credit.stockValue), collateralOccupied: yuan(credit.occupied),
    collateralPending: yuan(credit.pending), collateralAvailable: yuan(Math.max(0, credit.available)),
    financeMarginRatio: FINANCE_MARGIN, shortMarginRatio: SHORT_MARGIN, borrowAnnualRate: BORROW_RATE,
    repayAvailable: yuan(Math.min(credit.cash, m.principal + m.interest)),
    collateralPositions: credit.collateralPositions.map(row => ({ ...row,
      marketValue: yuan(row.marketValue), collateralValue: yuan(row.collateralValue) })),
    pools: m.stocks.filter(s => s.lendTotal > 0).map(s => {
      const reserved = m.orders.filter(o => active(o) && o.actorId === PLAYER && o.stockId === s.id && (o.side === 'short' || o.side === 'marginShort'))
        .reduce((sum, o) => sum + o.remaining, 0);
      const available = Math.max(0, s.lendAvailable - reserved);
      const upperPrice = limits(s, m.day).high;
      const atUpperPrice = creditAccount(m, { stockId: s.id, price: upperPrice });
      const stockCapacity = Math.max(0, Math.min(shortCapacity,
        SHORT_LIMIT - atUpperPrice.shortUsed - atUpperPrice.shortPending - marginTotals(m).shortValue - marginPending(m).short,
        atUpperPrice.available / SHORT_MARGIN));
      return { stockId: s.id, total: s.lendTotal, borrowed: s.lendTotal - s.lendAvailable, reserved, available,
        playerMaxQuantity: canOpenShort ? Math.floor(Math.min(available, stockCapacity / upperPrice) / 100) * 100 : 0 };
    }),
  };
}
function ipoFinance(m: Market) {
  return {
    availableCash: (actorId: string) => actorId === PLAYER ? freeCash(m)
      : Math.max(0, m.actors.find(a => a.id === actorId)!.cash - frozenCash(m, actorId) - ipoReservedCash(m, actorId)),
    equity: (actorId: string) => {
      if (actorId === PLAYER) return totals(m).equity;
      const a = m.actors.find(a => a.id === actorId)!;
      return a.cash + m.stocks.reduce((sum, s) => sum + (a.positions[s.id]?.quantity ?? 0) * s.price, 0);
    },
  };
}
function openIpoDay(m: Market) {
  if (m.simulationVersion !== 2) return;
  initIpo(m);
  for (const event of advanceIpo(m, ipoFinance(m))) {
    const offer = ipoForView(m).find(o => o.id === event.offerId)!;
    if (event.kind === 'cancelled') {
      m.news.unshift({ id: id(m, 'n'), day: m.day, time: '09:15', sector: offer.sector,
        sentiment: 'neutral', headline: `${offer.name}发行流标`,
        body: '本期没有有效认购，发行取消。该公司未进入行情牌，不生成股份或成交。', impacts: [] });
      m.news = m.news.slice(0, 40);
      ledger(m, '新股流标', `${offer.name}没有有效认购，本次发行取消。`);
      continue;
    }
    const demand = { weak: '需求线索偏弱', steady: '需求线索平稳', strong: '需求线索偏强' }[offer.demand];
    const valuation = offer.issuePe > offer.peerPe * 1.15 ? '发行估值高于同业参考'
      : offer.issuePe < offer.peerPe * .85 ? '发行估值低于同业参考' : '发行估值接近同业参考';
    const positive = offer.demand === 'strong' && offer.issuePe <= offer.peerPe * 1.2
      || offer.demand !== 'weak' && offer.issuePe < offer.peerPe * .9;
    const negative = offer.demand === 'weak' || offer.issuePe > offer.peerPe * 1.2;
    const sentiment = positive ? 'positive' : negative ? 'negative' : 'neutral';
    m.news.unshift({ id: id(m, 'n'), day: m.day, time: '09:15', sector: offer.sector, stockIds: [offer.stockId], sentiment,
      headline: event.kind === 'announcement' ? `${offer.name}明日上市，今日开放申购` : `${offer.name}今日上市，进入集合竞价`,
      body: `${demand}，${valuation}（发行 PE ${offer.issuePe} 倍，同业参考 ${offer.peerPe} 倍）。本期供给 ${(offer.offeredShares / 10_000).toFixed(0)} 万股。${event.kind === 'announcement'
        ? '今日收盘前可按额度申购，资金冻结至明早配售；未获配部分释放，中签也可能破发。'
        : '发行价只作开盘参考，涨跌由真实买卖决定；供给少时价格可能更敏感，原持有人也可能兑现。'}`,
      impacts: sentiment === 'neutral' ? [] : [{ sector: offer.sector, direction: positive ? 'positive' : 'negative',
        reason: `${demand}，${valuation}；本轮信息直接关联${offer.name}，不能等同为整个板块同步涨跌。` }] });
    m.news = m.news.slice(0, 40);
    if (event.kind === 'announcement') {
      ledger(m, '新股申购', `${offer.name}开放申购，发行价 ${offer.issuePrice.toFixed(2)} 元，本次额度 ${offer.quotaQuantity} 股。`);
    } else {
      const s = stockBy(m, event.stockId);
      m.storyState!.expectations[s.id] = { premium: 0, realizedPremium: 0, conviction: .5, updatedDay: m.day, activeStoryIds: [] };
      s.newsBias = positive ? .04 : negative ? -.04 : 0;
      initializeListedStock(m, s);
      ledger(m, '新股配售', `${offer.name}获配 ${event.playerAllocatedQuantity} 股；释放未获配冻结 ${(event.playerReleasedAmount / 10_000).toFixed(2)} 万元。`, -cents(event.playerPaidAmount));
    }
  }
}

export function submitIpoSubscription(m: Market, offerId: string, quantity: number): ActionResult {
  const result = subscribeIpo(m, offerId, quantity, ipoFinance(m));
  if (result.ok) ledger(m, '新股申购', `申购 ${offerId}：${quantity} 股。预留资金不等于已经成交。`);
  return result;
}
export function cancelIpoSubscription(m: Market, offerId: string): ActionResult {
  const result = cancelIpo(m, offerId);
  if (result.ok) ledger(m, '撤销申购', `${offerId}申购撤销，释放原有资金预留。`);
  return result;
}
function settleDebt(m: Market, amount: number) {
  const account = creditLedger(m);
  const paid = Math.min(amount, liquidCash(m), m.principal + m.interest);
  const fee = Math.min(paid, m.interest);
  m.interest -= fee; m.principal -= paid - fee; player(m).cash -= paid; account.cash -= paid; m.brokerCash += paid;
  if (m.principal === 0) for (const pos of Object.values(player(m).positions)) pos.financed = 0;
  return paid;
}
function risk(m: Market) {
  const t = totals(m);
  if (m.result === 'default') return { level: 'default' as const, message: '期限届满，尚有目标欠款或证券信用债务；未偿金额保留在账本。' };
  const marginRisk = marginAccounts(m).map(a => marginMetrics(m, a)).filter(t => t.debt || t.gross);
  if (marginRisk.some(t => t.ratio < 10)) return { level: 'margin-call' as const, message: '杠杆保证金率低于 10%：系统提交本账户可成交的强平委托，T+1、券源与买卖盘限制仍然生效。可补保证金或减仓，恢复至 20% 后停止强平。' };
  if (t.maintenance >= 145 && marginRisk.some(t => t.ratio < 20)) return { level: 'warning' as const, message: '杠杆保证金率低于 20% 预警线，请在杠杆交易页查看对应逐仓或全仓账户。普通资产不会自动补入。' };
  if (!t.debt && marginTotals(m).debt) return { level: 'normal' as const, message: '杠杆借款与借券按各保证金账户管理；目标还款前需先归还全部实际信用负债。' };
  if (!t.debt) {
    if (m.challenge && m.challenge.paid < m.challenge.target) return { level: 'normal' as const, message: '当前没有证券信用债务。到期目标须用可用现金偿还，持仓市值不能直接抵付。' };
    return { level: 'repaid' as const, message: m.challenge ? '目标还款及证券信用债务已清偿；到期保持无信用欠款即可完成本局。' : '证券信用债务已清偿。百日结束时按净资产结算。' };
  }
  if (t.maintenance < 145) return { level: 'margin-call' as const, message: '游戏券商追保线为 145%；请在下一交易日开盘前补足至 150%，否则提交强平订单。' };
  if (t.maintenance < 165) return { level: 'warning' as const, message: '维持担保比例低于本游戏合同 165% 提示线。新增融资仍需满足 100% 保证金约束。' };
  return { level: 'normal' as const, message: '担保状态正常；融资与融券仍受额度、库存和可用保证金约束。' };
}

function createBaseStock(d: BaseStockDefinition, day: number, legacy = false): Stock {
  const price = cents(d.price);
  return { id: d.id, code: d.code, name: d.name, sector: d.sector, concepts: [...d.concepts], description: d.description,
    price, previousClose: price, open: 0, high: 0, low: 0, volume: 0, turnover: 0, fair: price,
    shares: legacy ? 50_000_000 : d.shares, pe: d.pe, financeEligible: d.financeEligible,
    lendTotal: d.lendTotal, lendAvailable: d.lendTotal, newsBias: 0,
    coverageStartDay: day, history: day === 1 ? [] : [{ time: '昨收', price, volume: 0 }], dailyBars: [], dailyHistoryStartDay: day };
}

/** Expand the tradable universe at an opening. No cash, existing shares or past executions are rewritten. */
function expandStockUniverse(m: Market): void {
  if (m.stockUniverseVersion === STOCK_UNIVERSE_VERSION) return;
  const additions = BASE_STOCKS.slice(LEGACY_BASE_STOCK_COUNT).map(d => createBaseStock(d, m.day, m.simulationVersion === 1));
  for (const s of additions) {
    m.stocks.push(s);
    // Existing listed companies enter the game's coverage. Their finite float
    // starts with background holders, not free inventory or cash for the player.
    const holders = m.actors.filter(a => m.agentSimulation ? a.id.startsWith('crowd') : /^ai[0-5]$/.test(a.id));
    const quantity = 1_800_000 / holders.length;
    for (const a of holders) a.positions[s.id] = { quantity, today: 0, financed: 0, cost: s.price * quantity };
    if (m.storyState) m.storyState.expectations[s.id] = { premium: 0, realizedPremium: 0, conviction: 0, updatedDay: m.day, activeStoryIds: [] };
    initializeListedStock(m, s);
  }
  m.stockUniverseVersion = STOCK_UNIVERSE_VERSION;
  ensureDailyHistory(m);
  const names = additions.map(s => s.name).join('、');
  ledger(m, '行情扩容', `新增机器人、创新药、大消费三个板块，${names}进入行情牌。原有资产和成交记录保留。`);
  m.news.unshift({ id: id(m, 'n'), day: m.day, time: '09:15', sentiment: 'neutral', impacts: [],
    headline: '行情牌扩容：三个新板块进入视野',
    body: `${names}已纳入可交易股票池。这些是已有上市公司，不是新股发行；前期背景 K 线供观察，局内行情从今日真实成交开始记录。市场资金总量没有增加，热点仍要争夺有限的买盘。` });
  m.news = m.news.slice(0, 40);
}

export function createMarket(seed = 20261020, options: { legacySimulation?: boolean; openingScenario?: boolean } = {}): Market {
  if (options.openingScenario && options.legacySimulation) throw new Error('Opening scenario requires the current simulation');
  const marketSeed = options.openingScenario ? OPENING_SCENARIO_SEED : seed;
  const m: Market = {
    formatVersion: 1, seed: marketSeed >>> 0, rngState: (marketSeed >>> 0) || 1, revision: 0, sequence: 0,
    phase: 'auction', phaseElapsed: 0, tickCount: 0, day: 1, elapsedDays: 0,
    calendarDate: '2026-10-20', deadlineDate: '2027-01-28', paused: true, speed: 1,
    stocks: [], actors: [], orders: [], trades: [], shorts: {}, principal: 0,
    interest: 0, interestRemainder: 0, brokerCash: cents(200_000_000), news: [], ledger: [], leaderboard: [],
    result: null, marginCallDay: null, newsEvents: {}, simulationVersion: options.legacySimulation ? 1 : 2,
    challenge: { target: cents(100_000_000), paid: 0, startingCapital: cents(10_000_000) },
    creditAccount: { version: 1, cash: 0, positions: {} }, stockUniverseVersion: STOCK_UNIVERSE_VERSION,
  };
  m.stocks = BASE_STOCKS.map(definition => createBaseStock(options.openingScenario && definition.id === OPENING_SCENARIO.stockId ? { ...definition, price: OPENING_SCENARIO.initialPrice } : definition, 1, !!options.legacySimulation));
  m.actors.push({ id: PLAYER, name: '你的席位', cash: cents(10_000_000), positions: {} });
  const names = ['临江路 · 趋势资金', '青石街 · 逆向资金', '星河大道 · 题材资金', '南湾路 · 流动资金', '松风路 · 波段资金', '长桥路 · 稳健资金'];
  names.forEach((name, i) => {
    const actor: Actor = { id: `ai${i}`, name, cash: cents(45_000_000), positions: {} };
    m.stocks.forEach(s => { actor.positions[s.id] = { quantity: 300_000, today: 0, financed: 0, cost: s.price * 300_000 }; });
    m.actors.push(actor);
  });
  ensureDailyHistory(m);
  if (!options.legacySimulation) {
    initNewsArcs(m);
    advanceNewsArcs(m);
    initializeAgents(m, { legacy: false }, () => random(m));
    initIpo(m);
  }
  ledger(m, '开局', options.openingScenario
    ? '1000 万现金重新入场，无初始持仓；今日买入股份须下一交易日才能卖出。100 个自然日内偿还 1 亿元目标欠款。'
    : '1000 万现金重新入场，无初始持仓与证券融资；100 个自然日内偿还 1 亿元目标欠款。');
  m.news.push({ id: id(m, 'n'), day: m.day, time: '盘前', headline: '百日归期：重新坐上交易席', body: '旧债和解约定：100 个自然日内偿还 1 亿元，你的交易本金为 1000 万。目标欠款不占用证券保证金；第 20 个交易日开放融资融券，新增信用债务单独计息和追保。股票与席位均为虚构。', sentiment: 'neutral', impacts: [] });
  publishNews(m);
  seedBook(m);
  if (options.openingScenario) installOpeningScenario(m, seed, (who, input, created) => place(m, who, input, false, created));
  ensureDailyHistory(m);
  return m;
}

function place(m: Market, actorId: string, input: OrderInput, forced = false, created?: (order: Order) => void): ActionResult {
  if (!input || typeof input !== 'object') return fail('委托格式不正确。');
  const s = m.stocks.find(s => s.id === input.stockId);
  if (!s) return fail('股票不存在。');
  if (!['buy', 'sell', 'finance', 'short', 'cover', 'creditSell'].includes(input.side)) return fail('不支持的委托方向。');
  if (actorId === PLAYER && (input.side === 'finance' || input.side === 'short') && m.day < CREDIT_UNLOCK_DAY) return fail(`融资融券于第 ${CREDIT_UNLOCK_DAY} 个交易日开放；已有借券仍可按规则买券归还。`);
  if (!forced && actorId === PLAYER && m.orders.filter(o => o.actorId === PLAYER && active(o)).length >= 100) return fail('最多保留 100 笔未成交委托，请先撤销部分委托。');
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0 || input.quantity % 100 !== 0 || input.quantity > 10_000_000) return fail('数量须为 100 股的正整数倍，单笔最多 1000 万股。');
  if (!Number.isFinite(input.price) || input.price <= 0 || Math.abs(input.price * 100 - Math.round(input.price * 100)) > .00001) return fail('价格须精确到分。');
  if (['lunch', 'night', 'ended'].includes(m.phase)) return fail('当前阶段不接受新委托。');
  const price = cents(input.price), q = input.quantity, { low, high } = limits(s, m.day);
  if (price < low || price > high) return fail(`委托价格须在 ${yuan(low).toFixed(2)} 至 ${yuan(high).toFixed(2)} 元之间。`);
  if (m.orders.some(o => active(o) && o.actorId === actorId && o.stockId === s.id
    && buySide(o.side) !== buySide(input.side)
    && (buySide(input.side) ? price >= o.price : price <= o.price))) return fail('该委托会与同席位现有反向委托交叉，请先撤单。');
  const actor = m.actors.find(a => a.id === actorId)!;
  const p = position(actor, s.id);
  let frozen = 0, restrictedClaim = 0;
  if (input.side === 'sell') {
    if (q > (actorId === PLAYER ? ordinaryAvailable(m, s.id) : p.quantity - p.today - frozenQuantity(m, actorId, s.id))) return fail('可卖股份不足；今日买入股份须下一交易日才能卖出。');
  } else if (input.side === 'creditSell') {
    if (actorId !== PLAYER || q > creditAvailable(m, s.id)) return fail('信用账户可卖股份不足；担保及融资持仓须在信用账户卖出，今日买入须下一交易日出售。');
  } else if (input.side === 'buy') {
    const available = actorId === PLAYER ? freeCash(m) : actor.cash - frozenCash(m, actorId);
    if (price * q > available) return fail('可用现金不足。');
    frozen = price * q;
  } else if (input.side === 'finance') {
    if (actorId !== PLAYER || !s.financeEligible) return fail('该股未开放融资。');
    if (price * q > financeCapacity(m)) return fail('融资额度或可用担保不足；已借本金和未成交委托共用 200 万元授信。');
    if (totals(m).maintenance < 150) return fail('追保状态不允许新增融资。');
  } else if (input.side === 'short') {
    if (actorId !== PLAYER || !s.lendTotal) return fail('该股没有券源。');
    if (followingTradingDate(m.calendarDate) >= m.deadlineDate) return fail('本局到期前已无下一交易日，无法开立需要次日归还的新融券仓位。');
    const pending = m.orders.filter(o => active(o) && o.stockId === s.id && (o.side === 'short' || o.side === 'marginShort')).reduce((n, o) => n + o.remaining, 0);
    if (q > s.lendAvailable - pending) return fail('可借券数量不足。');
    if (price < s.price) return fail('融券卖出限价不得低于最近成交价。');
    if (totals(m).maintenance < 150) return fail('追保状态不允许新增融券。');
    const credit = creditAccount(m);
    if (credit.shortUsed + credit.shortPending + marginTotals(m).shortValue + marginPending(m).short + high * q > SHORT_LIMIT) return fail('融券总额度不足；借券市值和未成交委托共用 50 万元额度。');
    if (Math.ceil(high * q * SHORT_MARGIN) > credit.available) return fail('融券可用担保不足；请先将现金或股票放入信用账户，委托按涨停价预留 100% 保证金。');
  } else {
    const sp = shortPosition(m, s.id);
    const pending = m.orders.filter(o => active(o) && o.stockId === s.id && o.side === 'cover');
    const lockedQ = pending.reduce((n, o) => n + o.remaining, 0);
    if (q > sp.quantity - sp.today - lockedQ) return fail('可还券数量不足；当日新借券须下一交易日才能归还。');
    restrictedClaim = Math.floor(sp.proceeds * q / sp.quantity);
    frozen = Math.max(0, price * q - restrictedClaim);
    // A return is risk reducing: collateral cash may be used to buy back the
    // borrowed shares, but another cash order's reservation cannot be spent.
    if (frozen > liquidCash(m)) return fail('还券所需的补充现金不足。');
  }
  const orderId = id(m, 'o');
  const order: Order = { id: orderId, actorId, stockId: s.id, side: input.side, quantity: q, remaining: q,
    price, status: 'open', time: clock(m), sequence: m.sequence, createdTick: m.tickCount,
    frozenCash: frozen, restrictedClaim, forced, day: m.day };
  m.orders.push(order);
  created?.(order);
  if (m.phase === 'morning' || m.phase === 'afternoon') {
    if (actorId === PLAYER && !forced && (input.side === 'buy' || input.side === 'sell')) {
      order.execution = submissionExecution(m, order);
    } else matchContinuous(m, s.id);
  }
  m.revision++;
  if (actorId === PLAYER) {
    const filled = order.quantity - order.remaining;
    const shares = (quantity: number) => quantity.toLocaleString('zh-CN');
    if (filled === order.quantity) return ok(`${s.name}委托已全部成交 ${shares(filled)} 股。`);
    if (order.status === 'cancelled') return ok(`${s.name}已成交 ${shares(filled)} 股，剩余 ${shares(order.remaining)} 股因风控校验已取消。`);
    if (filled > 0) return ok(`${s.name}委托部分成交 ${shares(filled)} 股，剩余 ${shares(order.remaining)} 股继续挂单；收盘未成交部分自动撤销。`);
    if (m.phase === 'auction' || m.phase === 'closing') return ok(`${s.name}尚未成交：集合竞价将在竞价结束时集中撮合 ${shares(order.remaining)} 股委托。`);
    return ok(`${s.name}尚未成交，${shares(order.remaining)} 股正在等待对手盘；收盘未成交部分自动撤销。`);
  }
  return ok(`委托已提交：${orderId}`);
}

export function submitOrder(m: Market, input: OrderInput): ActionResult {
  if (m.paused) return fail('行情已暂停，请先继续行情');
  ensureDailyHistory(m);
  const result = place(m, PLAYER, input);
  updateRisk(m);
  return result;
}
export function cancelOrder(m: Market, orderId: string): ActionResult {
  const o = m.orders.find(o => o.id === orderId && o.actorId === PLAYER);
  if (!o || !active(o)) return fail('没有可撤销的委托。');
  if ((m.phase === 'auction' && m.phaseElapsed >= DURATIONS.auction / 2) || m.phase === 'closing') return fail('当前为集合竞价不可撤单时段。');
  if (o.forced) return fail('券商强平委托不可由玩家撤销。');
  cancelMarginReservation(m, o);
  o.status = 'cancelled'; o.cancelReason = 'user'; o.frozenCash = 0; o.restrictedClaim = 0; releaseMarginSurplus(m); m.revision++;
  return ok('委托已撤销，未成交部分的冻结已释放。');
}
export function transferCreditCollateral(m: Market, input: CollateralTransferInput): ActionResult {
  if (m.result || m.phase === 'ended') return fail('本轮已结算。');
  if (!input || typeof input !== 'object' || !['in', 'out'].includes(input.direction)) return fail('请选择放入或取回担保。');
  const isCash = input.cash !== undefined;
  if (isCash === (input.stockId !== undefined || input.quantity !== undefined)) return fail('每次只能划转一种资产。');
  const account = creditLedger(m);
  if (input.direction === 'in' && m.day < CREDIT_UNLOCK_DAY && !totals(m).debt) return fail(`信用账户于第 ${CREDIT_UNLOCK_DAY} 个交易日开放。`);
  let amount = 0, quantity = 0, stock: Stock | undefined;
  if (isCash) {
    if (!Number.isFinite(input.cash) || input.cash! <= 0 || !Number.isSafeInteger(cents(input.cash!))
      || Math.abs(input.cash! * 100 - cents(input.cash!)) > .00001) return fail('现金金额须为精确到分的正数。');
    amount = cents(input.cash!);
    if (amount > (input.direction === 'in' ? freeCash(m) : liquidCash(m))) return fail('可划转现金不足，挂单与申购冻结资金不能划转。');
  } else {
    stock = m.stocks.find(s => s.id === input.stockId);
    if (!stock || !Number.isSafeInteger(input.quantity) || input.quantity! <= 0 || input.quantity! % 100) return fail('请选择持仓股票，数量须为 100 股的正整数倍。');
    quantity = input.quantity!;
    if (input.direction === 'in' && collateralRatio(m, stock) <= 0) return fail('该股当前不接受作为担保品。');
    const p = position(player(m), stock.id), cp = creditPosition(m, stock.id);
    const available = input.direction === 'in' ? ordinaryAvailable(m, stock.id)
      : Math.min(creditAvailable(m, stock.id), cp.quantity - p.financed);
    if (quantity > available) return fail('可划转股份不足；今日买入、已挂单和未还款的融资股份不能取回。');
  }
  // Calculate the candidate before committing, so failed withdrawals are atomic.
  if (input.direction === 'out') {
    const c = creditAccount(m), t = totals(m);
    const collateralReduction = isCash ? amount : Math.floor(quantity * stock!.price * collateralRatio(m, stock!));
    const assetReduction = isCash ? amount : quantity * stock!.price;
    if (c.available - collateralReduction < 0 || (t.debt && (t.accountAssets - assetReduction) / t.debt < 1.65)) {
      return fail('取回后担保不足；请先撤销信用挂单或归还债务，取回后须保持 165% 安全目标。');
    }
  }
  const sign = input.direction === 'in' ? 1 : -1;
  if (isCash) account.cash += amount * sign;
  else creditPosition(m, stock!.id).quantity += quantity * sign;
  ledger(m, input.direction === 'in' ? '放入担保' : '取回担保', isCash
    ? `${yuan(amount).toLocaleString('zh-CN')} 元在普通与信用账户之间划转，总资产不变。`
    : `${stock!.name} ${quantity} 股在普通与信用账户之间划转，所有权和成本不变。`);
  updateRisk(m); m.revision++;
  return ok(input.direction === 'in' ? '担保已放入信用账户；实际融资成交前不产生借款。' : '担保已取回普通账户。');
}
export function repay(m: Market, amount: number): ActionResult {
  if (m.phase === 'ended') return fail('本轮已结算。');
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(cents(amount)) || Math.abs(amount * 100 - cents(amount)) > .00001) return fail('请输入精确到分的有效还款金额。');
  const pay = cents(amount);
  // Paying principal/fees releases the same amount of collateral occupancy.
  if (Math.min(pay, m.principal + m.interest) > liquidCash(m)) return fail('可用于还款的现金不足。');
  if (!m.principal && !m.interest) return fail('没有待还融资及费用。');
  const actual = settleDebt(m, pay);
  ledger(m, '还款', '现金偿债，先付应计费用再还本金。', -actual);
  updateRisk(m); m.revision++;
  return ok(`已偿还 ${yuan(actual).toLocaleString('zh-CN', { minimumFractionDigits: 2 })} 元。`);
}

function settleChallenge(m: Market, amount: number) {
  if (!m.challenge) return 0;
  const paid = Math.min(amount, freeCash(m), m.challenge.target - m.challenge.paid);
  player(m).cash -= paid; m.challenge.paid += paid;
  return paid;
}
export function repayChallenge(m: Market, amount: number): ActionResult {
  if (m.phase === 'ended') return fail('本轮已结算。');
  if (!m.challenge) return fail('本存档沿用原证券融资合同，没有独立目标欠款。');
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(cents(amount))
    || Math.abs(amount * 100 - cents(amount)) > .00001) return fail('请输入精确到分的有效还款金额。');
  if (m.challenge.paid >= m.challenge.target) return fail('目标欠款已全部偿还。');
  if (totals(m).totalDebt > 0 || marginHasCreditObligations(m) || m.orders.some(o => active(o) && o.actorId === PLAYER && (o.side === 'finance' || o.side === 'short'))) {
    return fail('请先清偿证券融资、费用和借券，并撤销信用委托，再偿还目标欠款。');
  }
  if (cents(amount) > freeCash(m)) return fail('可用于还款的现金不足；委托冻结资金和持仓不能用于目标还款。');
  const paid = settleChallenge(m, cents(amount));
  ledger(m, '目标还款', '可用现金支付外部债权人，计入百日目标已还金额。', -paid);
  updateRisk(m); m.revision++;
  return ok(`已偿还目标欠款 ${yuan(paid).toLocaleString('zh-CN', { minimumFractionDigits: 2 })} 元。`);
}

function book(m: Market, stockId: string) {
  const rows = m.orders.filter(o => o.stockId === stockId && active(o));
  const bids = rows.filter(o => buySide(o.side)).sort((a, b) => b.price - a.price || a.sequence - b.sequence);
  const asks = rows.filter(o => !buySide(o.side)).sort((a, b) => a.price - b.price || a.sequence - b.sequence);
  return { bids, asks };
}
function fill(m: Market, bid: Order, ask: Order, price: number, quantity: number) {
  const s = stockBy(m, bid.stockId), value = price * quantity;
  const buyer = m.actors.find(a => a.id === bid.actorId)!;
  const seller = m.actors.find(a => a.id === ask.actorId)!;
  if (buyer.id === seller.id) return;
  const forced = bid.forced && !marginOrder(bid) ? bid : ask.forced && !marginOrder(ask) ? ask : undefined;
  if (forced && totals(m).maintenance >= 150) {
    forced.status = 'cancelled'; forced.frozenCash = 0; forced.restrictedClaim = 0; return;
  }
  for (const o of [bid, ask].filter(marginOrder)) if (!marginCanFill(m, o, price, quantity)) {
    cancelMarginReservation(m, o); o.status = 'cancelled'; o.frozenCash = 0; o.restrictedClaim = 0; releaseMarginSurplus(m); return;
  }
  const creditOrder = bid.side === 'finance' ? bid : ask.side === 'short' ? ask : undefined;
  if (creditOrder) {
    // This execution also reprices every existing holding and borrowed share in
    // this stock. Test that resulting account before transferring any money or
    // shares; only the filled part leaves the pending reservation.
    const credit = creditAccount(m, { stockId: s.id, price, order: creditOrder, quantity });
    const financedValue = creditOrder.side === 'finance' ? value : 0;
    const currentTotals = totals(m);
    const repricedHoldings = creditPosition(m, s.id).quantity * (price - s.price);
    const projectedAssets = currentTotals.accountAssets + repricedHoldings + value;
    const projectedDebt = credit.financeUsed + m.interest + credit.shortUsed;
    const projectedMaintenance = projectedDebt ? projectedAssets / projectedDebt * 100 : 999;
    const exceeded = creditOrder.side === 'finance'
      ? credit.financeUsed + credit.financePending + marginTotals(m).loan + marginPending(m).loan > FINANCE_LIMIT || credit.financePending + marginPending(m).loan + financedValue > m.brokerCash
      : credit.shortUsed + credit.shortPending + marginTotals(m, { stockId: s.id, price }).shortValue + marginPending(m).short > SHORT_LIMIT;
    // Recheck resting orders after collateral prices or available inventory move.
    // Existing debt is retained; cancelling an unfilled order never liquidates it.
    if (credit.available < 0 || projectedMaintenance < 150 || exceeded) {
      creditOrder.status = 'cancelled'; creditOrder.frozenCash = 0;
      ledger(m, '信用撤单', `${s.name}信用委托因担保或额度变化撤销，未成交预留已释放。`);
      return;
    }
  }
  if (marginOrder(bid)) fillMarginLeg(m, bid, price, quantity);
  else if (bid.side === 'finance') { m.brokerCash -= value; m.principal += value; }
  else if (bid.side === 'cover') {
    const sp = shortPosition(m, s.id);
    const released = quantity === sp.quantity ? sp.proceeds : Math.floor(sp.proceeds * quantity / sp.quantity);
    const marginRelease = quantity === sp.quantity ? sp.margin : Math.floor(sp.margin * quantity / sp.quantity);
    sp.proceeds -= released; sp.margin -= marginRelease; sp.quantity -= quantity;
    buyer.cash += released - value; creditLedger(m).cash += released - value; s.lendAvailable += quantity;
  } else buyer.cash -= value;
  if (bid.side !== 'cover' && !marginOrder(bid)) {
    const p = position(buyer, s.id);
    p.quantity += quantity; p.today += quantity; p.cost += value;
    if (bid.side === 'finance') { p.financed += quantity; const cp = creditPosition(m, s.id); cp.quantity += quantity; cp.today += quantity; }
  }
  let financedSold = false;
  if (marginOrder(ask)) fillMarginLeg(m, ask, price, quantity);
  else if (ask.side === 'short') {
    const sp = shortPosition(m, s.id);
    sp.quantity += quantity; sp.today += quantity; sp.proceeds += value; sp.margin += value;
    s.lendAvailable -= quantity;
  } else {
    const p = position(seller, s.id);
    const soldFinanced = ask.side === 'creditSell' ? Math.min(quantity, Math.max(0, p.financed - creditPosition(m, s.id).today)) : 0;
    const marginHolding = marginShares(m, s.id);
    const separateCost = seller.id === PLAYER ? marginAccounts(m).flatMap(a=>a.positions).filter(p=>p.stockId===s.id&&p.direction==='long').reduce((sum,p)=>sum+p.cost,0) : 0;
    const eligibleQuantity = p.quantity - (seller.id === PLAYER ? marginHolding.quantity : 0), eligibleCost = p.cost - separateCost;
    p.cost -= quantity === eligibleQuantity ? eligibleCost : Math.floor(eligibleCost * quantity / eligibleQuantity);
    p.quantity -= quantity; p.financed -= soldFinanced;
    if (ask.forced) p.today = Math.min(p.today, p.quantity);
    financedSold = seller.id === PLAYER && (soldFinanced > 0 || !!ask.forced);
    seller.cash += value;
    if (ask.side === 'creditSell') {
      const cp = creditPosition(m, s.id); cp.quantity -= quantity;
      creditLedger(m).cash += value;
      financedSold = true;
    }
  }
  for (const o of [bid, ask]) {
    const ratio = (o.remaining - quantity) / o.remaining;
    o.remaining -= quantity; o.frozenCash = Math.floor(o.frozenCash * ratio);
    o.restrictedClaim = Math.floor(o.restrictedClaim * ratio);
    o.status = o.remaining ? 'partial' : 'filled';
  }
  if (financedSold) {
    const paid = settleDebt(m, Math.min(value, m.principal + m.interest));
    if (paid) ledger(m, '卖券还款', `${s.name} 信用持仓卖出款优先偿还融资和费用，余款留在信用账户。`, -paid);
  }
  if (marginOrder(bid) || marginOrder(ask)) {
    for (const o of [bid, ask].filter(marginOrder)) settleMarginFees(m, marginOwner(m,o).account);
    releaseMarginSurplus(m);
  }
  s.price = price;
  cancelRecoveredMarginOrders(m); releaseMarginSurplus(m);
  if (!s.volume) s.open = s.high = s.low = price;
  else { s.high = Math.max(s.high, price); s.low = Math.min(s.low, price); }
  s.volume += quantity; s.turnover += value;
  const time = clock(m), lastPoint = s.history.at(-1);
  // One point per actual execution minute preserves the whole session as
  // liquidity increases. Raw fills remain in trades for matching and reports.
  if (m.agentSimulation && lastPoint?.time === time) {
    lastPoint.price = price; lastPoint.volume += quantity;
  } else s.history.push({ time, price, volume: quantity });
  if (!m.agentSimulation && s.history.length > 360) s.history.shift();
  const playerSide = buyer.id === PLAYER ? bid.side : seller.id === PLAYER ? ask.side : undefined;
  m.trades.push({ id: id(m, 't'), stockId: s.id, price, quantity, time: clock(m), day: m.day,
    buyerId: buyer.id, sellerId: seller.id, buyerName: buyer.name, sellerName: seller.name, playerSide });
  recordOpeningFill(m, bid, ask, price, quantity);
  if (playerSide) ledger(m, '成交', `${s.name} ${playerSide} ${quantity} 股 × ${yuan(price).toFixed(2)}`, (buySide(playerSide) ? -1 : 1) * value);
}
type ObserveFill = (bid: Order, ask: Order, price: number, quantity: number, beforePrice: number) => void;
function submissionExecution(m: Market, order: Order): NonNullable<Order['execution']> {
  const execution: NonNullable<Order['execution']> = { filled: 0, amount: 0, priceLevels: 0 };
  const prices = new Set<number>();
  let foreignSinceOwnFill = false, interleaved = false;
  matchContinuous(m, order.stockId, (bid, ask, price, quantity, beforePrice) => {
    if (bid !== order && ask !== order) {
      if (execution.filled > 0) foreignSinceOwnFill = true;
      return;
    }
    if (execution.filled === 0) execution.beforePrice = beforePrice;
    else if (foreignSinceOwnFill) interleaved = true;
    execution.filled += quantity;
    execution.amount += price * quantity;
    execution.afterPrice = price;
    prices.add(price);
  });
  execution.priceLevels = prices.size;
  // A single before/after span cannot explain interleaved foreign executions.
  if (interleaved) { delete execution.beforePrice; delete execution.afterPrice; }
  return execution;
}
function matchContinuous(m: Market, stockId: string, observeFill?: ObserveFill) {
  const observedStock = observeFill ? stockBy(m, stockId) : undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const { bids, asks } = book(m, stockId);
    let pair: [Order, Order] | undefined;
    for (const bid of bids) {
      const ask = asks.find(a => a.price <= bid.price && a.actorId !== bid.actorId);
      if (ask) { pair = [bid, ask]; break; }
    }
    if (!pair) break;
    const [bid, ask] = pair;
    const price = bid.sequence < ask.sequence ? bid.price : ask.price;
    // A short order cannot execute below the latest price when the market has moved since submission.
    if (['short','marginShort'].includes(ask.side) && price < stockBy(m, stockId).price) { cancelMarginReservation(m,ask); ask.status = 'cancelled'; ask.frozenCash = 0; releaseMarginSurplus(m); continue; }
    const remaining = bid.remaining, beforePrice = observedStock?.price;
    fill(m, bid, ask, price, Math.min(bid.remaining, ask.remaining));
    const executed = remaining - bid.remaining;
    if (executed > 0 && observeFill) observeFill(bid, ask, price, executed, beforePrice!);
  }
}
function matchAuction(m: Market) {
  for (const s of m.stocks) {
    const { bids, asks } = book(m, s.id);
    const candidates = [...new Set([...bids, ...asks].map(o => o.price))];
    let best: { price: number; volume: number; imbalance: number } | null = null;
    for (const price of candidates) {
      const demand = bids.filter(o => o.price >= price).reduce((n, o) => n + o.remaining, 0);
      const supply = asks.filter(o => o.price <= price).reduce((n, o) => n + o.remaining, 0);
      const volume = Math.min(demand, supply), imbalance = Math.abs(demand - supply);
      if (!best || volume > best.volume || (volume === best.volume && (imbalance < best.imbalance || (imbalance === best.imbalance && Math.abs(price - s.previousClose) < Math.abs(best.price - s.previousClose))))) best = { price, volume, imbalance };
    }
    if (!best?.volume) continue;
    const price = best.price;
    for (const bid of bids.filter(o => o.price >= price)) {
      for (const ask of asks.filter(o => o.price <= price)) {
        if (bid.actorId === ask.actorId || !active(bid) || !active(ask)) continue;
        if (['short','marginShort'].includes(ask.side) && price < s.price) continue;
        fill(m, bid, ask, price, Math.min(bid.remaining, ask.remaining));
      }
    }
  }
}

function seedBook(m: Market) {
  if (m.agentSimulation) { seedBackgroundBook(m, (who, input) => place(m, who, input)); return; }
  for (const s of m.stocks) {
    const range = limits(s, m.day);
    for (let depth = 0; depth < 5; depth++) {
      const bidPrice = Math.max(range.low, s.price - 1 - depth * 2);
      const askPrice = Math.min(range.high, s.price + 1 + depth * 2);
      place(m, m.actors[1 + depth % 6].id, { stockId: s.id, side: 'buy', price: yuan(bidPrice), quantity: 2000 + depth * 1000 });
      place(m, m.actors[1 + (depth + 2) % 6].id, { stockId: s.id, side: 'sell', price: yuan(askPrice), quantity: 2000 + depth * 1000 });
    }
  }
}
function aiOrders(m: Market) {
  if (m.agentSimulation) { runMarketAgents(m, () => random(m), (who, input) => isOpeningScenarioStock(m, input.stockId) ? fail('首日固定盘口') : place(m, who, input)); return; }
  // Resting liquidity is real inventory/cash; expiry releases the original reservations.
  for (const o of m.orders) if (active(o) && o.actorId !== PLAYER && m.tickCount - o.createdTick > 60) {
    o.status = 'cancelled'; o.frozenCash = 0;
  }
  for (const s of m.stocks) {
    const actor = m.actors[1 + Math.floor(random(m) * 6)];
    const trend = (s.price - s.previousClose) / s.previousClose;
    const actorIndex = Number(actor.id.slice(2));
    const expectationGap = .2 + random(m) * .9;
    const newsOpinion = s.newsBias * .55 * AI_NEWS_RESPONSE[actorIndex] * expectationGap;
    const conviction = (s.fair - s.price) / s.price * .25 + newsOpinion
      + (actorIndex % 2 ? -trend * .12 : trend * .15);
    const side: 'buy' | 'sell' = random(m) < Math.max(.15, Math.min(.85, .5 + conviction * 4)) ? 'buy' : 'sell';
    const spread = Math.round((random(m) - .45) * s.price * .008 + conviction * s.price * .12);
    const price = Math.max(limits(s, m.day).low, Math.min(limits(s, m.day).high, s.price + spread));
    const quantity = (1 + Math.floor(random(m) * 30)) * 100;
    place(m, actor.id, { stockId: s.id, side, quantity, price: yuan(price) });
  }
}
function publishNews(m: Market) {
  if (m.storyState) { advanceNewsArcs(m); return; }
  rememberKnownNews(m);
  const sector = NEWS_SECTORS[Math.floor(random(m) * NEWS_SECTORS.length)];
  const positive = random(m) > .43;
  const story = NEWS_TEMPLATES[sector][positive ? 0 : 1];
  let event = m.newsEvents![story.headline];
  const alreadyKnown = !!event && m.day - event.day < 3;
  if (!alreadyKnown) {
    event = { id: id(m, 'e'), day: m.day, round: (event?.round ?? 0) + 1, applied: false };
    m.newsEvents![story.headline] = event;
  }
  const impacts = story.impacts.map(impact => ({ ...impact }));
  m.news.unshift({ id: id(m, 'n'), day: m.day, time: clock(m), sector,
    headline: alreadyKnown ? `消息回顾｜${story.headline}`
      : event.round > 1 ? `第${event.round}轮新增进展｜${story.headline}` : story.headline,
    body: alreadyKnown ? `这条消息此前已经公开。${event.round > 1 ? story.followUp : story.body}`
      : event.round > 1 ? story.followUp : story.body,
    sentiment: positive ? 'positive' : 'negative', impacts,
    eventId: event.id, eventDay: event.day, templateHeadline: story.headline });
  if (m.news.length > 40) m.news.length = 40;
  if (event.applied) return;
  event.applied = true;
  for (const impact of impacts) {
    const direction = impact.direction === 'positive' ? 1 : -1;
    for (const s of m.stocks) if (s.sector === impact.sector) {
      s.newsBias = Math.max(-NEWS_BIAS_CAP, Math.min(NEWS_BIAS_CAP,
        s.newsBias + direction * (.025 + random(m) * .04)));
      // A new fact changes a temporary expectation. The fixed earnings reference
      // and last traded price stay unchanged; disagreement enters actual AI orders.
    }
  }
}
function closeBoard(m: Market) {
  savePostCloseReport(m);
  const marketReturn = m.stocks.reduce((n, s) => n + s.price / s.previousClose - 1, 0) / m.stocks.length;
  const boards: LeaderboardView[] = [];
  for (const s of m.stocks) {
    const deviation = (s.price / s.previousClose - 1 - marketReturn) * 100;
    const amplitude = s.low ? (s.high - s.low) / s.low * 100 : 0;
    const turnover = s.volume / s.shares * 100;
    const reasons = [Math.abs(deviation) >= 7 ? '日涨跌幅偏离值达到 7%' : '', amplitude >= 15 ? '振幅达到 15%' : '', turnover >= 20 ? '换手率达到 20%' : ''].filter(Boolean);
    if (!reasons.length) continue;
    const amounts = new Map<string, { name: string; buy: number; sell: number; net: number }>();
    for (const t of m.trades.filter(t => t.day === m.day && t.stockId === s.id)) {
      for (const [who, name, key] of [[t.buyerId, t.buyerName, 'buy'], [t.sellerId, t.sellerName, 'sell']] as const) {
        const row = amounts.get(who) ?? { name, buy: 0, sell: 0, net: 0 };
        row[key] += yuan(t.price * t.quantity); amounts.set(who, row);
      }
    }
    const rows = [...amounts.values()].map(row => ({ ...row, net: row.buy - row.sell }));
    boards.push({ stockId: s.id, stockName: s.name, day: m.day, reason: `模拟榜：${reasons.join('；')}`,
      buyers: [...rows].filter(r => r.buy).sort((a, b) => b.buy - a.buy).slice(0, 5),
      sellers: [...rows].filter(r => r.sell).sort((a, b) => b.sell - a.sell).slice(0, 5),
      totalBuy: rows.reduce((n, r) => n + r.buy, 0), totalSell: rows.reduce((n, r) => n + r.sell, 0) });
  }
  m.leaderboard = boards;
  ledger(m, '收盘', boards.length ? `${boards.length} 只股票触发模拟龙虎榜，金额来自当日实际成交。` : '今日没有股票达到模拟龙虎榜阈值。');
}
function cancelAll(m: Market, reason: OrderCancelReason = 'day-expired') {
  const playerOrders = m.orders.filter(o => active(o) && o.actorId === PLAYER);
  const beforeAvailable = playerOrders.length ? freeCash(m) : 0;
  for (const o of m.orders) if (active(o)) { cancelMarginReservation(m, o); o.status = 'cancelled'; o.cancelReason = reason; o.frozenCash = 0; o.restrictedClaim = 0; }
  releaseMarginSurplus(m);
  if (playerOrders.length) {
    const released = Math.max(0, freeCash(m) - beforeAvailable);
    ledger(m, reason === 'game-ended' ? '结算撤单' : '收盘撤单', `${playerOrders.length} 笔委托的未成交部分${reason === 'game-ended' ? '因本局结算' : '在收盘后到期'}自动撤销，可用现金释放 ${yuan(released).toFixed(2)} 元；已成交结果保留，已买入股份不受影响。`);
  }
}
function updateRisk(m: Market) {
  const t = totals(m);
  if (t.maintenance < 145 && m.marginCallDay === null) {
    m.marginCallDay = m.day;
    ledger(m, '追保', '维持担保比例跌破游戏合同 145%，下一交易日开盘前须恢复至 150%。');
  } else if (t.maintenance >= 150) m.marginCallDay = null;
}
function forceLiquidation(m: Market) {
  if (m.marginCallDay === null || m.day <= m.marginCallDay || totals(m).maintenance >= 150) return;
  for (const o of m.orders) if (active(o) && o.actorId === PLAYER && ['finance', 'short', 'cover', 'creditSell'].includes(o.side)) {
    o.status = 'cancelled'; o.frozenCash = 0; o.restrictedClaim = 0;
  }
  const paid = settleDebt(m, liquidCash(m));
  if (paid) ledger(m, '强平偿债', '以信用账户现金偿还融资和费用，普通账户资产未划入。', -paid);
  if (totals(m).maintenance >= 150) { updateRisk(m); return; }
  ledger(m, '强平', '追保期限已到，券商按跌停限价提交持仓卖出；没有对手盘时继续等待。');
  for (const s of m.stocks) {
    const q = Math.floor(creditAvailable(m, s.id) / 100) * 100;
    if (q) place(m, PLAYER, { stockId: s.id, side: 'creditSell', quantity: q, price: yuan(limits(s, m.day).low) }, true);
    const sp = m.shorts[s.id], cover = sp ? sp.quantity - sp.today : 0;
    if (cover) place(m, PLAYER, { stockId: s.id, side: 'cover', quantity: cover, price: yuan(limits(s, m.day).high) }, true);
  }
}
function accrueDay(m: Market) {
  accrueMarginDay(m);
  const shortValue = m.stocks.reduce((n, s) => n + (m.shorts[s.id]?.quantity ?? 0) * s.price, 0);
  const exact = (m.principal * RATE + shortValue * BORROW_RATE) / 365 + m.interestRemainder;
  const charge = Math.floor(exact);
  m.interestRemainder = exact - charge;
  m.interest += charge;
  m.elapsedDays++;
  const date = new Date(`${m.calendarDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  m.calendarDate = date.toISOString().slice(0, 10);
  ledger(m, '计息', `${m.calendarDate} 自然日费用入账（不复利）。`, -charge);
}
function finish(m: Market) {
  cancelAll(m, 'game-ended');
  for (const event of releasePendingIpo(m)) ledger(m, '申购取消', `${event.name}尚未配售，本局结束释放预留 ${(event.releasedAmount / 10_000).toFixed(2)} 万元。`);
  // Final repayment may use only actual cash; unsold shares never become fictitious proceeds.
  creditLedger(m).cash = player(m).cash - marginCash(m);
  const paid = settleDebt(m, liquidCash(m));
  if (paid) ledger(m, '到期还款', '到期可用现金自动偿债。', -paid);
  settleMarginMaturity(m);
  const creditCleared = totals(m).totalDebt === 0 && !marginHasCreditObligations(m);
  if (creditCleared) creditLedger(m).cash = 0;
  // Pay the external target only after securities obligations are clear; borrowing cannot win the challenge.
  const targetPaid = creditCleared ? settleChallenge(m, freeCash(m)) : 0;
  if (targetPaid) ledger(m, '到期目标还款', '到期可用现金支付外部债权人，持仓不自动折现。', -targetPaid);
  const challengeCleared = !m.challenge || m.challenge.paid === m.challenge.target;
  m.result = creditCleared && challengeCleared ? 'won' : 'default';
  m.phase = 'ended'; m.paused = true;
  ledger(m, '结局', m.result === 'won' ? '到期目标与证券信用债务均已清偿，完成本局。' : '到期尚有目标欠款、证券融资或未还券，进入违约结局。');
}
function transitionPhase(m: Market): void {
  if (m.phase === 'night') { rollToNextDay(m); return; }
  if (m.phase === 'auction' || m.phase === 'closing') matchAuction(m);
  const previous = m.phase;
  m.phase = PHASES[PHASES.indexOf(m.phase) + 1]; m.phaseElapsed = 0;
  if (m.phase === 'night') {
    finalizeDailyBars(m); cancelAll(m); closeBoard(m); publishNews(m); m.paused = true;
  }
  if (m.phase === 'morning') for (const s of m.stocks) matchContinuous(m, s.id);
  if (previous === 'lunch') publishNews(m);
  updateRisk(m);
}
function rollToNextDay(m: Market): void {
  // Also covers older snapshots restored directly into the nightly review.
  finalizeDailyBars(m);
  ensurePostCloseReport(m);
  cancelAll(m);
  do {
    accrueDay(m);
    if (m.elapsedDays >= 100) { finish(m); m.revision++; return; }
    if (isTradingDate(m.calendarDate)) break;
    digestNews(m, 600); // A skipped weekend/holiday still digests known information.
  } while (true);
  m.day++; m.phase = 'auction'; m.phaseElapsed = 0; m.paused = true;
  continueOpeningMarket(m);
  if (m.day === 2 && m.openingScenario) randomizeOpeningIpo(m, m.openingScenario.continuationSeed);
  for (const actor of m.actors) for (const p of Object.values(actor.positions)) p.today = 0;
  for (const p of Object.values(m.shorts)) p.today = 0;
  for (const p of Object.values(creditLedger(m).positions)) p.today = 0;
  for (const a of marginAccounts(m)) for (const p of a.positions) p.today = 0;
  for (const s of m.stocks) {
    s.previousClose = s.price; s.open = 0; s.high = 0; s.low = 0; s.volume = 0; s.turnover = 0;
    s.history = [{ time: '昨收', price: s.price, volume: 0 }];
  }
  // Closed orders/trades are retained only as much as needed for UI and today's board.
  m.orders = m.orders.filter(o => o.actorId === PLAYER).slice(-100);
  m.trades = m.trades.filter(t => t.playerSide).slice(-150);
  expandStockUniverse(m);
  if (m.simulationVersion === undefined) {
    initNewsArcs(m);
    initializeAgents(m, { legacy: true }, () => random(m));
    m.simulationVersion = 2;
    ledger(m, '市场更新', '普通资金与游资分开运行；游资开始围绕少量标的制定跨日计划，后续电讯将持续跟踪项目进展。');
  }
  publishNews(m);
  openIpoDay(m);
  if (m.agentSimulation) prepareAgentDay(m, () => random(m));
  seedBook(m); forceLiquidation(m); forceMarginLiquidation(m); updateRisk(m); m.revision++;
}
function stepSimulationSecond(m: Market): void {
  ensureDailyHistory(m);
  if (!m.storyState) rememberKnownNews(m);
  digestNews(m);
  m.tickCount++; m.phaseElapsed++;
  advanceOpeningScenario(m, (who, input, created) => place(m, who, input, false, created));
  if (m.tickCount % 4 === 0) forceMarginLiquidation(m);
  if (m.storyState) advanceNewsArcs(m);
  if (['auction', 'morning', 'afternoon', 'closing'].includes(m.phase) && (m.agentSimulation || m.tickCount % 4 === 0)) aiOrders(m);
  if (!m.storyState && (m.phase === 'morning' || m.phase === 'afternoon') && m.phaseElapsed === 90) publishNews(m);
  if (m.phaseElapsed >= DURATIONS[m.phase]) transitionPhase(m);
  updateRisk(m);
}
export function advancePhase(m: Market): void {
  if (m.phase === 'ended') return;
  // Manual stepping explicitly advances time even when paused. Close/day boundaries
  // always pause; other phase changes preserve the existing pause/speed selection.
  // Stop at exactly one phase boundary; the same seconds drive orders, news and matching.
  const remaining = Math.max(1, Math.ceil(DURATIONS[m.phase] - m.phaseElapsed));
  for (let i = 0; i < remaining; i++) stepSimulationSecond(m);
  m.revision++;
}
export function nextDay(m: Market): void {
  if (m.phase === 'ended') return;
  const startingDay = m.day;
  // A whole simulated trading day is 600 seconds. This explicit bound prevents recursion
  // and stops at the next opening auction (or the contract deadline), never inside it.
  for (let i = 0; i < 600 && m.day === startingDay && m.result === null; i++) stepSimulationSecond(m);
  m.revision++;
}
export function tick(m: Market): void {
  if (m.paused || m.phase === 'ended') return;
  for (let i = 0; i < m.speed; i++) {
    if (m.result !== null || m.paused) break;
    stepSimulationSecond(m);
  }
  m.revision++;
}
export function getView(m: Market): MarketView {
  ensureCreditAccount(m);
  ensureDailyHistory(m);
  ensurePostCloseReport(m);
  const t = totals(m), r = risk(m), credit = creditForView(m);
  const playerOrders = m.orders.filter(o => o.actorId === PLAYER);
  const visibleOrders = [...playerOrders.filter(active), ...playerOrders.filter(o => !active(o)).slice(-100)]
    .sort((a, b) => b.sequence - a.sequence);
  const seatAmounts = new Map(m.actors.map(a => [a.id, { name: a.name, buy: 0, sell: 0 }]));
  if (m.phase === 'night' || m.phase === 'ended') {
    for (const trade of m.trades) {
      if (trade.day !== m.day) continue;
      const value = trade.price * trade.quantity;
      seatAmounts.get(trade.buyerId)!.buy += value;
      seatAmounts.get(trade.sellerId)!.sell += value;
    }
  }
  const seatFlows = m.phase === 'night' || m.phase === 'ended'
    ? [...seatAmounts.values()].map(row => ({
      name: row.name, buy: yuan(row.buy), sell: yuan(row.sell), net: yuan(row.buy - row.sell),
    })).sort((a, b) => b.net - a.net)
    : [];
  const levels = (orders: Order[], reverse: boolean) => {
    const map = new Map<number, number>();
    for (const o of orders) map.set(o.price, (map.get(o.price) ?? 0) + o.remaining);
    return [...map].sort((a, b) => reverse ? b[0] - a[0] : a[0] - b[0]).slice(0, 5).map(([price, quantity]) => ({ price: yuan(price), quantity }));
  };
  return {
    ...(m.openingScenario ? { openingScenario: openingScenarioForView(m) } : {}),
    revision: m.revision, phase: m.phase, phaseLabel: LABELS[m.phase], time: clock(m),
    day: m.day, daysLeft: Math.max(0, 100 - m.elapsedDays), calendarDate: m.calendarDate, deadlineDate: m.deadlineDate,
    paused: m.paused, speed: m.speed, phaseProgress: Math.min(1, m.phaseElapsed / DURATIONS[m.phase]),
    challenge: m.challenge ? { target: yuan(m.challenge.target), paid: yuan(m.challenge.paid),
      remaining: yuan(m.challenge.target - m.challenge.paid), startingCapital: yuan(m.challenge.startingCapital) } : null,
    creditUnlocked: m.day >= CREDIT_UNLOCK_DAY, creditUnlockDay: CREDIT_UNLOCK_DAY,
    credit, margin: marginForView(m),
    assets: yuan(t.assets), equity: yuan(t.equity), debt: yuan(t.totalDebt), financingDebt: yuan(m.principal + t.margin.loan),
    shortLiability: yuan(t.shortLiability + t.margin.shortValue), interest: yuan(m.interest + t.margin.interest), cash: yuan(player(m).cash),
    availableCash: yuan(freeCash(m)), frozenCash: yuan(player(m).cash - freeCash(m)),
    ipos: ipoForView(m),
    restrictedCash: yuan(t.restricted + t.margin.restricted), maintenance: t.maintenance, financeAvailable: credit.financeAvailable,
    annualInterestRate: RATE, dailyInterest: yuan(Math.floor((m.principal * RATE + t.shortLiability * BORROW_RATE) / 365) + marginDailyInterest(m)),
    riskLevel: r.level, riskMessage: r.message, result: m.result,
    stocks: m.stocks.map(s => {
      const b = book(m, s.id), limit = limits(s, m.day);
      const pendingBorrow = m.orders.filter(o => active(o) && o.stockId === s.id && (o.side === 'short' || o.side === 'marginShort')).reduce((n, o) => n + o.remaining, 0);
      const chips = m.agentSimulation ? getChipSupply(m, s) : null;
      const bucket = (ratio: number) => Math.round(Math.max(0, Math.min(1, ratio)) * 20) / 20;
      const totalShares = Math.max(chips?.floatShares ?? 0, Number.isSafeInteger(s.shares) && s.shares >= 0 ? s.shares : 0);
      const supplyRatio = chips && chips.floatShares ? chips.estimatedSupply / chips.floatShares : 0;
      return { id: s.id, code: s.code, name: s.name, sector: s.sector, concepts: [...s.concepts], description: s.description,
        price: yuan(s.price), previousClose: yuan(s.previousClose), change: yuan(s.price - s.previousClose),
        changePercent: (s.price / s.previousClose - 1) * 100, open: yuan(s.open), high: yuan(s.high), low: yuan(s.low),
        volume: s.volume, turnover: yuan(s.turnover), limitUp: yuan(limit.high), limitDown: yuan(limit.low),
        marketCap: yuan(s.shares * s.price), pe: s.pe * s.price / (s.issuePrice ?? cents(baseStockById(s.id)?.price ?? s.fair / 100)),
        ...(chips ? { chips: {
          totalShares, floatShares: chips.floatShares, floatMarketCap: yuan(chips.floatShares * s.price),
          inactiveShares: Math.max(0, totalShares - chips.floatShares), playerRatio: chips.playerRatio,
          concentrationRatio: bucket(chips.concentration),
          concentration: chips.concentration >= .6 ? 'high' as const : chips.concentration >= .35 ? 'concentrated' as const : 'dispersed' as const,
          supply: supplyRatio < .25 ? 'tight' as const : supplyRatio < .55 ? 'balanced' as const : 'ample' as const,
          profitPressure: chips.profitPressure >= .5 ? 'high' as const : chips.profitPressure >= .2 ? 'medium' as const : 'low' as const,
          t1LockedRatio: bucket(chips.floatShares ? chips.t1LockedShares / chips.floatShares : 0),
        } } : {}),
        limitBoard: buildLimitBoard(m, s),
        ...(s.listedDay ? { listedDay: s.listedDay, issuePrice: yuan(s.issuePrice!), ipoFactors: { ...s.ipoFactors! } } : {}),
        financeEligible: s.financeEligible, shortEligible: s.lendTotal > 0,
        shortAvailable: Math.max(0, s.lendAvailable - pendingBorrow), bids: levels(b.bids, true), asks: levels(b.asks, false),
        history: s.history.map(h => ({ ...h, price: yuan(h.price) })),
        dailyBars: dailyBarsForView(m, s), dailyHistoryStartDay: s.dailyHistoryStartDay! };
    }),
    positions: m.stocks.map(s => {
      const p = position(player(m), s.id), sp = m.shorts[s.id], frozen = frozenQuantity(m, PLAYER, s.id);
      return { stockId: s.id, quantity: p.quantity, available: ordinaryAvailable(m, s.id), frozen,
        todayBought: p.today, financedQuantity: p.financed, averageCost: p.quantity ? yuan(p.cost / p.quantity) : 0,
        marketValue: yuan(p.quantity * s.price), profit: yuan(p.quantity * s.price - p.cost),
        shortQuantity: sp?.quantity ?? 0, shortToday: sp?.today ?? 0, shortProceeds: yuan(sp?.proceeds ?? 0) };
    }).filter(p => p.quantity || p.shortQuantity),
    orders: visibleOrders.map(o => ({
      ...(o.marginAccountId ? { marginAccountId: o.marginAccountId, marginPositionId: o.marginPositionId } : {}),
      ...(o.day === undefined ? {} : { day: o.day }), ...(o.cancelReason === undefined ? {} : { cancelReason: o.cancelReason }),
      ...(o.execution === undefined ? {} : { execution: {
        filled: o.execution.filled, amount: yuan(o.execution.amount),
        averagePrice: o.execution.filled ? yuan(o.execution.amount / o.execution.filled) : null,
        priceLevels: o.execution.priceLevels,
        ...(o.execution.beforePrice === undefined ? {} : { beforePrice: yuan(o.execution.beforePrice), afterPrice: yuan(o.execution.afterPrice!) }),
      } }),
      id: o.id, stockId: o.stockId, side: o.side, quantity: o.quantity, remaining: o.remaining,
      filled: o.quantity - o.remaining, price: yuan(o.price), status: o.status, time: o.time,
      frozenCash: yuan(active(o) ? o.frozenCash : 0), frozenQuantity: active(o) && (o.side === 'sell' || o.side === 'creditSell') ? o.remaining : 0,
    })),
    trades: m.trades.filter(t => t.playerSide).slice(-120).reverse().map(t => ({
      id: t.id, stockId: t.stockId, price: yuan(t.price), quantity: t.quantity, time: t.time, day: t.day, side: t.playerSide!,
    })),
    news: m.news.map(newsForView), leaderboard: structuredClone(m.leaderboard),
    ledger: m.ledger.map(l => ({ ...l })), seatFlows,
    postClose: m.postClose ? structuredClone(m.postClose) : null,
  };
}
function savePostCloseReport(m: Market, date = m.calendarDate): void {
  if (m.postClose && m.postClose.day < m.day) {
    m.postCloseHistory = [...(m.postCloseHistory ?? []).filter(r => r.day !== m.postClose!.day), m.postClose]
      .sort((a, b) => a.day - b.day).slice(-4);
  }
  m.postClose = buildPostCloseReport(m, date);
}
function ensurePostCloseReport(m: Market): void {
  if ((m.phase !== 'night' && m.phase !== 'ended') || m.postClose?.day === m.day) return;
  // At maturity calendarDate has already advanced; only an archived candle can identify
  // the final trading date of a legacy ended save. Do not label it with the due date.
  const dates = new Set(m.stocks.flatMap(stock => (stock.dailyBars ?? [])
    .filter(bar => bar.day === m.day && bar.complete).map(bar => bar.date)));
  const date = m.phase === 'night' ? m.calendarDate : dates.size === 1 ? [...dates][0] : undefined;
  if (date) savePostCloseReport(m, date);
}
function validDailyHistory(s: Stock, m: Market): boolean {
  if (s.openingHistoryVersion !== undefined && ![1, OPENING_HISTORY_VERSION].includes(s.openingHistoryVersion)) return false;
  if (s.dailyBars === undefined && s.dailyHistoryStartDay === undefined) return true;
  if (!Array.isArray(s.dailyBars) || s.dailyBars.length > 100 + OPENING_HISTORY_LENGTH
    || !Number.isSafeInteger(s.dailyHistoryStartDay) || s.dailyHistoryStartDay! < 1
    || s.dailyHistoryStartDay! > m.day) return false;
  const positiveInteger = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
  const backgroundDates = openingHistoryDates();
  let previousDay = -OPENING_HISTORY_LENGTH, previousDate = '', backgroundCount = 0, sessionCount = 0;
  for (const bar of s.dailyBars) {
    if (!bar || typeof bar !== 'object' || !Number.isSafeInteger(bar.day)
      || bar.day <= previousDay || bar.day > m.day
      || (bar.origin !== undefined && bar.origin !== 'background' && bar.origin !== 'session')
      || typeof bar.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(bar.date)
      || !Number.isFinite(Date.parse(`${bar.date}T00:00:00Z`))
      || new Date(`${bar.date}T00:00:00Z`).toISOString().slice(0, 10) !== bar.date
      || bar.date <= previousDate || bar.date > m.calendarDate
      || bar.complete !== true
      || ![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.turnover].every(positiveInteger)
      || bar.volume % 100 !== 0 || bar.low > Math.min(bar.open, bar.close)
      || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high
      || bar.turnover < bar.low * bar.volume || bar.turnover > bar.high * bar.volume) return false;
    if (bar.origin === 'background') {
      if (++backgroundCount > OPENING_HISTORY_LENGTH || bar.day < 1 - OPENING_HISTORY_LENGTH || bar.day > 0
        || bar.date !== backgroundDates[bar.day + OPENING_HISTORY_LENGTH - 1]) return false;
    } else if (++sessionCount > 100 || bar.day < s.dailyHistoryStartDay!
      || bar.date < GAME_START_DATE
      || (bar.day === m.day && m.phase !== 'night' && m.phase !== 'ended')) return false;
    previousDay = bar.day; previousDate = bar.date;
  }
  return true;
}
function validCreditAccount(m: Market): boolean {
  const a = m.creditAccount;
  if (a === undefined) return true; // Accepted legacy format; migration is explicit after validation.
  const nonnegative = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  if (!a || typeof a !== 'object' || a.version !== 1 || !nonnegative(a.cash) || a.cash > player(m).cash
    || !a.positions || typeof a.positions !== 'object' || Array.isArray(a.positions)
    || (a.migrationNotice !== undefined && (typeof a.migrationNotice !== 'string' || a.migrationNotice.length > 1000))) return false;
  for (const [stockId, cp] of Object.entries(a.positions)) {
    const p = player(m).positions[stockId];
    if (!m.stocks.some(s => s.id === stockId) || !cp || !nonnegative(cp.quantity) || !nonnegative(cp.today)
      || cp.quantity % 100 || cp.today % 100 || cp.today > cp.quantity || cp.quantity > (p?.quantity ?? 0)
      || cp.today > (p?.today ?? 0) || (p?.today ?? 0) - cp.today > (p?.quantity ?? 0) - cp.quantity
      || (p?.financed ?? 0) > cp.quantity) return false;
  }
  for (const [stockId, p] of Object.entries(player(m).positions)) if (p.financed > (a.positions[stockId]?.quantity ?? 0)) return false;
  const ordinaryFrozen = m.orders.filter(o => active(o) && o.actorId === PLAYER && o.side === 'buy').reduce((sum, o) => sum + o.frozenCash, 0) + ipoReservedCash(m);
  const creditFrozen = m.orders.filter(o => active(o) && o.actorId === PLAYER && o.side === 'cover').reduce((sum, o) => sum + o.frozenCash, 0);
  if (ordinaryFrozen > player(m).cash - a.cash - marginCash(m) || creditFrozen > a.cash) return false;
  for (const s of m.stocks) {
    const p = player(m).positions[s.id], cp = a.positions[s.id];
    const mp = marginShares(m, s.id);
    const ordinary = (p?.quantity ?? 0) - (cp?.quantity ?? 0) - mp.quantity - ((p?.today ?? 0) - (cp?.today ?? 0) - mp.today);
    const credit = (cp?.quantity ?? 0) - (cp?.today ?? 0);
    if (frozenQuantity(m, PLAYER, s.id) > ordinary || frozenQuantity(m, PLAYER, s.id, true) > credit) return false;
  }
  return true;
}
function validStockUniverse(m: Market): boolean {
  if (m.stockUniverseVersion !== undefined && m.stockUniverseVersion !== STOCK_UNIVERSE_VERSION) return false;
  const definitions = m.stockUniverseVersion === STOCK_UNIVERSE_VERSION ? BASE_STOCKS : BASE_STOCKS.slice(0, LEGACY_BASE_STOCK_COUNT);
  if (!Array.isArray(m.stocks) || m.stocks.length < definitions.length || m.stocks.length > definitions.length + 4
    || new Set(m.stocks.map(s => s?.id)).size !== m.stocks.length) return false;
  if (!definitions.every(d => m.stocks.some(s => s?.id === d.id && s.listedDay === undefined))) return false;
  const extra = m.stocks.filter(s => !definitions.some(d => d.id === s?.id));
  return extra.length === 0 || !!m.ipoState && extra.every(s => s && /^s1[3-6]$/.test(s.id) && s.listedDay !== undefined);
}

export function validateMarket(value: unknown): value is Market {
  if (!value || typeof value !== 'object') return false;
  const m = value as Market;
  const nonnegative = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  return m.formatVersion === 1 && nonnegative(m.rngState) && nonnegative(m.seed)
    && nonnegative(m.revision) && nonnegative(m.sequence) && nonnegative(m.tickCount) && nonnegative(m.brokerCash)
    && nonnegative(m.principal) && nonnegative(m.interest) && Number.isFinite(m.interestRemainder)
    && (m.challenge === undefined || (!!m.challenge && typeof m.challenge === 'object'
      && nonnegative(m.challenge.target) && m.challenge.target > 0 && nonnegative(m.challenge.paid)
      && m.challenge.paid <= m.challenge.target && nonnegative(m.challenge.startingCapital) && m.challenge.startingCapital > 0))
    && validateOpeningScenario(m)
    && validStockUniverse(m)
    && m.stocks.every(s => s && typeof s.id === 'string' && nonnegative(s.price) && s.price > 0
      && nonnegative(s.previousClose) && s.previousClose > 0 && Array.isArray(s.history)
      && (s.coverageStartDay === undefined || Number.isSafeInteger(s.coverageStartDay) && s.coverageStartDay >= 1 && s.coverageStartDay <= m.day)
      && Array.isArray(s.concepts) && nonnegative(s.lendAvailable) && nonnegative(s.lendTotal)
      && s.lendAvailable <= s.lendTotal && Number.isFinite(s.newsBias) && nonnegative(s.fair)
      && validDailyHistory(s, m))
    && Array.isArray(m.actors) && m.actors.length === (m.agentSimulation ? 10 + (m.actors.some(a => a.id === 'ipo-issuer') ? 1 : 0) : 7) && m.actors[0]?.id === PLAYER
    && m.actors.every(a => a && nonnegative(a.cash) && a.positions && typeof a.positions === 'object'
      && Object.values(a.positions).every(p => p && nonnegative(p.quantity) && nonnegative(p.today)
        && nonnegative(p.financed) && nonnegative(p.cost) && p.today <= p.quantity && p.financed <= p.quantity))
    && Array.isArray(m.orders) && Array.isArray(m.trades) && Array.isArray(m.news) && Array.isArray(m.ledger)
    && Array.isArray(m.leaderboard) && !!m.shorts && PHASES.concat('ended').includes(m.phase)
    && (m.postClose === undefined || validPostCloseReport(m.postClose, m))
    && (m.postCloseHistory === undefined || (Array.isArray(m.postCloseHistory) && m.postCloseHistory.length <= 4
      && m.postCloseHistory.every((r, i, rows) => validPostCloseReport(r, m) && r.day < (m.postClose?.day ?? m.day)
        && (i === 0 || rows[i - 1].day < r.day))))
    && (m.simulationVersion === undefined || m.simulationVersion === 1 || m.simulationVersion === 2)
    && (m.simulationVersion === 2
      ? validateAgentSimulation(m.agentSimulation, m) && validateStoryState(m.storyState, m)
      : m.agentSimulation === undefined && m.storyState === undefined)
    && (m.ipoState === undefined ? !m.actors.some(a => a.id === 'ipo-issuer')
      : m.simulationVersion === 2 && validateIpoState(m.ipoState, m))
    && Object.values(m.shorts).every(s => s && nonnegative(s.quantity) && nonnegative(s.today)
      && s.today <= s.quantity && nonnegative(s.proceeds) && nonnegative(s.margin))
    && m.orders.every(o => o && typeof o.id === 'string' && nonnegative(o.price) && nonnegative(o.remaining)
      && nonnegative(o.quantity) && o.remaining <= o.quantity && nonnegative(o.frozenCash)
      && (o.day === undefined || Number.isSafeInteger(o.day) && o.day > 0 && o.day <= m.day)
      && (o.cancelReason === undefined || o.status === 'cancelled' && ['user', 'day-expired', 'game-ended'].includes(o.cancelReason))
      && validOrderExecution(o)
      && ['buy', 'sell', 'finance', 'short', 'cover', 'creditSell', 'marginBuy', 'marginShort', 'marginSell', 'marginCover'].includes(o.side)
      && (['buy', 'sell'].includes(o.side) || o.actorId === PLAYER)
      && m.stocks.some(s => s.id === o.stockId) && m.actors.some(a => a.id === o.actorId))
    && validMarginState(m) && validCreditAccount(m)
    && [1, 4, 12].includes(m.speed) && Number.isInteger(m.elapsedDays) && m.elapsedDays >= 0 && m.elapsedDays <= 100
    && nonnegative(m.day) && m.day > 0 && typeof m.paused === 'boolean'
    && Number.isFinite(m.phaseElapsed) && m.phaseElapsed >= 0
    && /^\d{4}-\d{2}-\d{2}$/.test(m.calendarDate) && /^\d{4}-\d{2}-\d{2}$/.test(m.deadlineDate);
}

function validOrderExecution(order: Order): boolean {
  if (order.execution === undefined) return true;
  const execution = order.execution;
  if (!execution || typeof execution !== 'object' || order.actorId !== PLAYER
    || (order.side !== 'buy' && order.side !== 'sell')) return false;
  const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!integer(execution.filled) || execution.filled > order.quantity - order.remaining
    || !integer(execution.amount) || !integer(execution.priceLevels)) return false;
  if (execution.filled === 0) return execution.amount === 0 && execution.priceLevels === 0
    && execution.beforePrice === undefined && execution.afterPrice === undefined;
  if (execution.amount <= 0 || execution.priceLevels < 1 || execution.priceLevels > execution.filled) return false;
  if (execution.beforePrice === undefined && execution.afterPrice === undefined) return true;
  return integer(execution.beforePrice) && execution.beforePrice! > 0
    && integer(execution.afterPrice) && execution.afterPrice! > 0;
}

// Cash-backed stock leverage. These buckets are subsets of player cash/shares,
// while borrowed-sale proceeds remain separate, exactly like legacy short proceeds.
const marginAccounts = (m: Market) => m.marginState?.accounts ?? [];
const marginCash = (m: Market) => marginAccounts(m).reduce((n, a) => n + a.cash, 0);
const marginOrder = (o: Order) => !!o.marginAccountId;
function marginOwner(m: Market, o: Order) {
  const account = marginAccounts(m).find(a => a.id === o.marginAccountId)!;
  return { account, position: account?.positions.find(p => p.id === o.marginPositionId)! };
}
function marginShares(m: Market, stockId: string) {
  return marginAccounts(m).flatMap(a => a.positions).filter(p => p.stockId === stockId && p.direction === 'long')
    .reduce((n, p) => ({ quantity: n.quantity + p.quantity, today: n.today + p.today }), { quantity: 0, today: 0 });
}
function marginMetrics(m: Market, a: MarginAccount, priceOverride?: { stockId: string; price: number }) {
  let stockValue = 0, shortValue = 0, proceeds = 0, loan = 0;
  for (const p of a.positions) {
    const price = p.stockId === priceOverride?.stockId ? priceOverride.price : stockBy(m, p.stockId).price;
    if (p.direction === 'long') stockValue += p.quantity * price;
    else { shortValue += p.quantity * price; proceeds += p.proceeds; }
    loan += p.loan;
  }
  const assets = a.cash + stockValue + proceeds, debt = loan + shortValue + a.interest;
  const gross = stockValue + shortValue, equity = assets - debt;
  const pendingExposure = m.orders.filter(o=>active(o)&&o.marginAccountId===a.id&&['marginBuy','marginShort'].includes(o.side))
    .reduce((sum,o)=>sum+(o.side==='marginShort'?limits(stockBy(m,o.stockId),m.day).high:o.price)*o.remaining,0);
  const riskGross=gross+pendingExposure;
  return { assets, debt, gross, pendingExposure, equity, loan, shortValue, proceeds, ratio: riskGross ? equity / riskGross * 100 : debt ? 0 : 999 };
}
function marginTotals(m: Market, priceOverride?: { stockId: string; price: number }) {
  return marginAccounts(m).reduce((n, a) => {
    const t = marginMetrics(m, a, priceOverride);
    return { debt: n.debt + t.debt, loan: n.loan + t.loan, shortValue: n.shortValue + t.shortValue,
      restricted: n.restricted + t.proceeds, interest: n.interest + a.interest };
  }, { debt: 0, loan: 0, shortValue: 0, restricted: 0, interest: 0 });
}
function marginPending(m: Market) {
  let loan = 0, short = 0;
  for (const o of m.orders.filter(o => active(o) && marginOrder(o))) {
    const p = marginOwner(m, o).position;
    if (o.side === 'marginBuy') loan += o.price * o.remaining - Math.ceil(o.price * o.remaining / p.leverage);
    if (o.side === 'marginShort') short += limits(stockBy(m, o.stockId), m.day).high * o.remaining;
  }
  return { loan, short };
}
function marginOpenReserve(o: Order, p: MarginPosition, quantity = o.remaining) {
  return ['marginBuy', 'marginShort'].includes(o.side) ? Math.ceil(o.marginReservePrice! * quantity / p.leverage) : 0;
}
function marginFreeCash(m: Market, a: MarginAccount, except?: Order) {
  return Math.max(0, a.cash - m.orders.filter(o => o !== except && active(o) && o.marginAccountId === a.id)
    .reduce((n, o) => n + marginOpenReserve(o, marginOwner(m, o).position) + (o.side === 'marginCover' ? o.frozenCash : 0), 0));
}
function marginAvailable(m: Market, p: MarginPosition) {
  return Math.max(0, p.quantity - p.today - m.orders.filter(o => active(o) && o.marginPositionId === p.id
    && ['marginSell', 'marginCover'].includes(o.side)).reduce((n, o) => n + o.remaining, 0));
}
function marginHasCreditObligations(m: Market) {
  return marginAccounts(m).some(a => a.positions.some(p => p.loan || (p.direction === 'short' && p.quantity)) || a.interest)
    || m.orders.some(o => active(o) && (o.side === 'marginShort' || (o.side === 'marginBuy' && marginOwner(m,o).position.leverage > 1)));
}
function cancelMarginReservation(m: Market, o: Order) {
  if (!marginOrder(o) || !active(o)) return;
  const { account: a, position: p } = marginOwner(m, o);
  const refund = marginOpenReserve(o, p);
  if (refund) { a.cash -= refund; p.principal -= refund; a.contributedPrincipal -= refund; }
}
function settleMarginFees(m: Market, a: MarginAccount) {
  const pay = Math.min(a.interest, marginFreeCash(m, a));
  a.interest -= pay; a.cash -= pay; player(m).cash -= pay; m.brokerCash += pay;
}
function releaseMarginSurplus(m: Market) {
  for (const a of marginAccounts(m)) {
    const pending = m.orders.some(o => active(o) && o.marginAccountId === a.id);
    if (pending || a.positions.some(p => p.quantity)) continue;
    for (const p of a.positions) {
      const pay = Math.min(p.loan, a.cash); p.loan -= pay; a.cash -= pay; player(m).cash -= pay; m.brokerCash += pay;
    }
    settleMarginFees(m, a);
    if (!a.interest && !a.positions.some(p => p.loan)) { a.cash = 0; a.contributedPrincipal = 0; }
  }
}
function marginDailyInterest(m: Market) {
  return marginAccounts(m).reduce((sum, a) => {
    const t = marginMetrics(m, a); return sum + Math.floor((t.loan * RATE + t.shortValue * BORROW_RATE) / 365);
  }, 0);
}
function accrueMarginDay(m: Market) {
  for (const a of marginAccounts(m)) {
    const t = marginMetrics(m, a), exact = (t.loan * RATE + t.shortValue * BORROW_RATE) / 365 + a.interestRemainder;
    const fee = Math.floor(exact); a.interest += fee; a.interestRemainder = exact - fee;
    if (fee) ledger(m, '杠杆计息', `${a.mode === 'isolated' ? '逐仓' : '全仓'}账户自然日费用，按实际融资或借券计算。`, -fee);
  }
}
function marginInputError(m: Market, stockId: string, price: number): string | undefined {
  if (m.paused) return '行情已暂停，请先继续行情。';
  if (!['auction', 'morning', 'afternoon', 'closing'].includes(m.phase) || m.result) return '当前阶段不接受新委托。';
  const s = m.stocks.find(s => s.id === stockId);
  if (!s) return '股票不存在。';
  if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(cents(price)) || Math.abs(price * 100 - cents(price)) > .00001) return '委托价格须精确到分。';
  const {low, high} = limits(s, m.day);
  if (cents(price) < low || cents(price) > high) return '委托价格超出今日涨跌幅范围。';
  if (m.orders.filter(o => active(o) && o.actorId === PLAYER).length >= 100) return '请先撤销部分未成交委托。';
}
function marginCrosses(m: Market, stockId: string, side: OrderSide, price: number) {
  return m.orders.some(o => active(o) && o.actorId === PLAYER && o.stockId === stockId && buySide(o.side) !== buySide(side)
    && (buySide(side) ? price >= o.price : price <= o.price));
}
export function submitMarginOrder(m: Market, input: MarginOpenInput): ActionResult {
  if (!input || typeof input !== 'object') return fail('开仓格式不正确。');
  const error = marginInputError(m, input.stockId, input.price); if (error) return fail(error);
  if (m.day < CREDIT_UNLOCK_DAY) return fail(`杠杆交易于第 ${CREDIT_UNLOCK_DAY} 个交易日开放。`);
  if (!['isolated', 'cross'].includes(input.mode) || !['long', 'short'].includes(input.direction) || ![1,2,3].includes(input.leverage)) return fail('请选择逐仓或全仓、买涨或做空，以及 1、2、3 倍杠杆。');
  if (!Number.isFinite(input.principal) || input.principal <= 0 || !Number.isSafeInteger(cents(input.principal))
    || Math.abs(input.principal * 100 - cents(input.principal)) > .00001) return fail('请输入精确到分的本金。');
  const s = stockBy(m, input.stockId), price = cents(input.price), short = input.direction === 'short';
  if (!short && input.leverage > 1 && !s.financeEligible) return fail('该股不支持借钱买入，可选 1 倍或更换股票。');
  if (short && (!s.lendTotal || price < s.price)) return fail('该股无券源，或做空限价低于最近成交价。');
  if (short && followingTradingDate(m.calendarDate) >= m.deadlineDate) return fail('到期前没有下一交易日，无法开立 T+1 借券仓位。');
  const reservePrice = short ? limits(s, m.day).high : price;
  const quantity = Math.floor(cents(input.principal) * input.leverage / reservePrice / 100) * 100;
  if (quantity < 100 || quantity > 10_000_000) return fail('本金不足一手，或数量超过单笔 1000 万股。');
  const own = Math.ceil(reservePrice * quantity / input.leverage), loan = short ? 0 : price * quantity - own;
  if (own > freeCash(m)) return fail('普通账户可用现金不足；已有担保及杠杆资金不能重复当作本金。');
  const c = creditAccount(m), mt = marginTotals(m), pending = marginPending(m);
  if (!short && loan > 0 && loan > Math.min(FINANCE_LIMIT - m.principal - c.financePending - mt.loan - pending.loan,
    m.brokerCash - c.financePending - pending.loan)) return fail('共享融资额度不足；所有新旧仓位及挂单合计最多借款 200 万元。');
  if (short) {
    const reserved = m.orders.filter(o => active(o) && o.stockId === s.id && ['short','marginShort'].includes(o.side)).reduce((n,o)=>n+o.remaining,0);
    if (quantity > s.lendAvailable - reserved) return fail('券商剩余券源不足，请减少本金或杠杆。');
    if (mt.shortValue + pending.short + c.shortUsed + c.shortPending + reservePrice * quantity > SHORT_LIMIT) return fail('共享融券额度不足；所有新旧借券及挂单合计最多 50 万元。');
  }
  const side: OrderSide = short ? 'marginShort' : 'marginBuy';
  if (marginCrosses(m, s.id, side, price)) return fail('委托会与自己现有反向委托成交，请先撤单。');
  const existing = input.mode === 'cross' ? marginAccounts(m).find(a => a.mode === 'cross' && (a.cash || a.positions.some(p=>p.quantity||p.loan) || a.interest)) : undefined;
  if (existing && marginMetrics(m, existing).ratio < 20) return fail('全仓账户处于风险区，请先补保证金或减仓。');
  m.marginState ??= {version:1,accounts:[]};
  const a: MarginAccount = existing ?? {id:id(m,'ma'),mode:input.mode,cash:0,interest:0,interestRemainder:0,contributedPrincipal:0,positions:[]};
  if (!existing) m.marginState.accounts.push(a);
  const p: MarginPosition = {id:id(m,'mp'),stockId:s.id,direction:input.direction,leverage:input.leverage,quantity:0,today:0,cost:0,loan:0,proceeds:0,principal:own};
  a.positions.push(p); a.cash += own; a.contributedPrincipal += own;
  const orderId = id(m,'o');
  m.orders.push({id:orderId,actorId:PLAYER,stockId:s.id,side,quantity,remaining:quantity,price,status:'open',time:clock(m),sequence:m.sequence,day:m.day,
    createdTick:m.tickCount,frozenCash:0,restrictedClaim:0,marginAccountId:a.id,marginPositionId:p.id,marginReservePrice:reservePrice});
  ledger(m,'杠杆开仓',`${s.name} ${input.mode === 'isolated' ? '逐仓' : '全仓'} ${input.leverage} 倍${short ? '做空' : '买涨'}，预留本金 ${yuan(own).toFixed(2)} 元；借款与借券只在成交后产生。`);
  if (m.phase === 'morning' || m.phase === 'afternoon') matchContinuous(m,s.id);
  updateRisk(m); m.revision++;
  return ok('委托已提交，本金自动划入对应账户；未成交部分可撤销。');
}
export function closeMarginPosition(m: Market, input: MarginCloseInput, forced = false): ActionResult {
  if (!input || typeof input !== 'object') return fail('平仓格式不正确。');
  const a = marginAccounts(m).find(a=>a.positions.some(p=>p.id===input.positionId)), p = a?.positions.find(p=>p.id===input.positionId);
  if (!a || !p) return fail('仓位不存在。');
  if (!forced) { const error=marginInputError(m,p.stockId,input.price); if(error) return fail(error); }
  if (!Number.isSafeInteger(input.quantity) || input.quantity<=0 || input.quantity%100 || input.quantity>marginAvailable(m,p)) return fail('可平仓数量不足；当日新仓须下一交易日才能平仓。');
  const s=stockBy(m,p.stockId),price=cents(input.price),q=input.quantity,side:OrderSide=p.direction==='long'?'marginSell':'marginCover';
  if (marginCrosses(m,s.id,side,price)) {
    if(!forced) return fail('平仓会与自己现有反向委托成交，请先撤单。');
    for(const o of m.orders.filter(o=>active(o)&&o.actorId===PLAYER&&o.stockId===s.id&&buySide(o.side)!==buySide(side)
      &&(buySide(side)?price>=o.price:price<=o.price))) {
      cancelMarginReservation(m,o);o.status='cancelled';o.frozenCash=0;o.restrictedClaim=0;
    }
  }
  const claim=p.direction==='short'?Math.floor(p.proceeds*q/p.quantity):0, frozen=p.direction==='short'?Math.max(0,price*q-claim):0;
  if(frozen>marginFreeCash(m,a)) return fail('该保证金账户现金不足以买回还券，请补入保证金或减少平仓数量；不会自动动用其他账户。');
  const orderId=id(m,'o');
  m.orders.push({id:orderId,actorId:PLAYER,stockId:s.id,side,quantity:q,remaining:q,price,status:'open',time:clock(m),sequence:m.sequence,day:m.day,
    createdTick:m.tickCount,frozenCash:frozen,restrictedClaim:claim,forced,marginAccountId:a.id,marginPositionId:p.id});
  if(m.phase==='morning'||m.phase==='afternoon') matchContinuous(m,s.id);
  m.revision++; return ok('平仓委托已提交；实际成交后归还本仓借款或借券。');
}
export function addMargin(m: Market, input: MarginAddInput): ActionResult {
  if(m.result || m.phase==='ended') return fail('本轮已结算。');
  const a=marginAccounts(m).find(a=>a.id===input?.accountId);
  if(!a || !Number.isFinite(input.amount)||input.amount<=0||!Number.isSafeInteger(cents(input.amount))
    ||Math.abs(input.amount*100-cents(input.amount))>.00001) return fail('请选择账户并输入精确到分的保证金。');
  if(cents(input.amount)>freeCash(m)) return fail('普通账户可用现金不足。');
  a.cash+=cents(input.amount); a.contributedPrincipal+=cents(input.amount); cancelRecoveredMarginOrders(m); releaseMarginSurplus(m); m.revision++;
  return ok('保证金已补入，其他账户资产不会自动划入。');
}
function marginCanFill(m: Market, o: Order, price: number, q: number): boolean {
  const {account:a,position:p}=marginOwner(m,o);
  if(!a||!p) return false;
  const t=marginMetrics(m,a,{stockId:p.stockId,price});
  if(o.forced && marginMetrics(m,a).ratio>=20) return false;
  if(o.side==='marginCover') return price*q-Math.floor(p.proceeds*q/p.quantity)<=marginFreeCash(m,a,o);
  if(!['marginBuy','marginShort'].includes(o.side)) return true;
  const value=price*q, own=o.side==='marginBuy'?Math.min(Math.ceil(value/p.leverage),marginOpenReserve(o,p)-marginOpenReserve(o,p,o.remaining-q)):0,c=creditAccount(m),mt=marginTotals(m), pending=marginPending(m);
  if(o.side==='marginBuy') {
    const releasedLoan=o.price*o.remaining-Math.ceil(o.price*o.remaining/p.leverage)
      -(o.price*(o.remaining-q)-Math.ceil(o.price*(o.remaining-q)/p.leverage));
    if(own>marginFreeCash(m,a,o) || (value-own>0 && (value-own>m.brokerCash-c.financePending-pending.loan+releasedLoan
      ||m.principal+c.financePending+mt.loan+pending.loan-releasedLoan+value-own>FINANCE_LIMIT))) return false;
  } else {
    const repriced=marginAccounts(m).flatMap(a=>a.positions).filter(p=>p.direction==='short'&&p.stockId===o.stockId)
      .reduce((n,p)=>n+p.quantity*(price-stockBy(m,o.stockId).price),0)
      +(m.shorts[o.stockId]?.quantity??0)*(price-stockBy(m,o.stockId).price);
    if(stockBy(m,o.stockId).lendAvailable<q||mt.shortValue+pending.short+c.shortUsed+c.shortPending+repriced
      -limits(stockBy(m,o.stockId),m.day).high*q+value>SHORT_LIMIT) return false;
  }
  // Full pending exposure is already cash reserved. A falling existing cross
  // account cannot keep executing old expansion orders below the warning line.
  const unfilledPrincipal=m.orders.filter(other=>active(other)&&other.marginAccountId===a.id&&['marginBuy','marginShort'].includes(other.side))
    .reduce((sum,other)=>sum+marginOpenReserve(other,marginOwner(m,other).position,other.remaining-(other===o?q:0)),0);
  return (t.gross+value)===0 || (t.equity-unfilledPrincipal)/(t.gross+value)*100>=20;
}
function fillMarginLeg(m: Market,o:Order,price:number,q:number) {
  const {account:a,position:p}=marginOwner(m,o),s=stockBy(m,o.stockId),value=price*q, actor=player(m);
  if(o.side==='marginBuy') {
    const released=marginOpenReserve(o,p)-marginOpenReserve(o,p,o.remaining-q);
    const own=Math.min(Math.ceil(value/p.leverage),released),loan=value-own,refund=released-own;
    a.cash-=own+refund; actor.cash-=own; p.loan+=loan; m.brokerCash-=loan; p.quantity+=q;p.today+=q;p.cost+=value;
    a.contributedPrincipal-=refund;p.principal-=refund;
    const pos=position(actor,s.id); pos.quantity+=q;pos.today+=q;pos.cost+=value;
  } else if(o.side==='marginShort') {
    p.quantity+=q;p.today+=q;p.cost+=value;p.proceeds+=value;s.lendAvailable-=q;
  } else if(o.side==='marginSell') {
    const due=q===p.quantity?p.loan:Math.floor(p.loan*q/p.quantity);
    const soldCost=q===p.quantity?p.cost:Math.floor(p.cost*q/p.quantity);p.cost-=soldCost;p.quantity-=q;
    const pos=position(actor,s.id);pos.cost-=soldCost;pos.quantity-=q;
    actor.cash+=value;a.cash+=value;
    const pay=Math.min(due,marginFreeCash(m,a,o));p.loan-=pay;a.cash-=pay;actor.cash-=pay;m.brokerCash+=pay;
  } else {
    const released=q===p.quantity?p.proceeds:Math.floor(p.proceeds*q/p.quantity);
    p.cost-=q===p.quantity?p.cost:Math.floor(p.cost*q/p.quantity);p.quantity-=q;p.proceeds-=released;
    a.cash+=released-value;actor.cash+=released-value;s.lendAvailable+=q;
  }
}
function cancelRecoveredMarginOrders(m: Market) {
  for(const a of marginAccounts(m)) if(marginMetrics(m,a).ratio>=20) {
    for(const o of m.orders.filter(o=>active(o)&&o.forced&&o.marginAccountId===a.id)) {
      o.status='cancelled';o.frozenCash=0;o.restrictedClaim=0;
    }
  }
}
function forceMarginLiquidation(m: Market) {
  cancelRecoveredMarginOrders(m);
  if(!['auction','morning','afternoon','closing'].includes(m.phase)||m.result) return;
  for(const a of marginAccounts(m)) {
    if(marginMetrics(m,a).ratio>=10) continue;
    for(const o of m.orders.filter(o=>active(o)&&o.marginAccountId===a.id&&['marginBuy','marginShort'].includes(o.side))) {
      cancelMarginReservation(m,o);o.status='cancelled';o.frozenCash=0;
    }
    for(const p of a.positions) {
      let q=marginAvailable(m,p); if(!q) continue;
      const lim=limits(stockBy(m,p.stockId),m.day);
      let price=lim.low;
      if(p.direction==='short') {
        const bestAsk=book(m,p.stockId).asks.find(o=>o.actorId!==PLAYER)?.price;
        price=Math.min(lim.high,bestAsk??lim.high);
        const unitDeficit=price-p.proceeds/p.quantity,cash=marginFreeCash(m,a);
        if(unitDeficit>0) q=Math.min(q,Math.floor(cash/unitDeficit/100)*100);
        if(!q) { q=Math.min(100,marginAvailable(m,p)); price=Math.min(price,Math.floor((cash+Math.floor(p.proceeds*q/p.quantity))/q)); }
        while(q>0 && price*q-Math.floor(p.proceeds*q/p.quantity)>cash) q-=100;
        if(!q||price<lim.low) continue;
      }
      const result=closeMarginPosition(m,{positionId:p.id,quantity:q,price:yuan(price)},true);
      if(result.ok) ledger(m,'杠杆强平',`${stockBy(m,p.stockId).name}保证金率低于 10%，已向市场提交平仓；成交及 T+1 限制仍生效。`);
    }
  }
}
function settleMarginMaturity(m: Market) {
  // Do not fake a sale/cover or sweep other buckets at the deadline.
  for(const a of marginAccounts(m)) {
    for(const p of a.positions) { const pay=Math.min(p.loan,a.cash);p.loan-=pay;a.cash-=pay;player(m).cash-=pay;m.brokerCash+=pay; }
    settleMarginFees(m,a);
  }
  releaseMarginSurplus(m);
}
function marginForView(m: Market): MarginView {
  const mt=marginTotals(m), pending=marginPending(m),c=creditAccount(m);
  const visible=marginAccounts(m).filter(a=>a.cash||a.interest||a.positions.some(p=>p.quantity||p.loan)
    ||m.orders.some(o=>active(o)&&o.marginAccountId===a.id));
  return {accounts:visible.map(a=>{const t=marginMetrics(m,a);return {id:a.id,mode:a.mode,cash:yuan(a.cash),assets:yuan(t.assets),equity:yuan(t.equity),debt:yuan(t.debt),grossExposure:yuan(t.gross+t.pendingExposure),pendingExposure:yuan(t.pendingExposure),marginRatio:t.ratio,riskLevel:t.ratio<10?'liquidating':t.ratio<20?'warning':'normal',interest:yuan(a.interest),contributedPrincipal:yuan(a.contributedPrincipal)};}),
    positions:visible.flatMap(a=>a.positions.filter(p=>p.quantity||p.loan||m.orders.some(o=>active(o)&&o.marginPositionId===p.id)).map(p=>{
      const s=stockBy(m,p.stockId),value=s.price*p.quantity;
      const liq=a.mode==='isolated'&&p.quantity ? p.direction==='long'?Math.max(0,(p.loan+a.interest-a.cash)/(.9*p.quantity)):(a.cash+p.proceeds-a.interest)/(1.1*p.quantity):null;
      return {id:p.id,accountId:a.id,stockId:p.stockId,direction:p.direction,leverage:p.leverage,quantity:p.quantity,availableQuantity:marginAvailable(m,p),todayQuantity:p.today,entryPrice:p.quantity?yuan(p.cost/p.quantity):0,currentPrice:yuan(s.price),principal:yuan(p.principal),loan:yuan(p.loan),lockedProceeds:yuan(p.proceeds),unrealizedPnl:yuan(p.direction==='long'?value-p.cost:p.cost-value),marketValue:yuan(value),liquidationPrice:liq===null?null:yuan(Math.max(0,liq))};})),
    financeLimit:yuan(FINANCE_LIMIT),financeUsed:yuan(m.principal+mt.loan+c.financePending+pending.loan),financeAvailable:yuan(Math.max(0,Math.min(FINANCE_LIMIT-m.principal-mt.loan-c.financePending-pending.loan,m.brokerCash-c.financePending-pending.loan))),
    shortLimit:yuan(SHORT_LIMIT),shortUsed:yuan(c.shortUsed+c.shortPending+mt.shortValue+pending.short),shortAvailable:yuan(Math.max(0,SHORT_LIMIT-c.shortUsed-c.shortPending-mt.shortValue-pending.short)),
    warningRatio:20,liquidationRatio:10,totalDebt:yuan(mt.debt),financingDebt:yuan(mt.loan),interest:yuan(mt.interest),dailyInterest:yuan(marginDailyInterest(m))};
}
function validMarginState(m: Market): boolean {
  if(m.marginState===undefined) return true;
  const state=m.marginState, nonnegative=(n:unknown)=>Number.isSafeInteger(n)&&(n as number)>=0;
  if(!state||state.version!==1||!Array.isArray(state.accounts)||state.accounts.length>10000) return false;
  const ids=new Set<string>(),pids=new Set<string>();
  for(const a of state.accounts) {
    if(!a||typeof a.id!=='string'||ids.has(a.id)||!['isolated','cross'].includes(a.mode)||![a.cash,a.interest,a.contributedPrincipal].every(nonnegative)
      ||!Number.isFinite(a.interestRemainder)||a.interestRemainder<0||a.interestRemainder>=1||!Array.isArray(a.positions)||a.positions.length>10000||(a.mode==='isolated'&&a.positions.length!==1)) return false;
    ids.add(a.id);
    for(const p of a.positions) {
      if(!p||typeof p.id!=='string'||pids.has(p.id)||!m.stocks.some(s=>s.id===p.stockId)||!['long','short'].includes(p.direction)||![1,2,3].includes(p.leverage)
        ||![p.quantity,p.today,p.cost,p.loan,p.proceeds,p.principal].every(nonnegative)||p.quantity%100||p.today%100||p.today>p.quantity
        ||(p.direction==='long'&&p.proceeds!==0)||(p.direction==='short'&&p.loan!==0)
        ||(!p.quantity&&(p.cost!==0||p.proceeds!==0))) return false;
      pids.add(p.id);
    }
  }
  for(const o of m.orders) {
    if(!marginOrder(o)) {if(o.side.startsWith('margin')) return false;continue;}
    const {account:a,position:p}=marginOwner(m,o);
    if(!a||!p||p.stockId!==o.stockId||!['marginBuy','marginSell','marginShort','marginCover'].includes(o.side)
      ||(p.direction==='long'?!['marginBuy','marginSell'].includes(o.side):!['marginShort','marginCover'].includes(o.side))
      ||(['marginBuy','marginShort'].includes(o.side)&&!nonnegative(o.marginReservePrice))) return false;
  }
  const ordinaryFrozen=m.orders.filter(o=>active(o)&&o.actorId===PLAYER&&o.side==='buy').reduce((sum,o)=>sum+o.frozenCash,0)+ipoReservedCash(m);
  if(marginCash(m)+(m.creditAccount?.cash??0)+ordinaryFrozen>player(m).cash) return false;
  for(const s of m.stocks) {
    const p=player(m).positions[s.id],cp=m.creditAccount?.positions?.[s.id],mp=marginShares(m,s.id);
    if(mp.quantity+(cp?.quantity??0)>(p?.quantity??0)||mp.today+(cp?.today??0)>(p?.today??0)
      ||(p?.today??0)-mp.today-(cp?.today??0)>(p?.quantity??0)-mp.quantity-(cp?.quantity??0)) return false;
    const borrowed=marginAccounts(m).flatMap(a=>a.positions).filter(p=>p.stockId===s.id&&p.direction==='short').reduce((n,p)=>n+p.quantity,0)+(m.shorts[s.id]?.quantity??0);
    if(borrowed+s.lendAvailable!==s.lendTotal) return false;
  }
  for(const a of state.accounts) {
    const reserved=m.orders.filter(o=>active(o)&&o.marginAccountId===a.id).reduce((sum,o)=>sum+marginOpenReserve(o,marginOwner(m,o).position)+(o.side==='marginCover'?o.frozenCash:0),0);
    if(reserved>a.cash) return false;
    for(const p of a.positions) {
      const closing=m.orders.filter(o=>active(o)&&o.marginPositionId===p.id&&['marginSell','marginCover'].includes(o.side)).reduce((sum,o)=>sum+o.remaining,0);
      if(closing>p.quantity-p.today) return false;
    }
  }
  return true;
}
