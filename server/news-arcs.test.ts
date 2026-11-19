import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceNewsArcs, expectedValue, initNewsArcs, validateStoryState, type StoryMarket, type NewsArc } from './news-arcs.js';

function fixture(seed = 42): StoryMarket & { actors: { positions: Record<string, number>; cash: number }[] } {
  const names = ['江澜芯科', '砺川设备', '云岫材料', '远辰微电', '星瀚光联', '海序通信', '长曜光电', '青屿连接', '丰泽电力', '川岚水电', '恒原电网', '沧岳储能'];
  return { seed, day: 1, phase: 'auction', phaseElapsed: 0, tickCount: 0, news: [],
    actors: [{ positions: {}, cash: 1_000_000_000 }],
    stocks: names.map((name, index) => ({ id: `s${index + 1}`, name, sector: index < 4 ? '半导体' : index < 8 ? '光通信' : '电力',
      fair: 1200 + index * 100, newsBias: 0, price: 1200 + index * 100, volume: 5000, history: [{ price: 1200, volume: 100 }] })),
  };
}
function atNode(m: StoryMarket, arc: NewsArc, index: number) {
  const node = arc.nodes[index];
  m.day = node.day; m.phase = node.phase; m.phaseElapsed = node.at;
  advanceNewsArcs(m);
}
function runDays(m: StoryMarket, days: number) {
  for (let day = 1; day <= days; day++) {
    m.day = day;
    for (const phase of ['auction', 'morning', 'afternoon', 'night'] as const) {
      m.phase = phase;
      for (const elapsed of [0, 40, 90, 179]) {
        m.phaseElapsed = phase === 'auction' ? 0 : elapsed;
        advanceNewsArcs(m);
      }
    }
    assert.equal(validateStoryState(m.storyState, m), true, `invalid state on day ${day}`);
  }
}

test('multi-day news changes public expectations without touching price, executions, inventory or money', () => {
  const m = fixture(), before = structuredClone(m);
  assert.equal(advanceNewsArcs(m), 1);
  const arc = m.storyState!.arcs[0];
  assert.equal(arc.publishedStage, 0);
  assert.equal(m.news[0].stage, 'proposal');
  assert.ok(expectedValue(m, m.stocks.find(s => s.id === arc.primaryStockId)!) > before.stocks.find(s => s.id === arc.primaryStockId)!.fair);
  for (let index = 1; index < 4; index++) atNode(m, arc, index);
  assert.equal(arc.publishedStage, 3);
  assert.deepEqual(m.actors, before.actors);
  for (const [index, stock] of m.stocks.entries()) {
    const { newsBias: _afterBias, ...after } = stock;
    const { newsBias: _beforeBias, ...previous } = before.stocks[index];
    assert.deepEqual(after, previous);
  }
  assert.deepEqual(m.news.filter(n => n.storyId === arc.id).map(n => n.stage), ['delivery', 'result', 'progress', 'proposal']);
  assert.ok(arc.nodes[3].day - arc.startedDay >= 2 && arc.nodes[3].day - arc.startedDay <= 6);
});

test('private future outcomes cannot affect current valuation, and public articles contain no future nodes', () => {
  const m = fixture(); advanceNewsArcs(m);
  const clone = structuredClone(m), stock = m.stocks.find(s => s.id === m.storyState!.arcs[0].primaryStockId)!;
  clone.storyState!.arcs[0].nodes[2].premium = -.15;
  clone.storyState!.arcs[0].nodes[2].outcome = 'delayed';
  clone.storyState!.arcs[0].nodes[3].premium = -.16;
  assert.equal(expectedValue(m, stock), expectedValue(clone, stock));
  assert.deepEqual(m.news, clone.news);
  for (const article of m.news) {
    assert.equal(Object.hasOwn(article, 'nodes'), false);
    assert.equal(Object.hasOwn(article, 'outcome'), false);
    assert.equal(Object.hasOwn(article, 'premium'), false);
  }
  assert.equal(advanceNewsArcs(m), 0);
  assert.equal(m.news.length, 1);
});

