import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MarketView, OrderView, Phase } from '../shared/types.js';
import { createMarket, getView } from './engine.js';
import { openingSellTicket, resolveOpeningStep, type OpeningGuideContext, type OpeningStep } from '../src/opening-guide.js';
import type { OpeningTutorialProps } from '../src/OpeningTutorial.js';

const cssLoader = registerHooks({ load(url, context, nextLoad) {
  return new URL(url).pathname.endsWith('.css')
    ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
} });
const { default: OpeningTutorial, openingLesson } = await import('../src/OpeningTutorial.js');
cssLoader.deregister();

const initial = getView(createMarket(42, { openingScenario: true }));
const targetId = initial.openingScenario!.stockId;
const allSteps: OpeningStep[] = ['stock', 'price', 'quantity', 'buy-start', 'buy-submit', 'impact', 'follow',
  'locked', 'overnight', 'unlocked', 'auction', 'sell-side', 'sell-ticket', 'sell-start', 'sell-submit',
  'done', 'orders', 'empty', 'wait-book'];

function context(options: {
  day?: number; phase?: Phase; paused?: boolean; stage?: NonNullable<MarketView['openingScenario']>['stage'];
  bought?: number; held?: number; available?: number; today?: number; sold?: number; saleProceeds?: number;
  side?: 'buy' | 'sell'; price?: number; quantity?: number;
} = {}): OpeningGuideContext {
  const { day = 1, phase = 'morning', paused = true, stage = 'ready', bought = 0, held = bought,
    available = day === 1 ? 0 : held, today = day === 1 ? held : 0, sold = 0, saleProceeds = 0,
    side = 'buy', price = 10.3, quantity = 500_000 } = options;
  const market = structuredClone(initial);
  Object.assign(market, { day, phase, paused });
  Object.assign(market.openingScenario!, { stage, boughtQuantity: bought, soldQuantity: sold, saleProceeds });
  market.positions = held ? [{ stockId: targetId, quantity: held, available, frozen: 0, todayBought: today,
    financedQuantity: 0, averageCost: 10.18, marketValue: held * 10.8, profit: held * .62,
    shortQuantity: 0, shortToday: 0, shortProceeds: 0 }] : [];
  const stock = market.stocks.find(value => value.id === targetId)!;
  if (day >= 2) Object.assign(stock, { price: 10.6, previousClose: 10.8, limitDown: 9.72, limitUp: 11.88,
    bids: [{ price: 10.6, quantity: 300 }, { price: 10.58, quantity: 400 }] });
  return { market, side, price, quantity };
}

