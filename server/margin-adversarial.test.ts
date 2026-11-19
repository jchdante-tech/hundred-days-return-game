import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarket, getView, submitMarginOrder, closeMarginPosition, addMargin,
  submitOrder, cancelOrder, nextDay, repayChallenge, transferCreditCollateral,
  validateMarket, type Market,
} from './engine.js';

function market() {
  const m = createMarket(42, { legacySimulation: true });
  m.day = 20; m.calendarDate = '2026-11-16'; m.elapsedDays = 27;
  m.phase = 'morning'; m.paused = false;
  return m;
}

function cashSupply(m: Market) {
  // Account cash is a subset of player cash. Short-sale proceeds are held outside it.
  return m.brokerCash + m.actors.reduce((sum, a) => sum + a.cash, 0)
    + Object.values(m.shorts).reduce((sum, p) => sum + p.proceeds, 0)
    + (m.marginState?.accounts ?? []).flatMap(a => a.positions).reduce((sum, p) => sum + p.proceeds, 0)
    + (m.challenge?.paid ?? 0);
}

function check(m: Market, supply: number) {
  assert.equal(validateMarket(m), true, 'the actual resulting snapshot remains loadable');
  assert.equal(cashSupply(m), supply, 'all real cash, including restricted proceeds, is conserved');
}

function overnight(m: Market) {
  // Finish the review without inserting artificial market trades during the day.
  m.phase = 'night'; m.phaseElapsed = 149; nextDay(m);
  m.phase = 'morning'; m.paused = false;
}

function npcOrder(m: Market, stockId: string, side: 'buy' | 'sell', price: number, quantity: number) {
  const actor = m.actors.find(a => a.id === 'ai0')!;
  const amount = Math.round(price * 100);
  assert.ok(side === 'buy' ? actor.cash >= amount * quantity
    : actor.positions[stockId].quantity - actor.positions[stockId].today >= quantity);
  m.orders.push({ id: `adversarial-${++m.sequence}`, actorId: actor.id, stockId, side, quantity, remaining: quantity,
    price: amount, status: 'open', time: '09:30', sequence: m.sequence, createdTick: m.tickCount,
    frozenCash: side === 'buy' ? amount * quantity : 0, restrictedClaim: 0 });
}

test('one-times long buys real shares, charges no financing interest, and conserves cash through closing', () => {
  const m = market(), supply = cashSupply(m), broker = m.brokerCash;
  const beforeShares = m.actors[0].positions.s1?.quantity ?? 0;
  assert.equal(submitMarginOrder(m, { stockId: 's1', direction: 'long', mode: 'isolated', leverage: 1,
    principal: 1201, price: 12.01 }).ok, true);
  const opened = getView(m).margin.positions[0];
  assert.equal(opened.quantity, 100); assert.equal(opened.loan, 0);
  assert.equal(m.actors[0].positions.s1.quantity, beforeShares + 100);
  assert.equal(m.brokerCash, broker); assert.equal(getView(m).margin.dailyInterest, 0);
  assert.equal(closeMarginPosition(m, { positionId: opened.id, quantity: 100, price: 11.99 }).ok, false);
  check(m, supply);
  overnight(m);
  assert.equal(getView(m).margin.interest, 0);
  const bid = getView(m).stocks[0].bids[0].price;
  assert.equal(closeMarginPosition(m, { positionId: opened.id, quantity: 100, price: bid }).ok, true);
  assert.equal(getView(m).margin.positions.some(p => p.quantity > 0), false);
  assert.equal(getView(m).margin.totalDebt, 0); assert.equal(m.brokerCash, broker);
  check(m, supply);
});

