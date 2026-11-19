import test from 'node:test';
import assert from 'node:assert/strict';
import type { OrderInput } from '../shared/types.js';
import { createMarket, advancePhase, nextDay, submitOrder, tick, type Market } from './engine.js';
import {
  initializeAgents, prepareAgentDay, runMarketAgents, seedBackgroundBook, validateAgentSimulation,
  initializeListedStock, type AgentSimulation, type ActorPlan,
} from './market-agents.js';

type AgentMarket = Market & { agentSimulation?: AgentSimulation };
function rng(seed: number) { let n = seed; return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; }; }
function totals(m: Market) {
  return { cash: m.actors.reduce((sum, a) => sum + a.cash, 0) + m.brokerCash,
    inventory: m.stocks.map(s => m.actors.reduce((sum, a) => sum + (a.positions[s.id]?.quantity ?? 0), 0)),
    cost: m.stocks.map(s => m.actors.reduce((sum, a) => sum + (a.positions[s.id]?.cost ?? 0), 0)) };
}
function rawLegacy(seed = 29): AgentMarket {
  const m: AgentMarket = createMarket(seed);
  // Recover a pre-upgrade shape without depending on createMarket's generation.
  for (const crowd of m.actors.filter(a => a.id.startsWith('crowd'))) {
    const a = m.actors[1 + Number(crowd.id.slice(5))];
    a.cash += crowd.cash;
    for (const [id, p] of Object.entries(crowd.positions)) {
      a.positions[id] ??= { quantity: 0, today: 0, financed: 0, cost: 0 };
      for (const key of ['quantity', 'today', 'financed', 'cost'] as const) a.positions[id][key] += p[key];
    }
  }
  m.actors = m.actors.filter(a => !a.id.startsWith('crowd'));
  m.orders = m.orders.filter(o => o.actorId === 'player'); delete m.agentSimulation;
  return m;
}
function model(m: AgentMarket) {
  assert.ok(m.agentSimulation, 'new games must install the focused agent model');
  return m.agentSimulation;
}
function closeDay(m: Market) { while (m.phase !== 'night' && m.phase !== 'ended') advancePhase(m); }
function assertSound(m: AgentMarket) {
  assert.ok(validateAgentSimulation(model(m), m));
  for (const a of m.actors) {
    assert.ok(Number.isSafeInteger(a.cash) && a.cash >= 0, `${a.id}: cash`);
    for (const p of Object.values(a.positions)) {
      assert.ok(p.quantity >= 0 && p.today >= 0 && p.today <= p.quantity, `${a.id}: T+1`);
      assert.ok(Number.isSafeInteger(p.cost) && p.cost >= 0, `${a.id}: basis`);
    }
  }
}

test('NPC split conserves existing cash, inventory and basis without changing player or quotes', () => {
  const m = rawLegacy(), before = totals(m), player = structuredClone(m.actors[0]);
  const quotes = structuredClone(m.stocks), trades = structuredClone(m.trades);
  initializeAgents(m, { legacy: false }, rng(59));
  assert.deepEqual(totals(m), before); assert.deepEqual(m.actors[0], player);
  assert.deepEqual(m.stocks, quotes); assert.deepEqual(m.trades, trades);
  assert.equal(m.actors.length, 10);
  for (const a of m.actors.filter(a => a.id.startsWith('ai'))) {
    assert.ok(Object.values(a.positions).filter(p => p.quantity > 0).length <= 2);
    const p = model(m).plans[a.id];
    assert.notEqual(p.mainId, p.reserveId);
  }
  const once = JSON.stringify(m); initializeAgents(m, { legacy: false }, rng(92));
  assert.equal(JSON.stringify(m), once, 'upgrading twice must not redistribute money again');
  assertSound(m);
});

test('legacy migration preserves today-bought shares and player while funding real crowd accounts', () => {
  const m = rawLegacy();
  const a = m.actors[1], id = Object.keys(a.positions).find(id => a.positions[id].quantity >= 1000)!;
  a.positions[id].today = 1000;
  const before = totals(m), totalToday = m.actors.reduce((sum, a) => sum + (a.positions[id]?.today ?? 0), 0);
  initializeAgents(m, { legacy: true }, rng(11));
  assert.deepEqual(totals(m), before);
  assert.equal(m.actors.reduce((sum, a) => sum + (a.positions[id]?.today ?? 0), 0), totalToday);
  assertSound(m);
});