const props = (value: OpeningGuideContext): OpeningTutorialProps => ({ ...value, pending: false, onClose() {} });
const stockOf = (value: OpeningGuideContext) => value.market.stocks.find(stock => stock.id === targetId)!;
function order(status: OrderView['status'] = 'open', stockId = targetId): OrderView {
  return { id: 'test-pending', stockId, side: 'buy', quantity: 500_000, remaining: 100, filled: 499_900,
    price: 10.3, status, time: '09:31', day: 1, frozenCash: 1030, frozenQuantity: 0 };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('day-one follow-through teaches locked holdings and overnight progression, never a same-day exit', () => {
  const value = context({ bought: 500_000, stage: 'exit' });
  for (const requested of allSteps) {
    const step = resolveOpeningStep(value, requested);
    assert.ok(step === 'locked' || step === 'overnight', `${requested} incorrectly resolved to ${step}`);
  }
  const locked = openingLesson(props(value), 'locked');
  assert.equal(locked.target, 'position');
  assert.equal(locked.next, 'overnight');
  assert.match(locked.body, /可卖 0 股/);
  assert.match(locked.body, /T\+1/);
  assert.match(locked.body, /浮盈/);
  assert.doesNotMatch(locked.body, /底仓|今天可以卖/);
  const overnight = openingLesson(props(value), 'overnight');
  assert.equal(overnight.target, 'clock-next');
  assert.match(overnight.body, /现金和持仓照常保留/);
  assert.match(overnight.body, /下一交易日/);
});

test('the first fill and later NPC follow-through remain separate steps after restoring server progress', () => {
  const value = context({ bought: 500_000, stage: 'following' });
  assert.equal(resolveOpeningStep(value, 'stock'), 'impact');
  assert.equal(resolveOpeningStep(value, 'sell-submit'), 'impact');
  assert.equal(resolveOpeningStep(value, 'follow'), 'follow');
  assert.equal(openingLesson(props(value), 'impact').target, 'receipt');
  assert.equal(openingLesson(props(value), 'follow').target, 'clock-play');
  value.market.paused = false;
  assert.equal(openingLesson(props(value), 'follow').target, 'quote');
  assert.match(openingLesson(props(value), 'follow').body, /来自其他资金成交/);
});

test('day-two unlock and unfilled orders do not complete the guide; a real sale does', () => {
  const value = context({ day: 2, stage: 'exit', bought: 500_000 });
  assert.equal(resolveOpeningStep(value, 'stock'), 'unlocked');
  assert.equal(resolveOpeningStep(value, 'done'), 'unlocked');
  assert.match(openingLesson(props(value), 'unlocked').body, /当前可卖 500,000 股/);
  value.market.orders.push({ ...order(), side: 'sell', day: 2, filled: 0, remaining: 500_000 });
  assert.equal(resolveOpeningStep(value, 'done'), 'orders');
  assert.equal(value.market.openingScenario!.saleProceeds, 0);
  Object.assign(value.market.openingScenario!, { stage: 'complete', soldQuantity: 100, saleProceeds: 1_059 });
  for (const requested of allSteps) assert.equal(resolveOpeningStep(value, requested), 'done');
  const done = openingLesson(props(value), 'done');
  assert.match(done.body, /实际卖出 100 股/);
  assert.match(done.body, /回款 1,059\.00 元/);
  assert.equal(done.title, '已卖出一部分，仍有持仓');
  assert.match(done.body, /还持有 500,000 股，未成交的挂单也仍计入持仓/);
  assert.match(done.body, /回款不是利润，盈亏需扣成交成本/);
  assert.doesNotMatch(done.body, /固定利润|216 万|47 万/);
});

test('reopening observes immutable server progress and does not invoke account or close actions', () => {
  let closes = 0;
  for (const [value, expected] of [
    [context({ bought: 500_000, stage: 'following' }), 'impact'],
    [context({ bought: 500_000, stage: 'exit' }), 'locked'],
    [context({ day: 2, bought: 500_000, stage: 'exit' }), 'unlocked'],
    [context({ day: 2, bought: 500_000, stage: 'complete', sold: 100, saleProceeds: 1_059 }), 'done'],
  ] as const) {
    const before = JSON.stringify(value);
    freeze(value);
    for (let reopening = 0; reopening < 2; reopening += 1) {
      const step = resolveOpeningStep(value, 'stock');
      assert.equal(step, expected);
      const current = { ...props(value), onClose() { closes++; } };
      openingLesson(current, step);
      assert.equal(renderToStaticMarkup(createElement(OpeningTutorial, current)), '',
        'the browser spotlight is not a second server-rendered trading surface');
    }
    assert.equal(JSON.stringify(value), before);
  }
  assert.equal(closes, 0);
});

test('skipping the first-day route leaves day-two empty or newly locked accounts free to close the guide', () => {
  for (const value of [context({ day: 2 }), context({ day: 2, bought: 0, held: 100, available: 0, today: 100 })]) {
    for (const requested of allSteps) assert.equal(resolveOpeningStep(value, requested), 'empty');
    const lesson = openingLesson(props(value), 'empty');
    assert.equal(lesson.next, undefined);
    assert.equal(lesson.label, '结束引导');
  }
  assert.match(openingLesson(props(context({ day: 2, held: 100, available: 0, today: 100 })), 'empty').body,
    /今天新买的股票还要等下一交易日/);
  const noScenario = context(); delete noScenario.market.openingScenario;
  assert.equal(resolveOpeningStep(noScenario, 'stock'), 'empty');
});

test('a live target order is checked before submitting another; unrelated or closed orders do not obstruct', () => {
  for (const day of [1, 2]) for (const status of ['open', 'partial'] as const) {
    const value = context({ day, bought: 500_000, stage: day === 1 ? 'following' : 'exit' });
    value.market.orders = [order(status)];
    for (const requested of allSteps) assert.equal(resolveOpeningStep(value, requested), 'orders');
    assert.equal(openingLesson(props(value), 'orders').target, 'receipt');
    assert.match(openingLesson(props(value), 'orders').body, /撤单/);
  }
  for (const pending of [order('filled'), order('cancelled'), order('open', 's2')]) {
    const value = context({ day: 2, bought: 500_000, stage: 'exit' });
    value.market.orders = [pending];
    assert.equal(resolveOpeningStep(value, 'stock'), 'unlocked');
  }
});

test('a sell preset uses only funded visible bids, available shares and complete lots', () => {
  const value = context({ day: 2, bought: 500_000, stage: 'exit' });
  const stock = stockOf(value);
  stock.bids = [{ price: 9.93, quantity: 250 }, { price: 9.87, quantity: 380 }];
  const before = JSON.stringify(stock);
  freeze(stock);
  assert.deepEqual(openingSellTicket(stock, 450), { quantity: 400, price: 9.87 });
  assert.deepEqual(openingSellTicket(stock, 199), { quantity: 100, price: 9.93 });
  assert.deepEqual(openingSellTicket(stock, 50_000), { quantity: 500, price: 9.87 });
  assert.equal(openingSellTicket(stock, 99), null);
  assert.equal(openingSellTicket(stock, 0), null);
  assert.equal(openingSellTicket({ ...stock, bids: [] }, 50_000), null,
    'a last trade or displayed ask is not a usable exit bid');
  assert.equal(JSON.stringify(stock), before);
});

test('auction, lunch and closing boundaries never suggest an immediately executable continuous order', () => {
  for (const phase of ['auction', 'lunch'] as const) {
    const first = context({ phase });
    assert.equal(resolveOpeningStep(first, 'buy-submit'), 'auction');
    const second = context({ day: 2, phase, bought: 500_000, stage: 'exit', side: 'sell' });
    assert.equal(resolveOpeningStep(second, 'stock'), 'unlocked');
    assert.equal(resolveOpeningStep(second, 'sell-submit'), 'auction');
    assert.equal(openingLesson(props(second), 'auction').target, 'clock-next');
    assert.match(openingLesson(props(second), 'auction').body, phase === 'lunch' ? /午间暂时不撮合/ : /统一价格撮合/);
  }
  for (const phase of ['closing', 'night', 'ended'] as const) {
    for (const stage of ['ready', 'following', 'exit'] as const) {
      assert.equal(resolveOpeningStep(context({ phase, stage }), 'buy-submit'), 'overnight');
    }
    assert.equal(resolveOpeningStep(context({ day: 2, phase, bought: 500_000, stage: 'exit' }), 'sell-submit'), 'empty');
  }
});

test('first-day wrong prices or quantities return to the actual input and cannot skip to order confirmation', () => {
  for (const price of [10, 10.29, 10.301, NaN]) {
    const value = context({ price });
    for (const requested of ['quantity', 'buy-start', 'buy-submit'] as const) assert.equal(resolveOpeningStep(value, requested), 'price');
    assert.equal(openingLesson(props(value), 'price').enabled, false);
  }
  for (const quantity of [0, 100, 499_900, 500_100, NaN]) {
    const value = context({ quantity });
    for (const requested of ['buy-start', 'buy-submit'] as const) assert.equal(resolveOpeningStep(value, requested), 'quantity');
    assert.equal(openingLesson(props(value), 'quantity').enabled, false);
  }
  const partial = context({ bought: 100_000, quantity: 400_000 });
  assert.equal(openingLesson(props(partial), 'quantity').enabled, true);
  assert.equal(resolveOpeningStep(partial, 'buy-submit'), 'buy-start');
  partial.market.paused = false;
  assert.equal(resolveOpeningStep(partial, 'buy-start'), 'buy-submit');
  assert.equal(resolveOpeningStep(partial, 'done'), 'stock');
});

test('second-day ticket preparation waits for the correct side, a live book and a valid ordinary limit order', () => {
  const value = context({ day: 2, bought: 500_000, stage: 'exit', price: 10.6, quantity: 100 });
  assert.equal(resolveOpeningStep(value, 'sell-submit'), 'sell-side');
  value.side = 'sell';
  assert.equal(resolveOpeningStep(value, 'sell-submit'), 'sell-start');
  value.market.paused = false;
  assert.equal(resolveOpeningStep(value, 'sell-start'), 'sell-submit');
  stockOf(value).bids = [];
  assert.equal(resolveOpeningStep(value, 'sell-ticket'), 'wait-book');
  assert.equal(openingLesson(props(value), 'wait-book').target, 'book');
  value.market.paused = true;
  assert.equal(openingLesson(props(value), 'wait-book').target, 'clock-play');
  stockOf(value).bids = [{ price: 10.6, quantity: 1000 }];
  assert.equal(resolveOpeningStep(value, 'wait-book'), 'sell-ticket');
  assert.match(openingLesson(props(value), 'sell-ticket').body, /第二天行情已经随机/);
  assert.match(openingLesson(props(value), 'sell-ticket').body, /成交价取决于提交时的买盘/);
  for (const invalid of [{ quantity: 99 }, { quantity: 500_100 }, { quantity: 0 },
    { price: 0.01 }, { price: 10.591 }, { price: 11.89 }, { price: Infinity }, { price: NaN }]) {
    const draft = { ...value, ...invalid };
    assert.equal(resolveOpeningStep(draft, 'sell-submit'), 'sell-ticket', JSON.stringify(invalid));
    assert.equal(openingLesson(props(draft), 'sell-ticket').enabled, false);
  }
});

test('a valid prepared sell stays on confirmation when live bids fall or disappear', () => {
  const value = context({ day: 2, bought: 500_000, stage: 'exit', side: 'sell',
    price: 10.6, quantity: 100, paused: false });
  assert.equal(openingLesson(props(value), 'sell-ticket').enabled, true);
  assert.equal(resolveOpeningStep(value, 'sell-start'), 'sell-submit');
  for (const bids of [[{ price: 10.55, quantity: 1000 }], []]) {
    stockOf(value).bids = bids;
    assert.equal(resolveOpeningStep(value, 'sell-submit'), 'sell-submit',
      'a changing quote must not cover the actual confirmation button with another teaching step');
    assert.equal(resolveOpeningStep(value, 'sell-start'), 'sell-submit');
    assert.equal(openingLesson(props(value), 'sell-submit').target, 'submit');
    assert.match(openingLesson(props(value), 'sell-submit').body, /未成交的部分会继续挂单/);
    assert.equal(openingLesson(props(value), 'sell-ticket').enabled, false,
      'a newly prepared ticket still needs a currently reachable bid before continuing');
    assert.equal(value.price, 10.6, 'the guide must not rewrite the user\'s chosen limit');
    value.market.paused = true;
    assert.equal(resolveOpeningStep(value, 'sell-start'), 'sell-start');
    assert.equal(resolveOpeningStep(value, 'sell-submit'), 'sell-start');
    value.market.paused = false;
    for (const invalid of [{ price: 0.01 }, { price: 10.591 }, { quantity: 99 }, { quantity: 500_100 }]) {
      assert.equal(resolveOpeningStep({ ...value, ...invalid }, 'sell-submit'), 'sell-ticket',
        'static order errors must still return to editing even when the book is empty');
    }
  }
  value.market.orders = [{ ...order(), day: 2, side: 'sell', quantity: 100, remaining: 100, filled: 0 }];
  assert.equal(resolveOpeningStep(value, 'sell-submit'), 'orders',
    'once the server accepts an unfilled order, its real pending state takes precedence');
  assert.equal(value.market.openingScenario!.soldQuantity, 0);
});

test('the observed sell side advances the guide without depending on native click listener ordering', () => {
  const value = context({ day: 2, bought: 500_000, stage: 'exit', side: 'buy', price: 10.6, quantity: 100 });
  assert.equal(resolveOpeningStep(value, 'sell-side'), 'sell-side');
  value.side = 'sell';
  assert.equal(resolveOpeningStep(value, 'sell-side'), 'sell-ticket');
  assert.equal(resolveOpeningStep(value, 'sell-side'), 'sell-ticket', 're-rendering must remain driven by the real order side');
  value.side = 'buy';
  assert.equal(resolveOpeningStep(value, 'sell-submit'), 'sell-side', 'switching back must not leave a buy button highlighted as a sale');
});
