import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, getView, submitOrder, repay, repayChallenge, nextDay, validateMarket, transferCreditCollateral, type Market } from './engine.js';

function liquidMarket(day = 1) {
  const market = createMarket(42);
  market.paused = false; market.phase = 'morning'; market.day = day;
  if (day === 19) { market.calendarDate = '2026-11-13'; market.elapsedDays = 24; }
  if (day === 20) { market.calendarDate = '2026-11-16'; market.elapsedDays = 27; assert.equal(transferCreditCollateral(market, {direction: 'in', cash: 3_000_000}).ok, true); }
  return market;
}
function totalCash(market: Market) {
  return market.brokerCash + market.actors.reduce((sum, actor) => sum + actor.cash, 0)
    + Object.values(market.shorts).reduce((sum, short) => sum + short.proceeds, 0)
    + (market.challenge?.paid ?? 0);
}
function setCash(market: Market, yuan: number) {
  const delta = Math.round(yuan * 100) - market.actors[0].cash;
  market.actors[0].cash += delta; market.brokerCash -= delta;
}
function mature(market: Market) {
  market.elapsedDays = 99; market.calendarDate = '2027-01-27'; market.day = 71;
  market.phase = 'night'; nextDay(market);
}

test('new challenge separates the 100-million target from securities debt and starts with cash only', () => {
  const market = createMarket(9), view = getView(market);
  assert.equal(view.cash, 10_000_000);
  assert.equal(view.assets, 10_000_000);
  assert.equal(view.equity, 10_000_000);
  assert.deepEqual(view.positions, []);
  assert.equal(view.debt, 0); assert.equal(view.interest, 0); assert.equal(view.dailyInterest, 0);
  assert.equal(view.riskLevel, 'normal'); assert.equal(market.marginCallDay, null);
  assert.deepEqual(view.challenge, { target: 100_000_000, paid: 0, remaining: 100_000_000, startingCapital: 10_000_000 });
  assert.equal(view.creditUnlockDay, 20); assert.equal(view.creditUnlocked, false); assert.equal(view.financeAvailable, 0);
  // NPC redistribution must retain the same finite total funding and shares.
  assert.equal(market.actors.slice(1).reduce((sum, actor) => sum + actor.cash, 0), 27_000_000_000);
  for (const stock of market.stocks) assert.equal(market.actors.slice(1)
    .reduce((sum, actor) => sum + (actor.positions[stock.id]?.quantity ?? 0), 0), 1_800_000);
  const before = totalCash(market);
  nextDay(market);
  assert.equal(market.interest, 0); assert.equal(market.challenge!.paid, 0);
  assert.equal(totalCash(market), before);
});

test('server blocks new finance and short orders on trading days 1 and 19, unlocks on day 20', () => {
  for (const day of [1, 19]) {
    const market = liquidMarket(day), before = totalCash(market);
    for (const input of [
      { stockId: 's1', side: 'finance' as const, quantity: 100, price: 12.01 },
      { stockId: 's5', side: 'short' as const, quantity: 100, price: 22 },
    ]) {
      const result = submitOrder(market, input);
      assert.equal(result.ok, false); assert.match(result.message, /第 20 个交易日/);
    }
    assert.equal(getView(market).creditUnlocked, false);
    assert.equal(getView(market).financeAvailable, 0);
    assert.equal(getView(market).orders.length, 0); assert.equal(totalCash(market), before);
  }
  const market = liquidMarket(20), before = totalCash(market);
  assert.equal(getView(market).creditUnlocked, true);
  assert.equal(getView(market).financeAvailable, 2_000_000);
  assert.equal(submitOrder(market, { stockId: 's1', side: 'finance', quantity: 100, price: 12.01 }).ok, true);
  assert.equal(market.principal, 120_100);
  assert.equal(market.actors[0].positions.s1.financed, 100);
  assert.equal(submitOrder(market, { stockId: 's5', side: 'short', quantity: 100, price: 22 }).ok, true);
  assert.equal(totalCash(market), before);
});

test('locked credit still permits legacy cash repayment and returning existing prior-day borrowed shares', () => {
  const market = liquidMarket(20);
  const bid = market.orders.find(order => order.stockId === 's5' && order.side === 'buy')!;
  bid.price = 2200; bid.frozenCash = bid.remaining * bid.price;
  assert.equal(submitOrder(market, { stockId: 's5', side: 'short', quantity: 100, price: 22 }).ok, true);
  market.shorts.s5.today = 0; market.day = 1; market.principal = 100_000;
  delete market.challenge;
  const before = totalCash(market);
  assert.equal(getView(market).creditUnlocked, false);
  assert.equal(repay(market, 1000).ok, true);
  assert.equal(submitOrder(market, { stockId: 's5', side: 'cover', quantity: 100, price: getView(market).stocks[4].asks[0].price }).ok, true);
  assert.equal(market.shorts.s5.quantity, 0); assert.equal(market.stocks[4].lendAvailable, 10000);
  assert.equal(totalCash(market), before);
});