test('winning a smaller order is positive operating news but can lower an already higher expectation', () => {
  const m = fixture(); advanceNewsArcs(m);
  const arc = m.storyState!.arcs[0], stock = m.stocks.find(s => s.id === arc.primaryStockId)!;
  arc.nodes[1].premium = .18;
  atNode(m, arc, 1);
  const expectedBefore = expectedValue(m, stock);
  arc.nodes[2].premium = .025; arc.nodes[2].outcome = 'modest';
  atNode(m, arc, 2);
  const article = m.news.find(n => n.id === `${arc.id}-result`)!;
  assert.ok(expectedValue(m, stock) < expectedBefore);
  assert.equal(article.sentiment, 'negative');
  assert.match(article.body, /弱于此前预期/);
  assert.match(article.headline, /取得|中标|通过/);
  assert.ok(expectedValue(m, stock) > stock.fair, 'a lower incremental expectation does not erase the positive project value');
});

test('different business exposure within one sector yields different public expectation changes', () => {
  const m = fixture(); advanceNewsArcs(m);
  const arc = m.storyState!.arcs[0], [primary, secondary] = arc.participants;
  assert.ok(secondary);
  assert.ok(m.storyState!.expectations[primary.stockId].premium > m.storyState!.expectations[secondary.stockId].premium);
  const unexposed = m.stocks.find(s => !arc.participants.some(p => p.stockId === s.id))!;
  assert.equal(expectedValue(m, unexposed), unexposed.fair);
  assert.equal(m.news[0].stockIds!.length, arc.participants.length);
});

test('publication times and future outcomes are independent of player holdings and market RNG calls', () => {
  const left = fixture(826), right = fixture(826);
  right.actors[0].positions = { s2: 200_000, s5: 900_000 };
  right.actors[0].cash = 1;
  runDays(left, 45); runDays(right, 45);
  assert.deepEqual(left.storyState, right.storyState);
  assert.deepEqual(left.news, right.news);
  assert.equal(left.news.length, 40);
});

test('expectations survive overnight and serialization; an old article is never replayed at upgrade', () => {
  const m = fixture(); advanceNewsArcs(m);
  const arc = m.storyState!.arcs[0], stock = m.stocks.find(s => s.id === arc.primaryStockId)!;
  const value = expectedValue(m, stock), reloaded = JSON.parse(JSON.stringify(m)) as StoryMarket;
  reloaded.phase = 'night'; reloaded.phaseElapsed = 0;
  // Stop before any scheduled intraday update to isolate persistence, rather than advancing through it.
  assert.equal(expectedValue(reloaded, stock), value);
  assert.equal(validateStoryState(reloaded.storyState, reloaded), true);
  const old = fixture(); old.phase = 'afternoon'; old.phaseElapsed = 90;
  old.news.push({ id: 'old', time: '10:00', headline: '本土产线启动新一轮设备验证', body: '已有消息', sentiment: 'positive' });
  old.stocks[1].newsBias = .025;
  const before = structuredClone(old);
  initNewsArcs(old); assert.equal(advanceNewsArcs(old), 0);
  assert.deepEqual(old.news, before.news); assert.deepEqual(old.stocks, before.stocks); assert.deepEqual(old.actors, before.actors);
  assert.equal(old.storyState!.nextStartDay, 2);
  old.day = 2; old.phase = 'auction'; old.phaseElapsed = 0;
  assert.equal(advanceNewsArcs(old), 1);
  assert.ok(old.news.some(n => n.id === 'old'));
});

test('completed results persist but do not apply again on repeated ticks or after save reload', () => {
  const m = fixture(); advanceNewsArcs(m);
  const arc = m.storyState!.arcs[0];
  for (let index = 1; index < 4; index++) atNode(m, arc, index);
  const expectations = structuredClone(m.storyState!.expectations), news = structuredClone(m.news);
  for (let i = 0; i < 10; i++) advanceNewsArcs(m);
  assert.deepEqual(m.storyState!.expectations, expectations); assert.deepEqual(m.news, news);
  const saved = structuredClone(m); advanceNewsArcs(saved);
  assert.deepEqual(saved.storyState!.expectations, expectations);
});

