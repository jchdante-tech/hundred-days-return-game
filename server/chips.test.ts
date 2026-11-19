import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, submitOrder, type Market } from './engine.js';
import { getChipSupply, getActorChipSupply } from './chips.js';
import { seedBackgroundBook, runMarketAgents } from './market-agents.js';
import type { OrderInput } from '../shared/types.js';

const live = (o: Market['orders'][number]) => o.remaining > 0 && (o.status === 'open' || o.status === 'partial');
const who = (m: Market, id: string) => m.actors.find(a => a.id === id)!;
const position = (m: Market, id: string, stockId = 's1') => who(m, id).positions[stockId]
  ??= { quantity: 0, today: 0, financed: 0, cost: 0 };

function move(m: Market, from: string, to: string, q: number, stockId = 's1') {
  const source = position(m, from, stockId), target = position(m, to, stockId);
  assert.ok(q <= source.quantity - source.today);
  const cost = Math.floor(source.cost * q / source.quantity);
  source.quantity -= q; source.cost -= cost; target.quantity += q; target.cost += cost;
}

function fixture() {
  const m = createMarket(77); m.phase = 'morning'; m.paused = false; m.orders = []; m.trades = [];
  const s = m.stocks[0];
  // Use the same finite stock and wealth, starting with independently held
  // household shares. All later changes in concentration come from real fills.
  for (const a of m.actors.filter(a => a.id.startsWith('ai'))) {
    const q = position(m, a.id).quantity;
    if (q) move(m, a.id, 'crowd0', q);
  }
  for (const a of m.actors) if (a.positions.s1) a.positions.s1.cost = a.positions.s1.quantity * s.price;
  return m;
}

/** Place an independently funded, executable counterparty quote in the test book. */
function quote(m: Market, actorId: string, input: OrderInput) {
  assert.ok(input.side === 'buy' || input.side === 'sell');
  const price = Math.round(input.price * 100), a = who(m, actorId);
  const pending = m.orders.filter(o => o.actorId === actorId && live(o));
  if (input.side === 'buy') assert.ok(price * input.quantity <= a.cash - pending.reduce((sum, o) => sum + o.frozenCash, 0));
  else assert.ok(input.quantity <= position(m, actorId, input.stockId).quantity - position(m, actorId, input.stockId).today
    - pending.filter(o => o.stockId === input.stockId && o.side === 'sell').reduce((sum, o) => sum + o.remaining, 0));
  m.orders.push({ id: `chip-test-${++m.sequence}`, actorId, stockId: input.stockId, side: input.side,
    quantity: input.quantity, remaining: input.quantity, price, status: 'open', time: '09:30', day: m.day,
    sequence: m.sequence, createdTick: m.tickCount, frozenCash: input.side === 'buy' ? price * input.quantity : 0, restrictedClaim: 0 });
  return { ok: true, message: '' };
}

function book(m: Market) {
  m.orders = [];
  seedBackgroundBook(m, (actorId, input) => quote(m, actorId, input));
  return m.orders.filter(o => o.stockId === 's1');
}

function buyExistingShares(m: Market, quantity: number) {
  m.orders = [];
  const price = m.stocks[0].price / 100;
  let remaining = quantity;
  for (const a of m.actors.filter(a => a.id.startsWith('crowd'))) {
    const q = Math.min(remaining, position(m, a.id).quantity - position(m, a.id).today);
    if (!q) continue;
    quote(m, a.id, { stockId: 's1', side: 'sell', price, quantity: q }); remaining -= q;
  }
  assert.equal(remaining, 0);
  assert.equal(submitOrder(m, { stockId: 's1', side: 'buy', price, quantity }).ok, true);
  assert.equal(position(m, 'player').quantity, quantity);
  assert.equal(m.trades.filter(t => t.buyerId === 'player').reduce((sum, t) => sum + t.quantity, 0), quantity);
}

test('concentration measures real named holders, not the three aggregated household accounts', () => {
  const m = fixture(), s = m.stocks[0], before = JSON.stringify(m);
  const chips = getChipSupply(m, s);
  assert.equal(chips.floatShares, 1_800_000);
  assert.equal(chips.concentration, 0);
  assert.equal(chips.depthFactor, 1);
  assert.equal(JSON.stringify(m), before, 'analysis does not initialize ledgers, change RNG, or write prices');
  move(m, 'crowd0', 'crowd1', 100_000);
  assert.equal(getChipSupply(m, s).concentration, 0, 'moving household cohorts cannot manufacture a whale');
  move(m, 'crowd1', 'ai2', 200_000);
  assert.equal(getChipSupply(m, s).largeHolderShares, 200_000);
  assert.equal(getChipSupply(m, s).concentration, 200_000 / chips.floatShares);
});

