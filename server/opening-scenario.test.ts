import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarket, getView, submitOrder, tick, nextDay, advancePhase, validateMarket, type Market } from './engine.js';
import { cloneForTransaction } from './market-transaction.js';
import { randomizeOpeningIpo } from './ipo.js';
import { OPENING_SCENARIO } from '../shared/opening-scenario.js';

const create = (seed = 42) => createMarket(seed, { openingScenario: true });
const cash = (m: Market) => m.brokerCash + m.actors.reduce((sum, actor) => sum + actor.cash, 0);
const shares = (m: Market) => Object.fromEntries(m.stocks.map(stock => [stock.id,
  m.actors.reduce((sum, actor) => sum + (actor.positions[stock.id]?.quantity ?? 0), 0)]));
const restore = (m: Market): Market => {
  const restored = JSON.parse(JSON.stringify(m)) as Market;
  assert.ok(validateMarket(restored)); return restored;
};
function buy(m: Market, quantity = OPENING_SCENARIO.buyQuantity as number, price = OPENING_SCENARIO.buyLimit as number) {
  m.paused = false;
  assert.ok(submitOrder(m, { stockId: 's1', side: 'buy', quantity, price }).ok);
}
function follow(m: Market) {
  m.paused = false; tick(m); tick(m); tick(m);
  assert.equal(m.openingScenario!.stage, 'exit'); assert.equal(m.paused, true);
}
function sell(m: Market, quantity = 100) {
  m.paused = false;
  const bid = getView(m).stocks[0].bids[0];
  assert.ok(bid && bid.quantity >= quantity, 'Fixture needs enough real visible buying interest');
  assert.ok(submitOrder(m, { stockId: 's1', side: 'sell', quantity, price: bid.price }).ok);
}
function nextTrading(m: Market) {
  nextDay(m); advancePhase(m);
  assert.equal(m.phase, 'morning');
}
function legacyCreate(seed = 42): Market {
  const m = create(seed), donor = m.actors.find(actor => actor.id === 'crowd2')!;
  m.openingScenario!.version = 1;
  m.actors[0].cash -= 200_000_000; donor.cash += 200_000_000;
  donor.positions.s1.quantity -= 200_000; donor.positions.s1.cost -= 200_000_000;
  m.actors[0].positions.s1 = { quantity: 200_000, today: 0, financed: 0, cost: 200_000_000 };
  return restore(m);
}

test('explicit new-game scenario has the same complete public day-one state for every continuation seed', () => {
  const a = create(12), b = create(987);
  assert.deepEqual(getView(a), getView(b));
  assert.equal(a.stocks.length, 18);
  assert.equal(a.phase, 'morning'); assert.equal(a.paused, true);
  assert.equal(getView(a).cash, 10_000_000); assert.equal(getView(a).equity, 10_000_000);
  assert.deepEqual(getView(a).stocks[0].asks, [
    { price: 10, quantity: 100_000 }, { price: 10.1, quantity: 150_000 }, { price: 10.3, quantity: 250_000 },
  ]);
  assert.equal(getView(a).positions.length, 0);
  assert.equal(getView(a).openingScenario!.version, 2);
  assert.equal(JSON.stringify(getView(a)).includes('continuationSeed'), false);
  assert.equal(a.openingScenario!.continuationSeed, 12);
  assert.equal(b.openingScenario!.continuationSeed, 987);
  assert.ok(validateMarket(a));
});

test('all initial cash and shares stay in their existing accounts and all other stocks remain tradable', () => {
  const m = create(), normal = createMarket(m.seed);
  assert.equal(cash(m), cash(normal)); assert.deepEqual(shares(m), shares(normal));
  assert.equal(m.actors.length, normal.actors.length);
  const other = getView(m).stocks[1];
  m.paused = false;
  assert.ok(submitOrder(m, { stockId: other.id, side: 'buy', quantity: 100, price: other.asks[0].price }).ok);
  assert.equal(getView(m).orders[0].filled, 100);
  assert.equal(m.openingScenario!.stage, 'ready');
});