test('an unfilled opening reserves principal once and cancellation returns it without a loan or fee', () => {
  const m = market(); m.phase = 'auction';
  const supply = cashSupply(m), available = getView(m).availableCash;
  assert.equal(submitMarginOrder(m, { stockId: 's1', direction: 'long', mode: 'isolated', leverage: 3,
    principal: 1080, price: 10.8 }).ok, true);
  let view = getView(m);
  const order = view.orders.find(o => o.side === 'marginBuy')!;
  assert.equal(order.remaining, 300); assert.equal(view.availableCash, available - 1080);
  assert.equal(view.margin.financingDebt, 0); assert.equal(view.margin.interest, 0);
  assert.equal(cancelOrder(m, order.id).ok, true);
  view = getView(m);
  assert.equal(view.availableCash, available); assert.equal(view.margin.totalDebt, 0);
  assert.equal(view.margin.positions.length, 0);
  check(m, supply);
});

test('partial opening cancellation refunds only unfilled principal and preserves the executed loan', () => {
  const m = market(); m.orders = [];
  npcOrder(m, 's1', 'sell', 12.01, 100);
  const supply = cashSupply(m), available = getView(m).availableCash;
  assert.equal(submitMarginOrder(m, { stockId: 's1', direction: 'long', mode: 'isolated', leverage: 2,
    principal: 1801.5, price: 12.01 }).ok, true);
  let view = getView(m);
  const order = view.orders.find(o => o.side === 'marginBuy')!;
  assert.equal(order.filled, 100); assert.equal(order.remaining, 200);
  assert.equal(view.margin.positions[0].loan, 600.5);
  assert.equal(view.availableCash, available - 1801.5);
  assert.equal(cancelOrder(m, order.id).ok, true);
  view = getView(m);
  assert.equal(view.availableCash, available - 600.5);
  assert.equal(view.margin.positions[0].quantity, 100);
  assert.equal(view.margin.positions[0].loan, 600.5);
  assert.equal(view.margin.positions[0].principal, 600.5);
  check(m, supply);
});

test('same-stock ordinary holdings, two isolated positions and a cross account cannot sell each other shares', () => {
  const m = market(), supply = cashSupply(m);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'buy', quantity: 100, price: 12.01 }).ok, true);
  for (const mode of ['isolated', 'isolated', 'cross', 'cross'] as const) {
    assert.equal(submitMarginOrder(m, { stockId: 's1', direction: 'long', mode, leverage: 2,
      principal: 600.5, price: 12.01 }).ok, true);
  }
  let view = getView(m);
  assert.equal(view.margin.accounts.filter(a => a.mode === 'isolated').length, 2);
  assert.equal(view.margin.accounts.filter(a => a.mode === 'cross').length, 1);
  assert.equal(view.margin.positions.length, 4);
  for (const p of view.margin.positions) {
    assert.equal(p.availableQuantity, 0);
    assert.equal(closeMarginPosition(m, { positionId: p.id, quantity: 100, price: 11.99 }).ok, false);
  }
  overnight(m); view = getView(m);
  assert.equal(view.positions.find(p => p.stockId === 's1')!.available, 100);
  const bid = view.stocks[0].bids[0].price;
  assert.equal(submitOrder(m, { stockId: 's1', side: 'sell', quantity: 100, price: bid }).ok, true);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'sell', quantity: 100, price: bid }).ok, false);
  const closing = view.margin.positions[0], untouched = view.margin.positions.slice(1).map(p => [p.id, p.quantity]);
  assert.equal(closeMarginPosition(m, { positionId: closing.id, quantity: 100, price: bid }).ok, true);
  const after = getView(m);
  for (const [id, quantity] of untouched) assert.equal(after.margin.positions.find(p => p.id === id)!.quantity, quantity);
  assert.equal(after.margin.positions.find(p => p.id === closing.id)?.quantity ?? 0, 0);
  check(m, supply);
});

