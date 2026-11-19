import { BASE_STOCKS } from './stock-catalog.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarket, advancePhase, nextDay, submitOrder, cancelOrder, repay, getView, tick, validateMarket, transferCreditCollateral, ensureCreditAccount,
  type Market,
} from './engine.js';

function monetarySupply(m: Market) {
  return m.brokerCash + m.actors.reduce((n, a) => n + a.cash, 0)
    + Object.values(m.shorts).reduce((n, s) => n + s.proceeds, 0) + (m.challenge?.paid ?? 0);
}
function shares(m: Market, stockId: string) {
  return m.actors.reduce((n, a) => n + (a.positions[stockId]?.quantity ?? 0), 0)
    + m.stocks.find(s => s.id === stockId)!.lendAvailable;
}
function continuous(seed = 42) {
  // A controlled unit fixture starts with the known seed order book. User-facing
  // advancePhase is tested separately and now executes all intervening AI activity.
  // Keep the historical fixed-depth book for exact matching assertions.
  const m = createMarket(seed, { legacySimulation: true }); m.paused = false; m.phase = 'morning'; return m;
}
// Preserve the prior contract explicitly when exercising legacy credit accounting.
function legacyMarket(seed = 42) {
  const m = createMarket(seed); delete m.challenge; delete m.creditAccount;
  m.principal = 1_000_000_000; m.actors[0].cash = 400_000_000;
  m.actors[0].positions.s1 = { quantity: 1_000_000, today: 0, financed: 1_000_000, cost: 1_600_000_000 };
  return m;
}
function legacyContinuous(seed = 42) {
  const m = legacyMarket(seed); m.paused = false; m.phase = 'morning'; return m;
}
function unlockCredit(m: Market) {
  m.day = 20; m.calendarDate = '2026-11-16'; m.elapsedDays = 27;
  ensureCreditAccount(m);
  if (!m.creditAccount!.cash) assert.equal(transferCreditCollateral(m, {direction: 'in', cash: 2_000_000}).ok, true);
  return m;
}
function giveOldShares(m: Market, quantity = 100) {
  // Transfer a prior-day holding from an AI fixture rather than manufacturing shares.
  m.actors[1].positions.s1.quantity -= quantity;
  m.actors[1].positions.s1.cost -= quantity * m.stocks[0].price;
  m.actors[0].positions.s1 = { quantity, today: 0, financed: 0, cost: quantity * m.stocks[0].price };
}
function assertLedgers(m: Market) {
  assert.ok(m.principal >= 0 && Number.isSafeInteger(m.principal));
  assert.ok(m.interest >= 0 && Number.isSafeInteger(m.interest));
  for (const a of m.actors) {
    assert.ok(a.cash >= 0 && Number.isSafeInteger(a.cash), `${a.id} cash ${a.cash}`);
    for (const [id, p] of Object.entries(a.positions)) {
      assert.ok(p.quantity >= 0 && Number.isInteger(p.quantity), `${a.id}/${id} quantity`);
      assert.ok(p.today >= 0 && p.today <= p.quantity, `${a.id}/${id} T+1`);
      assert.ok(p.financed >= 0 && p.financed <= p.quantity);
      assert.ok(p.cost >= 0 && Number.isSafeInteger(p.cost));
    }
  }
  for (const s of m.stocks) {
    assert.ok(s.lendAvailable >= 0 && s.lendAvailable <= s.lendTotal);
    assert.equal(s.lendAvailable + (m.shorts[s.id]?.quantity ?? 0), s.lendTotal);
    const rate = s.listedDay === m.day ? .3 : .1;
    assert.ok(s.price >= Math.round(s.previousClose * (1 - rate)) && s.price <= Math.round(s.previousClose * (1 + rate)));
  }
}

test('initial equity, finite accounts, DTO exclusion and history provenance', () => {
  const m = createMarket(7), view = getView(m);
  assert.equal(view.assets, 10_000_000);
  assert.equal(view.debt, 0);
  assert.equal(view.equity, 10_000_000);
  assert.equal(view.interest, 0);
  assert.equal(view.maintenance, 999);
  assert.deepEqual(view.positions, []);
  assert.deepEqual(view.challenge, { target: 100_000_000, paid: 0, remaining: 100_000_000, startingCapital: 10_000_000 });
  assert.equal(view.riskLevel, 'normal');
  assert.equal(view.creditUnlocked, false);
  assert.equal(view.stocks.length, BASE_STOCKS.length);
  assert.deepEqual(view.stocks.filter(s => s.shortEligible).map(s => s.id), ['s5', 's9', 's21']);
  assert.equal(view.daysLeft, 100);
  assert.equal(view.deadlineDate, '2027-01-28');
  assert.ok(view.stocks.every(s => s.history.length === 0));
  for (const forbidden of ['seed', 'rngState', 'actors', 'brokerCash', 'fair', 'newsBias'])
    assert.equal(Object.hasOwn(view, forbidden), false);
  assert.ok(view.stocks.every(s => !Object.hasOwn(s, 'fair') && !Object.hasOwn(s, 'newsBias')));
  view.stocks[0].concepts.push('MUTATION');
  assert.equal(m.stocks[0].concepts.includes('MUTATION'), false);
});

