import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeShortcutOptions } from '../src/trade-shortcuts.js';

const buy = (price: number, availableCash: number) => tradeShortcutOptions({ side: 'buy', price, availableCash, availableShares: 0 });
const sell = (availableShares: number) => tradeShortcutOptions({ side: 'sell', price: NaN, availableCash: 0, availableShares });

test('buy presets keep the requested three sizes and disable orders above actual cash at the limit price', () => {
  const options = buy(10.30, 103_000);
  assert.deepEqual(options.map(option => option.quantity), [1_000, 10_000, 100_000]);
  assert.deepEqual(options.map(option => !!option.disabledReason), [false, false, true]);
  assert.match(options[2].disabledReason!, /可用现金不足/);
});

test('cent-accurate affordability permits exact cash and rejects a one-cent shortfall', () => {
  assert.equal(buy(1.01, 1_010)[0].disabledReason, undefined);
  assert.match(buy(1.01, 1_009.99)[0].disabledReason!, /可用现金不足/);
  for (const price of [0, -1, NaN, Infinity, 10.001]) {
    assert.ok(buy(price, 10_000_000).every(option => option.disabledReason));
  }
  assert.ok(buy(10, NaN).every(option => option.disabledReason));
});

test('sell fractions use only supplied available shares and round each amount down to a board lot', () => {
  const options = sell(10_350);
  assert.deepEqual(options.map(option => option.label), ['1/4', '1/2', '全部']);
  assert.deepEqual(options.map(option => option.quantity), [2_500, 5_100, 10_300]);
  assert.ok(options.every(option => !option.disabledReason));
  assert.deepEqual(sell(300).map(option => [option.quantity, !!option.disabledReason]), [[0, true], [100, false], [300, false]]);
});

test('empty or invalid available-share balances never expose a zero-quantity clickable preset', () => {
  for (const available of [0, 99, -100, NaN, Infinity, 100.5]) {
    assert.ok(sell(available).every(option => option.quantity === 0 && !!option.disabledReason));
  }
  assert.equal(sell(100)[2].quantity, 100);
  assert.equal(sell(100)[2].disabledReason, undefined);
});
