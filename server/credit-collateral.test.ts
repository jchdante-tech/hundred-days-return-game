import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, getView, submitOrder, cancelOrder, repay, nextDay, validateMarket, transferCreditCollateral, type Market } from './engine.js';

function market() {
  const m = createMarket(42, { legacySimulation: true });
  m.day = 20; m.calendarDate = '2026-11-16'; m.elapsedDays = 27; m.paused = false;
  assert.equal(transferCreditCollateral(m, { direction: 'in', cash: 10_000_000 }).ok, true);
  return m;
}
function setCash(m: Market, amount: number) {
  const delta = Math.round(amount * 100) - m.actors[0].cash;
  m.actors[0].cash += delta; m.brokerCash -= delta; m.creditAccount!.cash = Math.round(amount * 100);
}
function transferShares(m: Market, stockId: string, quantity: number, pledged = true) {
  const s = m.stocks.find(s => s.id === stockId)!;
  const from = m.actors.find(a => a.id !== 'player' && (a.positions[stockId]?.quantity ?? 0) >= quantity)!;
  from.positions[stockId].quantity -= quantity; from.positions[stockId].cost -= s.price * quantity;
  m.actors[0].positions[stockId] = { quantity, today: 0, financed: 0, cost: s.price * quantity };
  if (pledged) assert.equal(transferCreditCollateral(m, { direction: 'in', stockId, quantity }).ok, true);
}
function cashSupply(m: Market) {
  return m.brokerCash + m.actors.reduce((sum, a) => sum + a.cash, 0)
    + Object.values(m.shorts).reduce((sum, s) => sum + s.proceeds, 0) + (m.challenge?.paid ?? 0);
}
function mature(m: Market) {
  m.elapsedDays = 99; m.calendarDate = '2027-01-27'; m.day = 71; m.phase = 'night'; nextDay(m);
}
function npcOrder(m: Market, stockId: string, side: 'buy' | 'sell', price: number, quantity: number) {
  m.orders.push({ id: `fixture-${++m.sequence}`, actorId: 'ai0', stockId, side, quantity, remaining: quantity,
    price: Math.round(price * 100), status: 'open', time: '09:30', sequence: m.sequence, createdTick: 0,
    frozenCash: side === 'buy' ? Math.round(price * 100) * quantity : 0, restrictedClaim: 0 });
}

test('aggregate financing cap counts filled principal and every remaining order, and cancellation releases it', () => {
  const m = market();
  m.principal = 150_000_000;
  assert.equal(getView(m).credit.financeAvailable, 500_000);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'finance', quantity: 40_000, price: 10.8 }).ok, true);
  const view = getView(m);
  assert.equal(view.credit.financePending, 432_000);
  assert.equal(view.credit.financeAvailable, 68_000);
  assert.equal(submitOrder(m, { stockId: 's3', side: 'finance', quantity: 5000, price: 16.2 }).ok, false);
  assert.equal(cancelOrder(m, view.orders[0].id).ok, true);
  assert.equal(getView(m).financeAvailable, 500_000);
  m.principal = 250_000_000;
  assert.equal(getView(m).financeAvailable, 0);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'finance', quantity: 100, price: 12 }).ok, false);
  assert.equal(repay(m, 1_000_000).ok, true);
  assert.equal(getView(m).credit.financeAvailable, 500_000);
});

test('cash, existing shares and IPO haircuts are explicit, while financed shares never multiply collateral', () => {
  const m = market(); setCash(m, 1000); transferShares(m, 's1', 1000); transferShares(m, 's3', 1000);
  m.actors[0].positions.s1.financed = 400;
  m.stocks[2].listedDay = 18;
  let credit = getView(m).credit;
  assert.equal(credit.collateralCash, 1000);
  assert.equal(credit.collateralPositions.find(p => p.stockId === 's1')!.quantity, 600);
  assert.equal(credit.collateralPositions.find(p => p.stockId === 's1')!.collateralValue, 4320);
  assert.equal(credit.collateralPositions.find(p => p.stockId === 's3')!.ratio, 0);
  assert.equal(credit.collateralTotal, 5320);
  m.day = 23; credit = getView(m).credit;
  assert.equal(credit.collateralPositions.find(p => p.stockId === 's3')!.ratio, .5);
  assert.equal(credit.collateralTotal, 14_320);
});

test('finance and short orders reserve one collateral pool, protecting it from ordinary cash spending', () => {
  const m = market(); setCash(m, 5000);
  const supply = cashSupply(m);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'finance', quantity: 100, price: 10.8 }).ok, true);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 100, price: 24.2 }).ok, true);
  let view = getView(m);
  assert.equal(view.credit.collateralPending, 3500);
  assert.equal(view.availableCash, 0); assert.equal(view.credit.withdrawableCash, 1500);
  assert.equal(submitOrder(m, { stockId: 's2', side: 'buy', quantity: 100, price: 25.2 }).ok, false);
  assert.equal(submitOrder(m, { stockId: 's3', side: 'finance', quantity: 100, price: 16.2 }).ok, false);
  assert.equal(cancelOrder(m, view.orders.find(o => o.side === 'short')!.id).ok, true);
  view = getView(m);
  assert.equal(view.credit.collateralPending, 1080);
  assert.equal(view.availableCash, 0); assert.equal(view.credit.withdrawableCash, 3920);
  assert.equal(cashSupply(m), supply);
});