test('new games buy on day one, show finite real follow-through, and can only sell into day-two market liquidity', () => {
  const m = create(), totalCash = cash(m), totalShares = shares(m);
  buy(m);
  let view = getView(m);
  assert.equal(view.openingScenario!.stage, 'following'); assert.equal(m.paused, true);
  assert.equal(view.stocks[0].price, 10.30); assert.equal(view.cash, 4_910_000);
  assert.deepEqual(view.orders[0].execution, { filled: 500_000, amount: 5_090_000,
    averagePrice: 10.18, priceLevels: 3, beforePrice: 10, afterPrice: 10.30 });
  const receipt = structuredClone(view.orders[0].execution);
  assert.equal(view.positions[0].quantity, 500_000); assert.equal(view.positions[0].available, 0);
  m.paused = false; tick(m); tick(m);
  assert.equal(getView(m).stocks[0].price, 10.30);
  tick(m); view = getView(m);
  assert.equal(view.stocks[0].price, 10.80); assert.equal(m.paused, true);
  assert.equal(view.equity, 10_310_000); assert.equal(view.openingScenario!.stage, 'exit');
  assert.deepEqual(view.stocks[0].bids, [], 'version two creates no scripted exit liquidity');
  assert.deepEqual(view.orders[0].execution, receipt, 'later NPC activity never rewrites the player receipt');
  assert.deepEqual(m.trades.filter(trade => trade.stockId === 's1' && !trade.playerSide).map(trade => [trade.price, trade.quantity]),
    [[1050, 1000], [1080, 1000]]);
  m.paused = false;
  assert.equal(submitOrder(m, { stockId: 's1', side: 'sell', quantity: 100, price: 10.8 }).ok, false);
  assert.equal(view.openingScenario!.soldQuantity, 0); assert.equal(view.openingScenario!.saleProceeds, 0);
  assert.equal(cash(m), totalCash); assert.deepEqual(shares(m), totalShares); restore(m);
  nextDay(m);
  assert.equal(getView(m).positions[0].available, 500_000);
  assert.equal(getView(m).cash, 4_910_000);
  assert.ok(!m.orders.some(order => order.id === m.openingScenario!.followOrderId));
  advancePhase(m); sell(m);
  view = getView(m);
  assert.equal(view.openingScenario!.stage, 'complete'); assert.equal(view.openingScenario!.soldQuantity, 100);
  assert.equal(view.cash, 4_910_000 + view.openingScenario!.saleProceeds);
  assert.equal(view.positions[0].quantity, 499_900);
  assert.equal(cash(m), totalCash); assert.deepEqual(shares(m), totalShares); restore(m);
});

test('small orders and a quantity-only threshold cannot replace actual consumption of all three levels', () => {
  const m = create(); buy(m, 100, 10);
  assert.equal(m.openingScenario!.boughtQuantity, 100); assert.equal(m.openingScenario!.stage, 'ready');
  buy(m, 499_900, 10);
  assert.equal(m.openingScenario!.boughtQuantity, 100_000);
  assert.equal(m.openingScenario!.stage, 'ready'); assert.equal(m.paused, false);
  const remaining = getView(m).orders[0]; assert.equal(remaining.remaining, 400_000);
  assert.ok(validateMarket(m));
});

test('fixed scenario orders survive NPC expiry while other stocks keep trading and the guide can be skipped', () => {
  const m = create(); m.paused = false;
  for (let i = 0; i < 40; i++) tick(m);
  assert.equal(m.openingScenario!.stage, 'ready');
  assert.equal(m.trades.filter(trade => trade.stockId === 's1').length, 0);
  assert.ok(m.trades.some(trade => trade.stockId !== 's1'));
  assert.deepEqual(getView(m).stocks[0].asks, getView(create()).stocks[0].asks);
  nextDay(m);
  assert.equal(m.day, 2); assert.equal(m.phase, 'auction');
  assert.equal(getView(m).cash, 10_000_000); assert.equal(getView(m).positions.length, 0);
  assert.ok(getView(m).stocks[0].bids.length > 0, 'ordinary target liquidity returns on day two');
  restore(m);
});

test('day-one simulation stays identical but future market, story RNG and unpublished IPOs use each game seed', () => {
  const a = create(1234), b = create(5678);
  a.paused = b.paused = false;
  for (let i = 0; i < 5; i++) { tick(a); tick(b); }
  assert.deepEqual(getView(a), getView(b));
  const anchor = a.seed;
  nextDay(a); nextDay(b);
  assert.equal(a.seed, anchor); assert.equal(b.seed, anchor);
  assert.notEqual(a.rngState, b.rngState); assert.notEqual(a.storyState!.rngState, b.storyState!.rngState);
  assert.equal(a.ipoState!.generationSeed, 1234); assert.equal(b.ipoState!.generationSeed, 5678);
  assert.notDeepEqual(a.ipoState!.offers, b.ipoState!.offers);
  assert.notDeepEqual(a.agentSimulation!.crowdOpinions, b.agentSimulation!.crowdOpinions);
  restore(a); restore(b);
});

