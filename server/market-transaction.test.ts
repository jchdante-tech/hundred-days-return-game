import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePhase, createMarket, getView, nextDay, submitIpoSubscription, submitOrder, tick, validateMarket, type Market } from './engine.js';
import { cloneForTransaction } from './market-transaction.js';

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

function compareTransaction(committed: Market, operation: (market: Market) => unknown): Market {
  const saved = JSON.stringify(committed);
  freezeTree(committed);
  const expected = structuredClone(committed);
  const actual = cloneForTransaction(committed);
  assert.deepEqual(operation(actual), operation(expected));
  assert.deepEqual(getView(actual), getView(expected));
  assert.deepEqual(actual, expected, 'candidate must exactly match the former full-clone transaction');
  assert.equal(JSON.stringify(committed), saved, 'discarding the candidate must preserve the committed snapshot');
  return actual;
}

test('shared history transactions exactly match full clones through trading, close and the next opening', () => {
  for (const seed of [42, 1729]) {
    let market = createMarket(seed);
    getView(market);
    market.paused = false;
    market.speed = 12;
    for (let step = 0; step < 8; step += 1) market = compareTransaction(market, tick);
    assert.equal(market.phase, 'morning');
    assert.ok(market.trades.length > 0);
    while (market.phase !== 'night') market = compareTransaction(market, advancePhase);
    market = compareTransaction(market, nextDay);
    assert.equal(market.day, 2);
    assert.equal(market.phase, 'auction');
    assert.ok(validateMarket(market));
  }
});

test('a real fill can update the latest chart point without changing committed history or cash', () => {
  let market = createMarket(42);
  advancePhase(market);
  market.paused = false;
  const stock = getView(market).stocks.find(stock => stock.asks[0]?.quantity >= 200)!;
  assert.ok(stock);
  const order = { stockId: stock.id, side: 'buy' as const, quantity: 100, price: stock.asks[0].price };
  assert.equal(submitOrder(market, order).ok, true);
  const before = getView(market);
  assert.equal(before.positions.find(position => position.stockId === stock.id)!.quantity, 100);
  const last = market.stocks.find(stock => stock.id === order.stockId)!.history.at(-1)!;
  const volume = last.volume;
  market = compareTransaction(market, candidate => submitOrder(candidate, order));
  assert.equal(last.volume, volume, 'the old snapshot keeps its original final chart point');
  assert.equal(getView(market).positions.find(position => position.stockId === stock.id)!.quantity, 200);
  assert.ok(getView(market).cash < before.cash);
});

test('legacy history migration and rejected orders leave the committed snapshot unchanged', () => {
  let market = createMarket(42, { legacySimulation: true });
  for (const stock of market.stocks) {
    delete stock.dailyBars;
    delete stock.dailyHistoryStartDay;
    delete stock.openingHistoryVersion;
  }
  delete market.creditAccount;
  market = compareTransaction(market, getView);
  market = compareTransaction(market, candidate => submitOrder(candidate,
    { stockId: 'unknown', side: 'buy', quantity: 100, price: 12 }));
  assert.ok(validateMarket(market));
});

test('IPO subscription and listing produce the same transactions with shared historical records', () => {
  let market = createMarket(42);
  while (!getView(market).ipos!.some(offer => offer.status === 'subscribing')) {
    nextDay(market);
    assert.ok(market.day < 20, 'expected an IPO offer in the opening weeks');
  }
  const offer = getView(market).ipos!.find(offer => offer.status === 'subscribing')!;
  market = compareTransaction(market, candidate => submitIpoSubscription(candidate, offer.id, 100));
  market = compareTransaction(market, nextDay);
  const listed = getView(market).ipos!.find(item => item.id === offer.id)!;
  assert.equal(listed.status, 'listed');
  assert.ok(validateMarket(market));
});

test('shared historical rows reject accidental writes while all transaction arrays remain independent', () => {
  const market = createMarket(42);
  advancePhase(market);
  market.paused = false;
  market.speed = 12;
  tick(market);
  const candidate = cloneForTransaction(market);
  assert.notEqual(candidate.trades, market.trades);
  assert.ok(candidate.trades.length > 0);
  assert.throws(() => { candidate.trades[0].price += 1; }, TypeError);
  assert.throws(() => { candidate.stocks[0].dailyBars![0].close += 1; }, TypeError);
  candidate.trades.pop();
  candidate.stocks[0].dailyBars!.pop();
  assert.notEqual(candidate.trades.length, market.trades.length);
  assert.notEqual(candidate.stocks[0].dailyBars!.length, market.stocks[0].dailyBars!.length);
  assert.notEqual(candidate.orders[0], market.orders[0]);
  assert.notEqual(candidate.actors[0], market.actors[0]);
});
