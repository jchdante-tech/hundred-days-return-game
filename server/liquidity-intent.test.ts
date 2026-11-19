import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, type Market } from './engine.js';
import { runMarketAgents, seedBackgroundBook } from './market-agents.js';
const active = (o: Market['orders'][number]) => o.remaining > 0 && (o.status === 'open' || o.status === 'partial');
function fixture() {
  const m = createMarket(42); m.phase = 'morning'; m.tickCount = 1; m.phaseElapsed = 1; m.orders = []; m.trades = []; m.news = [];
  for (const s of m.stocks) {
    s.price = s.previousClose = s.fair = 1000; s.newsBias = 0;
    m.storyState!.expectations[s.id].premium = 0;
    for (const [id, opinions] of Object.entries(m.agentSimulation!.crowdOpinions)) {
      opinions[s.id].bias = 0; opinions[s.id].inventory = m.actors.find(a => a.id === id)!.positions[s.id].quantity;
    }
  }
  return m;
}
function resting(m: Market, id: string, actorId: string, side: 'buy' | 'sell', price: number, stockId = 's1') {
  const o: Market['orders'][number] = { id, actorId, stockId, side, price, quantity: 100, remaining: 100, status: 'open', time: '09:30', sequence: ++m.sequence, createdTick: m.tickCount,
    frozenCash: side === 'buy' ? price * 100 : 0, restrictedClaim: 0 };
  m.orders.push(o); return o;
}
test('ordinary intent replaces only its crossing opposite quote before placing, preserving self-trade protection', () => {
  const m = fixture(), blocked = resting(m, 'blocked', 'crowd0', 'sell', 998);
  const other = resting(m, 'other-seat', 'ai0', 'sell', 998), player = resting(m, 'player-order', 'player', 'sell', 998);
  const sameSide = resting(m, 'same-side', 'crowd0', 'buy', 990), distant = resting(m, 'far-offer', 'crowd0', 'sell', 1050);
  const elsewhere = resting(m, 'other-stock', 'crowd0', 'sell', 1050, 's2');
  const beforeQuotes = structuredClone(m.stocks); let accepted = false;
  runMarketAgents(m, () => .1, (actorId, input) => {
    if (actorId === 'crowd0' && input.stockId === 's1' && input.side === 'buy') {
      assert.equal(blocked.status, 'cancelled');
      assert.ok(!m.orders.some(o => active(o) && o.actorId === actorId && o.stockId === input.stockId && o.side === 'sell' && o.price <= input.price * 100));
      accepted = true;
    }
    return { ok: true, message: '' };
  });
  assert.ok(accepted, 'ordinary buyer can place a funded intent after its own stale quote is removed');
  for (const retained of [other, player, sameSide, distant, elsewhere]) assert.equal(retained.status, 'open', retained.id);
  assert.deepEqual(m.stocks, beforeQuotes, 'placing intent never paints prices or volumes'); assert.equal(m.trades.length, 0);
});
for (const phase of ['auction', 'closing'] as const) test(`ordinary quote replacement observes protected ${phase} no-cancel window`, () => {
  const m = fixture(); m.phase = phase; m.phaseElapsed = phase === 'auction' ? 30 : 1;
  const blocked = resting(m, 'blocked', 'crowd0', 'sell', 998); let rejected = 0;
  runMarketAgents(m, () => .1, (id, input) => {
    if (id === 'crowd0' && input.stockId === 's1' && input.side === 'buy') {
      assert.equal(blocked.status, 'open'); rejected++;
      return { ok: false, message: 'same-actor crossing remains blocked' };
    }
    return { ok: true, message: '' };
  });
  assert.equal(blocked.status, 'open'); assert.equal(rejected, 1);
});
test('patient depth leaves at least three quarters of cash and transferable shares available to fresh intent', () => {
  const m = fixture();
  for (const a of m.actors.filter(a => a.id.startsWith('crowd'))) {
    a.cash = 1_000_000;
    for (const p of Object.values(a.positions)) { p.quantity = 1000; p.today = 0; p.cost = 1_000_000; }
  }
  let submissions = 0;
  for (let pulse = 0; pulse < 4; pulse++) seedBackgroundBook(m, (id, input) => {
    const a = m.actors.find(a => a.id === id)!;
    resting(m, `patient-${++submissions}`, id, input.side as 'buy' | 'sell', Math.round(input.price * 100), input.stockId);
    const order = m.orders.at(-1)!; order.quantity = order.remaining = input.quantity; order.frozenCash = input.side === 'buy' ? order.price * input.quantity : 0;
    const cashFrozen = m.orders.filter(o => o.actorId === id && active(o)).reduce((sum, o) => sum + o.frozenCash, 0);
    const sharesFrozen = m.orders.filter(o => o.actorId === id && o.stockId === input.stockId && o.side === 'sell' && active(o)).reduce((sum, o) => sum + o.remaining, 0);
    assert.ok(cashFrozen <= a.cash * .25);
    assert.ok(sharesFrozen <= (a.positions[input.stockId].quantity - a.positions[input.stockId].today) * .25);
    return { ok: true, message: '' };
  });
  assert.ok(submissions > 0); assert.equal(m.trades.length, 0);
});