test('price/time priority, partial fills, limit reservations and cancellation release', () => {
  const m = continuous();
  const cash = m.actors[0].cash;
  const result = submitOrder(m, { stockId: 's2', side: 'buy', quantity: 2500, price: 28.05 });
  assert.equal(result.ok, true);
  const fills = m.trades.filter(t => t.playerSide === 'buy');
  assert.deepEqual(fills.map(t => [t.price, t.quantity]), [[2801, 2000], [2803, 500]]);
  assert.equal(m.actors[0].cash, cash - 2801 * 2000 - 2803 * 500);
  assert.equal(getView(m).frozenCash, 0);
  const before = getView(m).availableCash;
  assert.equal(submitOrder(m, { stockId: 's2', side: 'buy', quantity: 100, price: 25.20 }).ok, true);
  assert.equal(getView(m).availableCash, before - 2520);
  const resting = getView(m).orders[0];
  assert.equal(resting.frozenCash, 2520);
  assert.equal(cancelOrder(m, resting.id).ok, true);
  assert.equal(getView(m).availableCash, before);
  assert.equal(cancelOrder(m, resting.id).ok, false);
});

test('T+1 rejects same-day sales and releases stock only on next trading day', () => {
  const m = continuous();
  assert.equal(submitOrder(m, { stockId: 's2', side: 'buy', quantity: 100, price: 28.01 }).ok, true);
  assert.equal(getView(m).positions.find(p => p.stockId === 's2')!.available, 0);
  assert.equal(submitOrder(m, { stockId: 's2', side: 'sell', quantity: 100, price: 27.99 }).ok, false);
  nextDay(m); advancePhase(m); m.paused = false;
  const p = getView(m).positions.find(p => p.stockId === 's2')!;
  assert.equal(p.available, 100);
  const bid = getView(m).stocks.find(s => s.id === 's2')!.bids[0].price;
  assert.equal(submitOrder(m, { stockId: 's2', side: 'sell', quantity: 100, price: bid }).ok, true);
  assert.equal(m.actors[0].positions.s2.quantity, 0);
  assertLedgers(m);
});

test('financed sale automatically repays principal, cash repayment transfers to broker', () => {
  const m = legacyContinuous(), supply = monetarySupply(m);
  const cash = m.actors[0].cash, principal = m.principal;
  assert.equal(submitOrder(m, { stockId: 's1', side: 'creditSell', quantity: 100, price: 11.99 }).ok, true);
  assert.equal(m.principal, principal - 1199 * 100);
  assert.equal(m.actors[0].cash, cash);
  const debt = m.principal;
  assert.equal(repay(m, 1000).ok, true);
  assert.equal(m.principal, debt - 100_000);
  assert.equal(m.actors[0].cash, cash - 100_000);
  assert.equal(monetarySupply(m), supply);
  assert.equal(repay(m, 5_000_000).ok, false);
});

test('new financing uses finite broker funds and adds debt without inventing cash', () => {
  const m = unlockCredit(legacyContinuous());
  assert.equal(submitOrder(m, { stockId: 's3', side: 'finance', quantity: 100, price: 18.01 }).ok, false);
  // Fixture representing prior profitable trading and debt repayment.
  m.principal = 100_000_000; // Below the new aggregate 2-million-yuan contract cap.
  const supply = monetarySupply(m), cash = m.actors[0].cash, broker = m.brokerCash;
  const debt = m.principal;
  assert.equal(submitOrder(m, { stockId: 's3', side: 'finance', quantity: 100, price: 18.01 }).ok, true);
  assert.equal(m.actors[0].cash, cash);
  assert.equal(m.principal, debt + 1801 * 100);
  assert.equal(m.brokerCash, broker - 1801 * 100);
  assert.equal(m.actors[0].positions.s3.financed, 100);
  assert.equal(monetarySupply(m), supply);
});