test('actual accumulation makes same-price funded depth thinner and the same new buy crosses farther', () => {
  const scattered = fixture(), concentrated = structuredClone(scattered), s = scattered.stocks[0];
  buyExistingShares(concentrated, 600_000);
  assert.equal(concentrated.stocks[0].price, s.price, 'concentration itself does not write a higher price');
  assert.equal(getChipSupply(concentrated, concentrated.stocks[0]).playerRatio, 1 / 3);
  const before = book(scattered), after = book(concentrated);
  for (const side of ['buy', 'sell'] as const) {
    const baseline = before.filter(o => o.side === side), reduced = after.filter(o => o.side === side);
    assert.ok(reduced.every(o => baseline.some(b => b.price === o.price)), 'depth changes at the same quoted prices; an exhausted seller may disappear');
    assert.ok(reduced.reduce((sum, o) => sum + o.quantity, 0) < baseline.reduce((sum, o) => sum + o.quantity, 0), `${side} executable depth falls`);
  }
  for (const market of [scattered, concentrated]) {
    assert.equal(submitOrder(market, { stockId: 's1', side: 'buy', quantity: 12_000, price: 13.2 }).ok, true);
    assert.equal(market.orders.filter(o => o.actorId === 'player').at(-1)!.remaining, 0);
  }
  assert.ok(concentrated.stocks[0].price > scattered.stocks[0].price, 'the price difference is printed by matched fills, not a percentage adjustment');
});

test('a next-day sale really redistributes chips; T+1 release alone never changes ownership', () => {
  const m = fixture(), s = m.stocks[0], initial = getChipSupply(m, s);
  buyExistingShares(m, 600_000);
  assert.equal(submitOrder(m, { stockId: s.id, side: 'sell', quantity: 100, price: s.price / 100 }).ok, false);
  const held = getChipSupply(m, s);
  m.day = 2;
  for (const a of m.actors) for (const p of Object.values(a.positions)) p.today = 0;
  const released = getChipSupply(m, s);
  assert.equal(released.concentration, held.concentration);
  assert.equal(released.t1LockedShares, 0);
  m.orders = [];
  quote(m, 'crowd1', { stockId: s.id, side: 'buy', quantity: 600_000, price: s.price / 100 });
  assert.equal(submitOrder(m, { stockId: s.id, side: 'sell', quantity: 600_000, price: s.price / 100 }).ok, true);
  assert.equal(position(m, 'player').quantity, 0);
  assert.equal(getChipSupply(m, s).concentration, initial.concentration);
  assert.equal(getChipSupply(m, s).floatShares, initial.floatShares);
  // Buyers received T+1 shares, so supply returns when those lots unlock.
  m.day = 3;
  for (const a of m.actors) for (const p of Object.values(a.positions)) p.today = 0;
  assert.equal(getChipSupply(m, s).depthFactor, initial.depthFactor);
});

test('resting unfilled sales count as supply without changing ownership or being cancelled by a holding preference', () => {
  const m = fixture(), s = m.stocks[0];
  move(m, 'crowd0', 'ai2', 500_000);
  Object.assign(m.agentSimulation!.plans.ai2, { mainId: s.id, reserveId: 's2', state: 'hold' });
  const held = getChipSupply(m, s);
  quote(m, 'ai2', { stockId: s.id, side: 'sell', quantity: 450_000, price: s.price / 100 });
  const offered = getChipSupply(m, s);
  assert.equal(offered.concentration, held.concentration);
  assert.ok(offered.estimatedSupply > held.estimatedSupply);
  assert.ok(offered.estimatedSupply >= 450_000);
  const before = structuredClone(m.orders); getChipSupply(m, s);
  assert.deepEqual(m.orders, before);
});

