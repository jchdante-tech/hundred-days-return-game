import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarket, getView, submitOrder, cancelOrder, nextDay, transferCreditCollateral,
  submitMarginOrder, closeMarginPosition, submitIpoSubscription, validateMarket, type Market,
} from './engine.js';
import { getChipSupply } from './chips.js';

const player = (m: Market) => m.actors.find(a => a.id === 'player')!;
const stock = (m: Market, id = 's1') => m.stocks.find(s => s.id === id)!;
const chips = (m: Market, id = 's1') => getChipSupply(m, stock(m, id));
const cashSupply = (m: Market) => m.brokerCash + m.actors.reduce((sum, a) => sum + a.cash, 0)
  + Object.values(m.shorts).reduce((sum, p) => sum + p.proceeds, 0)
  + (m.marginState?.accounts ?? []).flatMap(a => a.positions).reduce((sum, p) => sum + p.proceeds, 0)
  + (m.challenge?.paid ?? 0);

function fixture(credit = false) {
  const m = createMarket(42, { legacySimulation: credit });
  if (credit) { m.day = 20; m.calendarDate = '2026-11-16'; m.elapsedDays = 27; }
  m.phase = 'morning'; m.phaseElapsed = 0; m.paused = false; m.orders = [];
  return m;
}

// A finite, funded counterparty lets the real matching and settlement code run
// without unrelated NPC orders determining whether this regression fills.
function counterparty(m: Market, stockId: string, side: 'buy' | 'sell', quantity: number, price: number) {
  const a = m.actors.find(a => a.id === (m.agentSimulation ? 'crowd0' : 'ai0'))!;
  const cents = Math.round(price * 100);
  assert.ok(side === 'buy' ? a.cash >= quantity * cents
    : a.positions[stockId].quantity - a.positions[stockId].today >= quantity);
  const sequence = ++m.sequence;
  m.orders.push({ id: `chips-counterparty-${sequence}`, actorId: a.id, stockId, side, quantity,
    remaining: quantity, price: cents, status: 'open', time: '09:30', sequence,
    createdTick: m.tickCount, frozenCash: side === 'buy' ? quantity * cents : 0,
    restrictedClaim: 0, day: m.day });
}

function overnight(m: Market) {
  // Start the actual settlement transition at the end of the review period;
  // no manufactured intraday trades should obscure the ownership assertion.
  m.phase = 'night'; m.phaseElapsed = 149; nextDay(m);
  assert.equal(m.phase, 'auction');
  m.phase = 'morning'; m.phaseElapsed = 0; m.paused = false; m.orders = [];
}

function checkSave(m: Market, cash: number) {
  assert.equal(cashSupply(m), cash, 'real cash including restricted short proceeds remains conserved');
  const restored: unknown = JSON.parse(JSON.stringify(m));
  assert.ok(validateMarket(restored), 'the resulting holdings and subledgers remain a loadable save');
  return restored;
}

test('chip measurements read pre-feature snapshots without rewriting cash, inventory, cost or save shape', () => {
  for (const legacySimulation of [false, true]) {
    const original = createMarket(43, { legacySimulation });
    const restored: Market = JSON.parse(JSON.stringify(original));
    assert.ok(validateMarket(restored));
    const before = JSON.stringify(restored);
    for (const s of restored.stocks) {
      const actual = getChipSupply(restored, s);
      assert.equal(actual.floatShares, 1_800_000 + s.lendAvailable);
      assert.equal(actual.playerShares, 0);
      assert.ok(actual.floatShares <= s.shares);
      for (const amount of Object.values(actual)) assert.ok(Number.isFinite(amount));
    }
    assert.equal(JSON.stringify(restored), before, 'deriving chip state must not migrate or mint holdings');
  }
});

test('a real purchase concentrates chips, and T+1 unlocks supply without changing ownership or the float', () => {
  const m = fixture(), before = chips(m), cash = cashSupply(m);
  counterparty(m, 's1', 'sell', 10_000, 12);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'buy', quantity: 10_000, price: 12 }).ok, true);
  assert.equal(player(m).positions.s1.quantity, 10_000, 'the purchase must actually fill');
  const after = chips(m);
  assert.equal(after.floatShares, before.floatShares);
  assert.equal(after.playerShares, 10_000);
  assert.equal(after.largeHolderShares, before.largeHolderShares + 10_000);
  assert.ok(after.concentration > before.concentration);
  assert.equal(after.t1LockedShares, before.t1LockedShares + 10_000);
  assert.equal(getView(m).positions.find(p => p.stockId === 's1')!.available, 0);
  const cost = player(m).positions.s1.cost;
  overnight(m);
  const tomorrow = chips(m);
  assert.equal(tomorrow.floatShares, after.floatShares);
  assert.equal(tomorrow.concentration, after.concentration);
  assert.equal(tomorrow.playerShares, 10_000);
  assert.equal(tomorrow.t1LockedShares, 0);
  assert.equal(player(m).positions.s1.cost, cost);
  assert.equal(getView(m).positions.find(p => p.stockId === 's1')!.available, 10_000);
  checkSave(m, cash);
});