test('borrowing is finite, proceeds restricted, next-day cover restores lender inventory', () => {
  const m = unlockCredit(continuous()), supply = monetarySupply(m), physicalShares = shares(m, 's5');
  const aiBid = m.orders.find(o => o.stockId === 's5' && o.side === 'buy' && o.actorId !== 'player')!;
  aiBid.price = 2200; aiBid.frozenCash = aiBid.remaining * 2200;
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 100, price: 22 }).ok, true);
  assert.equal(m.shorts.s5.quantity, 100);
  assert.equal(m.shorts.s5.proceeds, 220_000);
  assert.equal(getView(m).restrictedCash, 2200);
  assert.equal(m.stocks[4].lendAvailable, 9900);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'cover', quantity: 100, price: 22.01 }).ok, false);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 10000, price: 22 }).ok, false);
  assert.equal(submitOrder(m, { stockId: 's4', side: 'short', quantity: 100, price: 35 }).ok, false);
  assert.equal(shares(m, 's5'), physicalShares);
  assert.equal(monetarySupply(m), supply);
  nextDay(m); advancePhase(m); m.paused = false;
  const ask = getView(m).stocks[4].asks[0].price;
  assert.equal(submitOrder(m, { stockId: 's5', side: 'cover', quantity: 100, price: ask }).ok, true);
  assert.equal(m.shorts.s5.quantity, 0);
  assert.equal(m.shorts.s5.proceeds, 0);
  assert.equal(m.shorts.s5.margin, 0);
  assert.equal(m.stocks[4].lendAvailable, 10000);
  assert.equal(shares(m, 's5'), physicalShares);
  assert.equal(monetarySupply(m), supply);
  assertLedgers(m);
});

test('auction has one clearing price and unavailable cancellation window', () => {
  const m = createMarket(42);
  m.paused = false;
  submitOrder(m, { stockId: 's2', side: 'buy', quantity: 6000, price: 28.09 });
  assert.equal(m.trades.length, 0);
  const orderId = getView(m).orders[0].id;
  m.phaseElapsed = 23;
  assert.equal(cancelOrder(m, orderId).ok, false);
  advancePhase(m);
  const fills = m.trades.filter(t => t.stockId === 's2');
  assert.ok(fills.length > 0);
  assert.equal(new Set(fills.map(t => t.price)).size, 1);
  assert.equal(m.actors[0].positions.s2.quantity, 6000);
  assertLedgers(m);
});

test('self-cross prevention keeps one seat from fabricating auction volume', () => {
  const m = createMarket(8);
  giveOldShares(m);
  m.paused = false;
  assert.equal(submitOrder(m, { stockId: 's1', side: 'sell', quantity: 100, price: 12.10 }).ok, true);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'buy', quantity: 100, price: 12.10 }).ok, false);
  assert.equal(m.trades.length, 0);
});

test('seed and serialized restore produce identical market continuation', () => {
  const m = createMarket(812); m.paused = false; m.speed = 12;
  for (let i = 0; i < 15; i++) tick(m);
  const restored = JSON.parse(JSON.stringify(m)) as Market;
  assert.equal(validateMarket(restored), true);
  for (let i = 0; i < 90; i++) {
    if (m.phase === 'night') {
      nextDay(m); nextDay(restored); m.paused = false; restored.paused = false;
    }
    tick(m); tick(restored);
  }
  assert.deepEqual(restored, m);
  assert.deepEqual(getView(restored), getView(m));
  assert.equal(validateMarket({ ...m, principal: -1 }), false);
});

for (const field of ['stockId', 'actorId'] as const) {
  test(`saved orders reject an unknown ${field} before market continuation`, () => {
    for (const legacySimulation of [false, true]) {
      for (const status of ['open', 'filled', 'cancelled'] as const) {
        const m = JSON.parse(JSON.stringify(createMarket(42, { legacySimulation }))) as Market;
        const order = m.orders.find(o => o.actorId !== 'player')!;
        assert.ok(order, 'the fixture should contain a real funded NPC order');
        order.status = status;
        if (status === 'filled') order.remaining = 0;
        if (status !== 'open') order.frozenCash = 0;
        assert.equal(validateMarket(m), true, 'valid references remain readable in legacy and current saves');
        order[field] = `missing-${field}`;
        const before = JSON.stringify(m);
        assert.equal(validateMarket(m), false, `reject ${status} ${field} in ${legacySimulation ? 'legacy' : 'current'} saves`);
        assert.equal(JSON.stringify(m), before, 'validation must not repair or mutate the saved data');
      }
    }
  });
}

test('finite-money and physical-share reconciliation survives many trading days', () => {
  const m = createMarket(414); m.paused = false; m.speed = 12;
  const supply = monetarySupply(m), inventories = m.stocks.map(s => shares(m, s.id));
  let hasTraded = false;
  for (let i = 0; i < 500; i++) {
    if (m.phase === 'night') { nextDay(m); m.paused = false; }
    tick(m);
    hasTraded ||= m.trades.length > 0;
    if (i % 25 === 0) {
      assertLedgers(m);
      assert.equal(monetarySupply(m), supply);
      m.stocks.forEach((s, index) => assert.equal(shares(m, s.id), s.listedDay ? s.shares : inventories[index]));
    }
  }
  assert.ok(m.day >= 10);
  assert.ok(hasTraded);
});

