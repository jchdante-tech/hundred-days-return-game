import test from 'node:test';
import assert from 'node:assert/strict';
import type { DailyBar, OrderSide } from '../shared/types.js';
import { createMarket, type Market } from './engine.js';
import { buildLimitBoard } from './limit-board.js';

function fixture(day = 1) {
  const market = createMarket(61);
  market.day = day; market.phase = 'morning'; market.orders = []; market.trades = [];
  const stock = market.stocks[0];
  Object.assign(stock, { price: 1000, previousClose: 1000, open: 0, high: 0, low: 0,
    volume: 0, turnover: 0, history: [], dailyBars: [] });
  return { market, stock };
}

function tape(market: Market, prices: number[], day = market.day) {
  const stock = market.stocks[0];
  market.trades = prices.map((price, index) => ({
    id: `trade${index}`, stockId: stock.id, price, quantity: 100, time: '10:10', day,
    buyerId: 'ai0', sellerId: 'ai1', buyerName: '买方', sellerName: '卖方',
  }));
  if (day === market.day && prices.length) Object.assign(stock, {
    price: prices.at(-1)!, open: prices[0], high: Math.max(...prices), low: Math.min(...prices),
    volume: prices.length * 100, turnover: prices.reduce((sum, price) => sum + price * 100, 0),
  });
}

function order(market: Market, side: OrderSide, quantity = 1000, actorId = 'ai0', price = 1100) {
  const result: Market['orders'][number] = {
    id: `order${market.orders.length}`, stockId: 's1', actorId, side, price, quantity, remaining: quantity,
    status: 'open', time: '10:10', sequence: market.orders.length + 1, createdTick: 10,
    frozenCash: quantity * price, restrictedClaim: 0,
  };
  market.orders.push(result);
  return result;
}

function bar(day: number, close: number, overrides: Partial<DailyBar> = {}): DailyBar {
  return { day, date: `2026-10-${String(20 + day).padStart(2, '0')}`, open: close,
    high: close, low: close, close, volume: 100, turnover: close * 100,
    complete: true, origin: day > 0 ? 'session' : 'background', ...overrides };
}

test('a limit-price order without any fill does not invent a touched or sealed limit', () => {
  const { market, stock } = fixture();
  order(market, 'buy');
  const board = buildLimitBoard(market, stock);
  assert.equal(board.touched, false);
  assert.equal(board.status, 'none');
  assert.equal(board.candidateStreak, 0);
  assert.equal(board.queuedBuyQuantity, 1000);
  assert.equal(board.queuedBuyAmount, 11000);
  assert.equal(board.breakCount, 0);
});

test('an actual limit fill needs a real unmatched buy queue in continuous trading to be sealed', () => {
  const { market, stock } = fixture();
  tape(market, [1000, 1100]);
  assert.equal(buildLimitBoard(market, stock).status, 'touched');
  const queued = order(market, 'buy', 1500);
  assert.equal(buildLimitBoard(market, stock).status, 'sealed');
  assert.equal(buildLimitBoard(market, stock).candidateStreak, 1);
  assert.equal(buildLimitBoard(market, stock).upStreak, 0);
  const offer = order(market, 'sell', 100, 'ai1', 1100);
  assert.equal(buildLimitBoard(market, stock).status, 'touched');
  offer.status = 'cancelled';
  assert.equal(buildLimitBoard(market, stock).status, 'sealed');
  for (const phase of ['auction', 'lunch', 'closing'] as const) {
    market.phase = phase;
    assert.equal(buildLimitBoard(market, stock).status, 'touched');
  }
  market.phase = 'morning'; queued.status = 'cancelled';
  assert.equal(buildLimitBoard(market, stock).status, 'touched');
  assert.equal(buildLimitBoard(market, stock).breakCount, 0, 'a cancelled queue is not an executed opening');
});

test('each actual limit-to-lower fill transition counts, even within the same minute', () => {
  const { market, stock } = fixture();
  tape(market, [1000, 1100, 1100, 1098, 1099, 1100, 1095]);
  const board = buildLimitBoard(market, stock);
  assert.equal(board.status, 'opened');
  assert.equal(board.breakCount, 2);
  assert.equal(board.candidateStreak, 0);
  assert.equal(board.touched, true);
});

test('a re-sealed limit keeps the previous actual opening count', () => {
  const { market, stock } = fixture();
  tape(market, [1100, 1099, 1100]);
  order(market, 'buy');
  const board = buildLimitBoard(market, stock);
  assert.equal(board.status, 'sealed');
  assert.equal(board.breakCount, 1);
});

test('completed session closes form a streak, while an intraday follow-up is only a candidate', () => {
  const { market, stock } = fixture(2);
  stock.previousClose = 1100;
  stock.dailyBars = [bar(0, 1000), bar(1, 1100)];
  tape(market, [1210]); order(market, 'buy', 500, 'ai0', 1210);
  let board = buildLimitBoard(market, stock);
  assert.equal(board.upStreak, 1);
  assert.equal(board.candidateStreak, 2);
  assert.equal(board.status, 'sealed');
  market.phase = 'night'; stock.dailyBars.push(bar(2, 1210));
  board = buildLimitBoard(market, stock);
  assert.equal(board.upStreak, 2);
  assert.equal(board.candidateStreak, 0);
  assert.equal(board.status, 'closed-limit');
  assert.equal(board.queuedBuyQuantity, 0, 'closed phases never display stale pending orders as a seal');
  assert.equal(board.queuedBuyAmount, 0);
});

