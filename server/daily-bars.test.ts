import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, submitOrder, advancePhase, nextDay, getView, tick, validateMarket, type Market } from './engine.js';
import type { DailyBar } from '../shared/types.js';

const sessionBars = (stock: { dailyBars?: DailyBar[] }) => stock.dailyBars!.filter(bar => bar.origin !== 'background');

function continuous(seed = 42) {
  // Historical fixed-depth book: these fixtures assert exact fill prices.
  const market = createMarket(seed, { legacySimulation: true });
  market.phase = 'morning'; market.paused = false;
  return market;
}

function closeWithoutAdditionalOrders(market: Market) {
  market.orders = [];
  // Model an unavailable sell side explicitly. A quiet close must not depend
  // on landing between NPC decision ticks, whose cadence can change.
  for (const actor of market.actors) for (const position of Object.values(actor.positions)) position.today = position.quantity;
  market.phase = 'closing'; market.phaseElapsed = 14; market.tickCount = 0;
  advancePhase(market);
  assert.equal(market.phase, 'night');
}

test('daily chart has background history but excludes quotes and unfilled session orders', () => {
  const market = createMarket(7);
  assert.ok(getView(market).stocks.every(stock => stock.dailyBars.length === 60 && stock.dailyHistoryStartDay === 1));
  market.paused = false;
  assert.equal(submitOrder(market, { stockId: 's2', side: 'buy', quantity: 100, price: 25.2 }).ok, true);
  assert.equal(market.trades.length, 0);
  assert.deepEqual(sessionBars(getView(market).stocks[1]), []);
});

test('intraday OHLCV comes from executed fills and excludes the previous close from extremes', () => {
  const market = continuous();
  assert.equal(submitOrder(market, { stockId: 's2', side: 'buy', quantity: 2500, price: 28.05 }).ok, true);
  const stock = getView(market).stocks[1];
  assert.deepEqual(sessionBars(stock), [{ day: 1, date: '2026-10-20', open: 28.01, high: 28.03,
    low: 28.01, close: 28.03, volume: 2500, turnover: 70035, complete: false }]);
  assert.equal(stock.previousClose, 28);
  assert.equal(stock.low, 28.01);
  // Explicit prior-day inventory for a sell below yesterday's close.
  market.actors[1].positions.s1.quantity -= 100;
  market.actors[1].positions.s1.cost -= 120_000;
  market.actors[0].positions.s1 = { quantity: 100, today: 0, financed: 0, cost: 120_000 };
  assert.equal(submitOrder(market, { stockId: 's1', side: 'sell', quantity: 100, price: 11.99 }).ok, true);
  assert.equal(sessionBars(getView(market).stocks[0])[0].high, 11.99);
  assert.equal(getView(market).stocks[0].high, 11.99);
  sessionBars(stock)[0].close = 999;
  assert.equal(sessionBars(getView(market).stocks[1])[0].close, 28.03);
});

test('closing auction is included, then one finalized candle survives day rollover', () => {
  const market = createMarket(441);
  for (let phase = 0; phase < 5; phase++) advancePhase(market);
  assert.equal(market.phase, 'night');
  const closed = getView(market).stocks.map(stock => stock.dailyBars);
  for (const stock of market.stocks) {
    const fills = market.trades.filter(trade => trade.stockId === stock.id && trade.day === 1);
    if (!fills.length) { assert.deepEqual(sessionBars(stock), []); continue; }
    assert.deepEqual(sessionBars(stock), [{ day: 1, date: '2026-10-20', open: fills[0].price,
      high: Math.max(...fills.map(fill => fill.price)), low: Math.min(...fills.map(fill => fill.price)),
      close: fills.at(-1)!.price, volume: fills.reduce((sum, fill) => sum + fill.quantity, 0),
      turnover: fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0), complete: true }]);
  }
  getView(market); getView(market);
  nextDay(market);
  assert.equal(market.day, 2);
  assert.deepEqual(getView(market).stocks.map(stock => stock.dailyBars), closed);
  assert.ok(market.stocks.every(stock => stock.volume === 0 && stock.open === 0 && stock.high === 0 && stock.low === 0));
  advancePhase(market);
  for (const [index, stock] of getView(market).stocks.entries()) {
    assert.deepEqual(stock.dailyBars.filter(bar => bar.day === 1), closed[index].filter(bar => bar.day === 1));
    assert.equal(stock.dailyBars.filter(bar => bar.day === 2).length, stock.volume ? 1 : 0);
    if (stock.volume) assert.equal(stock.dailyBars.at(-1)!.complete, false);
  }
});

test('a day with no executed trades never produces a flat invented candle', () => {
  const market = createMarket(8);
  closeWithoutAdditionalOrders(market);
  assert.ok(market.stocks.every(stock => sessionBars(stock).length === 0));
  assert.ok(getView(market).stocks.every(stock => sessionBars(stock).length === 0));
  nextDay(market);
  assert.equal(market.day, 2);
  assert.ok(getView(market).stocks.every(stock => sessionBars(stock).length === 0));
});

