import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TradeView } from '../shared/types.js';
import { createMarket, getView } from './engine.js';

// The component imports its browser stylesheet; render its actual markup in Node.
const stylesheet = new URL('../src/price-chart.css', import.meta.url).href;
const cssLoader = registerHooks({ load(url, context, nextLoad) {
  return url === stylesheet ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
} });
const { default: PriceChart, groupPlayerTrades } = await import('../src/PriceChart.js');
cssLoader.deregister();

function trade(overrides: Partial<TradeView> = {}): TradeView {
  return { id: 't1', stockId: 's1', day: 2, time: '09:30', price: 10, quantity: 100, side: 'buy', ...overrides };
}

test('recent fill groups preserve actual day, direction, quantity and weighted execution price', () => {
  const groups = groupPlayerTrades([
    trade(), trade({ id: 't2', time: '10:30', price: 12, quantity: 300 }),
    trade({ id: 't3', side: 'sell', price: 13, quantity: 200 }),
    trade({ id: 't4', day: 1, price: 9 }),
    trade({ id: 'legacy', day: undefined }), trade({ id: 'other-stock', stockId: 's2' }),
    trade({ id: 'market', side: 'market' }),
  ], 's1', 'daily');
  assert.equal(groups.length, 3);
  const buy = groups.find(group => group.day === 2 && group.side === 'buy')!;
  assert.equal(buy.quantity, 400);
  assert.equal(buy.fills, 2);
  assert.equal(buy.valueCents / buy.quantity / 100, 11.5);
  assert.equal(groups.find(group => group.day === 2 && group.side === 'sell')!.quantity, 200);
  assert.equal(groups.find(group => group.day === 1)!.quantity, 100);
});

test('intraday markers cannot mix other sessions or invent missing timestamps', () => {
  const trades = [trade(), trade({ id: 'same-minute', price: 11 }), trade({ id: 'next-minute', time: '09:31' }),
    trade({ id: 'yesterday', day: 1 }), trade({ id: 'legacy', day: undefined }),
    trade({ id: 'invalid-minute', time: '09:60' }), trade({ id: 'recess', time: '12:00' }),
    trade({ id: 'reference', time: '昨收' })];
  assert.deepEqual(groupPlayerTrades(trades, 's1', 'intraday'), []);
  const groups = groupPlayerTrades(trades, 's1', 'intraday', 2);
  assert.equal(groups.length, 2);
  assert.equal(groups.find(group => group.time === '09:30')!.quantity, 200);
  assert.equal(groups.find(group => group.time === '09:30')!.valueCents / 200 / 100, 10.5);
});

test('credit and leveraged executions map to the actual buying or selling direction', () => {
  const groups = groupPlayerTrades([
    trade({ side: 'finance' }), trade({ side: 'cover' }), trade({ side: 'marginBuy' }), trade({ side: 'marginCover' }),
    trade({ side: 'short' }), trade({ side: 'creditSell' }), trade({ side: 'marginShort' }), trade({ side: 'marginSell' }),
  ], 's1', 'daily');
  assert.equal(groups.length, 2);
  assert.equal(groups.find(group => group.side === 'buy')!.quantity, 400);
  assert.equal(groups.find(group => group.side === 'sell')!.quantity, 400);
});

test('default daily chart only marks recorded visible sessions and identifies recent fills', () => {
  const stock = getView(createMarket(42)).stocks[0];
  stock.dailyBars = [{ day: 2, date: '2026-10-21', open: 10, high: 12, low: 9, close: 11, volume: 1000, turnover: 11000, complete: true }];
  const html = renderToStaticMarkup(createElement(PriceChart, { stock, time: '15:00', phase: 'night', paused: true, day: 2,
    trades: [trade(), trade({ id: 't2', price: 12, quantity: 300 }), trade({ id: 'no-visible-bar', day: 1 }), trade({ id: 'legacy', day: undefined })] }));
  assert.match(html, /aria-pressed="true">日 K/);
  assert.equal((html.match(/class="chart-player-trade chart-player-trade--buy"/g) ?? []).length, 1);
  assert.match(html, /data-trade-day="2"/);
  assert.match(html, /data-trade-quantity="400"/);
  assert.match(html, /成交均价 11\.5000 元/);
  assert.match(html, /你的近期成交/);
  assert.match(html, /按日合并 · 仅含近期记录/);
  assert.doesNotMatch(html, /data-trade-day="1"|全天占比/);
});
