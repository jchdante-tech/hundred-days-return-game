import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePhase, cancelOrder, createMarket, getView, submitOrder, validateMarket, type Market } from './engine.js';
import { cloneForTransaction } from './market-transaction.js';

function fixture() {
  const market = createMarket(42, { legacySimulation: true });
  market.phase = 'morning'; market.paused = false;
  market.orders = []; market.trades = [];
  return market;
}

function resting(market: Market, side: 'buy' | 'sell', quantity: number, price: number, actorId = 'ai0') {
  const order: Market['orders'][number] = {
    id: `fixture-${++market.sequence}`, actorId, stockId: 's1', side, quantity, remaining: quantity,
    price: Math.round(price * 100), status: 'open', time: '09:30', sequence: market.sequence,
    createdTick: market.tickCount, frozenCash: side === 'buy' ? Math.round(price * 100) * quantity : 0,
    restrictedClaim: 0, day: market.day,
  };
  market.orders.push(order);
  return order;
}

function place(market: Market, side: 'buy' | 'sell', quantity: number, price: number) {
  assert.equal(submitOrder(market, { stockId: 's1', side, quantity, price }).ok, true);
  const order = market.orders.filter(order => order.actorId === 'player').at(-1)!;
  return getView(market).orders.find(row => row.id === order.id)!;
}

function oldShares(market: Market, quantity: number) {
  const donor = market.actors.find(actor => actor.id === 'ai5')!.positions.s1;
  donor.quantity -= quantity; donor.cost -= quantity * 1200;
  market.actors[0].positions.s1 = { quantity, today: 0, financed: 0, cost: quantity * 1200 };
}

test('a zero-fill ordinary order has no invented execution price or market impact', () => {
  const market = fixture();
  resting(market, 'sell', 100, 12.01);
  const before = market.stocks[0].price;
  const order = place(market, 'buy', 100, 12);
  assert.deepEqual(order.execution, { filled: 0, amount: 0, averagePrice: null, priceLevels: 0 });
  assert.equal(market.stocks[0].price, before);
  assert.equal(market.trades.length, 0);
  assert.equal(order.remaining, 100);
  assert.ok(validateMarket(market));
});

test('partial multi-level buys report only actual fills, exact VWAP and unique price levels', () => {
  const market = fixture();
  resting(market, 'sell', 100, 12.01, 'ai0');
  resting(market, 'sell', 200, 12.01, 'ai1');
  resting(market, 'sell', 300, 12.03, 'ai2');
  const order = place(market, 'buy', 700, 12.03);
  assert.equal(order.filled, 600);
  assert.equal(order.remaining, 100);
  assert.deepEqual(order.execution, { filled: 600, amount: 7212, averagePrice: 12.02,
    priceLevels: 2, beforePrice: 12, afterPrice: 12.03 });
  assert.equal(market.trades.length, 3, 'two counterparties at the same price are one price level');
  assert.ok(validateMarket(market));
});

test('multiple same-price fills count as one level rather than one level per counterparty', () => {
  const market = fixture();
  resting(market, 'sell', 100, 12.01, 'ai0');
  resting(market, 'sell', 200, 12.01, 'ai1');
  const order = place(market, 'buy', 300, 12.01);
  assert.deepEqual(order.execution, { filled: 300, amount: 3603, averagePrice: 12.01,
    priceLevels: 1, beforePrice: 12, afterPrice: 12.01 });
});

test('selling reports bid consumption with its own downward execution prices', () => {
  const market = fixture();
  oldShares(market, 500);
  resting(market, 'buy', 200, 11.99, 'ai0');
  resting(market, 'buy', 300, 11.97, 'ai1');
  const order = place(market, 'sell', 500, 11.97);
  assert.deepEqual(order.execution, { filled: 500, amount: 5989,
    averagePrice: 11.978, priceLevels: 2, beforePrice: 12, afterPrice: 11.97 });
  assert.equal(order.remaining, 0);
  assert.ok(validateMarket(market));
});

test('foreign fills before this order are excluded from its quantity, amount and starting price', () => {
  const market = fixture();
  resting(market, 'buy', 100, 12.05, 'ai0');
  resting(market, 'sell', 100, 12.01, 'ai1');
  resting(market, 'sell', 100, 12.02, 'ai2');
  const order = place(market, 'buy', 100, 12.03);
  assert.equal(market.trades.length, 2);
  assert.deepEqual(order.execution, { filled: 100, amount: 1202, averagePrice: 12.02,
    priceLevels: 1, beforePrice: 12.05, afterPrice: 12.02 });
});

