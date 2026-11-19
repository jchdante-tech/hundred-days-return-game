import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, getView, nextDay, advancePhase, submitOrder, validateMarket, type Market } from './engine.js';
import { initNewsArcs } from './news-arcs.js';
import { initializeAgents, initializeListedStock } from './market-agents.js';
import { advanceIpo, initIpo, subscribeIpo, ipoReservedCash, type IpoFinance } from './ipo.js';

const additions = ['s17', 's18', 's19', 's20', 's21', 's22'];
const cashSupply = (m: Market) => m.actors.reduce((sum, actor) => sum + actor.cash, 0) + m.brokerCash;
const shares = (m: Market, id: string) => m.actors.reduce((sum, actor) => sum + (actor.positions[id]?.quantity ?? 0), 0);
const player = (m: Market) => m.actors.find(actor => actor.id === 'player')!;

/** Reproduce the supported 12-stock save rather than deleting live plans from an expanded game. */
function oldMarket(seed = 42, simulation: 'modern' | 'unmarked' = 'modern'): Market {
  const m = createMarket(seed, { legacySimulation: true });
  m.stocks = m.stocks.filter(stock => !additions.includes(stock.id));
  for (const actor of m.actors) for (const id of additions) delete actor.positions[id];
  delete m.stockUniverseVersion;
  m.orders = []; m.news = [];
  if (simulation === 'modern') {
    initNewsArcs(m);
    let seed = 721;
    initializeAgents(m, { legacy: false }, () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000));
    m.simulationVersion = 2;
    initIpo(m);
  } else delete m.simulationVersion;
  getView(m); // Existing view code materializes zero-valued player/credit slots.
  assert.ok(validateMarket(m), 'fixture must be a supported old save');
  return m;
}

function nextOpening(m: Market) {
  m.phase = 'night'; m.phaseElapsed = 149;
  nextDay(m);
  assert.equal(m.phase, 'auction');
  assert.equal(m.phaseElapsed, 0);
}

function opening(m: Market, day: number) {
  const date = new Date('2026-10-20T00:00:00Z');
  for (let tradingDay = 1; tradingDay < day; tradingDay++) {
    do { date.setUTCDate(date.getUTCDate() + 1); }
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  }
  m.day = day; m.phase = 'auction'; m.phaseElapsed = 0;
  m.calendarDate = date.toISOString().slice(0, 10);
  m.elapsedDays = Math.round((date.getTime() - Date.parse('2026-10-20T00:00:00Z')) / 86_400_000);
}

test('expanded opening has six readable sectors, eighteen companies and reserved IPO identities', () => {
  const m = createMarket(42), view = getView(m);
  assert.equal(m.stockUniverseVersion, 1);
  assert.equal(view.stocks.length, 18);
  assert.deepEqual([...new Set(view.stocks.map(stock => stock.sector))].sort(), ['半导体', '光通信', '电力', '机器人', '创新药', '大消费'].sort());
  assert.equal(new Set(view.stocks.map(stock => stock.name)).size, 18);
  assert.equal(view.stocks.some(stock => /^s1[3-6]$/.test(stock.id)), false, 'IPO identifiers cannot be reused as base stocks');
  assert.equal(view.cash, 10_000_000);
  for (const id of additions) {
    const stock = m.stocks.find(stock => stock.id === id)!, publicStock = view.stocks.find(stock => stock.id === id)!;
    assert.equal(stock.listedDay, undefined, 'coverage expansion is not an IPO');
    assert.equal(stock.dailyBars!.filter(bar => bar.origin === 'background').length, 60);
    assert.equal(stock.dailyBars!.at(-1)!.close, stock.previousClose);
    assert.equal(stock.dailyHistoryStartDay, 1);
    assert.equal(shares(m, id), 1_800_000, 'tradable inventory is finite and backed by actors');
    assert.ok(Number.isFinite(publicStock.pe) && publicStock.pe > 0);
    assert.ok(Number.isFinite(publicStock.marketCap) && publicStock.marketCap > 0);
  }
  assert.ok(view.stocks.some(stock => stock.shortEligible));
  assert.ok(view.stocks.some(stock => !stock.shortEligible));
  assert.ok(validateMarket(JSON.parse(JSON.stringify(m))));
});

test('reading an old in-progress save does not add symbols or alter money, plans or pending orders', () => {
  const m = oldMarket();
  m.paused = false;
  assert.equal(submitOrder(m, { stockId: 's1', side: 'buy', quantity: 1000, price: 10.8 }).ok, true);
  const before = structuredClone(m);
  assert.equal(getView(m).stocks.length, 12);
  assert.deepEqual(m, before);
  assert.equal(m.stockUniverseVersion, undefined);
  assert.ok(validateMarket(m));
});