test('an isolated loss uses neither other margin accounts nor ordinary cash and top-ups stay in the selected account', () => {
  const m = market(), supply = cashSupply(m);
  for (const [stockId, mode, principal, price, leverage] of [
    ['s1', 'isolated', 400.34, 12.01, 3], ['s3', 'isolated', 1801, 18.01, 1], ['s5', 'cross', 2201, 22.01, 1],
  ] as const) assert.equal(submitMarginOrder(m, { stockId, direction: 'long', mode, principal, price, leverage }).ok, true);
  const stressed = getView(m).margin.positions.find(p => p.stockId === 's1')!;
  const other = getView(m).margin.accounts.find(a => a.id !== stressed.accountId)!;
  assert.equal(addMargin(m, { accountId: other.id, amount: 100 }).ok, true);
  const stressedCash = getView(m).margin.accounts.find(a => a.id === stressed.accountId)!.cash;
  // Print three real limit-down trades on successive days rather than forging a mark.
  for (let day = 0; day < 3; day++) {
    overnight(m);
    m.orders = m.orders.filter(o => o.actorId === 'player');
    const price = getView(m).stocks[0].limitDown;
    npcOrder(m, 's1', 'sell', price, 100);
    assert.equal(submitOrder(m, { stockId: 's1', side: 'buy', quantity: 100, price }).ok, true);
  }
  let view = getView(m);
  assert.equal(view.margin.accounts.find(a => a.id === stressed.accountId)!.riskLevel, 'liquidating');
  assert.equal(view.margin.accounts.find(a => a.id === stressed.accountId)!.cash, stressedCash);
  const ordinary = view.availableCash;
  const otherCash = view.margin.accounts.filter(a => a.id !== stressed.accountId).map(a => [a.id, a.cash] as const);
  overnight(m); view = getView(m);
  assert.equal(view.availableCash, ordinary);
  for (const [id, cash] of otherCash) assert.equal(view.margin.accounts.find(a => a.id === id)!.cash, cash);
  assert.ok(m.orders.some(o => o.forced && o.marginAccountId === stressed.accountId));
  assert.equal(m.orders.some(o => o.forced && o.marginAccountId && o.marginAccountId !== stressed.accountId), false);
  assert.equal(addMargin(m, { accountId: stressed.accountId, amount: 200 }).ok, true);
  assert.equal(getView(m).availableCash, ordinary - 200);
  assert.ok(getView(m).margin.accounts.find(a => a.id === stressed.accountId)!.marginRatio >= 20);
  assert.equal(getView(m).margin.positions.find(p => p.id === stressed.id)!.availableQuantity, stressed.quantity,
    'restoring margin releases stale forced-sale reservations so the player can close normally');
  assert.equal(m.orders.some(o => o.forced && o.marginAccountId === stressed.accountId
    && o.remaining > 0 && ['open', 'partial'].includes(o.status)), false);
  for (const [id, cash] of otherCash) assert.equal(getView(m).margin.accounts.find(a => a.id === id)!.cash, cash);
  check(m, supply);
});

test('pending margin borrowing cannot coexist with external challenge repayment', () => {
  const m = market(); m.phase = 'auction';
  const supply = cashSupply(m), target = m.challenge!.paid;
  assert.equal(submitMarginOrder(m, { stockId: 's1', direction: 'long', mode: 'cross', leverage: 2,
    principal: 1080, price: 10.8 }).ok, true);
  assert.equal(getView(m).margin.financingDebt, 0);
  assert.equal(repayChallenge(m, 1000).ok, false); assert.equal(m.challenge!.paid, target);
  const opening = getView(m).orders.find(o => o.side === 'marginBuy')!;
  assert.equal(cancelOrder(m, opening.id).ok, true);
  assert.equal(repayChallenge(m, 1000).ok, true);
  assert.equal(m.challenge!.paid, target + 100_000);
  check(m, supply);
});

