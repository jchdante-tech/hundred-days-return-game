import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePhase, createMarket, getView, nextDay, validateMarket, type Market } from './engine.js';
import { buildPostCloseReport, validPostCloseReport } from './post-close.js';

function fill(market: Market, stockId: string, price: number, quantity: number, time: string,
  buyerId = 'ai0', sellerId = 'ai1', day = market.day) {
  const buyer = market.actors.find(actor => actor.id === buyerId)!;
  const seller = market.actors.find(actor => actor.id === sellerId)!;
  market.trades.push({ id: `t${market.trades.length + 1}`, stockId, price, quantity, time, day,
    buyerId, sellerId, buyerName: buyer.name, sellerName: seller.name,
    ...(buyerId === 'player' ? { playerSide: 'buy' as const } : sellerId === 'player' ? { playerSide: 'sell' as const } : {}) });
}
function close(market: Market) {
  for (let phase = 0; phase < 5; phase++) advancePhase(market);
  assert.equal(market.phase, 'night');
}
const amountsInCents = (values: number[]) => values.map(value => Math.round(value * 100));

test('sector flows apply the price tick rule per stock, preserving fill order and neutral auctions', () => {
  const market = createMarket(1);
  fill(market, 's1', 1000, 100, '09:25');
  fill(market, 's1', 1000, 100, '09:30'); // Equal to auction: no direction yet.
  fill(market, 's1', 1010, 200, '09:31');
  fill(market, 's2', 5000, 100, '09:31'); // First fill: do not compare with s1.
  fill(market, 's1', 1010, 100, '09:32'); // Equal uptick inherits buying direction.
  fill(market, 's2', 5000, 100, '09:32'); // Other stock remains neutral.
  fill(market, 's1', 1005, 100, '09:33');
  fill(market, 's1', 1005, 200, '09:34'); // Equal downtick inherits selling direction.
  fill(market, 's1', 1020, 100, '15:00'); // Auction never inherits an intraday direction.
  fill(market, 's1', 1020, 100, '15:00');
  fill(market, 's5', 2200, 100, '09:30');
  fill(market, 's5', 2210, 100, '09:31');
  fill(market, 's1', 9999, 10000, '10:00', 'ai0', 'ai1', 0); // Other-day fills ignored.
  const before = structuredClone(market);
  const report = buildPostCloseReport(market);
  assert.deepEqual(report.sectorFlows.filter(row => row.turnover > 0), [
    { sector: '光通信', inflow: 2210, outflow: 0, neutral: 2200, net: 2210, turnover: 4410 },
    { sector: '半导体', inflow: 3030, outflow: 3015, neutral: 14040, net: 15, turnover: 20085 },
  ]);
  assert.equal(report.sectorFlows.length, 6);
  assert.ok(report.sectorFlows.filter(row => row.turnover === 0).every(row => row.inflow === 0 && row.outflow === 0 && row.neutral === 0 && row.net === 0));
  assert.deepEqual(market, before, 'report calculation must not change matching, price, cash, inventory or RNG');
});

test('all six AI seats disclose actual buy and sell amounts and quantities for each stock, excluding the player seat', () => {
  const market = createMarket(2);
  for (let index = 0; index < 6; index++) {
    const actorId = `ai${index}`, stock = market.stocks[index];
    fill(market, stock.id, 1001 + index, (index + 1) * 100, '10:01', actorId, 'player');
    fill(market, stock.id, 1101 + index, (index + 2) * 100, '10:02', 'player', actorId);
    fill(market, 's12', 2601 + index, 100, '10:03', actorId, 'player');
  }
  const report = buildPostCloseReport(market);
  assert.equal(report.seats.length, 6);
  assert.ok(report.seats.every(seat => seat.seatId !== 'player'));
  for (let index = 0; index < 6; index++) {
    const seat = report.seats.find(seat => seat.seatId === `ai${index}`)!;
    const first = seat.stocks.find(stock => stock.stockId === `s${index + 1}`)!;
    const buy = (1001 + index) * (index + 1), sell = (1101 + index) * (index + 2);
    assert.deepEqual(first, { stockId: `s${index + 1}`, stockName: market.stocks[index].name,
      sector: market.stocks[index].sector, buy, sell, net: buy - sell,
      buyQuantity: (index + 1) * 100, sellQuantity: (index + 2) * 100 });
    assert.equal(seat.stocks.length, 2);
    assert.equal(seat.buy, buy + 2601 + index); assert.equal(seat.sell, sell);
    assert.equal(seat.net, buy + 2601 + index - sell);
  }
  assert.notEqual(report.seats.reduce((sum, seat) => sum + seat.net, 0), 0,
    'AI-only net amounts need not sum to zero because the player can be their counterparty');
});