test('news changes never bypass actual fills, DTO exposes no private AI holdings', () => {
  const m = createMarket(121);
  while (m.phase !== 'night') advancePhase(m);
  const prices = m.stocks.map(s => s.price);
  // Overnight is a news publication with no matching. Price remains last actual trade.
  nextDay(m);
  assert.deepEqual(m.stocks.map(s => s.price), prices);
  const serialized = JSON.stringify(getView(m));
  assert.equal(serialized.includes('"rngState"'), false);
  assert.equal(serialized.includes('"actorId"'), false);
});

test('legacy model: news directions describe expectations while AI seats can disagree in their actual orders', () => {
  const examples = new Map<string, Market>();
  for (let i = 1; i <= 64 && examples.size < 6; i++) {
    const m = createMarket(Math.imul(i, 0x9e3779b1) >>> 0, { legacySimulation: true });
    const news = getView(m).news[0];
    assert.equal(news.impacts.length, 1);
    const impact = news.impacts[0];
    examples.set(`${impact.sector}:${impact.direction}`, m);
  }
  assert.deepEqual([...examples.keys()].sort(), [
    '光通信:negative', '光通信:positive', '半导体:negative',
    '半导体:positive', '电力:negative', '电力:positive',
  ].sort());
  let supportingQuotes = 0, opposingQuotes = 0;
  for (const original of examples.values()) {
    const impact = getView(original).news[0].impacts[0];
    const sign = impact.direction === 'positive' ? 1 : -1;
    assert.ok(impact.reason.length > 10);
    for (const stock of original.stocks) {
      if (stock.sector === impact.sector) {
        assert.ok(stock.newsBias * sign > 0, `${impact.sector}: bias follows displayed direction`);
      } else {
        assert.equal(stock.newsBias, 0);
      }
      assert.equal(stock.fair, stock.previousClose); // Headlines do not compound the earnings reference.
      assert.equal(stock.price, stock.previousClose); // Publication alone cannot move a traded price.
    }
    const affected = structuredClone(original);
    affected.phase = 'morning'; affected.paused = false; affected.orders = [];
    affected.tickCount = 3; // The next second produces one AI decision for each stock.
    const withoutNews = structuredClone(affected);
    for (const stock of withoutNews.stocks) { stock.newsBias = 0; stock.fair = stock.previousClose; }
    tick(affected); tick(withoutNews);
    assert.equal(affected.rngState, withoutNews.rngState); // Compare decisions under identical random draws.
    let shiftedQuotes = 0;
    for (const stock of affected.stocks) {
      const influencedOrder = affected.orders.find(o => o.stockId === stock.id)!;
      const baselineOrder = withoutNews.orders.find(o => o.stockId === stock.id)!;
      assert.ok(influencedOrder && baselineOrder);
      if (stock.sector === impact.sector) {
        const shift = (influencedOrder.price - baselineOrder.price) * sign;
        if (shift !== 0) shiftedQuotes++;
        if (shift > 0) supportingQuotes++;
        if (shift < 0) opposingQuotes++;
      } else {
        assert.equal(influencedOrder.price, baselineOrder.price);
        assert.equal(influencedOrder.side, baselineOrder.side);
      }
    }
    assert.ok(shiftedQuotes > 0);
    assert.equal(affected.trades.length, 0);
    assert.deepEqual(affected.stocks.map(s => s.price), original.stocks.map(s => s.price));
  }
  assert.ok(supportingQuotes > 0);
  assert.ok(opposingQuotes > 0, 'a public headline must not make every seat quote in the same direction');
  const positive = examples.get('半导体:positive')!;
  giveOldShares(positive);
  positive.phase = 'morning'; positive.paused = false;
  const before = positive.stocks[0].price;
  const bid = getView(positive).stocks[0].bids[0].price;
  assert.equal(submitOrder(positive, { stockId: 's1', side: 'sell', quantity: 100, price: bid }).ok, true);
  assert.ok(positive.stocks[0].price < before, 'positive expectations cannot override a real lower-priced execution');
  assert.equal(positive.stocks[0].price, positive.trades.at(-1)!.price);
});

