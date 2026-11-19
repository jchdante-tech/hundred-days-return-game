import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyMovingAverage, dailyPriceChanges, extendChartWindow, latestChartWindow, minuteTrades, normalizeChartWindow, panChartWindow, priceChange, simpleMovingAverage, zoomChartWindow } from '../shared/chart-math';

test('daily changes use the previous close, not the selected day opening price', () => {
  const bars = [{ day: 1, open: 9, close: 10 }, { day: 2, open: 12, close: 11 }, { day: 3, open: 10, close: 9.9 }];
  const changes = dailyPriceChanges(bars);
  assert.equal(changes[0], null);
  assert.deepEqual(changes[1], { reference: 10, amount: 1, percent: 10, basis: 'previous-close' });
  assert.deepEqual(changes[2], { reference: 11, amount: -1.1, percent: -10, basis: 'previous-close' });
});

test('daily returns never bridge missing closes and do not invent an earliest reference', () => {
  assert.deepEqual(dailyPriceChanges([{ day: 0, close: 10 }, { day: 5, close: 11 }, { day: 6, close: 11 }]), [
    null, null, { reference: 11, amount: 0, percent: 0, basis: 'previous-close' },
  ]);
  assert.deepEqual(dailyPriceChanges([]), []);
  assert.equal(priceChange(10, 0), null);
  assert.equal(priceChange(NaN, 10), null);
});

test('IPO listing day compares its actual latest close with the issue price', () => {
  const bars = [{ day: 7, close: 13 }, { day: 8, close: 12.35 }];
  const changes = dailyPriceChanges(bars, { listedDay: 7, issuePrice: 10 });
  assert.deepEqual(changes, [
    { reference: 10, amount: 3, percent: 30, basis: 'issue-price' },
    { reference: 13, amount: -.65, percent: -5, basis: 'previous-close' },
  ]);
  assert.equal(dailyPriceChanges(bars, { listedDay: 6, issuePrice: 10 })[0], null);
});

test('daily percentage at the left edge retains its earlier reference after zoom and pan', () => {
  const bars = Array.from({ length: 60 }, (_, index) => ({ day: index - 59, close: 10 + index }));
  const fullChanges = dailyPriceChanges(bars);
  const wide = latestChartWindow(bars.length);
  const narrow = zoomChartWindow(bars.length, wide, 20);
  const panned = panChartWindow(bars.length, narrow, -10);
  for (const range of [wide, narrow, panned]) {
    const visible = fullChanges.slice(range.start, range.start + range.size);
    assert.equal(visible[0]?.reference, bars[range.start - 1].close);
    assert.equal(visible[0]?.amount, 1);
  }
});

test('unfinished daily percentage follows only that day latest actual close', () => {
  const bars = [{ day: 1, close: 10, complete: true }, { day: 2, close: 10.5, complete: false }];
  assert.equal(dailyPriceChanges(bars)[1]?.percent, 5);
  bars[1].close = 10.7;
  assert.equal(dailyPriceChanges(bars)[1]?.percent, 7);
  assert.equal(dailyPriceChanges(bars)[0], null);
});

test('MA waits for the full window and never uses a later close', () => {
  const closes = [10, 11, 12, 13, 14, 25];
  assert.deepEqual(simpleMovingAverage(closes, 5), [null, null, null, null, 12, 15]);
  assert.deepEqual(simpleMovingAverage(closes.slice(0, 5), 5), [null, null, null, null, 12]);
  assert.deepEqual(simpleMovingAverage(closes, 10), [null, null, null, null, null, null]);
  assert.deepEqual(closes, [10, 11, 12, 13, 14, 25]);
});

test('changing today’s live close updates only the last MA value', () => {
  const before = simpleMovingAverage([10, 11, 12, 13, 14, 15], 5);
  const after = simpleMovingAverage([10, 11, 12, 13, 14, 20], 5);
  assert.deepEqual(before.slice(0, -1), after.slice(0, -1));
  assert.equal(before.at(-1), 13);
  assert.equal(after.at(-1), 14);
});

test('minute volume sums fills while price uses the latest fill and excludes reference quotes', () => {
  const points = [
    { time: '昨收', price: 10, volume: 0 },
    { time: '09:25', price: 10.02, volume: 200 },
    { time: '09:30', price: 10.03, volume: 100 },
    { time: '09:30', price: 10.04, volume: 500 },
    { time: '09:31', price: 10.04, volume: 0 },
  ];
  assert.deepEqual(minuteTrades(points), [
    { time: '09:25', price: 10.02, volume: 200 },
    { time: '09:30', price: 10.04, volume: 600 },
  ]);
  assert.equal(points[2].volume, 100);
  assert.deepEqual(minuteTrades([]), []);
});

test('daily chart defaults to the latest 40 recorded bars and zoom clamps to 12 through all bars', () => {
  assert.deepEqual(latestChartWindow(61), { start: 21, size: 40 });
  assert.deepEqual(latestChartWindow(5), { start: 0, size: 5 });
  assert.deepEqual(latestChartWindow(0), { start: 0, size: 0 });
  assert.deepEqual(zoomChartWindow(61, { start: 21, size: 40 }, 3), { start: 49, size: 12 });
  assert.deepEqual(zoomChartWindow(61, { start: 21, size: 40 }, 1000), { start: 0, size: 61 });
  assert.deepEqual(normalizeChartWindow(61, { start: -50, size: 30 }), { start: 0, size: 30 });
});

test('zoom preserves the hovered date away from history boundaries', () => {
  const current = { start: 20, size: 40 };
  const zoomed = zoomChartWindow(100, current, 20, .25);
  assert.deepEqual(zoomed, { start: 25, size: 20 });
  assert.equal(current.start + current.size * .25, zoomed.start + zoomed.size * .25);
  assert.deepEqual(zoomChartWindow(100, zoomed, 40, .25), current);
});

test('panning stays within history and live appends follow only a viewport at the end', () => {
  assert.deepEqual(panChartWindow(60, { start: 20, size: 40 }, -50), { start: 0, size: 40 });
  assert.deepEqual(panChartWindow(60, { start: 0, size: 40 }, 50), { start: 20, size: 40 });
  assert.deepEqual(extendChartWindow(60, 61, { start: 20, size: 40 }), { start: 21, size: 40 });
  assert.deepEqual(extendChartWindow(60, 61, { start: 4, size: 40 }), { start: 4, size: 40 });
});

test('zooming a window does not remove the earlier closes needed by its leftmost MA', () => {
  const bars = Array.from({ length: 60 }, (_, index) => ({ day: index - 59, close: 10 + index }));
  const fullMA = dailyMovingAverage(bars, 20);
  const wide = latestChartWindow(bars.length);
  const narrow = zoomChartWindow(bars.length, wide, 20);
  const wideMA = fullMA.slice(wide.start, wide.start + wide.size);
  const narrowMA = fullMA.slice(narrow.start, narrow.start + narrow.size);
  assert.equal(wideMA[0], 20.5);
  assert.equal(narrowMA[0], 40.5);
  assert.deepEqual(narrowMA, wideMA.slice(20));
  assert.equal(narrowMA.includes(null), false);
});

test('missing played days break the MA rather than joining fictional history across a save gap', () => {
  const bars = [
    { day: -3, close: 10 }, { day: -2, close: 11 }, { day: -1, close: 12 }, { day: 0, close: 13 },
    { day: 5, close: 30 }, { day: 6, close: 32 }, { day: 7, close: 34 }, { day: 8, close: 36 },
  ];
  assert.deepEqual(dailyMovingAverage(bars, 3), [null, null, 11, 12, null, null, 32, 34]);
});