test('foreign fills after this order cannot overwrite its final execution price', () => {
  const market = fixture();
  resting(market, 'buy', 100, 12.02, 'ai0');
  resting(market, 'sell', 100, 12.01, 'ai1');
  resting(market, 'sell', 100, 12.01, 'ai2');
  const order = place(market, 'buy', 100, 12.03);
  assert.equal(market.stocks[0].price, 1202, 'another order traded after the player');
  assert.deepEqual(order.execution, { filled: 100, amount: 1201, averagePrice: 12.01,
    priceLevels: 1, beforePrice: 12, afterPrice: 12.01 });
});

for (const phase of ['auction', 'closing'] as const) {
  test(`${phase} orders never manufacture an immediate receipt, including after the auction fills`, () => {
    const market = fixture();
    market.phase = phase; market.phaseElapsed = phase === 'auction' ? 44 : 14;
    resting(market, 'sell', 100, 12.01);
    const submitted = place(market, 'buy', 100, 12.03);
    assert.equal(submitted.execution, undefined);
    assert.equal(submitted.filled, 0);
    advancePhase(market);
    const filled = getView(market).orders.find(order => order.id === submitted.id)!;
    assert.equal(filled.filled, 100);
    assert.equal(filled.execution, undefined);
  });
}

test('later fills update cumulative filled only and are not attributed to a new zero-fill order', () => {
  const market = fixture();
  resting(market, 'sell', 200, 12.01);
  const submitted = place(market, 'buy', 300, 12.03);
  const receipt = structuredClone(submitted.execution);
  resting(market, 'sell', 100, 12.02, 'ai1');
  const later = place(market, 'buy', 100, 12.03);
  const original = getView(market).orders.find(order => order.id === submitted.id)!;
  assert.equal(original.filled, 300);
  assert.deepEqual(original.execution, receipt, 'receipt describes submission, not future matching');
  assert.equal(market.stocks[0].price, 1203);
  assert.deepEqual(later.execution, { filled: 0, amount: 0, averagePrice: null, priceLevels: 0 });
  cancelOrder(market, later.id);
  assert.deepEqual(getView(market).orders.find(order => order.id === later.id)!.execution, later.execution);
  assert.ok(validateMarket(market));
});

test('receipts survive JSON restore and transaction clones without sharing or mutating committed orders', () => {
  const market = fixture();
  resting(market, 'sell', 200, 12.01);
  const submitted = place(market, 'buy', 300, 12.03);
  const saved = JSON.stringify(market);
  const restored: unknown = JSON.parse(saved);
  assert.ok(validateMarket(restored));
  assert.deepEqual(getView(restored).orders.find(order => order.id === submitted.id)!.execution, submitted.execution);
  assert.equal(JSON.stringify(restored), saved);
  const original = market.orders.find(order => order.id === submitted.id)!;
  Object.freeze(original.execution);
  const candidate = cloneForTransaction(market);
  const copied = candidate.orders.find(order => order.id === submitted.id)!;
  assert.notEqual(copied.execution, original.execution);
  resting(candidate, 'sell', 100, 12.02, 'ai1');
  place(candidate, 'buy', 100, 12.03);
  assert.equal(copied.remaining, 0);
  assert.deepEqual(copied.execution, original.execution);
  copied.execution!.amount += 100;
  assert.equal(JSON.stringify(market), saved, 'candidate changes are safe to discard');
});

test('old orders remain unannotated and invalid new receipt data is rejected', () => {
  const market = fixture();
  resting(market, 'sell', 200, 12.01);
  const submitted = place(market, 'buy', 300, 12.03);
  const order = market.orders.find(order => order.id === submitted.id)!;
  const execution = structuredClone(order.execution!);
  delete order.execution;
  const saved = JSON.stringify(market);
  assert.ok(validateMarket(market));
  assert.equal(getView(market).orders.find(row => row.id === order.id)!.execution, undefined);
  assert.equal(JSON.stringify(market), saved, 'reading cannot guess a legacy receipt from trade history');
  for (const invalid of [
    { ...execution, filled: 300 }, { ...execution, amount: -1 }, { ...execution, priceLevels: 0 },
    { ...execution, afterPrice: undefined }, { ...execution, beforePrice: 0 },
    { filled: 0, amount: 0, priceLevels: 0, beforePrice: 1200, afterPrice: 1200 },
  ]) {
    order.execution = invalid;
    assert.equal(validateMarket(market), false, JSON.stringify(invalid));
  }
  order.execution = execution;
  assert.ok(validateMarket(market));
});