test('no fills produce six zero sectors and six zero seats without invented stock activity', () => {
  const market = createMarket(3), report = buildPostCloseReport(market);
  assert.equal(report.sectorFlows.length, 6); assert.equal(report.seats.length, 6);
  assert.ok(report.sectorFlows.every(row => row.turnover === 0 && row.net === 0));
  assert.ok(report.seats.every(seat => seat.buy === 0 && seat.sell === 0 && seat.stocks.length === 0));
});

test('public report is absent intraday, appears at close, and totals reconcile to executed fills', () => {
  const market = createMarket(20261020);
  assert.equal(getView(market).postClose, null);
  advancePhase(market); advancePhase(market);
  assert.ok(market.trades.length > 0); assert.equal(getView(market).postClose, null);
  advancePhase(market); advancePhase(market); advancePhase(market);
  const report = getView(market).postClose!;
  assert.equal(report.day, 1); assert.equal(report.date, '2026-10-20');
  assert.equal(validateMarket(market), true);
  for (const row of report.sectorFlows) {
    const trades = market.trades.filter(trade => market.stocks.find(stock => stock.id === trade.stockId)!.sector === row.sector);
    const expected = trades.reduce((sum, trade) => sum + trade.price * trade.quantity, 0);
    assert.equal(Math.round(row.turnover * 100), expected);
    assert.equal(amountsInCents([row.inflow, row.outflow, row.neutral]).reduce((a, b) => a + b, 0), expected);
  }
  assert.ok(report.seats.some(seat => seat.stocks.length > 0), 'focused seats still disclose their actual executions');
  assert.equal(market.leaderboard.length, 0, 'seat disclosure does not depend on unusual-trading thresholds');
  const saved = structuredClone(market.postClose);
  report.seats[0].stocks[0].buy = 999;
  assert.deepEqual(market.postClose, saved, 'public callers cannot mutate the stored report');
});

test('completed report persists through cross-day pruning, serialization and deterministic continuation', () => {
  const market = createMarket(57); close(market);
  const previous = structuredClone(getView(market).postClose);
  nextDay(market);
  assert.equal(market.day, 2);
  assert.ok(market.trades.every(trade => trade.playerSide), 'AI fills are pruned at rollover');
  assert.deepEqual(getView(market).postClose, previous);
  const restored: Market = JSON.parse(JSON.stringify(market));
  assert.equal(validateMarket(restored), true);
  advancePhase(market); advancePhase(restored);
  assert.deepEqual(getView(market).postClose, previous, 'new intraday activity must not leak into yesterday’s report');
  assert.deepEqual(getView(restored), getView(market));
  for (let phase = 0; phase < 4; phase++) { advancePhase(market); advancePhase(restored); }
  assert.deepEqual(restored, market);
  assert.equal(getView(restored).postClose!.day, 2);
  assert.equal(getView(restored).postClose!.date, '2026-10-21');
  assert.notDeepEqual(getView(restored).postClose, previous);
});

test('legacy nightly reports migrate before the first view or rollover, while old intraday saves remain unknown', () => {
  const nightly = createMarket(44); close(nightly);
  const expected = structuredClone(nightly.postClose); delete nightly.postClose;
  const directRollover = structuredClone(nightly);
  assert.equal(validateMarket(nightly), true);
  assert.deepEqual(getView(nightly).postClose, expected);
  assert.deepEqual(nightly.postClose, expected);
  nextDay(directRollover);
  assert.deepEqual(getView(directRollover).postClose, expected);
  delete directRollover.postClose;
  assert.equal(getView(directRollover).postClose, null, 'discarded old AI fills cannot be reconstructed from player history');
});

test('maturity keeps the last trading date, and legacy ended saves use archived dates or no report', () => {
  const market = createMarket(5); market.day = 71; market.calendarDate = '2027-01-27'; market.elapsedDays = 99;
  close(market);
  const expected = structuredClone(market.postClose);
  nextDay(market);
  assert.equal(market.phase, 'ended'); assert.equal(market.calendarDate, '2027-01-28');
  assert.deepEqual(getView(market).postClose, expected);
  delete market.postClose;
  assert.deepEqual(getView(market).postClose, expected, 'legacy ended date comes from final archived daily candle');
  delete market.postClose;
  market.stocks.forEach(stock => { stock.dailyBars = stock.dailyBars!.filter(bar => bar.day <= 0); });
  assert.equal(getView(market).postClose, null, 'unknown old final trade date is not replaced with the maturity date');
});

