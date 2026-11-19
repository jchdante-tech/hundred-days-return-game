import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarket, nextDay, advancePhase, getView, tick, submitOrder, repayChallenge,
  validateMarket, transferCreditCollateral, type Market,
} from './engine.js';

function closeDay(m: Market) {
  for (let guard = 0; guard < 6 && m.phase !== 'night' && m.phase !== 'ended'; guard++) advancePhase(m);
  assert.equal(m.phase, 'night');
}
function cashSupply(m: Market) {
  return m.actors.reduce((sum, a) => sum + a.cash, 0) + m.brokerCash
    + Object.values(m.shorts).reduce((sum, p) => sum + p.proceeds, 0) + (m.challenge?.paid ?? 0);
}
function shares(m: Market) {
  return m.stocks.map(s => m.actors.reduce((sum, a) => sum + (a.positions[s.id]?.quantity ?? 0), 0) + s.lendAvailable);
}
function playerFinances(m: Market) {
  return structuredClone({ player: m.actors[0], challenge: m.challenge, shorts: m.shorts,
    principal: m.principal, interest: m.interest, interestRemainder: m.interestRemainder,
    brokerCash: m.brokerCash, marginCallDay: m.marginCallDay,
    lending: m.stocks.map(s => [s.id, s.lendAvailable, s.lendTotal]),
  });
}
function jsonRestore(m: Market): Market {
  const restored: unknown = JSON.parse(JSON.stringify(m));
  assert.ok(validateMarket(restored), 'persisted simulation should pass validation');
  return restored;
}

test('a real pre-upgrade save stays on its current model throughout intraday and post-close reads', () => {
  const m = createMarket(17, { legacySimulation: true }); delete m.simulationVersion;
  advancePhase(m); assert.equal(m.phase, 'morning');
  m.paused = false;
  for (let i = 0; i < 12; i++) {
    const view = getView(m); assert.equal(view.day, 1); tick(m);
    assert.equal(m.agentSimulation, undefined); assert.equal(m.storyState, undefined);
    assert.equal(m.actors.length, 7); assert.equal(m.simulationVersion, undefined);
  }
  closeDay(m);
  const report = structuredClone(getView(m).postClose), news = structuredClone(m.news);
  const prices = m.stocks.map(s => [s.price, s.volume, s.turnover]);
  m.paused = false;
  for (let i = 0; i < 8; i++) { getView(m); tick(m); }
  assert.equal(m.phase, 'night'); assert.equal(m.day, 1);
  assert.equal(m.actors.length, 7); assert.equal(m.agentSimulation, undefined);
  assert.deepEqual(getView(m).postClose, report);
  assert.deepEqual(m.news, news);
  assert.deepEqual(m.stocks.map(s => [s.price, s.volume, s.turnover]), prices);
  assert.ok(validateMarket(m));
});

test('next-day upgrade preserves real financed positions, short collateral, target and last report', () => {
  const m = createMarket(42, { legacySimulation: true });
  for (let day = 1; day < 20; day++) nextDay(m);
  advancePhase(m); m.paused = false;
  assert.equal(repayChallenge(m, 100_000).ok, true);
  assert.equal(transferCreditCollateral(m, { direction: 'in', cash: 2_000_000 }).ok, true);
  const beforeOrders = getView(m);
  assert.equal(submitOrder(m, { stockId: 's3', side: 'finance', quantity: 100, price: beforeOrders.stocks[2].asks[0].price }).ok, true);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 100, price: beforeOrders.stocks[4].price }).ok, true);
  closeDay(m); getView(m);
  assert.ok(m.principal > 0); assert.equal(m.shorts.s5.quantity, 100);
  assert.equal(m.actors[0].positions.s3.financed, 100);
  const report = structuredClone(m.postClose), news = structuredClone(m.news);
  const supply = cashSupply(m), physicalShares = shares(m);
  const control = jsonRestore(m);
  delete m.simulationVersion;
  nextDay(m); nextDay(control);
  assert.equal(m.day, 21); assert.equal(m.phase, 'auction');
  assert.equal(m.simulationVersion, 2); assert.equal(m.actors.length, 10);
  assert.ok(m.agentSimulation); assert.ok(m.storyState);
  // The control accrues the same legitimate natural-day fees and releases T+1.
  // Any financial difference would therefore be caused by migration itself.
  assert.deepEqual(playerFinances(m), playerFinances(control));
  assert.equal(m.shorts.s5.today, 0); assert.equal(m.actors[0].positions.s3.today, 0);
  assert.equal(cashSupply(m), supply); assert.deepEqual(shares(m), physicalShares);
  assert.deepEqual(m.postClose, report); assert.deepEqual(getView(m).postClose, report);
  assert.deepEqual(m.news, news, 'migration must not replay old articles as fresh news');
  assert.equal(m.storyState!.arcs.length, 0);
  assert.equal(m.storyState!.nextStartDay, m.day + 1);
  assert.ok(validateMarket(m));
  const restored = jsonRestore(m);
  closeDay(m); closeDay(restored); nextDay(m); nextDay(restored);
  closeDay(m); closeDay(restored);
  assert.deepEqual(restored, m, 'upgraded strategy and story RNG must resume deterministically');
});