test('legacy model: one event applies once; a later catalyst needs a new event identity and explicit new progress', () => {
  const m = createMarket(137, { legacySimulation: true });
  const original = m.news[0];
  const originalEvent = original.eventId;
  const template = original.templateHeadline!;
  const fair = m.stocks.map(s => s.fair);
  const prices = m.stocks.map(s => s.price);
  for (let day = 2; day <= 3; day++) {
    const biases = m.stocks.map(s => Math.abs(s.newsBias));
    m.phase = 'night'; m.phaseElapsed = 149; m.rngState = m.seed;
    nextDay(m); // Reuse the same random draw to select exactly the same template.
    assert.equal(m.day, day);
    assert.equal(m.news[0].eventId, originalEvent);
    assert.match(m.news[0].headline, /^消息回顾｜/);
    m.stocks.forEach((s, i) => assert.ok(Math.abs(s.newsBias) <= biases[i]));
    assert.deepEqual(m.stocks.map(s => s.fair), fair);
    assert.deepEqual(m.stocks.map(s => s.price), prices);
  }
  const beforeNew = m.stocks.map(s => Math.abs(s.newsBias));
  m.phase = 'night'; m.phaseElapsed = 149; m.rngState = m.seed;
  nextDay(m);
  assert.equal(m.day, 4);
  assert.notEqual(m.news[0].eventId, originalEvent);
  assert.match(m.news[0].headline, /^第2轮新增进展｜/);
  assert.notEqual(m.news[0].body, original.body);
  assert.equal(m.newsEvents![template].round, 2);
  assert.ok(m.stocks.some((s, i) => Math.abs(s.newsBias) > beforeNew[i]));
  assert.ok(m.stocks.every(s => Math.abs(s.newsBias) <= .08));
  assert.deepEqual(m.stocks.map(s => s.fair), fair);
  assert.deepEqual(m.stocks.map(s => s.price), prices);
  for (let day = 5; day <= 20; day++) {
    m.phase = 'night'; m.phaseElapsed = 149; m.rngState = m.seed;
    nextDay(m);
    assert.ok(m.stocks.every(s => Math.abs(s.newsBias) <= .08));
    assert.deepEqual(m.stocks.map(s => s.fair), fair);
    if (day === 5) assert.ok(m.stocks.every(s => s.newsBias === 0), 'the skipped weekend digests the known Friday event');
  }
  assert.equal(m.newsEvents![template].round, 7);
});

test('public-news expectations decay through lunch and overnight without forcing a price move', () => {
  const m = createMarket(138);
  m.paused = false; m.phase = 'lunch'; m.phaseElapsed = 0;
  const lunchBiases = m.stocks.map(s => Math.abs(s.newsBias));
  const prices = m.stocks.map(s => s.price);
  for (let i = 0; i < 20; i++) tick(m);
  m.stocks.forEach((s, i) => assert.ok(Math.abs(s.newsBias) <= lunchBiases[i] * .736));
  m.phase = 'night'; m.phaseElapsed = 0;
  const biases = m.stocks.map(s => Math.abs(s.newsBias));
  for (let i = 0; i < 90; i++) tick(m);
  m.stocks.forEach((s, i) => assert.ok(Math.abs(s.newsBias) <= biases[i] * .251));
  assert.deepEqual(m.stocks.map(s => s.price), prices);
  assert.equal(m.trades.length, 0);
  // Passive pause still freezes simulated time, including expectation digestion.
  m.paused = true;
  const pausedBias = m.stocks.map(s => s.newsBias);
  tick(m);
  assert.deepEqual(m.stocks.map(s => s.newsBias), pausedBias);
});

test('legacy model: legacy saves remember their public headlines rather than applying them again on load', () => {
  const m = createMarket(139, { legacySimulation: true });
  const template = m.news[0].templateHeadline!;
  delete m.newsEvents;
  for (const news of m.news) {
    delete news.eventId; delete news.eventDay; delete news.templateHeadline;
  }
  for (const stock of m.stocks) stock.fair *= 2; // Old builds permanently accumulated headline effects.
  const prices = m.stocks.map(s => s.price);
  const cash = m.actors.map(a => a.cash);
  const sharesBefore = m.stocks.map(s => shares(m, s.id));
  m.phase = 'night'; m.phaseElapsed = 149; m.rngState = m.seed;
  nextDay(m);
  assert.match(m.news[0].headline, /^消息回顾｜/);
  assert.equal(m.newsEvents![template].applied, true);
  assert.deepEqual(m.stocks.map(s => s.price), prices);
  assert.deepEqual(m.stocks.map(s => s.fair), prices);
  assert.deepEqual(m.actors.map(a => a.cash), cash);
  assert.deepEqual(m.stocks.map(s => shares(m, s.id)), sharesBefore);
});