test('stored reports reject future days, invalid money, duplicate entities and private fields', () => {
  const market = createMarket(5); close(market);
  assert.equal(validateMarket(market), true);
  const corruptions: ((copy: Market) => void)[] = [
    copy => { copy.postClose!.day++; },
    copy => { copy.phase = 'morning'; },
    copy => { copy.postClose!.date = '2026-02-30'; },
    copy => { copy.postClose!.date = '2026-10-21'; },
    copy => { copy.postClose!.sectorFlows[0].inflow = Infinity; },
    copy => { copy.postClose!.sectorFlows[0].outflow = -1; },
    copy => { copy.postClose!.sectorFlows[0].net += 1; },
    copy => { copy.postClose!.sectorFlows[0].turnover += 1; },
    copy => { copy.postClose!.sectorFlows[0].neutral += .001; },
    copy => { copy.postClose!.sectorFlows[1] = structuredClone(copy.postClose!.sectorFlows[0]); },
    copy => { copy.postClose!.seats[1] = structuredClone(copy.postClose!.seats[0]); },
    copy => { copy.postClose!.seats[0].seatId = 'player'; },
    copy => { copy.postClose!.seats[0].buy += 1; },
    copy => { copy.postClose!.seats[0].stocks[0].buyQuantity = -100; },
    copy => { copy.postClose!.seats[0].stocks[0].sellQuantity = 1; },
    copy => { copy.postClose!.seats[0].stocks[0].sector = 'fake'; },
    copy => { copy.postClose!.seats[0].stocks.push(structuredClone(copy.postClose!.seats[0].stocks[0])); },
    copy => { Object.assign(copy.postClose!, { rngState: 123 }); },
    copy => { Object.assign(copy.postClose!.seats[0], { positions: copy.actors[1].positions }); },
    copy => { Object.assign(copy.postClose!.seats[0].stocks[0], { orders: copy.orders }); },
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const copy = structuredClone(market); corrupt(copy);
    assert.equal(validateMarket(copy), false, `corruption ${index}`);
  }
  const publicJson = JSON.stringify(getView(market).postClose);
  for (const privateField of ['rngState', 'positions', 'orders', 'fair', 'newsBias', 'cash']) {
    assert.equal(publicJson.includes(`"${privateField}"`), false, privateField);
  }
});

function setSyntheticDay(market: Market, day: number) {
  market.day = day; market.calendarDate = `2026-10-${19 + day}`; market.phase = 'night';
  market.trades = [];
}
function rememberReport(market: Market) {
  if (market.postClose) market.postCloseHistory = [...(market.postCloseHistory ?? []), market.postClose].slice(-4);
  market.postClose = buildPostCloseReport(market);
}

test('ordinary market fills contribute to sector flow but are not presented as named hot-money seats', () => {
  const market = createMarket(6);
  if (!market.actors.some(actor => actor.id === 'crowd-test')) market.actors.push({ id: 'crowd-test', name: '普通市场资金', cash: 0, positions: {} });
  fill(market, 's1', 1200, 100, '10:00', 'crowd-test', 'player');
  fill(market, 's1', 1201, 100, '10:01', 'ai0', 'crowd-test');
  const report = buildPostCloseReport(market);
  assert.equal(report.seats.length, 6);
  assert.ok(report.seats.every(seat => /^ai[0-5]$/.test(seat.seatId)));
  assert.equal(report.sectorFlows.find(flow => flow.sector === '半导体')!.turnover, 2401);
  assert.equal(report.seats.find(seat => seat.seatId === 'ai0')!.buy, 1201);
  market.phase = 'night';
  assert.equal(validPostCloseReport(report, market), true);
});

test('concentration describes actual bought amount and reveals no private plan or unfilled order', () => {
  const market = createMarket(7); setSyntheticDay(market, 1);
  fill(market, 's1', 1000, 800, '10:00', 'ai0', 'player');
  fill(market, 's2', 1000, 200, '10:01', 'ai0', 'player');
  const before = structuredClone(market), report = buildPostCloseReport(market);
  assert.deepEqual(report.seats.find(seat => seat.seatId === 'ai0')!.observations, [
    { stockId: 's1', kind: 'concentration', text: '今日买入金额的 80% 集中在江澜芯科。' },
  ]);
  assert.deepEqual(market, before);
  assert.equal(validPostCloseReport(report, market), true);
});