test('opening expansion preserves existing assets and gives each new stock one finite background allocation', () => {
  const m = oldMarket(), holder = m.actors.find(actor => actor.id === 'crowd0')!;
  holder.positions.s1.quantity -= 100;
  holder.positions.s1.cost -= 120_000;
  player(m).positions.s1 = { quantity: 100, today: 0, financed: 0, cost: 120_000 };
  const before = structuredClone(m), totalCash = cashSupply(m);
  nextOpening(m);
  assert.equal(m.stocks.length, 18);
  assert.equal(m.stockUniverseVersion, 1);
  assert.equal(cashSupply(m), totalCash);
  assert.equal(player(m).cash, player(before).cash);
  assert.equal(m.brokerCash, before.brokerCash);
  for (const actor of before.actors) {
    const current = m.actors.find(item => item.id === actor.id)!;
    assert.equal(current.cash, actor.cash);
    for (const [id, position] of Object.entries(actor.positions)) assert.deepEqual(current.positions[id], position);
  }
  for (const previous of before.stocks) {
    const current = m.stocks.find(stock => stock.id === previous.id)!;
    assert.equal(current.price, previous.price);
    assert.equal(current.fair, previous.fair);
    assert.deepEqual(current.dailyBars, previous.dailyBars, 'played and background history must not be replaced');
    assert.equal(shares(m, previous.id), shares(before, previous.id));
  }
  for (const id of additions) {
    assert.equal(shares(m, id), 1_800_000);
    for (const crowd of m.actors.filter(actor => actor.id.startsWith('crowd'))) assert.equal(crowd.positions[id].quantity, 600_000);
    assert.equal(player(m).positions[id]?.quantity ?? 0, 0);
    assert.equal(m.stocks.find(stock => stock.id === id)!.dailyHistoryStartDay, 2);
    assert.equal(m.stocks.find(stock => stock.id === id)!.dailyBars!.filter(bar => bar.origin !== 'background').length, 0);
  }
  assert.ok(m.news.some(item => /行情牌扩容/.test(item.headline)));
  assert.ok(validateMarket(JSON.parse(JSON.stringify(m))));
  nextOpening(m);
  assert.equal(m.stocks.length, 18);
  assert.equal(cashSupply(m), totalCash);
  for (const id of additions) assert.equal(shares(m, id), 1_800_000, 'later openings must not issue duplicate inventory');
  assert.ok(validateMarket(m));
});

test('a pre-agent legacy save can adopt both the new actors and stock universe without creating cash', () => {
  const m = oldMarket(52, 'unmarked'), cash = cashSupply(m), oldShares = m.stocks.map(stock => [stock.id, shares(m, stock.id)] as const);
  nextOpening(m);
  assert.equal(m.simulationVersion, 2);
  assert.equal(m.stockUniverseVersion, 1);
  assert.equal(cashSupply(m), cash);
  for (const [id, quantity] of oldShares) assert.equal(shares(m, id), quantity);
  for (const id of additions) assert.equal(shares(m, id), 1_800_000);
  assert.ok(validateMarket(m));
});

test('old saves with a listed IPO retain its identity, valuation and holdings when coverage expands', () => {
  const m = oldMarket(42);
  const finance: IpoFinance = {
    availableCash: id => Math.max(0, m.actors.find(actor => actor.id === id)!.cash - ipoReservedCash(m, id)),
    equity: id => {
      const actor = m.actors.find(actor => actor.id === id)!;
      return actor.cash + m.stocks.reduce((sum, stock) => sum + (actor.positions[stock.id]?.quantity ?? 0) * stock.price, 0);
    },
  };
  const offer = m.ipoState!.offers[0];
  opening(m, offer.announcementDay);
  advanceIpo(m, finance);
  assert.equal(subscribeIpo(m, offer.id, 1000, finance).ok, true);
  opening(m, offer.listingDay);
  advanceIpo(m, finance);
  assert.equal(offer.status, 'listed');
  const ipo = m.stocks.find(stock => stock.id === offer.stockId)!;
  m.storyState!.expectations[ipo.id] = { premium: 0, realizedPremium: 0, conviction: .5, updatedDay: m.day, activeStoryIds: [] };
  initializeListedStock(m, ipo);
  ipo.price = Math.round(ipo.issuePrice! * 1.07);
  assert.ok(validateMarket(m));
  const before = structuredClone(m), view = getView(m).stocks.find(stock => stock.id === ipo.id)!;
  assert.equal(view.pe, ipo.pe * ipo.price / ipo.issuePrice!);
  nextOpening(m);
  const after = getView(m).stocks.find(stock => stock.id === ipo.id)!;
  assert.equal(m.stocks.length, 19);
  assert.equal(after.name, view.name);
  assert.equal(after.pe, view.pe);
  assert.equal(ipo.fair, before.stocks.find(stock => stock.id === ipo.id)!.fair);
  assert.equal(shares(m, ipo.id), shares(before, ipo.id));
  assert.equal(player(m).positions[ipo.id]?.quantity, player(before).positions[ipo.id]?.quantity);
  assert.equal(ipo.dailyBars!.some(bar => bar.origin === 'background'), false, 'IPO candles must not become fabricated pregame candles');
  assert.equal(cashSupply(m), cashSupply(before));
  assert.ok(validateMarket(m));
});

