import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intradayMinute, intradayTimeline } from '../shared/chart-math';
import type { PricePoint } from '../shared/types';
import { advancePhase, createMarket, getView, nextDay, tick } from './engine';

test('the selected stock timeline advances with the real engine clock during a gap between fills', () => {
  const market = createMarket(20261020);
  advancePhase(market);
  market.paused = false;
  for (let i = 0; i < 87; i++) tick(market);
  const before = getView(market);
  const firstStock = before.stocks.find(stock => stock.id === 's11')!;
  const firstTimeline = intradayTimeline(firstStock.history, before.time, before.phase);
  assert.ok(firstStock.volume > 0, 'the quiet interval follows genuine executions');
  // Remove available supply for this controlled interval. Ordinary trading is
  // now continuous, so do not depend on a particular seed accidentally going quiet.
  market.orders = market.orders.filter(order => order.stockId !== firstStock.id);
  for (const actor of market.actors) {
    const held = actor.positions[firstStock.id];
    if (held) held.today = held.quantity;
  }
  for (let i = 0; i < 40; i++) tick(market);
  const after = getView(market);
  const lastStock = after.stocks.find(stock => stock.id === 's11')!;
  const lastTimeline = intradayTimeline(lastStock.history, after.time, after.phase);

  assert.equal(before.time, '10:28');
  assert.equal(after.time, '10:54');
  assert.equal(lastStock.price, firstStock.price);
  assert.equal(lastStock.volume, firstStock.volume);
  assert.deepEqual(lastStock.history, firstStock.history);
  assert.deepEqual(lastStock.dailyBars, firstStock.dailyBars);
  assert.ok(lastTimeline.points.length > firstTimeline.points.length, 'the visible timeline must continue to the market clock even without a new fill');
  assert.equal(lastTimeline.points.at(-1)?.time, after.time);
  assert.equal(lastTimeline.points.at(-1)?.price, lastStock.price);
  assert.equal(lastTimeline.points.at(-1)?.volume, 0);
  assert.equal(lastTimeline.points.at(-1)?.executed, false);
  assert.deepEqual(lastTimeline.trades, firstTimeline.trades);
  assert.equal(lastTimeline.lastTradeTime, firstTimeline.lastTradeTime);
});

test('fixed session coordinates compress the recess and stop at the close', () => {
  assert.deepEqual(['09:15', '09:25', '09:30', '11:30', '12:10', '13:00', '15:00', '18:00'].map(intradayMinute), [0, 0, 5, 125, 125, 125, 245, 245]);
  assert.equal(intradayMinute('昨收'), 0);
  assert.equal(intradayMinute('09:99'), 0);
});

test('quiet minutes carry price with zero volume and preserve all executed shares', () => {
  const history: PricePoint[] = [
    { time: '昨收', price: 10, volume: 0 },
    { time: '09:25', price: 10.01, volume: 200 },
    { time: '09:30', price: 10.03, volume: 100 },
    { time: '09:30', price: 10.05, volume: 500 },
    { time: '09:31', price: 99, volume: 0 },
  ];
  const before = structuredClone(history);
  const timeline = intradayTimeline(history, '09:33', 'morning');
  assert.equal(timeline.points.length, 9);
  assert.deepEqual(timeline.trades, [
    { time: '09:25', price: 10.01, volume: 200 },
    { time: '09:30', price: 10.05, volume: 600 },
  ]);
  assert.equal(timeline.points.filter(point => point.executed).length, 2);
  assert.equal(timeline.points.reduce((sum, point) => sum + point.volume, 0), 800);
  assert.deepEqual(timeline.points.at(-1), { time: '09:33', price: 10.05, volume: 0, executed: false });
  assert.equal(timeline.lastTradeTime, '09:30');
  assert.deepEqual(history, before);
});

test('auction before the first fill stays empty and cannot reveal a later trade', () => {
  const history: PricePoint[] = [
    { time: '昨收', price: 10, volume: 0 },
    { time: '09:25', price: 11, volume: 100 },
  ];
  assert.deepEqual(intradayTimeline(history, '09:24', 'auction'), { points: [], trades: [], lastTradeTime: null, cursor: 0 });
  const market = createMarket(20261020);
  market.paused = false;
  tick(market);
  const view = getView(market);
  assert.ok(view.stocks.every(stock => intradayTimeline(stock.history, view.time, view.phase).points.length === 0));
});