test('strategy calls can only submit real orders; quote and volume cannot move without matching', () => {
  const m = rawLegacy(); initializeAgents(m, { legacy: false }, rng(5));
  const quotes = structuredClone(m.stocks), calls: { actor: string; side: string; quantity: number }[] = [];
  const place = (actor: string, input: { side: string; quantity: number }) => { calls.push({ actor, side: input.side, quantity: input.quantity }); return { ok: true, message: '' }; };
  seedBackgroundBook(m, place); m.tickCount = 4; m.phase = 'morning';
  runMarketAgents(m, rng(23), place);
  assert.ok(calls.length > 100); assert.ok(calls.every(c => c.quantity >= 100 && c.quantity % 100 === 0));
  assert.deepEqual(m.stocks, quotes); assert.equal(m.trades.length, 0);
  assert.ok(calls.filter(c => c.actor.startsWith('crowd')).length > 100);
});

test('a plan survives intraday news and refreshes once per day, with a real cooldown after exit', () => {
  const m = rawLegacy(); initializeAgents(m, { legacy: false }, rng(12));
  const before = structuredClone(model(m).plans);
  m.stocks.forEach(s => { s.newsBias = .08; });
  prepareAgentDay(m, rng(3));
  assert.deepEqual(model(m).plans, before, 'headline changes do not rotate every seat through the stock list');
  const p = model(m).plans.ai0;
  for (const pos of Object.values(m.actors[1].positions)) pos.quantity = pos.cost = pos.today = 0;
  p.state = 'reduce'; m.day++;
  prepareAgentDay(m, rng(4));
  assert.equal(p.state, 'cooldown'); assert.equal(p.cooldownUntil, m.day + 1);
  const selected = [p.mainId, p.reserveId];
  prepareAgentDay(m, rng(8)); assert.deepEqual([p.mainId, p.reserveId], selected);
  m.day++; prepareAgentDay(m, rng(4));
  assert.equal(model(m).plans.ai0.startedDay, m.day);
});

test('persisted model rejects bad identifiers, nonfinite budgets and out-of-range strategy state', () => {
  const m = rawLegacy(); initializeAgents(m, { legacy: false }, rng(6));
  assert.ok(validateAgentSimulation(model(m), m));
  const cases: ((s: AgentSimulation) => void)[] = [
    s => { s.plans.ai0.mainId = 'missing'; }, s => { s.plans.ai0.dayBudget = Number.NaN; },
    s => { s.plans.ai0.state = 'wrong' as ActorPlan['state']; }, s => { s.plans.ai0.dayBuyIds = ['s1', 's2', 's3']; },
    s => { s.crowdOpinions.crowd0.s1.inventory = -1; }, s => { s.plans.ai0.lastActionTick = m.tickCount + 1; },
  ];
  for (const mutate of cases) { const copy = structuredClone(model(m)); mutate(copy); assert.equal(validateAgentSimulation(copy, m), false); }
  m.actors[9].id = 'crowd0'; assert.equal(validateAgentSimulation(model(m), m), false);
});

test('featured seats buy at most two planned stocks each day with explicit budgets and finite T+1 assets', () => {
  const m: AgentMarket = createMarket(20261020), supply = totals(m);
  for (let day = 1; day <= 6; day++) {
    const plans = structuredClone(model(m).plans);
    closeDay(m);
    for (const [id, plan] of Object.entries(plans)) {
      const buys = m.trades.filter(t => t.day === m.day && t.buyerId === id);
      const ids = [...new Set(buys.map(t => t.stockId))];
      assert.ok(ids.length <= 2, `${id} day ${day}: ${ids}`);
      assert.ok(ids.every(id => id === plan.mainId || id === plan.reserveId));
      assert.ok(buys.reduce((sum, t) => sum + t.price * t.quantity, 0) <= plan.dayBudget, `${id} overspent its daily risk budget`);
    }
    assertSound(m);
    assert.equal(totals(m).cash, supply.cash);
    assert.deepEqual(totals(m).inventory, supply.inventory);
    if (day < 6) nextDay(m);
  }
});