test('unknown universe versions and mismatched catalogs are rejected without rewriting', () => {
  const m = createMarket(42), unknown = structuredClone(m) as Omit<Market, 'stockUniverseVersion'> & { stockUniverseVersion?: number };
  unknown.stockUniverseVersion = 999;
  const before = structuredClone(unknown);
  assert.equal(validateMarket(unknown), false);
  assert.deepEqual(unknown, before);
  const missing = structuredClone(m); missing.stocks = missing.stocks.filter(stock => stock.id !== 's22');
  assert.equal(validateMarket(missing), false);
  const unmarked = structuredClone(m); delete unmarked.stockUniverseVersion;
  assert.equal(validateMarket(unmarked), false, 'unmarked expanded files must not be expanded a second time');
  const duplicate = structuredClone(m); duplicate.stocks.push(structuredClone(duplicate.stocks[0]));
  assert.equal(validateMarket(duplicate), false);
});

test('archived reviews use the sectors that were covered that day and still reject missing or premature rows', () => {
  const m = oldMarket();
  nextOpening(m);
  assert.equal(m.postClose!.day, 1);
  assert.equal(m.postClose!.sectorFlows.length, 3);
  assert.ok(validateMarket(m), 'a three-sector review remains valid after the opening expansion');
  const missingOldSector = structuredClone(m);
  missingOldSector.postClose!.sectorFlows.pop();
  assert.equal(validateMarket(missingOldSector), false, 'historical reviews still require every sector covered then');
  const premature = structuredClone(m);
  premature.postClose!.sectorFlows.push({ sector: '机器人', inflow: 0, outflow: 0, neutral: 0, net: 0, turnover: 0 });
  assert.equal(validateMarket(premature), false, 'a new sector cannot appear in a pre-expansion report');
  nextOpening(m);
  assert.equal(m.postClose!.sectorFlows.length, 6);
  assert.equal(m.postCloseHistory!.find(report => report.day === 1)!.sectorFlows.length, 3);
  assert.ok(validateMarket(m));
  const missingNewSector = structuredClone(m);
  missingNewSector.postClose!.sectorFlows = missingNewSector.postClose!.sectorFlows.filter(row => row.sector !== '机器人');
  assert.equal(validateMarket(missingNewSector), false, 'post-expansion reviews require the new sectors too');
  for (const value of [0, -1, 1.5, m.day + 1]) {
    const invalid = structuredClone(m);
    (invalid.stocks.find(stock => stock.id === 's17')! as Market['stocks'][number] & { coverageStartDay?: number }).coverageStartDay = value;
    assert.equal(validateMarket(invalid), false, `invalid coverage start ${value}`);
  }
});

test('new sectors have real matched liquidity while named seats retain two-target budgets', () => {
  const m = createMarket(42), cash = cashSupply(m);
  for (let phase = 0; phase < 5; phase++) advancePhase(m);
  assert.equal(m.phase, 'night');
  assert.equal(cashSupply(m), cash);
  for (const id of additions) {
    const stock = m.stocks.find(stock => stock.id === id)!, trades = m.trades.filter(trade => trade.stockId === id && trade.day === m.day);
    assert.ok(trades.length > 0, `${id} must trade against funded counterparts`);
    assert.ok(trades.every(trade => trade.buyerId !== trade.sellerId && trade.quantity > 0));
    assert.equal(stock.volume, trades.reduce((sum, trade) => sum + trade.quantity, 0));
    assert.equal(stock.turnover, trades.reduce((sum, trade) => sum + trade.quantity * trade.price, 0));
    assert.equal(shares(m, id), 1_800_000);
  }
  for (const [id, plan] of Object.entries(m.agentSimulation!.plans)) {
    assert.ok(plan.dayBuyIds.length <= 2);
    assert.ok(new Set(m.trades.filter(trade => trade.buyerId === id && trade.day === m.day).map(trade => trade.stockId)).size <= 2);
  }
  assert.equal(getView(m).postClose!.sectorFlows.length, 6);
  assert.ok(validateMarket(m));
});

test('new sector stories disclose linked companies and impact labels at their public stage', () => {
  const seen = new Set<string>();
  for (let sample = 1; sample <= 80; sample++) {
    const m = createMarket(Math.imul(sample, 2654435761) >>> 0), view = getView(m);
    for (const article of view.news.filter(news => news.storyId)) {
      const linked = view.stocks.filter(stock => article.stockIds?.includes(stock.id));
      assert.ok(linked.length > 0);
      assert.ok(article.impacts.every(impact => linked.some(stock => stock.sector === impact.sector)));
      for (const stock of linked.filter(stock => additions.includes(stock.id))) seen.add(stock.sector);
    }
    if (seen.size === 3) break;
  }
  assert.deepEqual([...seen].sort(), ['机器人', '创新药', '大消费'].sort());
});
