import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_STOCKS, LEGACY_BASE_STOCK_COUNT, STOCK_UNIVERSE_VERSION, baseStockById } from './stock-catalog.js';
import { advanceNewsArcs, validateStoryState, type StoryMarket } from './news-arcs.js';

function market(seed: number, legacy = false): StoryMarket {
  return { seed, day: 1, phase: 'auction', phaseElapsed: 0, tickCount: 0, news: [],
    stocks: (legacy ? BASE_STOCKS.slice(0, LEGACY_BASE_STOCK_COUNT) : BASE_STOCKS).map(stock => ({
      id: stock.id, name: stock.name, sector: stock.sector, fair: stock.price * 100, newsBias: 0,
    })) };
}

test('expanded catalogue preserves all original identifiers and loan supply, while reserving IPO identifiers', () => {
  assert.equal(STOCK_UNIVERSE_VERSION, 1);
  assert.equal(BASE_STOCKS.length, 18);
  assert.equal(new Set(BASE_STOCKS.map(stock => stock.id)).size, 18);
  assert.equal(new Set(BASE_STOCKS.map(stock => stock.code)).size, 18);
  assert.deepEqual([...new Set(BASE_STOCKS.map(stock => stock.sector))], ['半导体', '光通信', '电力', '机器人', '创新药', '大消费']);
  const originalNames = ['江澜芯科', '砺川设备', '云岫材料', '远辰微电', '星瀚光联', '海序通信', '长曜光电', '青屿连接', '丰泽电力', '川岚水电', '恒原电网', '沧岳储能'];
  const originalPrices = [12, 28, 18, 35, 22, 16, 31, 9, 8, 14, 19, 26];
  const originalShares = [24, 75, 40, 120, 30, 180, 20, 60, 240, 160, 100, 45];
  for (let i = 0; i < LEGACY_BASE_STOCK_COUNT; i++) {
    const stock = BASE_STOCKS[i];
    assert.equal(stock.id, `s${i + 1}`); assert.equal(stock.name, originalNames[i]);
    assert.equal(stock.price, originalPrices[i]); assert.equal(stock.shares, originalShares[i] * 1_000_000);
    assert.equal(stock.pe, 16 + i * 3); assert.equal(stock.financeEligible, i % 2 === 0);
    assert.equal(stock.lendTotal, i === 4 || i === 8 ? 10_000 : 0);
  }
  for (const id of ['s13', 's14', 's15', 's16']) assert.equal(baseStockById(id), undefined);
  assert.deepEqual(BASE_STOCKS.filter(stock => stock.lendTotal > 0).map(stock => stock.id), ['s5', 's9', 's21']);
  for (const stock of BASE_STOCKS) {
    assert.equal(stock.code, `虚${stock.id.slice(1).padStart(3, '0')}`);
    assert.ok(stock.description && stock.concepts.length >= 2 && stock.shares > 0 && stock.price > 0 && stock.pe > 0);
  }
});

test('each new company can lead a complete four-stage news story with weaker related-company exposure', () => {
  const newIds = new Set(['s17', 's18', 's19', 's20', 's21', 's22']);
  const covered = new Set<string>();
  for (let i = 1; i <= 256 && covered.size < newIds.size; i++) {
    const m = market(Math.imul(i, 2654435761) >>> 0);
    advanceNewsArcs(m);
    const state = m.storyState!, arc = state.arcs[0];
    if (!newIds.has(arc.primaryStockId) || covered.has(arc.primaryStockId)) continue;
    covered.add(arc.primaryStockId);
    assert.equal(arc.participants[0].stockId, arc.primaryStockId);
    assert.equal(arc.participants[0].exposure, 1);
    assert.ok(arc.participants.length >= 2);
    const primary = baseStockById(arc.primaryStockId)!;
    for (const other of arc.participants.slice(1)) {
      assert.ok(other.exposure > 0 && other.exposure < .5);
      assert.equal(baseStockById(other.stockId)!.sector, primary.sector);
      assert.ok(state.expectations[other.stockId].premium < state.expectations[primary.id].premium);
    }
    // Keep this isolated story test from starting a second project during its later auction nodes.
    state.nextStartDay = 9;
    for (const node of arc.nodes.slice(1)) {
      m.day = node.day; m.phase = node.phase; m.phaseElapsed = node.at;
      advanceNewsArcs(m);
    }
    assert.equal(arc.publishedStage, 3);
    assert.equal(validateStoryState(state, m), true);
    assert.deepEqual(m.news.map(article => article.stage), ['delivery', 'result', 'progress', 'proposal']);
    for (const article of m.news) {
      assert.equal(article.sector, primary.sector);
      assert.equal(article.impacts?.[0].sector, primary.sector);
      assert.ok(article.stockIds?.includes(primary.id));
      assert.match(article.body, /价格仍取决于买卖成交和市场承接/);
      assert.ok(article.headline.includes(primary.name.slice(0, 2)));
      if (primary.sector === '创新药') assert.doesNotMatch(article.body, /订单结果已经公布|进入评审不等于拿到订单/);
    }
    for (const stock of m.stocks) {
      if (!arc.participants.some(p => p.stockId === stock.id)) assert.equal(state.expectations[stock.id].premium, 0);
    }
  }
  assert.deepEqual([...covered].sort(), [...newIds].sort());
});

test('more sectors diversify story selection without increasing the two-active-story cap or start frequency', () => {
  function simulate(legacy: boolean, seed: number) {
    const m = market(seed, legacy), starts: number[] = [];
    for (let day = 1; day <= 71; day++) {
      m.day = day;
      for (const phase of ['auction', 'morning', 'afternoon', 'night'] as const) {
        m.phase = phase; m.phaseElapsed = phase === 'auction' || phase === 'night' ? 0 : 179;
        const sequence = m.storyState?.sequence ?? 0;
        advanceNewsArcs(m);
        assert.ok(m.storyState!.arcs.filter(arc => arc.publishedStage < 3).length <= 2);
        if (m.storyState!.sequence > sequence) starts.push(day);
        assert.equal(validateStoryState(m.storyState, m), true);
      }
    }
    return starts;
  }
  for (const seed of [1, 42, 20261020]) {
    const original = simulate(true, seed), expanded = simulate(false, seed);
    assert.deepEqual(expanded, original);
    assert.ok(expanded.length >= 15 && expanded.length <= 36);
  }
});