test('daily history survives serialization and deterministic continuation without duplicate days', () => {
  const market = createMarket(57);
  for (let day = 0; day < 6; day++) nextDay(market);
  advancePhase(market);
  const restored: Market = JSON.parse(JSON.stringify(market));
  assert.equal(validateMarket(restored), true);
  assert.deepEqual(getView(restored), getView(market));
  nextDay(market); nextDay(restored);
  assert.deepEqual(restored, market);
  for (const stock of getView(restored).stocks) {
    if (stock.listedDay) {
      assert.ok(stock.dailyBars.every(bar => bar.day >= stock.listedDay! && bar.origin === 'session'));
      assert.ok(sessionBars(stock).length <= restored.day - stock.listedDay);
    } else assert.ok(sessionBars(stock).length >= 6);
    assert.equal(new Set(stock.dailyBars.map(bar => bar.day)).size, stock.dailyBars.length);
  }
  const view = getView(restored);
  view.stocks[0].dailyBars[0].open = 1;
  assert.notEqual(getView(restored).stocks[0].dailyBars[0].open, 1);
});

test('legacy v1 save starts recording on its current day and repairs previous-close polluted extremes', () => {
  const market = createMarket(42);
  nextDay(market);
  market.phase = 'morning'; market.paused = false;
  const ask = getView(market).stocks[1].asks[1].price;
  assert.equal(submitOrder(market, { stockId: 's2', side: 'buy', quantity: 2500, price: ask }).ok, true);
  const original = getView(market).stocks[1].dailyBars.at(-1)!;
  for (const stock of market.stocks) {
    delete stock.dailyBars; delete stock.dailyHistoryStartDay;
    stock.high = Math.max(stock.high, stock.previousClose);
    stock.low = stock.volume ? Math.min(stock.low, stock.previousClose) : stock.previousClose;
  }
  const restored: Market = JSON.parse(JSON.stringify(market));
  assert.equal(validateMarket(restored), true);
  const view = getView(restored);
  assert.ok(view.stocks.every(stock => stock.dailyHistoryStartDay === 2));
  assert.deepEqual(sessionBars(view.stocks[1]), [original]);
  assert.ok(view.stocks.every(stock => sessionBars(stock).every(bar => bar.day >= 2)));
  assert.ok(view.stocks.every(stock => stock.dailyBars.filter(bar => bar.origin === 'background').length === 60));
  assert.equal(validateMarket(restored), true);
  closeWithoutAdditionalOrders(restored);
  assert.deepEqual(sessionBars(restored.stocks[1]).map(bar => [bar.day, bar.complete]), [[2, true]]);
  nextDay(restored);
  assert.equal(sessionBars(restored.stocks[1]).length, 1);
});

test('legacy save can continue trading before its first view without losing earlier fills', () => {
  const market = continuous();
  submitOrder(market, { stockId: 's2', side: 'buy', quantity: 100, price: 28.01 });
  for (const stock of market.stocks) { delete stock.dailyBars; delete stock.dailyHistoryStartDay; }
  submitOrder(market, { stockId: 's2', side: 'buy', quantity: 100, price: 28.01 });
  assert.equal(sessionBars(getView(market).stocks[1])[0].volume, 200);
  market.paused = false;
  tick(market);
  assert.equal(sessionBars(getView(market).stocks[1]).length, 1);
});

test('legacy nightly save persists its completed current-day candle once on migration', () => {
  const market = continuous();
  submitOrder(market, { stockId: 's2', side: 'buy', quantity: 2500, price: 28.05 });
  closeWithoutAdditionalOrders(market);
  for (const stock of market.stocks) { delete stock.dailyBars; delete stock.dailyHistoryStartDay; }
  assert.equal(validateMarket(market), true);
  const firstView = getView(market);
  assert.deepEqual(sessionBars(market.stocks[1]).map(bar => [bar.day, bar.complete]), [[1, true]]);
  assert.deepEqual(getView(market), firstView);
  assert.equal(validateMarket(JSON.parse(JSON.stringify(market))), true);
  nextDay(market);
  assert.equal(sessionBars(market.stocks[1]).length, 1);
});

test('restore rejects malformed, duplicated, future, or incomplete stored daily bars', () => {
  const market = continuous();
  submitOrder(market, { stockId: 's2', side: 'buy', quantity: 2500, price: 28.05 });
  closeWithoutAdditionalOrders(market);
  assert.equal(validateMarket(market), true);
  const corruptions: ((copy: Market) => void)[] = [
    copy => { copy.stocks[1].dailyBars![0].close = Number.NaN; },
    copy => { copy.stocks[1].dailyBars![0].low = 999999; },
    copy => { copy.stocks[1].dailyBars![0].high = 1; },
    copy => { copy.stocks[1].dailyBars![0].volume = -100; },
    copy => { copy.stocks[1].dailyBars![0].turnover = 1; },
    copy => { copy.stocks[1].dailyBars![0].date = '2026-02-30'; },
    copy => { copy.stocks[1].dailyBars![0].date = '2026-10-21'; },
    copy => { copy.stocks[1].dailyBars![0].day = 2; },
    copy => { delete copy.stocks[1].dailyBars![0].origin; },
    copy => { copy.stocks[1].dailyBars![0].origin = 'session'; },
    copy => { sessionBars(copy.stocks[1])[0].origin = 'background'; },
    copy => { copy.stocks[1].dailyBars![0].complete = false; },
    copy => { copy.stocks[1].dailyBars!.push({ ...copy.stocks[1].dailyBars![0] }); },
    copy => { delete copy.stocks[1].dailyHistoryStartDay; },
    copy => { copy.stocks[1].dailyHistoryStartDay = 2; },
    copy => { copy.phase = 'morning'; },
    copy => { copy.stocks[1].dailyBars = Array.from({ length: 101 }, () => ({ ...copy.stocks[1].dailyBars![0] })); },
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const copy = structuredClone(market); corrupt(copy);
    assert.equal(validateMarket(copy), false, `malformed history ${index}`);
  }
});