test('unfilled and cancelled orders do not fabricate concentrated ownership', () => {
  const m = fixture(), before = chips(m), cash = cashSupply(m);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'buy', quantity: 10_000, price: 10.8 }).ok, true);
  const order = m.orders.find(o => o.actorId === 'player')!;
  assert.equal(order.remaining, 10_000);
  assert.deepEqual(chips(m), before);
  assert.equal(cancelOrder(m, order.id).ok, true);
  assert.deepEqual(chips(m), before);
  checkSave(m, cash);
});

test('credit collateral, financed shares and margin subledgers count each physical share only once', () => {
  const m = fixture(true), before = chips(m), cash = cashSupply(m);
  counterparty(m, 's1', 'sell', 1_000, 12);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'buy', quantity: 1_000, price: 12 }).ok, true);
  overnight(m);
  const held = chips(m);
  assert.equal(transferCreditCollateral(m, { direction: 'in', stockId: 's1', quantity: 400 }).ok, true);
  assert.equal(transferCreditCollateral(m, { direction: 'in', cash: 10_000 }).ok, true);
  assert.equal(chips(m).playerShares, held.playerShares, 'pledging creates no new ownership');
  assert.equal(chips(m).floatShares, held.floatShares);
  counterparty(m, 's1', 'sell', 200, 12);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'finance', quantity: 100, price: 12 }).ok, true);
  assert.equal(submitMarginOrder(m, { stockId: 's1', direction: 'long', mode: 'isolated', leverage: 2,
    principal: 600, price: 12 }).ok, true);
  assert.equal(m.creditAccount!.positions.s1.quantity, 500);
  assert.equal(m.marginState!.accounts[0].positions[0].quantity, 100);
  assert.equal(player(m).positions.s1.quantity, 1_200);
  const actual = chips(m);
  assert.equal(actual.floatShares, before.floatShares);
  assert.equal(actual.playerShares, 1_200, 'credit and margin holdings are subsets, not extra float');
  assert.equal(actual.playerRatio, 1_200 / actual.floatShares);
  assert.equal(actual.t1LockedShares, 200, 'subledger T+1 amounts must not be double counted');
  checkSave(m, cash);
});

for (const method of ['legacy', 'margin'] as const) {
  test(`${method} short opening and covering move lender inventory without granting the short seller chips`, () => {
    const m = fixture(true), s = stock(m, 's5'), before = chips(m, s.id), cash = cashSupply(m);
    if (method === 'legacy') assert.equal(transferCreditCollateral(m, { direction: 'in', cash: 10_000 }).ok, true);
    counterparty(m, s.id, 'buy', 100, 22);
    const result = method === 'legacy'
      ? submitOrder(m, { stockId: s.id, side: 'short', quantity: 100, price: 22 })
      : submitMarginOrder(m, { stockId: s.id, direction: 'short', mode: 'isolated', leverage: 2,
        principal: 1_210, price: 22 });
    assert.equal(result.ok, true);
    const positionId = method === 'margin' ? m.marginState!.accounts[0].positions[0].id : undefined;
    assert.equal(method === 'legacy' ? m.shorts[s.id].quantity : m.marginState!.accounts[0].positions[0].quantity, 100);
    assert.equal(s.lendAvailable, s.lendTotal - 100);
    assert.equal(chips(m, s.id).floatShares, before.floatShares);
    assert.equal(chips(m, s.id).playerShares, 0, 'borrowed-sale liabilities are not player-owned chips');
    checkSave(m, cash);
    overnight(m);
    counterparty(m, s.id, 'sell', 100, 22);
    const cover = method === 'legacy'
      ? submitOrder(m, { stockId: s.id, side: 'cover', quantity: 100, price: 22 })
      : closeMarginPosition(m, { positionId: positionId!, quantity: 100, price: 22 });
    assert.equal(cover.ok, true);
    assert.equal(s.lendAvailable, s.lendTotal);
    assert.equal(chips(m, s.id).floatShares, before.floatShares);
    assert.equal(chips(m, s.id).playerShares, 0, 'buying to return borrowed shares must not create a long holding');
    checkSave(m, cash);
  });
}

test('a real IPO includes only allocated shares in the local float and excludes issuer custody', () => {
  const m = createMarket(42), cash = cashSupply(m);
  for (let i = 0; i < 12 && !getView(m).ipos?.some(o => o.status === 'subscribing'); i++) nextDay(m);
  const offer = getView(m).ipos?.find(o => o.status === 'subscribing');
  assert.ok(offer);
  assert.equal(submitIpoSubscription(m, offer.id, offer.quotaQuantity).ok, true);
  nextDay(m);
  const listed = getView(m).ipos!.find(o => o.id === offer.id)!;
  assert.equal(listed.status, 'listed');
  assert.ok(listed.allocatedQuantity! > 0);
  const actual = chips(m, offer.stockId);
  const issuerShares = m.actors.find(a => a.id === 'ipo-issuer')!.positions[offer.stockId].quantity;
  assert.ok(issuerShares > 0);
  assert.equal(actual.floatShares, listed.issuedQuantity);
  assert.equal(actual.floatShares + issuerShares, stock(m, offer.stockId).shares);
  assert.equal(actual.playerShares, listed.allocatedQuantity);
  assert.equal(actual.t1LockedShares, 0, 'primary allocations are eligible to trade on listing day');
  assert.equal(getView(m).positions.find(p => p.stockId === offer.stockId)!.available, listed.allocatedQuantity);
  checkSave(m, cash);
});
