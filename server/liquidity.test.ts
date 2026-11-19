import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarket, tick } from './engine.js';

test('ordinary funded trading keeps a readable intraday tape without inventing chart volume or price changes', () => {
  const m = createMarket(42); m.speed = 1; m.paused = false;
  while (m.phase !== 'night' && !m.result) {
    const prior = m.stocks.map(s => ({ price: s.price, volume: s.volume }));
    tick(m);
    for (const [i, s] of m.stocks.entries()) {
      if (s.volume === prior[i].volume) assert.equal(s.price, prior[i].price, 'No execution must mean no new price');
    }
  }
  const toMinute = (time: string) => /^\d\d:\d\d$/.test(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : -1;
  // No overnight, lunch, or call-auction gaps. This is a game-readability
  // threshold for the pool, not an assertion that every stock trades each minute.
  const sessions = [Array.from({ length: 120 }, (_, i) => 570 + i), Array.from({ length: 117 }, (_, i) => 780 + i)];
  const minutes = new Set(sessions.flat()), coverage: number[] = [], longestGaps: number[] = [];
  for (const stock of m.stocks) {
    const trades = m.trades.filter(t => t.day === m.day && t.stockId === stock.id);
    const aggregate = new Map<string, { volume: number; price: number }>();
    for (const trade of trades) aggregate.set(trade.time, { volume: (aggregate.get(trade.time)?.volume ?? 0) + trade.quantity, price: trade.price });
    assert.equal(trades.reduce((n, t) => n + t.quantity, 0), stock.volume);
    assert.equal(stock.history.reduce((n, h) => n + h.volume, 0), stock.volume);
    for (const point of stock.history.filter(h => h.volume > 0)) assert.deepEqual({ volume: point.volume, price: point.price }, aggregate.get(point.time));
    const tradedMinutes = new Set(trades.map(t => toMinute(t.time)).filter(t => minutes.has(t)));
    coverage.push(tradedMinutes.size / minutes.size);
    let longest = 0;
    for (const session of sessions) {
      let gap = 0;
      for (const minute of session) { gap = tradedMinutes.has(minute) ? 0 : gap + 1; longest = Math.max(longest, gap); }
    }
    longestGaps.push(longest);
  }
  coverage.sort((a, b) => a - b); longestGaps.sort((a, b) => a - b);
  const mean = coverage.reduce((n, value) => n + value, 0) / coverage.length;
  const median = coverage[Math.floor((coverage.length - 1) * .5)];
  const p95Gap = longestGaps[Math.floor((longestGaps.length - 1) * .95)];
  assert.ok(mean >= .5, `Sparse tape: mean continuous-minute coverage ${(mean * 100).toFixed(2)}% < 50%`);
  assert.ok(median >= .5, `Sparse typical stock: median coverage ${(median * 100).toFixed(2)}% < 50%`);
  assert.ok(p95Gap <= 15, `Long silent tape: P95 no-fill gap ${p95Gap} > 15 minutes`);
});