test('serialized strategy and RNG resume the same orders and executions across days', () => {
  const original: AgentMarket = createMarket(119); model(original);
  advancePhase(original); original.paused = false;
  for (let i = 0; i < 37; i++) tick(original);
  const restored: AgentMarket = JSON.parse(JSON.stringify(original));
  closeDay(original); closeDay(restored);
  nextDay(original); nextDay(restored);
  closeDay(original); closeDay(restored);
  assert.deepEqual(restored, original);
});


test('NPC expiry respects both protected auction windows and frees reservations afterwards', () => {
  const m = rawLegacy(); initializeAgents(m, { legacy: false }, rng(15));
  m.orders.push({ id: 'npc-expiry-test', actorId: 'crowd0', stockId: 's1', side: 'buy',
    quantity: 100, remaining: 100, price: 1080, status: 'open', time: '09:15', sequence: 1,
    createdTick: 0, frozenCash: 108_000, restrictedClaim: 0 });
  const order = m.orders[0];
  const reject = () => ({ ok: false, message: 'test observes expiry only' });
  m.tickCount = 28; m.phaseElapsed = 28; runMarketAgents(m, rng(4), reject);
  assert.equal(order.status, 'open'); assert.equal(order.frozenCash, 108_000);
  m.phase = 'closing'; m.tickCount = 440; runMarketAgents(m, rng(4), reject);
  assert.equal(order.status, 'open');
  m.phase = 'morning'; m.phaseElapsed = 0; m.tickCount = 448; runMarketAgents(m, rng(4), reject);
  assert.equal(order.status, 'cancelled'); assert.equal(order.frozenCash, 0);
});

function signalFixture() {
  const m: AgentMarket = createMarket(77); m.phase = 'morning'; m.phaseElapsed = 90; m.tickCount = 160;
  for (const s of m.stocks) {
    s.price = s.previousClose = s.fair = 1000; s.high = s.low = s.open = 1000;
    s.volume = 0; s.newsBias = 0;
    for (const bar of s.dailyBars ?? []) { bar.close = bar.open = bar.high = bar.low = 1000; bar.volume = 200_000; }
    if (m.storyState?.expectations[s.id]) m.storyState.expectations[s.id].premium = 0;
  }
  for (const [id, plan] of Object.entries(model(m).plans)) {
    Object.assign(plan, { mainId: 's1', reserveId: 's2', lastActionTick: -100, startedDay: 1,
      state: 'observe', dayBudget: 100_000_000, daySpent: 0, dayBuyIds: [], peakPrice: 1000 });
    const a = m.actors.find(a => a.id === id)!;
    a.cash = 1_000_000_000;
    for (const p of Object.values(a.positions)) p.quantity = p.today = p.cost = p.financed = 0;
  }
  m.orders = []; m.trades = [];
  return m;
}
function submittedSeatBuys(m: AgentMarket) {
  const ids: string[] = [];
  runMarketAgents(m, () => .1, (id, input) => { if (id.startsWith('ai') && input.side === 'buy') ids.push(id); return { ok: true, message: '' }; });
  return ids;
}

test('a fresh catalyst attracts the theme seat without making every strategy buy', () => {
  const m = signalFixture(); m.stocks[0].newsBias = .02;
  assert.deepEqual(submittedSeatBuys(m), ['ai2']);
});

test('trend entry requires observed volume as well as rising prices', () => {
  const quiet = signalFixture();
  for (const bar of quiet.stocks[0].dailyBars ?? []) bar.close = 950;
  const active = structuredClone(quiet); active.stocks[0].volume = 180_000;
  assert.ok(!submittedSeatBuys(quiet).includes('ai0'));
  assert.ok(submittedSeatBuys(active).includes('ai0'));
});

test('the theme seat can follow published multi-day expectations after short-lived news bias decays', () => {
  const m = signalFixture();
  m.storyState!.expectations.s1.premium = .08;
  assert.equal(m.stocks[0].newsBias, 0);
  assert.ok(submittedSeatBuys(m).includes('ai2'));
});

