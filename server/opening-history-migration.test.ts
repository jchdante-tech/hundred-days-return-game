import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, getView, nextDay, validateMarket, type Market } from './engine.js';

type VersionedStock = Market['stocks'][number] & { openingHistoryVersion?: number };
function withoutBackgroundMetadata(market: Market) {
  const copy = structuredClone(market);
  for (const stock of copy.stocks as VersionedStock[]) {
    delete stock.openingHistoryVersion;
    stock.dailyBars = stock.dailyBars?.filter(bar => bar.origin !== 'background');
  }
  return copy;
}
function legacyQuietBackground(market: Market, version?: number) {
  for (const stock of market.stocks as VersionedStock[]) {
    if (stock.listedDay) continue;
    const anchor = stock.dailyBars!.find(bar => bar.day === 0)!.close;
    for (const bar of stock.dailyBars!.filter(bar => bar.origin === 'background')) {
      bar.open = bar.high = bar.low = bar.close = anchor;
      bar.turnover = anchor * bar.volume;
    }
    if (version === undefined) delete stock.openingHistoryVersion;
    else stock.openingHistoryVersion = version;
  }
}

for (const version of [undefined, 1]) test(`upgrading background version ${version ?? 'unmarked'} preserves the player's entire live market and recorded sessions`, () => {
  const market = createMarket(713);
  nextDay(market);
  legacyQuietBackground(market, version);
  const before = structuredClone(market);
  assert.equal(validateMarket(market), true);
  getView(market);
  assert.notDeepEqual(market.stocks[0].dailyBars!.filter(bar => bar.origin === 'background'), before.stocks[0].dailyBars!.filter(bar => bar.origin === 'background'));
  assert.deepEqual(withoutBackgroundMetadata(market), withoutBackgroundMetadata(before), 'only opening world history and its version may change');
  for (const [index, stock] of market.stocks.entries()) {
    assert.equal(stock.dailyBars!.find(bar => bar.day === 0)!.close, before.stocks[index].dailyBars!.find(bar => bar.day === 0)!.close);
    assert.equal((stock as VersionedStock).openingHistoryVersion, 2);
  }
  const once = structuredClone(market);
  getView(market);
  assert.deepEqual(market, once, 'reading repeatedly must not regenerate history');
  const restored = JSON.parse(JSON.stringify(market)) as Market;
  assert.equal(validateMarket(restored), true);
  assert.deepEqual(getView(restored), getView(market));
});

test('unknown opening-history versions are rejected instead of silently rewritten', () => {
  const market = createMarket(42);
  (market.stocks[0] as VersionedStock).openingHistoryVersion = 99;
  assert.equal(validateMarket(market), false);
});