test('both first-day pauses and the real second-day sale survive restore without repeating follow orders', () => {
  let m = create(); buy(m); m = restore(m); follow(m);
  const orderId = m.openingScenario!.followOrderId;
  m = restore(m); m.paused = false; for (let i = 0; i < 5; i++) tick(m);
  assert.equal(m.openingScenario!.followOrderId, orderId);
  assert.deepEqual(getView(m).stocks[0].bids, []);
  nextTrading(m); m = restore(m); sell(m); m = restore(m);
  assert.equal(m.openingScenario!.stage, 'complete');
  const prior = m.openingScenario!.saleProceeds;
  sell(m); m = restore(m);
  assert.equal(m.openingScenario!.soldQuantity, 200);
  assert.ok(m.openingScenario!.saleProceeds > prior);
});

test('aborted transaction candidates do not mutate the source scenario progress or portfolio', () => {
  const source = create(), before = JSON.stringify(source), candidate = cloneForTransaction(source);
  buy(candidate); follow(candidate); nextTrading(candidate); sell(candidate);
  assert.equal(JSON.stringify(source), before);
  assert.equal(source.openingScenario!.boughtQuantity, 0);
});

test('ordinary and old day-one saves never acquire a scenario from reading, restoring, or advancing', () => {
  const old = createMarket(4321), originalCash = cash(old), originalShares = shares(old);
  getView(old); restore(old);
  assert.equal(old.openingScenario, undefined);
  assert.equal(cash(old), originalCash); assert.deepEqual(shares(old), originalShares);
  nextDay(old); assert.equal(old.openingScenario, undefined); assert.equal(old.seed, 4321);
  assert.equal(old.ipoState!.generationSeed, undefined);
});

test('invalid scenario versions, progress and continuation IPO seeds are rejected', () => {
  const original = create();
  for (const modify of [
    (m: Market) => { (m.openingScenario as { version: number }).version = 3; },
    (m: Market) => { m.openingScenario!.boughtQuantity = 100; },
    (m: Market) => { m.openingScenario!.asks[0].filled = 100_100; },
    (m: Market) => { m.openingScenario!.continuationSeed = -1; },
    (m: Market) => { m.openingScenario!.saleProceeds = 10; },
  ]) { const copy = structuredClone(original); modify(copy); assert.equal(validateMarket(copy), false); }
  nextDay(original); original.ipoState!.generationSeed!++;
  assert.equal(validateMarket(original), false);
});

test('IPO continuation is idempotent and never redraws a public or subscribed offering', () => {
  const m = create(); nextDay(m);
  const before = JSON.stringify(m.ipoState); randomizeOpeningIpo(m, 999);
  assert.equal(JSON.stringify(m.ipoState), before);
  const guarded = create(); guarded.day = 2; guarded.ipoState!.offers[0].status = 'offered';
  const publicBefore = JSON.stringify(guarded.ipoState); randomizeOpeningIpo(guarded, 42);
  assert.equal(JSON.stringify(guarded.ipoState), publicBefore);
  guarded.ipoState!.offers[0].status = 'scheduled'; guarded.ipoState!.offers[0].subscriptions.player = 100;
  const reservedBefore = JSON.stringify(guarded.ipoState); randomizeOpeningIpo(guarded, 42);
  assert.equal(JSON.stringify(guarded.ipoState), reservedBefore);
});

test('explicit phase/day stepping can leave either pause point without requiring tutorial completion', () => {
  const m = create(); buy(m); advancePhase(m);
  assert.equal(m.phase, 'lunch'); assert.equal(m.openingScenario!.stage, 'exit');
  nextDay(m); assert.equal(m.day, 2); restore(m);
});