test('own stock collateral enables borrowing with little cash; sale is permitted and cash replaces the pledge', () => {
  const m = market(); setCash(m, 100); transferShares(m, 's1', 1000);
  m.phase = 'morning';
  const bid = m.orders.find(o => o.stockId === 's5' && o.side === 'buy')!;
  bid.price = 2200; bid.frozenCash = bid.remaining * bid.price;
  const supply = cashSupply(m);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 100, price: 22 }).ok, true);
  assert.equal(m.shorts.s5.quantity, 100);
  let view = getView(m);
  assert.equal(view.credit.collateralCash, 100);
  assert.equal(view.credit.collateralOccupied, 2200);
  assert.equal(view.restrictedCash, 2200);
  assert.equal(view.credit.collateralTotal, 7300);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'creditSell', quantity: 1000, price: 11.99 }).ok, true);
  view = getView(m);
  assert.equal(view.credit.collateralPositions.length, 0);
  assert.equal(view.credit.collateralCash, 12_090);
  assert.equal(cashSupply(m), supply);
  m.shorts.s5.today = 0;
  assert.equal(submitOrder(m, { stockId: 's5', side: 'cover', quantity: 100, price: 22.01 }).ok, true);
  assert.equal(m.stocks[4].lendAvailable, 10000);
  assert.equal(getView(m).credit.collateralOccupied, 0);
  assert.equal(cashSupply(m), supply);
});

test('borrow inventory and account capacity are different, finite, serialized and reserved until cancellation', () => {
  const m = market();
  assert.deepEqual(getView(m).credit.pools.map(p => p.stockId), ['s5', 's9', 's21']);
  assert.equal(submitOrder(m, { stockId: 's4', side: 'short', quantity: 100, price: 35 }).ok, false);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 10_000, price: 24.2 }).ok, true);
  const view = getView(m), pool = view.credit.pools.find(p => p.stockId === 's5')!;
  assert.deepEqual(pool, { stockId: 's5', total: 10_000, borrowed: 0, reserved: 10_000, available: 0, playerMaxQuantity: 0 });
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 100, price: 24.2 }).ok, false);
  const restored = JSON.parse(JSON.stringify(m));
  assert.equal(validateMarket(restored), true);
  assert.deepEqual(getView(restored).credit, view.credit);
  assert.equal(cancelOrder(restored, view.orders[0].id).ok, true);
  assert.equal(getView(restored).credit.pools[0].available, 10_000);
  setCash(restored, 2500);
  assert.equal(getView(restored).credit.pools[0].playerMaxQuantity, 100);
  assert.equal(submitOrder(restored, { stockId: 's5', side: 'short', quantity: 200, price: 24.2 }).ok, false);
});

test('combined short exposure has a contract ceiling even when the broker has spare shares', () => {
  const m = market(); m.stocks[4].lendTotal = m.stocks[4].lendAvailable = 100_000;
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 20_000, price: 24.2 }).ok, true);
  assert.equal(getView(m).credit.shortPending, 484_000);
  assert.equal(getView(m).credit.shortAvailableAmount, 16_000);
  assert.equal(submitOrder(m, { stockId: 's9', side: 'short', quantity: 2000, price: 8.8 }).ok, false);
});

test('resting credit orders are cancelled before execution if pledged shares fall', () => {
  const m = market(); setCash(m, 0); transferShares(m, 's1', 1000);
  assert.equal(submitOrder(m, { stockId: 's3', side: 'finance', quantity: 400, price: 18.01 }).ok, false);
  assert.equal(submitOrder(m, { stockId: 's3', side: 'finance', quantity: 300, price: 18.01 }).ok, true);
  m.stocks[0].price = 600; // Adverse price change before this stale resting order can fill.
  m.phase = 'morning';
  // A harmless new sell re-enters matching of the already crossable book.
  transferShares(m, 's3', 100, false);
  assert.equal(submitOrder(m, { stockId: 's3', side: 'sell', quantity: 100, price: 19.8 }).ok, true);
  const order = getView(m).orders.find(o => o.side === 'finance')!;
  assert.equal(order.status, 'cancelled');
  assert.equal(m.principal, 0);
  assert.equal(getView(m).credit.collateralPending, 0);
});