test('legacy news gains known impact labels without inferring unknown stories or rewriting saves', () => {
  const m = createMarket(9);
  const known = [
    ['本土产线启动新一轮设备验证', '半导体', 'positive'],
    ['晶圆厂调整设备验收节奏', '半导体', 'negative'],
    ['算力园区启动光互联升级招标', '光通信', 'positive'],
    ['海外客户推迟部分光模块交付', '光通信', 'negative'],
    ['区域负荷上升，电网更新项目提速', '电力', 'positive'],
    ['来水与燃料成本出现分化', '电力', 'negative'],
  ] as const;
  m.news = known.map(([headline, sector, sentiment], i) => ({
    id: `legacy${i}`, time: '09:30', headline, body: '旧存档正文保持原样。', sector, sentiment,
  }));
  m.news.push({ id: 'unknown', time: '10:00', headline: '尚未核实的产业传闻',
    body: '只有板块标签，不能据此认定存在利好。', sector: '半导体', sentiment: 'positive' });
  m.news.push({ id: 'intro', time: '盘前', headline: '百日归期：重新坐上交易席',
    body: '旧的开局介绍。', sentiment: 'neutral' });
  const savedNews = structuredClone(m.news);
  const biases = m.stocks.map(s => s.newsBias);
  const rng = m.rngState;
  const view = getView(m);
  known.forEach(([, sector, direction], i) => {
    assert.equal(view.news[i].impacts.length, 1);
    assert.equal(view.news[i].impacts[0].sector, sector);
    assert.equal(view.news[i].impacts[0].direction, direction);
  });
  assert.match(view.news[5].impacts[0].reason, /并非直接利空/);
  assert.deepEqual(view.news[6].impacts, []);
  assert.deepEqual(view.news[7].impacts, []);
  view.news[0].impacts[0].reason = 'UI mutation';
  assert.deepEqual(m.news, savedNews);
  assert.deepEqual(m.stocks.map(s => s.newsBias), biases);
  assert.equal(m.rngState, rng);
  assert.equal(validateMarket(JSON.parse(JSON.stringify(m))), true);
  const current = createMarket(10);
  const currentReason = current.news[0].impacts![0].reason;
  getView(current).news[0].impacts[0].reason = 'another UI mutation';
  assert.equal(current.news[0].impacts![0].reason, currentReason);
});

test('night leaderboard amounts are exactly actual triggered-stock executions', () => {
  const m = continuous(77);
  const asks = m.orders.filter(o => o.stockId === 's2' && o.side === 'sell');
  for (const ask of asks) ask.status = 'cancelled';
  asks[0].status = 'open'; asks[0].price = 3080;
  assert.equal(submitOrder(m, { stockId: 's2', side: 'buy', quantity: 100, price: 30.80 }).ok, true);
  assert.equal(getView(m).stocks[1].pe, 20.9); // Fixed initial EPS: 19 × 30.80 / 28.00.
  // Isolate the closing publication from subsequent unrelated AI trades.
  m.phase = 'closing'; m.phaseElapsed = 14;
  advancePhase(m);
  const board = getView(m).leaderboard.find(b => b.stockId === 's2')!;
  assert.ok(board);
  assert.equal(board.totalBuy, 3080);
  assert.equal(board.totalSell, 3080);
  assert.equal(board.buyers[0].name, '你的席位');
  assert.equal(board.buyers[0].buy, 3080);
  assert.ok(m.trades.every(t => t.buyerId !== t.sellerId));
});

test('natural-calendar interest includes skipped weekends and deadline cannot manufacture cash', () => {
  const m = legacyMarket(1);
  const supply = monetarySupply(m);
  nextDay(m); nextDay(m); nextDay(m); // Tue -> Wed -> Thu -> Fri
  assert.equal(m.calendarDate, '2026-10-23');
  while (m.phase !== 'night') advancePhase(m); // Friday trading can repay debt through real forced sales.
  const before = m.interest;
  const fridayPrincipal = m.principal;
  nextDay(m); // Friday -> Monday: three calendar days of fees
  assert.equal(m.calendarDate, '2026-10-26');
  assert.equal(m.elapsedDays, 6);
  assert.ok(m.interest - before >= Math.floor(fridayPrincipal * .085 / 365) * 3);
  while (m.result === null) nextDay(m);
  assert.equal(m.calendarDate, m.deadlineDate);
  assert.equal(m.elapsedDays, 100);
  assert.equal(m.result, getView(m).debt === 0 ? 'won' : 'default');
  assert.equal(monetarySupply(m), supply);
  assert.equal(getView(m).daysLeft, 0);
  assert.equal(m.paused, true);
  // The maturity process must not convert unsold positions into fictitious cash.
  const unpaid = legacyMarket(2);
  unpaid.elapsedDays = 99; unpaid.calendarDate = '2027-01-27'; unpaid.phase = 'night';
  nextDay(unpaid);
  assert.equal(unpaid.result, 'default');
  assert.equal(unpaid.principal, 600_000_000 + Math.floor(1_000_000_000 * .085 / 365));
  assert.equal(unpaid.actors[0].positions.s1.quantity, 1_000_000);
});

test('rejects malformed quantities, off-tick prices and price-limit violations', () => {
  const m = continuous();
  for (const input of [
    { stockId: 's2', side: 'buy' as const, quantity: 99, price: 28 },
    { stockId: 's2', side: 'buy' as const, quantity: 100, price: 28.001 },
    { stockId: 's2', side: 'buy' as const, quantity: 100, price: 31 },
    { stockId: 'bad', side: 'buy' as const, quantity: 100, price: 28 },
  ]) assert.equal(submitOrder(m, input).ok, false);
});