test('an auction at one clearing price does not manufacture the three-level sweep trigger', () => {
  const m = create(); m.phase = 'closing'; buy(m);
  assert.equal(m.openingScenario!.boughtQuantity, 0);
  advancePhase(m);
  assert.equal(m.phase, 'night'); assert.equal(m.openingScenario!.stage, 'ready');
  assert.equal(getView(m).orders[0].filled, 500_000);
  assert.ok(m.openingScenario!.boughtQuantity < 500_000);
  nextDay(m); assert.equal(m.day, 2); restore(m);
});


test('version-one restored accounts keep their bottom holding, original exit liquidity and completion rule', () => {
  let m = legacyCreate();
  const positions = structuredClone(m.actors[0].positions), initialCash = m.actors[0].cash;
  getView(m); m = restore(m);
  assert.deepEqual(m.actors[0].positions.s1, positions.s1); assert.equal(m.actors[0].cash, initialCash);
  assert.equal(getView(m).openingScenario!.version, 1);
  assert.equal(getView(m).positions[0].available, 200_000);
  buy(m); m = restore(m); follow(m); m = restore(m);
  assert.deepEqual(getView(m).stocks[0].bids, [{ price: 10.8, quantity: 200_000 }]);
  sell(m, 100_000); assert.equal(m.openingScenario!.stage, 'exit'); m = restore(m);
  sell(m, 100_000); assert.equal(m.openingScenario!.stage, 'complete');
  assert.equal(getView(m).cash, 5_070_000); assert.equal(getView(m).equity, 10_470_000);
  assert.equal(getView(m).openingScenario!.saleProceeds, 2_160_000); m = restore(m);
  nextTrading(m); sell(m);
  assert.equal(m.openingScenario!.soldQuantity, 200_000, 'v1 historical progress only records day-one sales');
  restore(m);
});

test('version-two completion accepts real day-two sales after a partial sweep or a missed follow-through', () => {
  const partial = create(); buy(partial, 1_000, 10); nextTrading(partial);
  assert.equal(partial.openingScenario!.stage, 'ready'); sell(partial);
  assert.equal(partial.openingScenario!.stage, 'complete'); assert.equal(partial.openingScenario!.boughtQuantity, 1_000);
  restore(partial);
  const late = create(); late.phase = 'afternoon'; late.phaseElapsed = 179; buy(late); nextTrading(late);
  assert.equal(late.openingScenario!.stage, 'following');
  assert.equal(late.openingScenario!.followOrderId, undefined);
  sell(late); assert.equal(late.openingScenario!.stage, 'complete'); restore(late);
});

test('later genuine sales are not restricted by version-one quantity or first-day price bounds', () => {
  const m = create(); buy(m); follow(m); nextTrading(m);
  const totalCash = cash(m), totalShares = shares(m);
  function fundedBid(quantity: number, price: number) {
    m.orders = m.orders.filter(order => order.stockId !== 's1');
    const buyer = m.actors.find(actor => actor.id === 'crowd0')!;
    assert.ok(buyer.cash > quantity * price * 100);
    m.orders.push({ id: `fixture-${++m.sequence}`, actorId: buyer.id, stockId: 's1', side: 'buy', quantity,
      remaining: quantity, price: Math.round(price * 100), status: 'open', time: '09:30', sequence: m.sequence,
      createdTick: m.tickCount, frozenCash: quantity * Math.round(price * 100), restrictedClaim: 0, day: m.day });
  }
  fundedBid(300_000, 11.50); sell(m, 300_000); restore(m);
  assert.equal(m.openingScenario!.soldQuantity, 300_000);
  assert.equal(getView(m).openingScenario!.saleProceeds, 3_450_000);
  fundedBid(100_000, 11.60); sell(m, 100_000); restore(m);
  assert.equal(m.openingScenario!.soldQuantity, 400_000);
  assert.equal(getView(m).openingScenario!.saleProceeds, 4_610_000);
  assert.equal(cash(m), totalCash); assert.deepEqual(shares(m), totalShares);
});

test('version-two restore rejects impossible first-day sales and complete stages without actual proceeds', () => {
  const original = create(); buy(original); follow(original);
  const firstDay = structuredClone(original);
  firstDay.openingScenario!.stage = 'complete'; firstDay.openingScenario!.soldQuantity = 100;
  firstDay.openingScenario!.saleProceeds = 108_000;
  assert.equal(validateMarket(firstDay), false);
  nextDay(original);
  original.openingScenario!.stage = 'complete';
  assert.equal(validateMarket(original), false);
});