function publishedHotFixture() {
  // A featured-seat pulse, without the separate twelve-tick patient-book refresh.
  const m = signalFixture(); m.tickCount = 160;
  m.storyState!.expectations.s1.premium = .18;
  m.storyState!.expectations.s1.conviction = .75;
  m.stocks[0].newsBias = .06;
  m.news = [{ id: 'public-catalyst-test', day: m.day, time: '10:30', headline: '项目规模超出原方案',
    body: '测试中的已公布订单结果', sentiment: 'positive', stockIds: ['s1', 's2'], stage: 'result', storyId: 'story-test' }];
  return m;
}
function captureOrders(m: AgentMarket, random: () => number) {
  const calls: { actorId: string; input: OrderInput }[] = [];
  runMarketAgents(m, random, (actorId, input) => { calls.push({ actorId, input }); return { ok: true, message: '' }; });
  return calls;
}

test('a strong published catalyst increases focused funded aggression without scripting a price move', () => {
  const hot = publishedHotFixture(), undisclosed = structuredClone(hot);
  undisclosed.news = []; // Same valuation and holdings; no public catalyst to attract scarce attention.
  const before = structuredClone(hot.stocks);
  const hotOrders = captureOrders(hot, () => .1), ordinaryOrders = captureOrders(undisclosed, () => .1);
  const hotBid = hotOrders.find(o => o.actorId === 'ai2' && o.input.side === 'buy')!;
  const ordinaryBid = ordinaryOrders.find(o => o.actorId === 'ai2' && o.input.side === 'buy')!;
  assert.ok(hotBid.input.price > ordinaryBid.input.price, 'strong catalyst pays through more visible ask levels');
  assert.ok(hotBid.input.quantity > ordinaryBid.input.quantity, 'a real finite cash budget funds the larger order');
  assert.ok(hotBid.input.price * 100 * hotBid.input.quantity <= hot.agentSimulation!.plans.ai2.dayBudget);
  assert.deepEqual(hot.stocks, before, 'submitting intent alone cannot alter prices, bars or volume');
  assert.equal(hot.trades.length, 0);
});

test('hot-stock holders demand higher offers while cash-needs sellers remain, and spillovers do not all become hot', () => {
  const hot = publishedHotFixture(), ordinary = structuredClone(hot); ordinary.news = [];
  const hotOrders = captureOrders(hot, () => .95), ordinaryOrders = captureOrders(ordinary, () => .95);
  const offer = (rows: typeof hotOrders, actorId: string, stockId: string) => rows.find(o => o.actorId === actorId && o.input.stockId === stockId && o.input.side === 'sell')!;
  assert.ok(offer(hotOrders, 'crowd0', 's1').input.price > offer(ordinaryOrders, 'crowd0', 's1').input.price);
  assert.ok(offer(hotOrders, 'crowd0', 's1').input.quantity < offer(ordinaryOrders, 'crowd0', 's1').input.quantity);
  assert.ok(offer(hotOrders, 'crowd1', 's1').input.quantity >= 100, 'liquidity sellers do not vanish under a positive headline');
  assert.deepEqual(offer(hotOrders, 'crowd0', 's2'), offer(ordinaryOrders, 'crowd0', 's2'), 'associated stocks do not receive the primary company attention boost');
});

test('hidden future story outcomes cannot influence present NPC orders', () => {
  const left = publishedHotFixture(), right = structuredClone(left);
  for (const arc of right.storyState!.arcs) for (const node of arc.nodes.slice(arc.publishedStage + 1)) {
    node.premium = -.15; node.outcome = 'delayed';
  }
  assert.deepEqual(captureOrders(left, rng(81)), captureOrders(right, rng(81)));
});

test('stale news or a fully spent valuation gap removes the extra hot-stock order aggression', () => {
  const stale = publishedHotFixture(), pricedIn = publishedHotFixture(), fresh = publishedHotFixture();
  stale.day = 5;
  for (const p of Object.values(stale.agentSimulation!.plans)) p.budgetDay = 5;
  stale.agentSimulation!.preparedDay = 5;
  pricedIn.stocks[0].price = pricedIn.stocks[0].previousClose = 1350;
  pricedIn.stocks[0].newsBias = 0;
  const staleBid = captureOrders(stale, () => .1).find(o => o.actorId === 'ai2' && o.input.side === 'buy')!;
  const freshBid = captureOrders(fresh, () => .1).find(o => o.actorId === 'ai2' && o.input.side === 'buy')!;
  assert.ok(staleBid.input.quantity < freshBid.input.quantity);
  assert.ok(!captureOrders(pricedIn, () => .1).some(o => o.actorId === 'ai2' && o.input.side === 'buy'));
});