test('unknown margin versions and malformed account ownership are rejected while valid positions round-trip', () => {
  const m = market();
  assert.equal(submitMarginOrder(m, { stockId: 's1', direction: 'long', mode: 'isolated', leverage: 2,
    principal: 600.5, price: 12.01 }).ok, true);
  const restored = JSON.parse(JSON.stringify(m));
  assert.equal(validateMarket(restored), true);
  assert.deepEqual(getView(restored).margin, getView(m).margin);
  for (const marginState of [null, {}, { version: 2, accounts: [] }, { version: 1, accounts: {} }]) {
    assert.equal(validateMarket({ ...m, marginState }), false);
  }
  const badCash = structuredClone(m);
  badCash.marginState!.accounts[0].cash = badCash.actors[0].cash + 1;
  assert.equal(validateMarket(badCash), false);
  const duplicate = structuredClone(m);
  duplicate.marginState!.accounts.push(structuredClone(duplicate.marginState!.accounts[0]));
  assert.equal(validateMarket(duplicate), false);
  const pending = market(); pending.phase = 'auction';
  assert.equal(submitMarginOrder(pending, { stockId: 's1', direction: 'long', mode: 'isolated', leverage: 2,
    principal: 1080, price: 10.8 }).ok, true);
  const underReserved = structuredClone(pending);
  underReserved.marginState!.accounts[0].cash = 0;
  assert.equal(validateMarket(underReserved), false, 'an opening reservation must be backed by its own account cash');
  assert.equal(submitOrder(pending, { stockId: 's1', side: 'buy', quantity: 100, price: 10.8 }).ok, true);
  const overlappingCash = structuredClone(pending);
  overlappingCash.actors[0].cash = 108_000;
  assert.equal(validateMarket(overlappingCash), false, 'ordinary order freezes and margin cash cannot claim the same money');
});

test('legacy and new shorts share reserved and borrowed inventory and real short proceeds remain cash-conserving', () => {
  const m = market(); m.phase = 'auction';
  const supply = cashSupply(m);
  assert.equal(transferCreditCollateral(m, { direction: 'in', cash: 500_000 }).ok, true);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 9000, price: 24.2 }).ok, true);
  assert.equal(submitMarginOrder(m, { stockId: 's5', direction: 'short', mode: 'isolated', leverage: 1,
    principal: 48_400, price: 24.2 }).ok, false);
  assert.equal(cancelOrder(m, getView(m).orders.find(o => o.side === 'short')!.id).ok, true);
  assert.equal(submitMarginOrder(m, { stockId: 's5', direction: 'short', mode: 'isolated', leverage: 1,
    principal: 242_000, price: 24.2 }).ok, true);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 100, price: 24.2 }).ok, false);
  assert.equal(cancelOrder(m, getView(m).orders.find(o => o.side === 'marginShort')!.id).ok, true);
  m.phase = 'morning'; m.orders = [];
  npcOrder(m, 's5', 'buy', 22, 10_000);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 1000, price: 22 }).ok, true);
  assert.equal(submitMarginOrder(m, { stockId: 's5', direction: 'short', mode: 'isolated', leverage: 1,
    principal: 217_800, price: 22 }).ok, true);
  let view = getView(m);
  const opened = view.margin.positions.find(p => p.quantity > 0)!;
  assert.equal(opened.quantity, 9000); assert.equal(opened.lockedProceeds, 198_000);
  assert.equal(m.stocks[4].lendAvailable, 0); assert.equal(m.shorts.s5.quantity, 1000);
  assert.equal(submitOrder(m, { stockId: 's5', side: 'short', quantity: 100, price: 22 }).ok, false);
  check(m, supply);
  overnight(m); m.orders = [];
  npcOrder(m, 's5', 'sell', 22, 9000);
  assert.equal(closeMarginPosition(m, { positionId: opened.id, quantity: 9000, price: 22 }).ok, true);
  view = getView(m);
  assert.equal(view.margin.positions.some(p => p.direction === 'short' && p.quantity > 0), false);
  assert.equal(m.stocks[4].lendAvailable, 9000); assert.equal(m.shorts.s5.quantity, 1000);
  check(m, supply);
});