test('profitable household inventory makes real offers larger while keeping them cash/share backed', () => {
  const flat = fixture(), profitable = structuredClone(flat);
  for (const a of profitable.actors.filter(a => a.id.startsWith('crowd'))) position(profitable, a.id).cost = Math.floor(position(profitable, a.id).cost / 1.5);
  assert.ok(getChipSupply(profitable, profitable.stocks[0]).profitPressure > getChipSupply(flat, flat.stocks[0]).profitPressure);
  const baseline = book(flat).filter(o => o.side === 'sell'), offers = book(profitable).filter(o => o.side === 'sell');
  assert.deepEqual(offers.map(o => o.price), baseline.map(o => o.price));
  assert.ok(offers.reduce((sum, o) => sum + o.quantity, 0) > baseline.reduce((sum, o) => sum + o.quantity, 0));
  for (const a of profitable.actors) {
    const held = a.positions.s1;
    if (held) assert.ok(offers.filter(o => o.actorId === a.id).reduce((sum, o) => sum + o.quantity, 0) <= held.quantity - held.today);
  }
});

test('a patient seat can release inventory on exit, with funded orders rather than a forced price move', () => {
  const m = fixture(), s = m.stocks[0];
  move(m, 'crowd0', 'ai2', 500_000);
  const plan = m.agentSimulation!.plans.ai2;
  Object.assign(plan, { mainId: s.id, reserveId: 's2', state: 'hold', startedDay: 1, minimumDays: 2 });
  const hold = getChipSupply(m, s), locked = getActorChipSupply(m, s, who(m, 'ai2'));
  plan.state = 'reduce';
  const release = getChipSupply(m, s), willing = getActorChipSupply(m, s, who(m, 'ai2'));
  assert.equal(release.concentration, hold.concentration);
  assert.ok(release.estimatedSupply > hold.estimatedSupply);
  assert.ok(willing.sellFactor > locked.sellFactor);
  m.tickCount = 4;
  const price = s.price;
  runMarketAgents(m, () => .1, (id, input) => quote(m, id, input));
  assert.ok(m.orders.some(o => o.actorId === 'ai2' && o.stockId === s.id && o.side === 'sell'));
  assert.equal(s.price, price, 'unmatched quotes cannot change the price');
});

test('broker borrowing and return preserve physical float; margin and collateral sub-ledgers do not double it', () => {
  const m = fixture(), s = m.stocks.find(s => s.lendTotal > 0)!;
  const before = getChipSupply(m, s);
  s.lendAvailable -= 100;
  const bought = position(m, 'crowd0', s.id); bought.quantity += 100; bought.today += 100; bought.cost += s.price * 100;
  m.shorts[s.id] = { quantity: 100, today: 100, margin: s.price * 100, proceeds: s.price * 100 };
  assert.equal(getChipSupply(m, s).floatShares, before.floatShares);
  s.lendAvailable += 100; bought.quantity -= 100; bought.today -= 100; bought.cost -= s.price * 100;
  m.shorts[s.id].quantity = 0;
  assert.equal(getChipSupply(m, s).floatShares, before.floatShares);
  move(m, 'crowd0', 'player', 1000, s.id);
  const physical = getChipSupply(m, s);
  m.creditAccount!.positions[s.id] = { quantity: 500, today: 0 };
  m.marginState = { version: 1, accounts: [{ id: 'chip-margin', mode: 'isolated', cash: 0, interest: 0,
    interestRemainder: 0, contributedPrincipal: 0, positions: [{ id: 'chip-long', stockId: s.id,
      direction: 'long', leverage: 2, quantity: 500, today: 0, cost: s.price * 500, loan: s.price * 250, proceeds: 0, principal: s.price * 250 }] }] };
  assert.deepEqual(getChipSupply(m, s), physical);
});

test('unissued IPO stock cannot make a small live float look dispersed or create patient depth', () => {
  const m = fixture(), s = m.stocks[0], before = getChipSupply(m, s), quotes = book(m);
  m.actors.push({ id: 'ipo-issuer', name: '发行账户', cash: 0, positions: { [s.id]: {
    quantity: s.shares - before.floatShares, today: 0, financed: 0, cost: 0,
  } } });
  assert.deepEqual(getChipSupply(m, s), before);
  assert.equal(getActorChipSupply(m, s, who(m, 'ipo-issuer')).available, 0);
  const after = book(m);
  assert.deepEqual(after.map(o => [o.actorId, o.side, o.price, o.quantity]), quotes.map(o => [o.actorId, o.side, o.price, o.quantity]));
});