test('a replayable public catalyst can produce two consecutive limit closes through actual funded fills', () => {
  // The expanded catalog selects a retail catalyst for this deterministic seed.
  const m = createMarket(42), before = totals(m);
  for (let day = 1; day <= 2; day++) {
    closeDay(m);
    {
      const s = m.stocks.find(s => s.id === 's22')!, limit = Math.round(s.previousClose * 1.1);
      assert.equal(s.price, limit);
      assert.ok(m.trades.some(t => t.stockId === s.id && t.price === limit), 'a displayed limit must have a real execution');
      assert.ok(m.news.some(n => n.stockIds?.[0] === s.id && n.sentiment === 'positive' && n.day !== undefined && m.day - n.day <= 3));
      if (day === 2) assert.ok(m.trades.some(t => t.stockId === s.id && t.buyerId.startsWith('ai')), 'the second board includes actual named-trader purchases');
    }
    assert.equal(totals(m).cash, before.cash); assert.deepEqual(totals(m).inventory, before.inventory);
    if (day < 2) nextDay(m);
  }
});

test('real old-share selling pressure in the closing auction can break a board despite the same positive story', () => {
  const opening = createMarket(42);
  closeDay(opening); nextDay(opening);
  const s = opening.stocks.find(s => s.id === 's22')!, before = totals(opening);
  // Give the controlled investor existing transferable shares, conserving the
  // same total supply and basis in both branches. Only the sell decision differs.
  const player = opening.actors[0];
  const p = player.positions[s.id] ??= { quantity: 0, today: 0, financed: 0, cost: 0 };
  let remaining = 1_000_000;
  for (const a of opening.actors.slice(1)) {
    const old = a.positions[s.id]; if (!old) continue;
    const reserved = opening.orders.filter(o => o.actorId === a.id && o.stockId === s.id && o.side === 'sell'
      && (o.status === 'open' || o.status === 'partial')).reduce((sum, o) => sum + o.remaining, 0);
    const q = Math.min(remaining, Math.max(0, old.quantity - old.today - reserved));
    const cost = Math.floor(old.cost * q / Math.max(1, old.quantity));
    old.quantity -= q; old.cost -= cost; p.quantity += q; p.cost += cost; remaining -= q;
  }
  assert.equal(remaining, 0); assert.deepEqual(totals(opening), before);
  const hold = structuredClone(opening), sell = structuredClone(opening);
  // A late holder exit tests the closing board itself: morning supply may be
  // legitimately absorbed by fresh funded demand during the remaining session.
  for (const branch of [hold, sell]) while (branch.phase !== 'closing') advancePhase(branch);
  assert.deepEqual(hold.news, sell.news);
  assert.ok(hold.news.some(n => n.stockIds?.[0] === s.id && n.sentiment === 'positive' && n.day !== undefined && hold.day - n.day <= 3));
  sell.paused = false;
  assert.equal(submitOrder(sell, { stockId: s.id, side: 'sell', quantity: p.quantity, price: s.previousClose / 100 }).ok, true);
  closeDay(hold); closeDay(sell);
  const heldStock = hold.stocks.find(x => x.id === s.id)!, soldStock = sell.stocks.find(x => x.id === s.id)!;
  assert.equal(heldStock.price, Math.round(s.previousClose * 1.1));
  assert.ok(soldStock.price < heldStock.price, 'available supply changes the outcome despite the identical published catalyst');
  assert.ok(sell.trades.some(t => t.stockId === s.id && t.sellerId === 'player' && t.time === '15:00'), 'closing selling pressure consumes genuinely funded buy orders');
  for (const result of [hold, sell]) {
    assert.equal(totals(result).cash, before.cash); assert.deepEqual(totals(result).inventory, before.inventory);
    assertSound(result);
  }
});