test('cross-day observation combines continued net buying with a drop in executed buy amount', () => {
  const market = createMarket(8); setSyntheticDay(market, 1);
  fill(market, 's1', 1000, 1000, '10:00', 'ai0', 'player'); rememberReport(market);
  setSyntheticDay(market, 2);
  fill(market, 's1', 1000, 1000, '10:00', 'ai0', 'player'); rememberReport(market);
  setSyntheticDay(market, 3);
  fill(market, 's1', 1000, 600, '10:00', 'ai0', 'player');
  const report = buildPostCloseReport(market);
  const observations = report.seats.find(seat => seat.seatId === 'ai0')!.observations!;
  assert.deepEqual(observations, [{ stockId: 's1', kind: 'reduced', text: '连续 3 个交易日净买入江澜芯科，但今日买入金额比昨日减少 40%。' }]);
  assert.equal(validPostCloseReport(report, market), true);
});

test('net-buy to net-sell reversal and reduced buying take priority over concentration, with at most two observations', () => {
  const market = createMarket(9); setSyntheticDay(market, 1);
  for (const stockId of ['s1', 's2', 's3']) fill(market, stockId, 1000, 1000, '10:00', 'ai0', 'player');
  rememberReport(market); setSyntheticDay(market, 2);
  fill(market, 's1', 1000, 100, '10:00', 'ai0', 'player');
  fill(market, 's1', 1000, 1000, '10:01', 'player', 'ai0');
  fill(market, 's2', 1000, 200, '10:02', 'ai0', 'player');
  fill(market, 's3', 1000, 1000, '10:03', 'ai0', 'player');
  const observations = buildPostCloseReport(market).seats.find(seat => seat.seatId === 'ai0')!.observations!;
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map(observation => [observation.stockId, observation.kind]), [['s1', 'reversed'], ['s2', 'reduced']]);
  assert.match(observations[0].text, /由昨日净买入转为今日净卖出/);
  assert.match(observations[1].text, /减少 80%/);
});

test('a missing report breaks consecutive-day claims; no-buy days are not described as position exits', () => {
  const market = createMarket(10); setSyntheticDay(market, 1);
  fill(market, 's1', 1000, 1000, '10:00', 'ai0', 'player'); rememberReport(market);
  setSyntheticDay(market, 3);
  fill(market, 's1', 1000, 1000, '10:00', 'ai0', 'player');
  assert.deepEqual(buildPostCloseReport(market).seats.find(seat => seat.seatId === 'ai0')!.observations?.map(observation => observation.kind), ['concentration']);
  setSyntheticDay(market, 2);
  const idle = buildPostCloseReport(market).seats.find(seat => seat.seatId === 'ai0')!;
  assert.equal(idle.stocks.length, 0);
  assert.deepEqual(idle.observations, [{ stockId: 's1', kind: 'reduced', text: '江澜芯科今日没有买入成交，昨日曾买入。' }]);
  assert.equal(idle.observations!.some(observation => /清仓|撤退|减仓/.test(observation.text)), false);
});

test('stable buying reports consecutive days and does not apply the reduction label below its threshold', () => {
  const market = createMarket(12); setSyntheticDay(market, 1);
  fill(market, 's1', 1000, 1000, '10:00', 'ai0', 'player'); rememberReport(market);
  setSyntheticDay(market, 2); fill(market, 's1', 1000, 700, '10:00', 'ai0', 'player');
  assert.deepEqual(buildPostCloseReport(market).seats.find(seat => seat.seatId === 'ai0')!.observations, [
    { stockId: 's1', kind: 'continuation', text: '已连续 2 个交易日净买入江澜芯科。' },
  ]);
});

test('old reports without observations remain valid while optional observations reject extra fields and malformed content', () => {
  const market = createMarket(11); setSyntheticDay(market, 1);
  fill(market, 's1', 1000, 100, '10:00', 'ai0', 'player');
  const report = buildPostCloseReport(market);
  assert.equal(validPostCloseReport(report, market), true);
  const legacy = structuredClone(report); legacy.seats.forEach(seat => { delete seat.observations; });
  assert.equal(validPostCloseReport(legacy, market), true);
  const corruptions: ((copy: typeof report) => void)[] = [
    copy => { copy.seats[0].observations![0].stockId = 'missing'; },
    copy => { copy.seats[0].observations![0].text = ''; },
    copy => { copy.seats[0].observations![0].text = 'x'.repeat(241); },
    copy => { copy.seats[0].observations![0].text = 'invalid\u0000text'; },
    copy => { Object.assign(copy.seats[0].observations![0], { kind: 'future' }); },
    copy => { Object.assign(copy.seats[0].observations![0], { privatePlan: 'buy tomorrow' }); },
    copy => { copy.seats[0].observations!.push(structuredClone(copy.seats[0].observations![0])); },
    copy => { Object.assign(copy.seats[0], { observations: {} }); },
  ];
  for (const corrupt of corruptions) {
    const copy = structuredClone(report); corrupt(copy);
    assert.equal(validPostCloseReport(copy, market), false);
  }
});