test('paused market rejects new orders and cannot advance by passive ticks', () => {
  const m = continuous();
  m.paused = true;
  const snapshot = structuredClone(m);
  assert.deepEqual(submitOrder(m, { stockId: 's2', side: 'buy', quantity: 100, price: 28.01 }),
    { ok: false, message: '行情已暂停，请先继续行情' });
  for (let i = 0; i < 20; i++) tick(m);
  assert.deepEqual(m, snapshot);
  advancePhase(m);
  assert.equal(m.phase, 'lunch'); // Explicit stepping is active time advancement.
  assert.equal(m.paused, true);
});

test('legacy model: 12x natural close pauses for review and explicit nextDay stops at the next opening', () => {
  const m = createMarket(67, { legacySimulation: true });
  m.paused = false; m.speed = 12; m.phase = 'closing'; m.phaseElapsed = 14;
  const prices = m.stocks.map(s => s.price);
  const newsCount = m.news.length;
  tick(m);
  assert.equal(m.phase, 'night');
  assert.equal(m.phaseElapsed, 0);
  assert.equal(m.tickCount, 1); // The remaining eleven ticks must not eat into review time.
  assert.equal(m.day, 1);
  assert.equal(m.paused, true);
  assert.equal(m.news.length, newsCount + 1);
  assert.equal(m.news[0].time, '18:00');
  assert.equal(m.news[0].day, 1);
  assert.deepEqual(m.stocks.map(s => s.price), prices); // The post-close news is not a trade.
  const snapshot = structuredClone(m);
  for (let i = 0; i < 100; i++) tick(m);
  assert.deepEqual(m, snapshot);
  nextDay(m);
  assert.equal(m.phase, 'auction');
  assert.equal(m.phaseElapsed, 0);
  assert.equal(m.day, 2);
  assert.equal(m.tickCount, 151);
  assert.equal(m.paused, true);
  assert.equal(m.speed, 12);
  const opening = structuredClone(m);
  tick(m);
  assert.deepEqual(m, opening);
});

test('legacy model: news exposes its publication day without treating an old event day as publication metadata', () => {
  const m = createMarket(68, { legacySimulation: true });
  assert.ok(getView(m).news.every(news => news.day === 1));
  m.phase = 'night'; m.phaseElapsed = 149; m.rngState = m.seed;
  nextDay(m);
  const newest = getView(m).news[0];
  assert.match(newest.headline, /^消息回顾｜/);
  assert.equal(newest.day, 2);
  assert.equal(m.news[0].eventDay, 1);
  const stored = m.news[0];
  delete stored.day;
  assert.equal(getView(m).news[0].day, undefined);
  assert.equal(Object.hasOwn(getView(m).news[0], 'day'), false);
  for (const invalidDay of [0, -1, 1.5, NaN, Infinity]) {
    stored.day = invalidDay;
    assert.equal(getView(m).news[0].day, undefined);
  }
  delete stored.day;
  assert.equal(validateMarket(JSON.parse(JSON.stringify(m))), true);
});

test('manual phase advance runs identical simulation seconds to normal ticking', () => {
  const manual = createMarket(64);
  const running = structuredClone(manual);
  running.paused = false;
  advancePhase(manual);
  for (let i = 0; i < 45; i++) tick(running);
  assert.equal(manual.phase, 'morning');
  assert.equal(manual.tickCount, 45);
  assert.equal(manual.paused, true);
  assert.ok(manual.trades.length > 0);
  running.paused = true;
  manual.revision = 0; running.revision = 0; // API request count is not simulated market state.
  assert.deepEqual(manual, running);
});

test('skipping a complete day generates real AI trades, news and closing records', () => {
  const m = createMarket(65);
  m.speed = 12;
  const supply = monetarySupply(m);
  const initialNews = m.news.length;
  for (const phase of ['morning', 'lunch', 'afternoon', 'closing', 'night']) {
    advancePhase(m);
    assert.equal(m.phase, phase);
    assert.equal(m.paused, true);
    assert.equal(m.speed, 12);
  }
  assert.equal(m.tickCount, 450);
  assert.ok(m.trades.length > 100);
  assert.ok(m.news.length > initialNews);
  assert.ok(m.ledger.some(l => l.kind === '收盘' && l.day === 1));
  for (const s of m.stocks) {
    const executions = m.trades.filter(t => t.day === 1 && t.stockId === s.id);
    assert.ok(executions.length > 0);
    assert.equal(s.price, executions.at(-1)!.price);
    assert.equal(s.volume, executions.reduce((n, t) => n + t.quantity, 0));
    assert.equal(s.turnover, executions.reduce((n, t) => n + t.price * t.quantity, 0));
  }
  assert.equal(monetarySupply(m), supply);
  assertLedgers(m);
  advancePhase(m);
  assert.equal(m.phase, 'auction');
  assert.equal(m.phaseElapsed, 0);
  assert.equal(m.day, 2);
  assert.equal(m.tickCount, 600);
  assert.equal(m.paused, true);
});

