import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePhase, cancelOrder, createMarket, getView, nextDay, submitOrder, validateMarket, type Market } from './engine.js';

function closeDay(m: Market) {
  for (let phase = 0; phase < 6 && m.phase !== 'night'; phase++) advancePhase(m);
  assert.equal(m.phase, 'night');
}

function matchingFixture() {
  const m = createMarket(42, { legacySimulation: true });
  m.phase = 'morning'; m.paused = false;
  return m;
}

test('an unfilled day-one buy is clearly pending and expires at close without inventing a holding', () => {
  const m = createMarket(42);
  advancePhase(m); m.paused = false;
  const initialCash = getView(m).cash;
  const stock = getView(m).stocks.find(s => s.id === 's4')!;
  const result = submitOrder(m, { stockId: stock.id, side: 'buy', quantity: 100, price: stock.limitDown });
  assert.equal(result.ok, true);
  assert.match(result.message, /尚未成交/);
  const submitted = getView(m).orders.find(o => o.stockId === stock.id)!;
  assert.equal(submitted.filled, 0);
  assert.equal(submitted.day, 1);
  assert.equal(getView(m).positions.some(p => p.stockId === stock.id), false);
  assert.equal(getView(m).frozenCash, stock.limitDown * 100);
  closeDay(m);
  const expired = getView(m).orders.find(o => o.id === submitted.id)!;
  assert.equal(expired.status, 'cancelled');
  assert.equal(expired.cancelReason, 'day-expired');
  assert.equal(expired.filled, 0);
  assert.equal(getView(m).cash, initialCash);
  assert.equal(getView(m).frozenCash, 0);
  assert.ok(m.ledger.some(l => l.kind === '收盘撤单' && /未成交/.test(l.description)));
  nextDay(m);
  assert.equal(m.day, 2);
  assert.equal(getView(m).orders.find(o => o.id === submitted.id)!.day, 1);
  assert.equal(getView(m).positions.some(p => p.stockId === stock.id), false);
  assert.equal(getView(m).availableCash, initialCash);
});

test('filled and partial buy acknowledgements report actual matched shares', () => {
  const full = matchingFixture();
  const filled = submitOrder(full, { stockId: 's2', side: 'buy', quantity: 100, price: 28.01 });
  assert.equal(filled.ok, true);
  assert.match(filled.message, /已全部成交.*100 股/);
  assert.equal(getView(full).positions.find(p => p.stockId === 's2')!.quantity, 100);
  assert.equal(getView(full).trades[0].day, 1);

  const partial = matchingFixture();
  const result = submitOrder(partial, { stockId: 's2', side: 'buy', quantity: 2500, price: 28.01 });
  assert.equal(result.ok, true);
  assert.match(result.message, /部分成交.*2,000 股.*500 股/);
  assert.equal(getView(partial).positions.find(p => p.stockId === 's2')!.quantity, 2000);
  // Reach the real closing-auction boundary while retaining the fixed-price book.
  partial.phase = 'closing'; partial.phaseElapsed = 14;
  advancePhase(partial);
  const expired = getView(partial).orders.find(o => o.stockId === 's2')!;
  assert.equal(expired.cancelReason, 'day-expired');
  assert.equal(expired.filled, 2000);
  assert.equal(expired.remaining, 500);
  assert.equal(getView(partial).positions.find(p => p.stockId === 's2')!.quantity, 2000);
  nextDay(partial);
  assert.equal(getView(partial).positions.find(p => p.stockId === 's2')!.available, 2000);
  assert.equal(getView(partial).trades.find(t => t.stockId === 's2')!.day, 1);
});

test('auction feedback explains waiting for matching and manual cancellation keeps its own reason', () => {
  const m = createMarket(42); m.paused = false;
  const result = submitOrder(m, { stockId: 's4', side: 'buy', quantity: 100, price: 35 });
  assert.equal(result.ok, true);
  assert.match(result.message, /尚未成交.*集合竞价.*集中撮合/);
  const order = getView(m).orders.find(o => o.stockId === 's4')!;
  assert.equal(cancelOrder(m, order.id).ok, true);
  assert.equal(getView(m).orders.find(o => o.id === order.id)!.cancelReason, 'user');
});

test('legacy orders remain readable without guessing their trade day or cancellation reason', () => {
  const m = matchingFixture();
  submitOrder(m, { stockId: 's2', side: 'buy', quantity: 100, price: 25.2 });
  const order = m.orders.find(o => o.actorId === 'player')!;
  cancelOrder(m, order.id);
  delete order.day; delete order.cancelReason;
  const saved: unknown = JSON.parse(JSON.stringify(m));
  assert.ok(validateMarket(saved));
  const restored = getView(saved).orders.find(o => o.id === order.id)!;
  assert.equal(restored.day, undefined);
  assert.equal(restored.cancelReason, undefined);
  order.day = 0;
  assert.equal(validateMarket(m), false);
});