test('background rises never count as the player session streak', () => {
  const { market, stock } = fixture();
  stock.dailyBars = [bar(-2, 826), bar(-1, 909), bar(0, 1000)];
  tape(market, [1100]);
  assert.equal(buildLimitBoard(market, stock).upStreak, 0);
  assert.equal(buildLimitBoard(market, stock).candidateStreak, 1);
  market.phase = 'night'; stock.dailyBars.push(bar(1, 1100));
  assert.equal(buildLimitBoard(market, stock).upStreak, 1);
});

test('an IPO starts its streak from the real first-day 30 percent limit and then uses 10 percent', () => {
  const { market, stock } = fixture(5);
  stock.listedDay = 5; stock.issuePrice = 1000;
  tape(market, [1100]);
  assert.equal(buildLimitBoard(market, stock).touched, false, 'a 10 percent listing gain is not a limit board');
  tape(market, [1300]); order(market, 'buy', 500, 'ai0', 1300);
  assert.equal(buildLimitBoard(market, stock).status, 'sealed');
  assert.equal(buildLimitBoard(market, stock).candidateStreak, 1);
  market.phase = 'night'; stock.dailyBars = [bar(5, 1300)];
  assert.equal(buildLimitBoard(market, stock).upStreak, 1);
  market.day = 6; market.phase = 'morning'; stock.previousClose = 1300;
  tape(market, [1430]);
  assert.equal(buildLimitBoard(market, stock).candidateStreak, 2);
  market.phase = 'night'; stock.dailyBars.push(bar(6, 1430));
  assert.equal(buildLimitBoard(market, stock).upStreak, 2);
});

test('a missing trading-day candle or unfinished candle breaks a recorded streak', () => {
  const { market, stock } = fixture(4);
  stock.previousClose = 1210;
  stock.dailyBars = [bar(0, 1000), bar(1, 1100), bar(3, 1210)];
  tape(market, [1331]);
  assert.equal(buildLimitBoard(market, stock).upStreak, 0, 'day 3 cannot be inferred as a limit close without day 2');
  stock.dailyBars.push(bar(4, 1331)); market.phase = 'night';
  assert.equal(buildLimitBoard(market, stock).upStreak, 1, 'today can be verified from its known previous close');
  stock.dailyBars = [bar(0, 1000), bar(1, 1100), bar(2, 1210, { complete: false }), bar(3, 1331)];
  market.phase = 'morning';
  assert.equal(buildLimitBoard(market, stock).upStreak, 0);
});

test('a non-limit close ends the run, including when the day touched the limit', () => {
  const { market, stock } = fixture(2);
  stock.previousClose = 1100;
  stock.dailyBars = [bar(0, 1000), bar(1, 1100)];
  tape(market, [1210, 1200]);
  stock.dailyBars.push(bar(2, 1200, { high: 1210, volume: 200, turnover: 241000 }));
  market.phase = 'night';
  const board = buildLimitBoard(market, stock);
  assert.equal(board.status, 'opened');
  assert.equal(board.upStreak, 0);
  assert.equal(board.breakCount, 1);
});

test('legacy partial tapes show unknown opening counts but can use an actual completed candle', () => {
  const { market, stock } = fixture();
  stock.dailyBars = [bar(0, 1000), bar(1, 1100, { high: 1100, low: 1000, volume: 500, turnover: 525000 })];
  Object.assign(stock, { price: 1100, volume: 500 });
  market.phase = 'night';
  const board = buildLimitBoard(market, stock);
  assert.equal(board.status, 'closed-limit');
  assert.equal(board.touched, true);
  assert.equal(board.breakCount, null);
  assert.equal(board.upStreak, 1);
  stock.dailyBars = [];
  stock.price = 1000;
  stock.high = 1100;
  assert.equal(buildLimitBoard(market, stock).touched, false, 'a quote/extreme without actual trade or daily-bar evidence is insufficient');
});

test('queue counts only finite remaining real orders at the limit price', () => {
  const { market, stock } = fixture();
  tape(market, [1100]);
  order(market, 'buy', 1000).remaining = 300;
  order(market, 'finance', 200).status = 'partial';
  order(market, 'cover', 100);
  order(market, 'buy', 300).status = 'filled';
  order(market, 'buy', 400).status = 'cancelled';
  order(market, 'buy', 500, 'ai1', 1099);
  order(market, 'buy', 600, 'missing-actor');
  order(market, 'buy', 700).remaining = Infinity;
  order(market, 'buy', 800).remaining = 900;
  const before = JSON.stringify(market);
  const board = buildLimitBoard(market, stock);
  assert.equal(board.queuedBuyQuantity, 600);
  assert.equal(board.queuedBuyAmount, 6600);
  assert.equal(JSON.stringify(market), before, 'the observer cannot change RNG, quotes, cash, or orders');
});

test('previous-day player trade retention cannot masquerade as a new-day touch', () => {
  const { market, stock } = fixture(2);
  tape(market, [1100], 1);
  order(market, 'buy');
  assert.equal(buildLimitBoard(market, stock).touched, false);
  assert.equal(buildLimitBoard(market, stock).status, 'none');
});