test('seat cash-flow totals reconcile all daily trades and remain hidden before close', () => {
  const m = continuous(61);
  assert.equal(submitOrder(m, { stockId: 's2', side: 'buy', quantity: 100, price: 28.01 }).ok, true);
  const playerTradeId = m.trades.find(t => t.playerSide)!.id;
  assert.deepEqual(getView(m).seatFlows, []);
  while (m.phase !== 'night') advancePhase(m);
  const view = getView(m);
  assert.equal(view.seatFlows.length, 7);
  assert.equal(view.seatFlows.reduce((n, row) => n + Math.round(row.net * 100), 0), 0);
  const turnover = m.trades.filter(t => t.day === m.day).reduce((n, t) => n + t.price * t.quantity, 0);
  assert.equal(view.seatFlows.reduce((n, row) => n + Math.round(row.buy * 100), 0), turnover);
  assert.equal(view.seatFlows.reduce((n, row) => n + Math.round(row.sell * 100), 0), turnover);
  for (const actor of m.actors) {
    const row = view.seatFlows.find(s => s.name === actor.name)!;
    const buying = m.trades.filter(t => t.day === m.day && t.buyerId === actor.id).reduce((n, t) => n + t.price * t.quantity, 0);
    const selling = m.trades.filter(t => t.day === m.day && t.sellerId === actor.id).reduce((n, t) => n + t.price * t.quantity, 0);
    assert.equal(Math.round(row.buy * 100), buying);
    assert.equal(Math.round(row.sell * 100), selling);
    assert.equal(Math.round(row.net * 100), buying - selling);
  }
  assert.ok(m.trades.length > 120); // Public market activity must not bury the player's early fill.
  assert.ok(view.trades.some(t => t.id === playerTradeId));
  assert.ok(view.trades.every(t => t.side !== 'market'));
  assert.deepEqual(view.trades.map(t => t.id), m.trades.filter(t => t.playerSide).slice(-120).reverse().map(t => t.id));
  nextDay(m);
  assert.deepEqual(getView(m).seatFlows, []);
});

test('nextDay simulates unfinished sessions and stops exactly at the next opening', () => {
  const m = createMarket(66);
  const initialPrices = m.stocks.map(s => s.price);
  nextDay(m);
  assert.equal(m.day, 2);
  assert.equal(m.phase, 'auction');
  assert.equal(m.phaseElapsed, 0);
  assert.equal(m.tickCount, 600);
  assert.equal(m.calendarDate, '2026-10-21');
  assert.ok(m.ledger.some(l => l.kind === '收盘' && l.day === 1));
  assert.ok(m.stocks.some((s, i) => s.price !== initialPrices[i]));
  assert.equal(m.paused, true);
});

test('last tradable day blocks new short debt but permits returning prior-day borrowed shares', () => {
  const m = continuous();
  while (m.calendarDate < '2027-01-26') nextDay(m);
  assert.equal(m.calendarDate, '2027-01-26');
  advancePhase(m); m.paused = false;
  assert.equal(transferCreditCollateral(m, {direction: 'in', cash: 2_000_000}).ok, true);
  m.principal = 100_000_000; m.marginCallDay = null; // Explicit collateral keeps the maturity fixture clear of forced liquidation.
  const current = getView(m).stocks[4].price;
  const aiBid = m.orders.find(o => o.stockId === 's5' && o.side === 'buy' && o.actorId !== 'player')!;
  for (const o of m.orders.filter(o => o.stockId === 's5')) { o.status = 'cancelled'; o.frozenCash = 0; }
  aiBid.status = 'open'; aiBid.quantity = 100; aiBid.remaining = 100;
  aiBid.price = Math.round(current * 100); aiBid.frozenCash = aiBid.remaining * aiBid.price;
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 100, price: current }).ok, true);
  assert.equal(m.shorts.s5.today, 100);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'cover', quantity: 100, price: current }).ok, false);
  nextDay(m);
  assert.equal(m.calendarDate, '2027-01-27');
  assert.equal(getView(m).daysLeft, 1);
  advancePhase(m); m.paused = false;
  const blocked = submitOrder(m, { stockId: 's5', side: 'short', quantity: 100, price: getView(m).stocks[4].price });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /到期前已无下一交易日/);
  assert.equal(m.shorts.s5.today, 0);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'cover', quantity: 100, price: getView(m).stocks[4].asks[0].price }).ok, true);
  assert.equal(m.shorts.s5.quantity, 0);
  nextDay(m);
  assert.equal(m.calendarDate, '2027-01-28');
  assert.equal(m.phase, 'ended');
});