test('pledged cash remains available for debt reduction, including automatic maturity repayment', () => {
  const m = market(); delete m.challenge; setCash(m, 1000); m.principal = 100_000;
  assert.equal(getView(m).availableCash, 0);
  assert.equal(getView(m).credit.repayAvailable, 1000);
  assert.equal(repay(m, 1000).ok, true);
  assert.equal(m.principal, 0); assert.equal(m.actors[0].cash, 0);

  const due = market(); delete due.challenge; setCash(due, 1000.23); due.principal = 100_000;
  const supply = cashSupply(due); mature(due);
  assert.equal(due.result, 'won'); assert.equal(due.principal, 0); assert.equal(due.interest, 0);
  assert.equal(due.actors[0].cash, 0); assert.equal(cashSupply(due), supply);

  const borrowed = market(); delete borrowed.challenge; setCash(borrowed, 1000.86);
  borrowed.principal = 100_000; borrowed.shorts.s5 = { quantity: 100, today: 0, proceeds: 220_000, margin: 220_000 };
  borrowed.stocks[4].lendAvailable -= 100;
  mature(borrowed);
  assert.equal(borrowed.result, 'default'); assert.equal(borrowed.principal, 0);
  assert.equal(borrowed.shorts.s5.quantity, 100); assert.equal(borrowed.shorts.s5.proceeds, 220_000);
});

test('a new short fill cannot reprice earlier borrowed shares beyond collateral', () => {
  const m = market(); m.phase = 'morning'; m.orders = []; setCash(m, 0); transferShares(m, 's1', 1000);
  npcOrder(m, 's5', 'buy', 22, 200);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 200, price: 22 }).ok, true);
  assert.equal(getView(m).credit.pools.find(p => p.stockId === 's5')!.playerMaxQuantity, 0);
  const before = cashSupply(m), trades = m.trades.length;
  npcOrder(m, 's5', 'buy', 24.2, 100);
  const result = submitOrder(m, { stockId: 's5', side: 'short', quantity: 100, price: 24.2 });
  assert.equal(result.ok, true);
  assert.match(result.message, /已取消/);
  assert.doesNotMatch(result.message, /等待|继续挂单/);
  const after = getView(m);
  assert.equal(after.orders[0].status, 'cancelled');
  assert.equal(after.credit.collateralOccupied, 4400); assert.equal(after.credit.collateralTotal, 7200);
  assert.equal(m.shorts.s5.quantity, 200); assert.equal(m.stocks[4].price, 2200);
  assert.equal(m.trades.length, trades); assert.equal(cashSupply(m), before);
});

test('a new financed fill cannot mark its existing collateral below the resulting debt', () => {
  const m = market(); m.phase = 'morning'; m.orders = []; setCash(m, 0); transferShares(m, 's1', 1000);
  npcOrder(m, 's3', 'sell', 19.8, 300);
  assert.equal(submitOrder(m, { stockId: 's3', side: 'finance', quantity: 300, price: 19.8 }).ok, true);
  const before = cashSupply(m), trades = m.trades.length;
  npcOrder(m, 's1', 'sell', 10.8, 100);
  const result = submitOrder(m, { stockId: 's1', side: 'finance', quantity: 100, price: 12 });
  assert.equal(result.ok, true);
  assert.match(result.message, /已取消/);
  assert.doesNotMatch(result.message, /等待|继续挂单/);
  const after = getView(m);
  assert.equal(after.orders[0].status, 'cancelled'); assert.equal(m.principal, 594_000);
  assert.equal(after.credit.collateralTotal, 7200); assert.equal(m.stocks[0].price, 1200);
  assert.equal(m.actors[0].positions.s1.quantity, 1000);
  assert.equal(m.trades.length, trades); assert.equal(cashSupply(m), before);
});

test('a short execution cannot exceed the aggregate cap by repricing the existing borrowed balance', () => {
  const m = market(); m.phase = 'morning'; m.orders = [];
  m.stocks[4].price = m.stocks[4].previousClose = 4400;
  m.stocks[8].price = m.stocks[8].previousClose = 1000;
  npcOrder(m, 's5', 'buy', 44, 9000);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 9000, price: 44 }).ok, true);
  npcOrder(m, 's9', 'buy', 10, 5000);
  assert.equal(submitOrder(m, { stockId: 's9', side: 'short', quantity: 5000, price: 10 }).ok, true);
  assert.equal(getView(m).credit.pools.find(p => p.stockId === 's5')!.playerMaxQuantity, 200);
  const before = cashSupply(m), trades = m.trades.length;
  npcOrder(m, 's5', 'buy', 48.4, 1000);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 1000, price: 48.4 }).ok, true);
  const after = getView(m);
  assert.equal(after.orders[0].status, 'cancelled'); assert.equal(after.credit.shortUsed, 446_000);
  assert.equal(m.shorts.s5.quantity, 9000); assert.equal(m.stocks[4].price, 4400);
  assert.equal(m.trades.length, trades); assert.equal(cashSupply(m), before);
});

test('a safe improved fill replaces only its executed reservation by actual principal', () => {
  const m = market(); m.phase = 'morning'; m.orders = []; setCash(m, 1000); transferShares(m, 's1', 100);
  m.principal = 52_000;
  npcOrder(m, 's1', 'sell', 10.8, 100);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'finance', quantity: 100, price: 12 }).ok, true);
  const view = getView(m);
  assert.equal(view.orders[0].status, 'filled'); assert.equal(m.principal, 160_000);
  assert.equal(view.credit.collateralTotal, 1648); assert.equal(view.credit.collateralAvailable, 48);
  assert.equal(view.credit.collateralPending, 0); assert.equal(m.actors[0].positions.s1.quantity, 200);
});
