import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import type { OrderView } from '../shared/types.js';
import { advancePhase, cancelOrder, createMarket, getView, nextDay, submitOrder, validateMarket } from './engine.js';
import { EmptyPositionNote, OrderImpact, OrderPriceGuide, RecentStockOrders } from '../src/OrderFeedback.js';
import PositionSlip from '../src/PositionSlip.js';

const stock = getView(createMarket(42)).stocks.find(s => s.id === 's4')!;
function order(overrides: Partial<OrderView> = {}): OrderView {
  return { id: 'o1', stockId: stock.id, side: 'buy', quantity: 1000, remaining: 1000, filled: 0,
    price: 35, status: 'open', time: '09:46', day: 1, frozenCash: 35000, frozenQuantity: 0, ...overrides };
}
const renderOrders = (orders: OrderView[]) => renderToStaticMarkup(createElement(RecentStockOrders, {
  orders, disabled: false, onCancel: () => {}, onAll: () => {},
}));

test('unfilled first-day buy stays visible after close as a cancelled order, never a holding', () => {
  const cancelled = order({ status: 'cancelled', cancelReason: 'day-expired', frozenCash: 0 });
  const html = renderOrders([cancelled]);
  assert.match(html, /第 1 日 ·/);
  assert.match(html, /35.00 元/);
  assert.match(html, /已成交 0 股 · 已撤销 1,000 股/);
  assert.match(html, /当日委托收盘到期，未成交部分已撤销/);
  assert.doesNotMatch(html, /待成交 1,000|冻结 ¥/);
  const position = renderToStaticMarkup(createElement(PositionSlip, { stock, orders: [cancelled], onOpen: () => {}, onCredit: () => {} }));
  assert.match(position, /已在收盘时到期撤销/);
  assert.match(position, /资金已解冻，没有形成持仓/);
  assert.doesNotMatch(position, /<dd>1,000<\/dd>/);
});

test('pending and partial receipts separate acquired shares from frozen or cancelled remainder', () => {
  const pending = order();
  assert.match(renderOrders([pending]), /已成交 0 股 · 待成交 1,000 股/);
  assert.match(renderOrders([pending]), /冻结 ¥ 35,000.00 · 尚未支出/);
  assert.match(renderToStaticMarkup(createElement(EmptyPositionNote, { orders: [pending] })), /冻结资金仍在账户内，成交后才计入持仓/);
  const partial = order({ status: 'partial', quantity: 1000, filled: 300, remaining: 700, frozenCash: 24500 });
  assert.match(renderOrders([partial]), /已成交 300 股 · 待成交 700 股/);
  assert.match(renderOrders([{ ...partial, status: 'cancelled', cancelReason: 'day-expired', frozenCash: 0 }]), /已成交 300 股 · 已撤销 700 股/);
  assert.match(renderOrders([order({ status: 'filled', filled: 1000, remaining: 0, frozenCash: 0 })]), /全部成交/);
});

test('legacy cancelled orders do not acquire an invented submission day or expiry reason', () => {
  const legacy = order({ status: 'cancelled', day: undefined, cancelReason: undefined, frozenCash: 0 });
  const html = renderOrders([legacy]);
  assert.match(html, /未成交部分已撤销/);
  assert.doesNotMatch(html, /第 1 日|收盘到期/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(EmptyPositionNote, { orders: [legacy] })), /收盘/);
});

test('price guide shows current opposing quote and explains why a stale limit is waiting', () => {
  const quoted = { ...stock, asks: [{ price: 35.48, quantity: 2100 }], bids: [{ price: 35.46, quantity: 1000 }] };
  const buy = renderToStaticMarkup(createElement(OrderPriceGuide, { stock: quoted, side: 'buy', price: 35, phase: 'morning', onPrice: () => {} }));
  assert.match(buy, /35.48 元/);
  assert.match(buy, /按卖一填价/);
  assert.match(buy, /买价低于卖一，当前需等待对手盘/);
  const sell = renderToStaticMarkup(createElement(OrderPriceGuide, { stock: quoted, side: 'sell', price: 36, phase: 'morning', onPrice: () => {} }));
  assert.match(sell, /按买一填价/);
  assert.match(sell, /卖价高于买一/);
  const auction = renderToStaticMarkup(createElement(OrderPriceGuide, { stock: quoted, side: 'buy', price: 35, phase: 'auction', onPrice: () => {} }));
  assert.match(auction, /等待集中撮合，挂单不代表成交/);
  const empty = renderToStaticMarkup(createElement(OrderPriceGuide, { stock: { ...quoted, asks: [] }, side: 'buy', price: 35, phase: 'morning', onPrice: () => {} }));
  assert.match(empty, /暂无报价/);
  assert.match(empty, /disabled=""/);
});

test('impact receipts distinguish submission fills from later cumulative fills and legacy absence', () => {
  const result = renderToStaticMarkup(createElement(OrderImpact, { order: order({ filled: 1000, remaining: 0,
    execution: { filled: 600, amount: 21006, averagePrice: 35.01, priceLevels: 2, beforePrice: 35, afterPrice: 35.02 } }) }));
  assert.match(result, /提交瞬间/); assert.match(result, /600/); assert.doesNotMatch(result, /1,000/);
  assert.match(result, /35.00 → 35.02/); assert.match(result, /其他席位/);
  const empty = renderToStaticMarkup(createElement(OrderImpact, { order: order({ filled:1000,
    execution: { filled:0, amount:0, averagePrice:null, priceLevels:0 } }) }));
  assert.match(empty, /后续成交进度见上方/); assert.doesNotMatch(empty, /→/);
  assert.equal(renderToStaticMarkup(createElement(OrderImpact, {order:order()})), '');
});