test('an observable selloff attracts funded value and contrarian orders, not a guaranteed reversal', () => {
  const funded = signalFixture(); funded.stocks[0].price = 950; funded.stocks[0].low = 940;
  const broke = structuredClone(funded);
  const panic = structuredClone(funded); panic.stocks[0].price = 900; panic.stocks[0].low = 890;
  for (const a of broke.actors.filter(a => a.id === 'ai1' || a.id === 'ai5')) a.cash = 0;
  const before = structuredClone(funded.stocks);
  const buys = captureOrders(funded, () => .1).filter(o => o.input.side === 'buy');
  assert.ok(buys.some(o => o.actorId === 'ai1'));
  assert.ok(buys.some(o => o.actorId === 'ai5'));
  assert.ok(!captureOrders(broke, () => .1).some(o => o.input.side === 'buy' && ['ai1', 'ai5'].includes(o.actorId)));
  assert.ok(!captureOrders(panic, () => .1).some(o => o.input.side === 'buy' && o.actorId === 'ai1'), 'the contrarian still avoids an unchecked daily plunge');
  assert.deepEqual(funded.stocks, before, 'a cheaper valuation creates demand but never forces a rebound');
});

test('ordinary value holders supply more real old shares when their floating profit increases', () => {
  const flat = signalFixture(); flat.tickCount = 160;
  const seller = flat.actors.find(a => a.id === 'crowd2')!;
  seller.positions.s1.cost = seller.positions.s1.quantity * flat.stocks[0].price;
  const profit = structuredClone(flat);
  profit.actors.find(a => a.id === 'crowd2')!.positions.s1.cost = Math.floor(seller.positions.s1.cost / 1.2);
  const flatOffer = captureOrders(flat, () => .95).find(o => o.actorId === 'crowd2' && o.input.stockId === 's1' && o.input.side === 'sell')!;
  const profitOffer = captureOrders(profit, () => .95).find(o => o.actorId === 'crowd2' && o.input.stockId === 's1' && o.input.side === 'sell')!;
  assert.ok(profitOffer.input.quantity > flatOffer.input.quantity);
  assert.ok(profitOffer.input.quantity <= seller.positions.s1.quantity - seller.positions.s1.today);
});

function largeBuyFixture(phaseElapsed = 90) {
  const start = signalFixture(); start.tickCount = 160; start.paused = false;
  start.phaseElapsed = phaseElapsed;
  const s = start.stocks[0];
  // Use the depth of the existing large-cap names so all three signal strengths
  // are distinguishable after real 100-share lot rounding; fills stay funded.
  s.shares = 240_000_000;
  s.history = [{ time: '09:30', price: s.price, volume: 0 }];
  start.news = [];
  const seller = start.actors.find(a => a.id === 'crowd1')!;
  assert.ok(seller.positions.s1.quantity - seller.positions.s1.today >= 100_000);
  for (const [i, price] of [1002, 1008, 1015, 1025, 1035].entries()) start.orders.push({
    id: `test-offer-${i}`, actorId: seller.id, stockId: s.id, side: 'sell', quantity: 20_000, remaining: 20_000,
    price, status: 'open', time: '10:30', sequence: ++start.sequence, createdTick: start.tickCount,
    frozenCash: 0, restrictedClaim: 0,
  });
  const opinion = start.agentSimulation!.crowdOpinions.crowd0.s1;
  opinion.bias = 0; opinion.inventory = start.actors.find(a => a.id === 'crowd0')!.positions.s1.quantity;
  const quiet = structuredClone(start), advertised = structuredClone(start), bought = structuredClone(start);
  assert.equal(submitOrder(advertised, { stockId: s.id, side: 'buy', quantity: 100_000, price: 9.9 }).ok, true);
  assert.equal(submitOrder(bought, { stockId: s.id, side: 'buy', quantity: 100_000, price: 10.35 }).ok, true);
  return { quiet, advertised, bought, s };
}

test('a real large buy can attract limited ordinary followers, while an unfilled large bid cannot', () => {
  const { quiet, advertised, bought, s } = largeBuyFixture();
  assert.equal(advertised.stocks[0].volume, 0);
  assert.equal(bought.stocks[0].volume, 100_000); assert.equal(bought.stocks[0].price, 1035);
  const reaction = (m: Market) => captureOrders(m, () => .51).find(o => o.actorId === 'crowd0' && o.input.stockId === s.id)!.input;
  assert.equal(reaction(quiet).side, 'sell');
  assert.equal(reaction(advertised).side, 'sell');
  assert.equal(reaction(bought).side, 'buy');
  assert.ok(bought.trades.every(t => t.quantity > 0), 'the observable move was entirely paid and matched');
});

const followerQuantity = (m: Market) => captureOrders(m, () => .45)
  .find(o => o.actorId === 'crowd0' && o.input.stockId === 's1' && o.input.side === 'buy')!.input.quantity;