test('short liquidation can use an affordable real ask even when a full limit-up reservation exceeds its account cash', () => {
  const m = market(); m.orders = [];
  const supply = cashSupply(m);
  npcOrder(m, 's5', 'buy', 22, 100);
  assert.equal(submitMarginOrder(m, { stockId: 's5', direction: 'short', mode: 'isolated', leverage: 3,
    principal: 806.67, price: 22 }).ok, true);
  const opened = getView(m).margin.positions[0];
  for (let day = 0; day < 3; day++) {
    overnight(m);
    m.orders = m.orders.filter(o => o.actorId === 'player');
    const price = getView(m).stocks[4].limitUp;
    npcOrder(m, 's5', 'sell', price, 100);
    assert.equal(submitOrder(m, { stockId: 's5', side: 'buy', quantity: 100, price }).ok, true);
  }
  assert.equal(getView(m).margin.accounts[0].riskLevel, 'liquidating');
  const ordinary = getView(m).availableCash;
  overnight(m);
  const view = getView(m), stock = view.stocks[4], account = view.margin.accounts[0];
  assert.ok(stock.asks[0].price * opened.quantity - opened.lockedProceeds < account.cash);
  assert.ok(stock.limitUp * opened.quantity - opened.lockedProceeds > account.cash);
  assert.ok(m.orders.some(o => o.forced && o.side === 'marginCover' && o.marginPositionId === opened.id
    && o.remaining > 0 && ['open', 'partial'].includes(o.status)), 'affordable liquidation must have an actual close order');
  assert.equal(view.availableCash, ordinary);
  check(m, supply);
});

test('a cross liquidation cancels remaining forced sales once an actual first close restores the warning threshold', () => {
  const m = market(), supply = cashSupply(m);
  assert.equal(submitMarginOrder(m, { stockId: 's1', direction: 'long', mode: 'cross', leverage: 3,
    principal: 1201, price: 12.01 }).ok, true);
  assert.equal(submitMarginOrder(m, { stockId: 's3', direction: 'long', mode: 'cross', leverage: 3,
    principal: 600.34, price: 18.01 }).ok, true);
  const first = getView(m).margin.positions.find(p => p.stockId === 's1')!;
  const second = getView(m).margin.positions.find(p => p.stockId === 's3')!;
  for (let day = 0; day < 3; day++) {
    overnight(m);
    m.orders = m.orders.filter(o => o.actorId === 'player');
    for (const stockId of ['s1', 's3']) {
      const price = getView(m).stocks.find(s => s.id === stockId)!.limitDown;
      npcOrder(m, stockId, 'sell', price, 100);
      assert.equal(submitOrder(m, { stockId, side: 'buy', quantity: 100, price }).ok, true);
    }
  }
  assert.equal(getView(m).margin.accounts[0].riskLevel, 'liquidating');
  overnight(m);
  const firstForced = m.orders.find(o => o.forced && o.marginPositionId === first.id)!;
  const secondForced = m.orders.find(o => o.forced && o.marginPositionId === second.id)!;
  assert.ok(firstForced); assert.ok(secondForced);
  for (const stockId of ['s1', 's3']) {
    const s = getView(m).stocks.find(s => s.id === stockId)!;
    // Keep the already resting bids: their earlier sequence gives the actual
    // sale price. An unmarketable ordinary sale only invokes matching.
    assert.equal(submitOrder(m, { stockId, side: 'sell', quantity: 100, price: s.limitUp }).ok, true);
  }
  assert.equal(firstForced.status, 'filled');
  assert.equal(secondForced.status, 'cancelled');
  assert.ok(getView(m).margin.accounts[0].marginRatio >= 20);
  assert.equal(getView(m).margin.positions.find(p => p.id === second.id)!.quantity, second.quantity);
  check(m, supply);
});