function partialSale() {
  const market = createMarket(42, { openingScenario: true });
  market.paused = false;
  assert.equal(submitOrder(market, { stockId: 's1', side: 'buy', quantity: 500_000, price: 10.3 }).ok, true);
  nextDay(market); advancePhase(market);
  // A finite, funded buyer reproduces the reported liquidity boundary. The
  // ordinary matcher and cancellation path perform every player mutation.
  market.orders = market.orders.filter(value => value.stockId !== 's1' || value.actorId === 'player');
  assert.ok(market.actors.find(actor => actor.id === 'crowd0')!.cash > 24_500 * 1060);
  market.orders.push({ id: 'test-finite-bid', actorId: 'crowd0', stockId: 's1', side: 'buy',
    quantity: 24_500, remaining: 24_500, price: 1060, status: 'open', time: '09:30', day: 2,
    sequence: ++market.sequence, createdTick: market.tickCount, frozenCash: 24_500 * 1060, restrictedClaim: 0 });
  market.paused = false;
  const before = getView(market);
  assert.equal(submitOrder(market, { stockId: 's1', side: 'sell', quantity: 500_000, price: 10.6 }).ok, true);
  assert.ok(validateMarket(market));
  const view = getView(market), sale = view.orders.find(value => value.side === 'sell')!;
  return { market, view, sale, cashBefore: before.cash };
}

test('a real 24,500-of-500,000 sale shows the unsold holding, order freeze and explicit cancellation entry', () => {
  const { view, sale, cashBefore } = partialSale();
  const position = view.positions.find(value => value.stockId === 's1')!;
  assert.equal(sale.filled, 24_500);
  assert.equal(sale.remaining, 475_500);
  assert.equal(sale.frozenQuantity, 475_500);
  assert.equal(position.quantity, 475_500);
  assert.equal(position.available, 0);
  assert.equal(position.frozen, 475_500);
  assert.equal(position.todayBought, 0);
  assert.equal(view.cash, cashBefore + 24_500 * 10.6);
  const html = renderOrders([sale]);
  assert.match(html, /已卖出 24,500 \/ 500,000 股/);
  assert.match(html, /475,500 股还未卖出/);
  assert.match(html, /仅部分成交/);
  assert.match(html, /剩余 475,500 股仍在持仓中，等待买盘成交/);
  assert.match(html, /撤销剩余 475,500 股/);
  assert.match(html, /委托冻结 475,500 股/);
  assert.doesNotMatch(html, /全部成交|已卖出 500,000/);
  const holding = renderToStaticMarkup(createElement(PositionSlip, {
    stock: view.stocks.find(value => value.id === 's1')!, position, orders: [sale], onOpen() {}, onCredit() {},
  })).replace(/<[^>]*>/g, '');
  assert.match(holding, /总持仓 股475,500/);
  assert.match(holding, /普通可卖 股0/);
  assert.match(holding, /委托冻结 股475,500/);
  assert.match(holding, /今日锁定 股0/);
  assert.match(holding, /仅部分成交 · 475,500 股还未卖出，仍计入持仓/);
  assert.match(holding, /查看挂单 \/ 撤单/);
});

test('cancelling the real remaining sale unfreezes shares without pretending to sell them or add proceeds', () => {
  const { market, view: before, sale } = partialSale();
  assert.equal(cancelOrder(market, sale.id).ok, true);
  const view = getView(market), cancelled = view.orders.find(value => value.id === sale.id)!;
  const position = view.positions.find(value => value.stockId === 's1')!;
  assert.equal(view.cash, before.cash);
  assert.equal(position.quantity, 475_500);
  assert.equal(position.available, 475_500);
  assert.equal(position.frozen, 0);
  const html = renderOrders([cancelled]);
  assert.match(html, /已卖出 24,500 \/ 500,000 股 · 已撤销 475,500 股/);
  assert.match(html, /撤单只解除冻结，不会卖出股票/);
  assert.doesNotMatch(html, /等待买盘成交|撤销剩余|委托冻结 475,500/);
  const holding = renderToStaticMarkup(createElement(PositionSlip, {
    stock: view.stocks.find(value => value.id === 's1')!, position, orders: [cancelled], onOpen() {}, onCredit() {},
  })).replace(/<[^>]*>/g, '');
  assert.match(holding, /总持仓 股475,500/);
  assert.match(holding, /普通可卖 股475,500/);
  assert.match(holding, /委托冻结 股0/);
  assert.doesNotMatch(holding, /仅部分成交|查看挂单 \/ 撤单/);
});

test('the receipt prioritizes a still-active sale over newer closed orders and keeps cancellation disabled during writes', () => {
  const pending = order({ id: 'older-sale', side: 'sell', status: 'partial', quantity: 500_000,
    filled: 24_500, remaining: 475_500, frozenCash: 0, frozenQuantity: 475_500 });
  const recent = [1, 2, 3].map(index => order({ id: `newer-${index}`, status: 'filled', filled: 1000, remaining: 0, frozenCash: 0 }));
  const html = renderOrders([...recent, pending]);
  assert.ok(html.indexOf('仅部分成交') < html.indexOf('全部成交'));
  assert.match(html, /撤销剩余 475,500 股/);
  const disabled = renderToStaticMarkup(createElement(RecentStockOrders, {
    orders: [pending], disabled: true, onCancel() {}, onAll() {},
  }));
  assert.match(disabled, /class="order-cancel-action" disabled=""/);
  assert.equal(recent[0].id, 'newer-1', 'display ordering must not mutate the server snapshot');
});
