import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, getView, nextDay, validateMarket, type Market } from './engine.js';
import { generateOpeningHistory, openingHistoryDates } from './opening-history.js';

function withoutBackground(market: Market) {
  const copy = structuredClone(market);
  for (const stock of copy.stocks) stock.dailyBars = stock.dailyBars?.filter(bar => bar.origin !== 'background');
  return copy;
}

test('opening history has 60 prior trading dates and reproducible seeded OHLCV paths', () => {
  const dates = openingHistoryDates();
  assert.equal(dates.length, 60);
  assert.equal(dates.at(-1), '2026-10-19');
  assert.equal(new Set(dates).size, 60);
  assert.ok(dates.every(date => date < '2026-10-20' && ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())));
  const bars = generateOpeningHistory(2026, 's1', '半导体', 1200);
  assert.deepEqual(generateOpeningHistory(2026, 's1', '半导体', 1200), bars);
  assert.notDeepEqual(generateOpeningHistory(2027, 's1', '半导体', 1200), bars);
  assert.equal(bars[0].day, -59);
  assert.equal(bars.at(-1)!.day, 0);
  assert.equal(bars.at(-1)!.close, 1200);
  assert.deepEqual(bars.map(bar => bar.date), dates);
  assert.ok(bars.every(bar => bar.origin === 'background' && bar.complete));
});

test('simulated fill prices produce coherent candles, 100-share volumes and weighted turnover within 10% limits', () => {
  for (const seed of [0, 1, 42, 441, 20261020, 0xffffffff]) {
    const market = createMarket(seed);
    assert.equal(validateMarket(market), true);
    for (const stock of market.stocks) {
      assert.equal(stock.dailyBars!.length, 60);
      assert.equal(stock.dailyBars!.at(-1)!.close, stock.previousClose);
      for (const [index, bar] of stock.dailyBars!.entries()) {
        assert.ok([bar.open, bar.high, bar.low, bar.close, bar.volume, bar.turnover].every(value => Number.isSafeInteger(value) && value > 0));
        assert.equal(bar.volume % 100, 0);
        assert.ok(bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close));
        assert.ok(bar.turnover >= bar.low * bar.volume && bar.turnover <= bar.high * bar.volume);
        if (index) {
          const previous = stock.dailyBars![index - 1].close;
          assert.ok(bar.low >= Math.round(previous * .9) && bar.high <= Math.round(previous * 1.1));
        }
      }
    }
  }
});

test('stocks share sector regimes while retaining their own paths', () => {
  const first = generateOpeningHistory(112, 's1', '半导体', 1200);
  const second = generateOpeningHistory(112, 's2', '半导体', 2800);
  const other = generateOpeningHistory(112, 's9', '电力', 800);
  const moves = (bars: typeof first) => bars.slice(1).map((bar, index) => bar.close / bars[index].close - 1);
  const correlation = (left: number[], right: number[]) => {
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const leftMean = mean(left), rightMean = mean(right);
    const covariance = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
    return covariance / Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0)
      * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  };
  assert.ok(correlation(moves(first), moves(second)) > .65);
  assert.ok(correlation(moves(first), moves(second)) > correlation(moves(first), moves(other)));
  assert.notDeepEqual(moves(first), moves(second));
});

test('opening history has calm and active days at the scale of the live market, with matching volume activity', () => {
  // Broad continuity bands from the simulator audit, not real-world market
  // claims or exact random-output snapshots. The old generator fails on both
  // average return (0.8%) and volume (227k shares).
  const observations: { change: number; volume: number }[] = [];
  for (const seed of [20261020, 20261021, 42, 1337, 123456, 7, 99, 314159, 271828, 8675309]) {
    for (const [sectorIndex, sector] of ['半导体', '光通信', '电力'].entries()) {
      for (let member = 1; member <= 4; member++) {
        const bars = generateOpeningHistory(seed, `s${sectorIndex * 4 + member}`, sector, 1200);
        for (let i = 1; i < bars.length; i++) {
          observations.push({ change: bars[i].close / bars[i - 1].close - 1, volume: bars[i].volume });
        }
      }
    }
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanChange = mean(observations.map(row => Math.abs(row.change)));
  assert.ok(meanChange >= .017 && meanChange <= .028, `Average daily absolute return ${meanChange} is out of the live-market continuity band`);
  const calm = observations.filter(row => Math.abs(row.change) < .01);
  const active = observations.filter(row => Math.abs(row.change) >= .05);
  assert.ok(calm.length / observations.length > .2, 'Quiet days should remain common');
  assert.ok(active.length / observations.length > .05 && active.length / observations.length < .2, 'Large days should exist without dominating the background');
  assert.ok(observations.some(row => row.change > .07) && observations.some(row => row.change < -.07));
  const meanVolume = mean(observations.map(row => row.volume));
  assert.ok(meanVolume >= 350_000 && meanVolume <= 600_000, `Average daily volume ${meanVolume} should not step abruptly at game start`);
  assert.ok(mean(active.map(row => row.volume)) > mean(calm.map(row => row.volume)) * 1.4, 'Active candles should carry more volume on average');
});

test('legacy migration adds only pregame history, preserving account, live RNG, current quotes and recorded days', () => {
  const market = createMarket(713);
  nextDay(market); nextDay(market);
  getView(market);
  const legacy = withoutBackground(market);
  const before = structuredClone(legacy);
  assert.equal(validateMarket(legacy), true);
  const firstView = getView(legacy);
  assert.deepEqual(withoutBackground(legacy), before);
  assert.deepEqual(firstView, getView(legacy));
  assert.equal(validateMarket(legacy), true);
  const initial = createMarket(713);
  for (const [index, stock] of legacy.stocks.entries()) {
    assert.equal(stock.dailyBars!.filter(bar => bar.origin === 'background').length, 60);
    assert.equal(stock.dailyBars!.find(bar => bar.day === 0)!.close, initial.stocks[index].previousClose);
    assert.equal(stock.previousClose, before.stocks[index].previousClose);
    assert.equal(stock.dailyHistoryStartDay, before.stocks[index].dailyHistoryStartDay);
  }
  const restored: Market = JSON.parse(JSON.stringify(legacy));
  assert.equal(validateMarket(restored), true);
  assert.deepEqual(getView(restored), firstView);
  nextDay(restored); nextDay(legacy);
  assert.deepEqual(restored, legacy);
});

test('a late legacy recording keeps its missing player interval instead of filling it with background candles', () => {
  const market = createMarket(21);
  nextDay(market); nextDay(market);
  for (const stock of market.stocks) { delete stock.dailyBars; delete stock.dailyHistoryStartDay; }
  const view = getView(market);
  for (const stock of view.stocks) {
    assert.equal(stock.dailyHistoryStartDay, 3);
    assert.equal(stock.dailyBars.length, 60);
    assert.equal(stock.dailyBars.at(-1)!.day, 0);
    assert.ok(stock.dailyBars.every(bar => bar.day <= 0 && bar.origin === 'background'));
  }
});