test('the same real volume fades with elapsed trading minutes and expires after ten without a new execution', () => {
  const { bought } = largeBuyFixture();
  const fresh = structuredClone(bought), fading = structuredClone(bought), expired = structuredClone(bought), nextSession = structuredClone(bought);
  fading.phaseElapsed = 96; // 10:34: four trading minutes after the actual 10:30 fills.
  expired.phaseElapsed = 108; // 10:42: no new fills, same daily volume and history.
  nextSession.day++;
  nextSession.agentSimulation!.preparedDay = nextSession.day;
  for (const plan of Object.values(nextSession.agentSimulation!.plans)) plan.budgetDay = nextSession.day;
  const quantities = [fresh, fading, expired, nextSession].map(followerQuantity);
  assert.ok(quantities.every(quantity => quantity >= 100 && quantity % 100 === 0));
  assert.ok(quantities[0] > quantities[1]);
  assert.ok(quantities[1] > quantities[2]);
  assert.equal(quantities[2], quantities[3], 'even a retained old history cannot supply another day with a fresh flow signal');
  assert.deepEqual(expired.stocks[0].history, bought.stocks[0].history);
  assert.equal(expired.stocks[0].volume, 100_000);
});

test('the lunch recess does not age the signal but a tiny later print cannot renew expired large volume', () => {
  const { bought: nearLunch } = largeBuyFixture(178.5); // Actual fills at 11:29.
  const afterLunch = structuredClone(nearLunch), later = structuredClone(nearLunch);
  afterLunch.phase = later.phase = 'afternoon';
  afterLunch.phaseElapsed = 0; later.phaseElapsed = 17; // 13:00 vs 13:11.
  assert.ok(followerQuantity(afterLunch) > followerQuantity(later), 'only one trading minute elapsed across the recess');

  const { bought } = largeBuyFixture(); bought.phaseElapsed = 108;
  const expired = structuredClone(bought);
  bought.orders.push({ id: 'late-small-offer', actorId: 'crowd1', stockId: 's1', side: 'sell', quantity: 100, remaining: 100,
    price: 1035, status: 'open', time: '10:42', sequence: ++bought.sequence, createdTick: bought.tickCount,
    frozenCash: 0, restrictedClaim: 0 });
  assert.equal(submitOrder(bought, { stockId: 's1', side: 'buy', quantity: 100, price: 10.35 }).ok, true);
  assert.equal(bought.stocks[0].volume, 100_100);
  assert.equal(followerQuantity(bought), followerQuantity(expired), 'only fresh executed volume counts toward the large-flow threshold');
});

test('a real large sell makes funded valuation buyers respond, but their intent alone cannot force a rebound', () => {
  const start = signalFixture(); start.tickCount = 160; start.paused = false; start.news = [];
  const s = start.stocks[0]; s.history = [{ time: '09:30', price: s.price, volume: 0 }];
  const source = start.actors.find(a => a.id === 'crowd1')!.positions.s1;
  assert.ok(source.quantity - source.today >= 100_000);
  const transferredCost = Math.floor(source.cost * 100_000 / source.quantity);
  source.quantity -= 100_000; source.cost -= transferredCost;
  start.actors[0].positions.s1 = { quantity: 100_000, today: 0, financed: 0, cost: transferredCost };
  const buyer = start.actors.find(a => a.id === 'crowd0')!;
  for (const [i, price] of [998, 990, 980, 960, 950].entries()) start.orders.push({
    id: `test-bid-${i}`, actorId: buyer.id, stockId: s.id, side: 'buy', quantity: 20_000, remaining: 20_000,
    price, status: 'open', time: '10:30', sequence: ++start.sequence, createdTick: start.tickCount,
    frozenCash: price * 20_000, restrictedClaim: 0,
  });
  const quiet = structuredClone(start), sold = structuredClone(start), before = totals(start);
  assert.equal(submitOrder(sold, { stockId: s.id, side: 'sell', quantity: 100_000, price: 9.5 }).ok, true);
  assert.equal(sold.stocks[0].price, 950); assert.equal(sold.stocks[0].volume, 100_000);
  const selectiveBuys = (m: Market) => captureOrders(m, () => .1).filter(o => ['ai1', 'ai5'].includes(o.actorId) && o.input.side === 'buy').map(o => o.actorId);
  assert.deepEqual(selectiveBuys(quiet), []);
  assert.deepEqual(selectiveBuys(sold), ['ai1', 'ai5']);
  assert.equal(sold.stocks[0].price, 950, 'subsequent buying intent still needs a willing counterparty to print a new price');
  assert.equal(totals(sold).cash, before.cash); assert.deepEqual(totals(sold).inventory, before.inventory);
});