test('after-hours news publishes at 18:00 without a trade, survives the next opening, and never repeats', () => {
  let m = fixture(1); advanceNewsArcs(m);
  for (let seed = 2; m.storyState!.arcs[0].nodes[3].phase !== 'night' && seed < 100; seed++) {
    m = fixture(seed); advanceNewsArcs(m);
  }
  const arc = m.storyState!.arcs[0], delivery = arc.nodes[3];
  assert.equal(delivery.phase, 'night'); assert.equal(delivery.at, 0);
  // Isolate this project's completion from the independent start of a later project.
  m.storyState!.nextStartDay = delivery.day + 3;
  for (let index = 1; index < 3; index++) atNode(m, arc, index);
  m.day = delivery.day; m.phase = 'closing'; m.phaseElapsed = 14;
  assert.equal(advanceNewsArcs(m), 0, 'the result is not public during the closing auction');
  const before = structuredClone(m);
  m.phase = 'night'; m.phaseElapsed = 0;
  assert.equal(advanceNewsArcs(m), 1);
  const article = m.news[0];
  assert.equal(article.id, `${arc.id}-delivery`);
  assert.equal(article.stage, 'delivery'); assert.equal(article.time, '18:00'); assert.equal(article.day, delivery.day);
  assert.deepEqual(m.actors, before.actors);
  for (const [index, stock] of m.stocks.entries()) {
    const { newsBias: _newBias, ...after } = stock;
    const { newsBias: _oldBias, ...previous } = before.stocks[index];
    assert.deepEqual(after, previous, 'nightly information must not manufacture a print or volume');
  }
  const values = m.stocks.map(stock => expectedValue(m, stock)), published = structuredClone(m.news);
  assert.equal(advanceNewsArcs(m), 0);
  m.day++; m.phase = 'auction'; m.phaseElapsed = 0;
  assert.equal(advanceNewsArcs(m), 0);
  assert.deepEqual(m.stocks.map(stock => expectedValue(m, stock)), values);
  assert.deepEqual(m.news, published);
  assert.equal(validateStoryState(m.storyState, m), true);
});

test('most results and deliveries are disclosed outside continuous trading, with occasional intraday updates', () => {
  let afterHours = 0, premarket = 0, intraday = 0, eveningProgress = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const m = fixture(seed); advanceNewsArcs(m);
    const arc = m.storyState!.arcs[0];
    if (arc.nodes[1].phase === 'night') eveningProgress++;
    for (const node of arc.nodes.slice(2)) {
      if (node.phase === 'night') afterHours++;
      else if (node.phase === 'auction') premarket++;
      else intraday++;
    }
  }
  assert.ok(afterHours > 0 && premarket > 0 && intraday > 0 && eveningProgress > 0);
  assert.ok(afterHours + premarket > 160, 'most earnings-sensitive facts should arrive between trading sessions');
});

test('story progression is bounded, avoids adjacent repeated projects and is deterministic across seeds', () => {
  for (const seed of [1, 42, 20261020]) {
    const m = fixture(seed); runDays(m, 71);
    assert.ok(m.storyState!.arcs.length <= 6);
    assert.ok(m.storyState!.sequence >= 15 && m.storyState!.sequence <= 36);
    for (const stock of m.stocks) {
      assert.ok(expectedValue(m, stock) >= Math.round(stock.fair * .55));
      assert.ok(expectedValue(m, stock) <= Math.round(stock.fair * 3.5));
    }
    const another = fixture(seed); runDays(another, 71);
    assert.deepEqual(m.storyState, another.storyState);
  }
});

test('save validation rejects malformed private state and unsafe expectation values', () => {
  const m = fixture(); advanceNewsArcs(m);
  assert.equal(validateStoryState(m.storyState, m), true);
  const corruptions: ((value: NonNullable<StoryMarket['storyState']>) => void)[] = [
    state => { state.rngState = NaN; },
    state => { state.arcs[0].nodes[2].premium = Infinity; },
    state => { state.arcs[0].nodes[2].day = 99999; },
    state => { state.arcs[0].primaryStockId = 'missing'; },
    state => { state.arcs[0].participants[0].stockId = 'missing'; },
    state => { state.expectations.s1.premium = -2; },
    state => { state.expectations.s1.activeStoryIds = ['unknown']; },
    state => { state.arcs[0].nodes[1].day = 0; },
    state => { state.arcs[0].nodes[0].outcome = 'strong'; },
    state => { state.arcs[0].nodes[2].phase = 'night'; state.arcs[0].nodes[2].at = 1; },
  ];
  for (const corrupt of corruptions) {
    const state = structuredClone(m.storyState!); corrupt(state);
    assert.equal(validateStoryState(state, m), false);
  }
  assert.equal(validateStoryState(null, m), false);
  assert.equal(validateStoryState({}, m), false);
});
