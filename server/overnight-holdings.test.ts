import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePhase, createMarket, getView, nextDay, submitOrder, validateMarket, type Market } from './engine.js';

function restored(m: Market): Market {
  const candidate: unknown = JSON.parse(JSON.stringify(m));
  assert.ok(validateMarket(candidate), 'the purchased position must survive save validation');
  return candidate;
}

function closeDay(m: Market) {
  for (let phase = 0; phase < 6 && m.phase !== 'night'; phase++) advancePhase(m);
  assert.equal(m.phase, 'night');
}

for (const seed of [42, 119, 20261022]) {
  test(`day-one matched cash purchases remain visible and become sellable on day two (seed ${seed})`, () => {
    let m = createMarket(seed);
    advancePhase(m);
    assert.equal(m.phase, 'morning');
    m.paused = false;
    const acquired: { stockId: string; quantity: number; cost: number }[] = [];
    const offered = getView(m).stocks.filter(s => s.asks[0]?.quantity >= 100).slice(0, 3);
    assert.equal(offered.length, 3, 'test requires three real, funded counterparty offers');
    for (const stock of offered) {
      const result = submitOrder(m, { stockId: stock.id, side: 'buy', quantity: 100, price: stock.asks[0].price });
      assert.equal(result.ok, true, result.message);
      const holding = m.actors.find(a => a.id === 'player')!.positions[stock.id];
      assert.equal(holding.quantity, 100, 'an accepted but unfilled order is not a holding');
      assert.ok(m.trades.some(t => t.stockId === stock.id && t.playerSide === 'buy' && t.quantity === 100));
      acquired.push({ stockId: stock.id, quantity: holding.quantity, cost: holding.cost });
    }

    function assertHoldings(today: number, available: number) {
      const view = getView(m);
      for (const bought of acquired) {
        const actual = view.positions.find(p => p.stockId === bought.stockId);
        assert.ok(actual, `${bought.stockId} disappeared from the holdings response on day ${m.day} (${m.phase})`);
        assert.equal(actual.quantity, bought.quantity, 'overnight processing must retain every bought share');
        assert.equal(actual.todayBought, today);
        assert.equal(actual.available, available);
        assert.equal(m.actors.find(a => a.id === 'player')!.positions[bought.stockId].cost, bought.cost);
      }
    }

    assertHoldings(100, 0);
    m = restored(m);
    assertHoldings(100, 0);
    closeDay(m);
    assertHoldings(100, 0);
    m = restored(m);
    nextDay(m);
    assert.equal(m.day, 2);
    assert.equal(m.phase, 'auction');
    assertHoldings(0, 100);
    m = restored(m);
    assertHoldings(0, 100);
    advancePhase(m);
    assert.equal(m.phase, 'morning');
    assertHoldings(0, 100);
  });
}