function listedStockFixture() {
  const m = signalFixture();
  const s: Market['stocks'][number] = { ...structuredClone(m.stocks[0]), id: 's13', name: '测试新股',
    listedDay: m.day, issuePrice: 1000, fair: 1150, dailyBars: [], dailyHistoryStartDay: m.day,
    ipoFactors: { demand: 'strong', issuePe: 18, peerPe: 30, offeredShares: 200_000, floatRatio: .1 } };
  m.stocks.push(s);
  for (const a of m.actors.filter(a => a.id.startsWith('crowd'))) a.positions.s13 = { quantity: 60_000, today: 0, financed: 0, cost: 60_000_000 };
  m.storyState!.expectations.s13 = { premium: 0, realizedPremium: 0, conviction: .5, updatedDay: m.day, activeStoryIds: [] };
  m.news.unshift({ id: 'listing-test', day: m.day, time: '盘前', headline: '测试新股上市', body: '公开发行因素', sentiment: 'positive', stockIds: ['s13'], impacts: [] });
  return { m, s };
}

test('listed-stock initialization anchors differentiated crowd opinions to actual allocations without creating assets', () => {
  const { m, s } = listedStockFixture(), assets = structuredClone(m.actors), seed = m.rngState;
  assert.equal(validateAgentSimulation(m.agentSimulation, m), false, 'new stock must have complete per-crowd opinions');
  initializeListedStock(m, s);
  assert.deepEqual(m.actors, assets); assert.equal(m.rngState, seed);
  assert.ok(validateAgentSimulation(m.agentSimulation, m));
  assert.equal(m.agentSimulation!.crowdOpinions.crowd0.s13.inventory, 60_000);
  assert.notEqual(m.agentSimulation!.crowdOpinions.crowd0.s13.bias, m.agentSimulation!.crowdOpinions.crowd1.s13.bias);
  const once = structuredClone(m.agentSimulation);
  m.actors.find(a => a.id === 'crowd0')!.positions.s13.quantity -= 100;
  initializeListedStock(m, s); assert.deepEqual(m.agentSimulation, once, 'reloading does not reset inventory anchors');
});

test('NPC IPO quotes use the same first-day thirty-percent limits and normal limits afterwards', () => {
  const { m, s } = listedStockFixture(); s.price = 1270;
  initializeListedStock(m, s);
  const collect = (market: Market) => {
    const orders: OrderInput[] = [];
    seedBackgroundBook(market, (_id, input) => { if (input.stockId === s.id) orders.push(input); return { ok: true, message: '' }; });
    return orders;
  };
  const first = collect(m);
  assert.ok(first.some(o => o.price > 11)); assert.ok(first.every(o => o.price >= 7 && o.price <= 13));
  m.day++; const later = collect(m);
  assert.ok(later.every(o => o.price >= 9 && o.price <= 11));
});

test('the issuer is optional before issuance, unique when present, and cannot trade the secondary book', () => {
  const m = signalFixture(); Object.assign(m, { ipoState: {} });
  assert.ok(validateAgentSimulation(m.agentSimulation, m));
  m.actors.push({ id: 'ipo-issuer', name: '发行结算', cash: 0, positions: {} });
  assert.ok(validateAgentSimulation(m.agentSimulation, m));
  m.actors.push({ id: 'ipo-issuer', name: '重复发行结算', cash: 0, positions: {} });
  assert.equal(validateAgentSimulation(m.agentSimulation, m), false); m.actors.pop();
  m.orders.push({ id: 'issuer-order', actorId: 'ipo-issuer', stockId: 's1', side: 'buy', quantity: 100,
    remaining: 100, price: 1000, status: 'open', time: '10:30', sequence: 999, createdTick: m.tickCount,
    frozenCash: 100_000, restrictedClaim: 0 });
  assert.equal(validateAgentSimulation(m.agentSimulation, m), false);
});