test('target repayment excludes frozen orders and records an external cash transfer without creating broker money', () => {
  const market = liquidMarket(), supply = totalCash(market), brokerCash = market.brokerCash;
  assert.equal(submitOrder(market, { stockId: 's1', side: 'buy', quantity: 100, price: 10.8 }).ok, true);
  const before = structuredClone(market.challenge), cash = market.actors[0].cash;
  assert.equal(getView(market).frozenCash, 1080);
  assert.equal(repayChallenge(market, 10_000_000).ok, false);
  assert.deepEqual(market.challenge, before); assert.equal(market.actors[0].cash, cash);
  assert.equal(repayChallenge(market, 1_000_000).ok, true);
  assert.equal(market.challenge!.paid, 100_000_000);
  assert.equal(getView(market).challenge!.remaining, 99_000_000);
  assert.equal(market.actors[0].cash, cash - 100_000_000);
  assert.equal(market.brokerCash, brokerCash); assert.equal(totalCash(market), supply);
  assert.equal(market.result, null);
  assert.equal(market.ledger[0].kind, '目标还款'); assert.equal(market.ledger[0].amount, -1_000_000);
});

test('target repayment rejects securities debt, pending credit orders and invalid amounts', () => {
  const market = liquidMarket(20);
  market.principal = 100_000;
  assert.equal(repayChallenge(market, 1000).ok, false);
  assert.equal(market.challenge!.paid, 0);
  assert.equal(repay(market, 1000).ok, true);
  assert.equal(submitOrder(market, { stockId: 's1', side: 'finance', quantity: 100, price: 10.8 }).ok, true);
  assert.equal(repayChallenge(market, 1000).ok, false);
  market.orders = [];
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(repayChallenge(market, invalid).ok, false);
  }
  assert.equal(market.challenge!.paid, 0);
});

test('maturity uses only actual cash, counts prior target payments, and requires the entire target to be paid', () => {
  const winner = createMarket(5);
  setCash(winner, 100_000_000);
  const supply = totalCash(winner);
  assert.equal(repayChallenge(winner, 40_000_000).ok, true);
  assert.equal(winner.result, null); assert.equal(winner.challenge!.paid, 4_000_000_000);
  mature(winner);
  assert.equal(winner.result, 'won'); assert.equal(winner.challenge!.paid, 10_000_000_000);
  assert.equal(winner.actors[0].cash, 0); assert.equal(totalCash(winner), supply);
  assert.equal(repayChallenge(winner, 1).ok, false);
  const loser = createMarket(5);
  setCash(loser, 99_000_000);
  loser.actors[1].positions.s1.quantity -= 100_000;
  loser.actors[1].positions.s1.cost -= 120_000_000;
  loser.actors[0].positions.s1 = { quantity: 100_000, today: 0, financed: 0, cost: 120_000_000 };
  const loserSupply = totalCash(loser);
  assert.ok(getView(loser).assets > 100_000_000);
  mature(loser);
  assert.equal(loser.result, 'default'); assert.equal(loser.challenge!.paid, 9_900_000_000);
  assert.equal(getView(loser).challenge!.remaining, 1_000_000);
  assert.equal(loser.actors[0].positions.s1.quantity, 100_000);
  assert.equal(loser.actors[0].cash, 0); assert.equal(totalCash(loser), loserSupply);
});

test('maturity pays securities principal and fees first, so borrowed cash cannot satisfy the target', () => {
  const market = createMarket(11);
  setCash(market, 100_000_000); market.principal = 100_000_000;
  const supply = totalCash(market), brokerCash = market.brokerCash;
  mature(market);
  const financingPayment = 100_000_000 + Math.floor(100_000_000 * .085 / 365);
  assert.equal(market.principal, 0); assert.equal(market.interest, 0);
  assert.equal(market.brokerCash, brokerCash + financingPayment);
  assert.equal(market.challenge!.paid, 10_000_000_000 - financingPayment);
  assert.equal(market.result, 'default'); assert.equal(totalCash(market), supply);
  const short = liquidMarket(20);
  const bid = short.orders.find(order => order.stockId === 's5' && order.side === 'buy')!;
  bid.price = 2200; bid.frozenCash = bid.remaining * bid.price;
  assert.equal(submitOrder(short, { stockId: 's5', side: 'short', quantity: 100, price: 22 }).ok, true);
  setCash(short, 100_000_000);
  mature(short);
  assert.equal(short.result, 'default'); assert.equal(short.challenge!.paid, 0);
  assert.equal(short.shorts.s5.quantity, 100);
});

test('old contracts keep their assets and repayment rules, while malformed new challenge snapshots are rejected', () => {
  const legacy = createMarket(9); delete legacy.challenge; delete legacy.creditAccount;
  legacy.principal = 1_000_000_000; legacy.actors[0].cash = 400_000_000;
  legacy.actors[0].positions.s1 = { quantity: 1_000_000, today: 0, financed: 1_000_000, cost: 1_600_000_000 };
  getView(legacy); // Normalize the engine's zero-quantity position slots before comparing serialized state.
  const restored = JSON.parse(JSON.stringify(legacy)) as Market;
  assert.equal(validateMarket(restored), true);
  const view = getView(restored);
  assert.equal(view.challenge, null); assert.equal(view.equity, 6_000_000); assert.equal(view.financingDebt, 10_000_000);
  assert.deepEqual(restored, legacy); assert.equal(repayChallenge(restored, 1).ok, false);
  mature(restored);
  assert.equal(restored.result, 'default'); assert.equal(restored.actors[0].positions.s1.quantity, 1_000_000);
  for (const challenge of [null, {}, { target: -1, paid: 0, startingCapital: 1 },
    { target: 1, paid: 2, startingCapital: 1 }, { target: 1, paid: .1, startingCapital: 1 },
    { target: 1, paid: 0, startingCapital: 0 }]) {
    assert.equal(validateMarket({ ...createMarket(), challenge }), false);
  }
});