test('the engine lunch clock does not extend the displayed trading session', () => {
  const market = createMarket(20261020);
  advancePhase(market);
  advancePhase(market);
  const before = getView(market);
  market.paused = false;
  for (let i = 0; i < 15; i++) tick(market);
  const after = getView(market);
  assert.equal(before.phase, 'lunch');
  assert.equal(after.phase, 'lunch');
  assert.notEqual(before.time, after.time);
  const firstStock = before.stocks[0];
  const lastStock = after.stocks[0];
  const firstTimeline = intradayTimeline(firstStock.history, before.time, before.phase);
  const lastTimeline = intradayTimeline(lastStock.history, after.time, after.phase);
  assert.deepEqual(lastTimeline, firstTimeline);
  assert.equal(lastTimeline.points.at(-1)?.time, '11:30');
  assert.equal(lastTimeline.cursor, 125);
});

test('afternoon skips recess minutes and never reveals the afternoon at the morning boundary', () => {
  const history: PricePoint[] = [
    { time: '11:29', price: 10, volume: 100 },
    { time: '13:00', price: 11, volume: 200 },
  ];
  const lunch = intradayTimeline(history, '12:30', 'lunch');
  assert.equal(lunch.lastTradeTime, '11:29');
  assert.deepEqual(lunch.points.map(point => point.time), ['11:29', '11:30']);
  const afternoon = intradayTimeline(history, '13:02', 'afternoon');
  assert.deepEqual(afternoon.points.map(point => point.time), ['11:29', '11:30', '13:00', '13:01', '13:02']);
  assert.equal(afternoon.points.reduce((sum, point) => sum + point.volume, 0), 300);
  assert.equal(afternoon.points.at(-1)?.price, 11);
});

test('the first late fill starts the line without making earlier prices or volume', () => {
  const history = [{ time: '昨收', price: 10, volume: 0 }, { time: '10:45', price: 10.5, volume: 100 }];
  const timeline = intradayTimeline(history, '10:47', 'morning');
  assert.deepEqual(timeline.points.map(point => point.time), ['10:45', '10:46', '10:47']);
  assert.equal(timeline.points[0].executed, true);
  assert.equal(timeline.points[1].executed, false);
});

test('same-price fills update real volume without requiring a price change', () => {
  const first = [{ time: '10:00', price: 10, volume: 100 }];
  const before = intradayTimeline(first, '10:01', 'morning');
  const after = intradayTimeline([...first, { time: '10:01', price: 10, volume: 300 }], '10:01', 'morning');
  assert.equal(after.points.at(-1)?.price, before.points.at(-1)?.price);
  assert.equal(before.points.at(-1)?.volume, 0);
  assert.equal(after.points.at(-1)?.volume, 300);
  assert.equal(after.points.at(-1)?.executed, true);
  assert.equal(after.lastTradeTime, '10:01');
});

test('night and ended charts stop at 15:00 and a new engine day begins empty', () => {
  const market = createMarket(20261020);
  for (let i = 0; i < 5; i++) advancePhase(market);
  const closed = getView(market);
  assert.equal(closed.phase, 'night');
  const timeline = intradayTimeline(closed.stocks[0].history, closed.time, closed.phase);
  assert.equal(timeline.cursor, 245);
  assert.equal(timeline.points.at(-1)?.time, '15:00');
  assert.deepEqual(intradayTimeline(closed.stocks[0].history, '21:00', 'ended'), timeline);
  nextDay(market);
  const next = getView(market);
  assert.equal(next.day, closed.day + 1);
  assert.equal(next.phase, 'auction');
  assert.ok(next.stocks.every(stock => intradayTimeline(stock.history, next.time, next.phase).points.length === 0));
});

test('out-of-order recorded minutes are chronological without admitting future or invalid records', () => {
  const history = [
    { time: '10:05', price: 13, volume: 300 },
    { time: '10:01', price: 11, volume: 100 },
    { time: '10:03', price: 12, volume: 200 },
    { time: '09:99', price: 100, volume: 500 },
    { time: '09:20', price: 100, volume: 500 },
  ];
  const timeline = intradayTimeline(history, '10:04', 'morning');
  assert.deepEqual(timeline.points.map(point => point.time), ['10:01', '10:02', '10:03', '10:04']);
  assert.equal(timeline.lastTradeTime, '10:03');
  assert.equal(timeline.points.reduce((sum, point) => sum + point.volume, 0), 300);
  assert.equal(timeline.points.at(-1)?.price, 12);
});