test('new-model public views never expose private plans, expectations or future event nodes', () => {
  const m = createMarket(119);
  const forbidden = new Set(['agentSimulation', 'storyState', 'plans', 'crowdOpinions', 'expectations',
    'nodes', 'publishedStage', 'premium', 'realizedPremium', 'rngState', 'seed', 'actors', 'fair', 'newsBias', 'outcome']);
  const inspect = (value: unknown, path = '$') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbidden.has(key), `private field leaked at ${path}.${key}`);
      inspect(child, `${path}.${key}`);
    }
  };
  assert.ok(m.agentSimulation); assert.ok(m.storyState!.arcs[0].nodes.length > 1);
  inspect(getView(m));
  for (let day = 1; day <= 3; day++) { closeDay(m); inspect(getView(m)); nextDay(m); inspect(getView(m)); }
});

test('cross-day reports retain only four prior days and remain valid after JSON restoration', () => {
  const m = createMarket(20261020);
  for (let day = 1; day <= 8; day++) {
    closeDay(m);
    assert.equal(m.postClose!.day, day);
    assert.deepEqual((m.postCloseHistory ?? []).map(r => r.day), Array.from({ length: Math.min(4, day - 1) }, (_, i) => Math.max(1, day - 4) + i));
    assert.ok(validateMarket(m)); assert.ok(validateMarket(jsonRestore(m)));
    if (day < 8) nextDay(m);
  }
  const corrupt = jsonRestore(m);
  corrupt.postCloseHistory!.push(structuredClone(corrupt.postCloseHistory![0]));
  assert.equal(validateMarket(corrupt), false, 'unbounded or repeated history cannot enter a save');
});

test('a player trades 100 real shares against the new market and T+1 still gates the sale', () => {
  const m = createMarket(42), supply = cashSupply(m), physicalShares = shares(m);
  advancePhase(m); m.paused = false;
  const stock = getView(m).stocks.find(s => s.asks.length > 0)!;
  const buy = submitOrder(m, { stockId: stock.id, side: 'buy', quantity: 100, price: stock.asks[0].price });
  assert.equal(buy.ok, true); assert.equal(m.actors[0].positions[stock.id].quantity, 100);
  assert.equal(getView(m).positions.find(p => p.stockId === stock.id)!.available, 0);
  const todaySell = submitOrder(m, { stockId: stock.id, side: 'sell', quantity: 100, price: stock.limitDown });
  assert.equal(todaySell.ok, false); assert.match(todaySell.message, /下一交易日/);
  nextDay(m); advancePhase(m); m.paused = false;
  assert.equal(getView(m).positions.find(p => p.stockId === stock.id)!.available, 100);
  const bid = getView(m).stocks.find(s => s.id === stock.id)!.bids[0];
  assert.ok(bid, 'ordinary finite funds should offer a real buyer');
  assert.equal(submitOrder(m, { stockId: stock.id, side: 'sell', quantity: 100, price: bid.price }).ok, true);
  assert.equal(m.actors[0].positions[stock.id].quantity, 0);
  assert.ok(m.trades.some(t => t.playerSide === 'sell' && t.stockId === stock.id && t.quantity === 100));
  assert.equal(cashSupply(m), supply); assert.deepEqual(shares(m), physicalShares);
  assert.ok(validateMarket(m));
});

test('more than 360 real executions retain the entire intraday volume and opening-to-close range', () => {
  const m = createMarket(42); advancePhase(m); m.paused = false;
  const stockId = 's9';
  let submitted = 0;
  for (let attempt = 0; attempt < 620 && submitted < 420 && m.phase === 'morning'; attempt++) {
    const ask = getView(m).stocks.find(s => s.id === stockId)!.asks[0];
    if (!ask) { tick(m); continue; }
    const before = m.trades.length;
    const result = submitOrder(m, { stockId, side: 'buy', quantity: 100, price: ask.price });
    assert.equal(result.ok, true);
    assert.ok(m.trades.length > before, 'submitted marketable order must execute against finite inventory');
    submitted++;
  }
  assert.ok(submitted > 360, `expected a stress run above the previous 360-fill retention, got ${submitted}`);
  closeDay(m);
  const stock = m.stocks.find(s => s.id === stockId)!;
  const trades = m.trades.filter(t => t.day === m.day && t.stockId === stockId);
  const points = stock.history.filter(p => p.volume > 0);
  assert.ok(trades.length > 360);
  assert.equal(points.reduce((sum, p) => sum + p.volume, 0), stock.volume);
  assert.equal(stock.volume, trades.reduce((sum, t) => sum + t.quantity, 0));
  assert.equal(points[0].time, trades[0].time);
  assert.equal(points.at(-1)!.time, trades.at(-1)!.time);
  assert.equal(points.at(-1)!.price, stock.price);
  assert.ok(points.length < trades.length, 'minute buckets should combine executions without discarding their volume');
  assert.ok(validateMarket(m)); assert.ok(validateMarket(jsonRestore(m)));
  const legacy = createMarket(42, { legacySimulation: true }); advancePhase(legacy);
  assert.ok(validateMarket(legacy), 'pre-upgrade execution-point histories remain readable');
});
