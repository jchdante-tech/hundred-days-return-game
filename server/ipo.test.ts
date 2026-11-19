import { BASE_STOCKS } from './stock-catalog.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, type Market } from './engine.js';
import { advanceIpo, cancelIpo, initIpo, ipoForView, ipoReservedCash, IPO_ISSUER_ID,
  subscribeIpo, releasePendingIpo, validateIpoState, type IpoFinance, type IpoState } from './ipo.js';

type TestMarket = Market & { ipoState?: IpoState };

function fixture(seed = 42) {
  const market: TestMarket = createMarket(seed);
  market.orders = [];
  initIpo(market);
  return market;
}

function finances(market: TestMarket, npc = true): IpoFinance {
  return {
    availableCash: id => (id === 'player' || npc) ? Math.max(0, market.actors.find(actor => actor.id === id)!.cash
      - market.orders.filter(order => order.actorId === id && (order.status === 'open' || order.status === 'partial'))
        .reduce((sum, order) => sum + order.frozenCash, 0) - ipoReservedCash(market, id)) : 0,
    equity: id => {
      const actor = market.actors.find(actor => actor.id === id)!;
      return actor.cash + market.stocks.reduce((sum, stock) => sum + (actor.positions[stock.id]?.quantity ?? 0) * stock.price, 0);
    },
  };
}

function opening(market: Market, day: number) {
  const date = new Date('2026-10-20T00:00:00Z');
  for (let tradingDay = 1; tradingDay < day; tradingDay++) {
    do { date.setUTCDate(date.getUTCDate() + 1); }
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6 || date.toISOString().slice(0, 10) === '2027-01-01');
  }
  market.day = day; market.phase = 'auction'; market.phaseElapsed = 0;
  market.calendarDate = date.toISOString().slice(0, 10);
}

function announce(market: TestMarket, finance = finances(market), index = 0) {
  const offer = market.ipoState!.offers[index];
  opening(market, offer.announcementDay);
  const events = advanceIpo(market, finance);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'announcement');
  return offer;
}

const cashTotal = (market: Market) => market.actors.reduce((sum, actor) => sum + actor.cash, 0);

test('private IPO schedule is bounded, spaced, independent of trading RNG, and invisible before announcement', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const market = fixture(seed), state = market.ipoState!;
    assert.equal(state.offers.length, 4);
    assert.ok(state.offers[0].listingDay >= 5 && state.offers[0].listingDay <= 9);
    for (const [index, offer] of state.offers.entries()) {
      assert.equal(offer.announcementDay, offer.listingDay - 1);
      if (index) assert.ok(offer.listingDay - state.offers[index - 1].listingDay >= 12
        && offer.listingDay - state.offers[index - 1].listingDay <= 20);
    }
    assert.equal(new Set(state.offers.map(offer => offer.companyIndex)).size, 4);
    assert.deepEqual(ipoForView(market), []);
    const clone: TestMarket = JSON.parse(JSON.stringify(market));
    delete clone.ipoState; clone.rngState ^= 321; clone.trades.reverse();
    const before = JSON.stringify({ actors: clone.actors, stocks: clone.stocks, rngState: clone.rngState });
    assert.deepEqual(initIpo(clone), state);
    assert.equal(JSON.stringify({ actors: clone.actors, stocks: clone.stocks, rngState: clone.rngState }), before);
    assert.equal(initIpo(clone), clone.ipoState, 'initialization is idempotent');
    assert.equal(validateIpoState(state, market), true);
  }
});

test('legacy initialization starts new offers five to nine sessions later and never replays missed ones', () => {
  const market = fixture();
  delete market.ipoState; opening(market, 21);
  const state = initIpo(market);
  assert.ok(state.offers[0].listingDay >= 26 && state.offers[0].listingDay <= 30);
  assert.deepEqual(advanceIpo(market, finances(market)), []);
});

test('announcement and settlement run only at 09:15, with a fixed cash-backed player quota', () => {
  const market = fixture(), finance = finances(market), offer = market.ipoState!.offers[0];
  opening(market, offer.announcementDay); market.phaseElapsed = 1;
  assert.deepEqual(advanceIpo(market, finance), []);
  market.phase = 'morning'; market.phaseElapsed = 0;
  assert.deepEqual(advanceIpo(market, finance), []);
  market.phase = 'auction';
  const cash = market.actors[0].cash, rng = market.rngState;
  advanceIpo(market, finance);
  const view = ipoForView(market)[0];
  assert.equal(view.status, 'subscribing');
  assert.ok(view.quotaAmount <= 1_000_000);
  assert.equal(view.quotaQuantity % 100, 0);
  assert.equal(view.quotaAmount, view.quotaQuantity * view.issuePrice);
  assert.equal(market.actors[0].cash, cash);
  assert.equal(market.rngState, rng);
  assert.equal(view.allocatedQuantity, null);
  assert.equal(view.subscriptionRate, null);
  assert.equal(market.stocks.length, BASE_STOCKS.length);
  assert.deepEqual(advanceIpo(market, finance), []);
  const serialized = JSON.stringify(view);
  for (const privateKey of ['lotterySeed', 'companyIndex', 'allocations', 'subscriptions', 'fair', 'rngState']) assert.equal(serialized.includes(`"${privateKey}"`), false);
});

test('quota respects ten percent equity, the 200 万 cap, and currently usable cash', () => {
  const cases = [{ equity: 10_000_000_000, cash: 10_000_000_000, cap: 200_000_000 },
    { equity: 500_000_000, cash: 10_000_000_000, cap: 50_000_000 },
    { equity: 10_000_000_000, cash: 123_456, cap: 123_456 },
    { equity: -100, cash: 10_000_000_000, cap: 0 }];
  for (const row of cases) {
    const market = fixture(), finance: IpoFinance = { equity: () => row.equity, availableCash: () => row.cash };
    const offer = announce(market, finance);
    assert.equal(offer.playerQuotaQuantity, Math.floor(row.cap / offer.issuePrice / 100) * 100);
  }
});

test('subscribe, resize, duplicate submit, and cancel only reserve money and cannot exceed spendable funds', () => {
  const market = fixture(), finance = finances(market), offer = announce(market, finance);
  const originalCash = market.actors[0].cash, rngState = market.rngState, privateRng = market.ipoState!.rngState;
  assert.equal(subscribeIpo(market, offer.id, 1000, finance).ok, true);
  assert.equal(ipoReservedCash(market), offer.issuePrice * 1000);
  assert.equal(market.actors[0].cash, originalCash);
  const revision = market.revision;
  assert.equal(subscribeIpo(market, offer.id, 1000, finance).ok, true);
  assert.equal(market.revision, revision);
  assert.equal(subscribeIpo(market, offer.id, 2000, finance).ok, true);
  assert.equal(ipoReservedCash(market), offer.issuePrice * 2000);
  assert.equal(subscribeIpo(market, offer.id, 100, finance).ok, true);
  assert.equal(ipoReservedCash(market), offer.issuePrice * 100);
  for (const quantity of [0, -100, 101, 100.5, Infinity, offer.playerQuotaQuantity + 100]) assert.equal(subscribeIpo(market, offer.id, quantity, finance).ok, false);
  assert.equal(subscribeIpo(market, offer.id, 200, { ...finance, availableCash: () => 0 }).ok, false);
  assert.equal(cancelIpo(market, offer.id).ok, true);
  assert.equal(ipoReservedCash(market), 0);
  assert.equal(market.actors[0].cash, originalCash);
  assert.equal(market.rngState, rngState);
  assert.equal(market.ipoState!.rngState, privateRng);
  assert.equal(validateIpoState(market.ipoState, market), true);
});

test('IPO subscriptions allow lunch and closing but lock after the session closes', () => {
  const market = fixture(), finance = finances(market), offer = announce(market, finance);
  market.phase = 'lunch';
  assert.equal(subscribeIpo(market, offer.id, 100, finance).ok, true);
  market.phase = 'closing';
  assert.equal(cancelIpo(market, offer.id).ok, true);
  assert.equal(subscribeIpo(market, offer.id, 200, finance).ok, true);
  market.phase = 'night';
  assert.equal(cancelIpo(market, offer.id).ok, false);
  assert.equal(subscribeIpo(market, offer.id, 100, finance).ok, false);
  assert.equal(ipoForView(market)[0].status, 'awaiting-listing');
  assert.equal(ipoReservedCash(market), 200 * offer.issuePrice);
});

test('terminal cancellation releases pending reservations without inventing cash or changing completed allocations', () => {
  const market = fixture(101), finance = finances(market);
  const first = announce(market, finance);
  opening(market, first.listingDay); advanceIpo(market, finance);
  const completed = JSON.stringify(first), firstStock = JSON.stringify(market.stocks.at(-1));
  const pending = announce(market, finance, 1);
  subscribeIpo(market, pending.id, 1000, finance);
  market.phase = 'night';
  const originalActors = JSON.stringify(market.actors), initialCash = market.actors[0].cash;
  const frozen = ipoReservedCash(market), freeBefore = finance.availableCash('player');
  const result = releasePendingIpo(market);
  assert.deepEqual(result, [{ offerId: pending.id, name: ipoForView(market)[0].name, releasedAmount: frozen / 100 }]);
  assert.equal(ipoReservedCash(market), 0);
  assert.equal(finance.availableCash('player'), freeBefore + frozen);
  assert.equal(market.actors[0].cash, initialCash);
  assert.equal(JSON.stringify(market.actors), originalActors);
  assert.equal(JSON.stringify(first), completed);
  assert.equal(JSON.stringify(market.stocks.at(-1)), firstStock);
  market.phase = 'ended'; market.result = 'default';
  const view = ipoForView(market)[0];
  assert.equal(view.status, 'cancelled'); assert.equal(view.subscribedQuantity, 1000);
  assert.equal(view.cancelReason, 'game-ended');
  assert.equal(view.allocatedQuantity, 0); assert.equal(view.allocatedAmount, 0);
  assert.equal(view.reservedAmount, 0); assert.equal(view.refundAmount, frozen / 100);
  assert.equal(validateIpoState(market.ipoState, market), true);
  const beforeSecondRelease = JSON.stringify(market);
  assert.deepEqual(releasePendingIpo(market), []);
  assert.equal(JSON.stringify(market), beforeSecondRelease);
  assert.equal(cancelIpo(market, pending.id).ok, false);
});

test('named NPCs select IPOs according to public demand and valuation instead of all subscribing', () => {
  const participation = new Map<string, number>();
  let offers = 0, totalParticipating = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const market = fixture(seed);
    for (let index = 0; index < 4; index++) {
      const finance = finances(market), offer = announce(market, finance, index);
      opening(market, offer.listingDay); advanceIpo(market, finance);
      const seats = Object.keys(offer.subscriptions).filter(id => id.startsWith('ai'));
      assert.ok(seats.length < 6, 'every issue must leave at least some named seats observing');
      for (const id of seats) participation.set(id, (participation.get(id) ?? 0) + 1);
      totalParticipating += seats.length; offers++;
      if (offer.factors.demand !== 'strong') {
        assert.equal(offer.subscriptions.ai0, undefined, 'trend seat needs strong public demand before any price prints');
        assert.equal(offer.subscriptions.ai2, undefined, 'theme seat does not subscribe to every quiet issue');
      } else assert.equal(offer.subscriptions.ai1, undefined, 'contrarian seat does not also subscribe to every strong-demand issue');
      if (offer.factors.issuePe > offer.factors.peerPe) assert.equal(offer.subscriptions.ai5, undefined, 'value seat waits when the issue PE is above peers');
      assert.equal(validateIpoState(market.ipoState, market), true);
    }
  }
  assert.ok(totalParticipating > 0 && totalParticipating < offers * 3);
  assert.ok(participation.size >= 5, 'multiple named styles must have possible qualifying opportunities');
  assert.ok(new Set(participation.values()).size > 2, 'styles must not have identical participation patterns');
});

test('listing conserves cash and issued shares without fabricating a trade or historical candle', () => {
  const market = fixture(), finance = finances(market), offer = announce(market, finance);
  assert.equal(subscribeIpo(market, offer.id, offer.playerQuotaQuantity, finance).ok, true);
  const totalBefore = cashTotal(market), playerBefore = market.actors[0].cash, initialStockCount = market.stocks.length;
  const tradesBefore = [...market.trades];
  opening(market, offer.listingDay);
  const events = advanceIpo(market, finance);
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'listing');
  assert.equal(cashTotal(market), totalBefore);
  assert.equal(market.stocks.length, initialStockCount + 1);
  const stock = market.stocks.find(stock => stock.id === offer.stockId)!;
  assert.equal(stock.volume, 0); assert.equal(stock.turnover, 0);
  assert.equal(stock.open, 0); assert.equal(stock.high, 0); assert.equal(stock.low, 0);
  assert.equal(stock.price, offer.issuePrice); assert.equal(stock.previousClose, offer.issuePrice);
  assert.deepEqual(stock.history, []); assert.deepEqual(stock.dailyBars, []);
  assert.deepEqual(market.trades, tradesBefore);
  assert.equal(stock.listedDay, offer.listingDay); assert.equal(stock.dailyHistoryStartDay, offer.listingDay);
  assert.equal(market.actors.reduce((sum, actor) => sum + (actor.positions[offer.stockId]?.quantity ?? 0), 0), offer.totalShares);
  const playerAllocation = offer.allocations.player ?? 0;
  assert.equal(market.actors[0].positions[offer.stockId]?.quantity ?? 0, playerAllocation);
  assert.equal(market.actors[0].positions[offer.stockId]?.today ?? 0, 0);
  assert.equal(playerBefore - market.actors[0].cash, playerAllocation * offer.issuePrice);
  assert.equal(events[0].playerPaidAmount * 100, playerAllocation * offer.issuePrice);
  assert.equal(events[0].playerReleasedAmount * 100, (offer.playerQuotaQuantity - playerAllocation) * offer.issuePrice);
  assert.equal(ipoReservedCash(market), 0);
  assert.equal(validateIpoState(market.ipoState, market), true);
  const beforeDuplicate = JSON.stringify(market);
  assert.deepEqual(advanceIpo(market, finance), []);
  assert.equal(JSON.stringify(market), beforeDuplicate);
});

test('undersubscribed issuance fills every funded request and leaves unsold shares at the issuer', () => {
  const market = fixture(12), finance = finances(market, false), offer = announce(market, finance);
  subscribeIpo(market, offer.id, 1000, finance);
  opening(market, offer.listingDay); advanceIpo(market, finance);
  assert.equal(offer.allocations.player, 1000);
  assert.equal(market.actors.find(actor => actor.id === IPO_ISSUER_ID)!.positions[offer.stockId].quantity, offer.totalShares - 1000);
  const view = ipoForView(market)[0];
  assert.equal(view.refundAmount, 0); assert.equal(view.issuedQuantity, 1000);
  assert.ok(view.subscriptionRate! < 1);
  assert.equal(validateIpoState(market.ipoState, market), true);
});

test('zero effective subscriptions cancel the issue instead of creating an untradable zero-float stock', () => {
  const market = fixture(12), finance = finances(market, false), offer = announce(market, finance);
  opening(market, offer.listingDay);
  const prior = JSON.stringify({ actors: market.actors, stocks: market.stocks, trades: market.trades, rng: market.rngState });
  const events = advanceIpo(market, finance);
  assert.deepEqual(events, [{ kind: 'cancelled', offerId: offer.id, stockId: offer.stockId,
    name: ipoForView(market)[0].name, playerAllocatedQuantity: 0, playerPaidAmount: 0, playerReleasedAmount: 0 }]);
  assert.equal(JSON.stringify({ actors: market.actors, stocks: market.stocks, trades: market.trades, rng: market.rngState }), prior);
  assert.equal(market.actors.some(actor => actor.id === IPO_ISSUER_ID), false);
  assert.equal(market.stocks.some(stock => stock.id === offer.stockId), false);
  const view = ipoForView(market)[0];
  assert.equal(view.status, 'cancelled'); assert.equal(view.cancelReason, 'no-demand');
  assert.equal(view.issuedQuantity, 0); assert.equal(view.subscriptionRate, 0);
  assert.equal(view.reservedAmount, 0); assert.equal(view.allocatedQuantity, 0);
  assert.equal(validateIpoState(market.ipoState, market), true);
  assert.deepEqual(advanceIpo(market, finance), []);
});

test('a player who does not subscribe is distinct from an issue with no effective demand', () => {
  const market = fixture(101), finance = finances(market), offer = announce(market, finance);
  opening(market, offer.listingDay);
  const events = advanceIpo(market, finance);
  assert.equal(events[0].kind, 'listing');
  const view = ipoForView(market)[0];
  assert.equal(view.status, 'listed'); assert.equal(view.cancelReason, undefined);
  assert.equal(view.subscribedQuantity, 0); assert.equal(view.allocatedQuantity, 0);
  assert.ok(view.issuedQuantity! > 0);
});

test('funded oversubscription can allocate partially or zero, never more than actual issue supply', () => {
  let partial = false, zero = false;
  for (let seed = 1; seed <= 80 && (!partial || !zero); seed++) {
    for (const oneLot of [false, true]) {
      const market = fixture(seed), finance = finances(market), offer = announce(market, finance);
      const requested = oneLot ? 100 : offer.playerQuotaQuantity;
      subscribeIpo(market, offer.id, requested, finance);
      opening(market, offer.listingDay); advanceIpo(market, finance);
      const allocated = offer.allocations.player ?? 0;
      partial ||= allocated > 0 && allocated < requested;
      zero ||= allocated === 0;
      assert.equal(offer.status, 'listed', 'an unsuccessful player ticket is not a cancelled issuance');
      assert.ok(allocated <= requested);
      assert.equal(allocated % 100, 0);
      assert.equal(Object.values(offer.allocations).reduce((sum, q) => sum + q, 0), Math.min(offer.offeredShares, offer.eligibleQuantity));
      assert.equal(validateIpoState(market.ipoState, market), true);
    }
  }
  assert.equal(partial, true); assert.equal(zero, true);
});

test('cancel and reapply does not reroll fixed tickets, and save/restore keeps the exact allotment', () => {
  const first = fixture(17), finance = finances(first), offer = announce(first, finance);
  subscribeIpo(first, offer.id, offer.playerQuotaQuantity, finance);
  const second: TestMarket = JSON.parse(JSON.stringify(first));
  second.rngState ^= 0x123456;
  for (let i = 0; i < 5; i++) {
    cancelIpo(second, offer.id);
    subscribeIpo(second, offer.id, offer.playerQuotaQuantity, finances(second));
  }
  opening(first, offer.listingDay); opening(second, offer.listingDay);
  advanceIpo(first, finances(first)); advanceIpo(second, finances(second));
  assert.deepEqual(first.ipoState, second.ipoState);
  assert.deepEqual(first.actors, second.actors);
  assert.equal(validateIpoState(JSON.parse(JSON.stringify(first.ipoState)), first), true);
});

test('up to four actual issuances share one issuer and never grow the universe beyond sixteen stocks', () => {
  const market = fixture(101), totalCash = cashTotal(market);
  for (let index = 0; index < 4; index++) {
    const finance = finances(market), offer = announce(market, finance, index);
    opening(market, offer.listingDay); advanceIpo(market, finance);
    assert.equal(market.actors.filter(actor => actor.id === IPO_ISSUER_ID).length, 1);
    assert.equal(cashTotal(market), totalCash);
    assert.equal(validateIpoState(market.ipoState, market), true);
  }
  assert.equal(market.stocks.length, BASE_STOCKS.length + market.ipoState!.offers.filter(offer => offer.status === 'listed').length);
  assert.ok(market.stocks.length <= BASE_STOCKS.length + 4);
  assert.equal(ipoForView(market).length, 4);
});

test('insufficient deadline window skips the offer before freezing any funds', () => {
  for (const dates of [{ date: '2027-01-26', deadline: '2027-01-28' },
    { date: '2027-01-22', deadline: '2027-01-25' }]) {
    const market = fixture(), offer = market.ipoState!.offers[0];
    opening(market, offer.announcementDay);
    market.calendarDate = dates.date; market.deadlineDate = dates.deadline;
    assert.deepEqual(advanceIpo(market, finances(market)), []);
    assert.equal(offer.status, 'skipped');
    assert.equal(ipoReservedCash(market), 0);
    assert.deepEqual(ipoForView(market), []);
    assert.equal(validateIpoState(market.ipoState, market), true);
  }
});

test('public demand and valuation can disagree, so issue prices are not scripted profitable entries', () => {
  let expensiveHot = false, cheapQuiet = false;
  for (let seed = 1; seed <= 30; seed++) for (const offer of fixture(seed).ipoState!.offers) {
    const demandFactor = { weak: .85, steady: 1, strong: 1.15 }[offer.factors.demand];
    assert.equal(offer.fair, Math.round(offer.issuePrice / offer.factors.issuePe * offer.factors.peerPe * demandFactor));
    expensiveHot ||= offer.factors.demand === 'strong' && offer.issuePrice > offer.fair;
    cheapQuiet ||= offer.factors.demand === 'weak' && offer.issuePrice < offer.fair;
  }
  assert.equal(expensiveHot, true); assert.equal(cheapQuiet, true);
});

test('strict restore rejects forged schedules, unknown subscribers, excess allotments, and issuer leakage', () => {
  const market = fixture(), finance = finances(market), offer = announce(market, finance);
  subscribeIpo(market, offer.id, 1000, finance);
  const mutations: ((m: TestMarket) => void)[] = [
    m => { m.ipoState!.offers[0].listingDay++; },
    m => { m.ipoState!.offers[0].fair++; },
    m => { m.ipoState!.offers[0].lotterySeed++; },
    m => { m.ipoState!.rngState++; },
    m => { m.ipoState!.offers[0].factors.issuePe++; },
    m => { m.ipoState!.offers[0].subscriptions.ghost = 100; },
    m => { m.ipoState!.offers[0].subscriptions.player = 101; },
    m => { m.ipoState!.offers[0].allocations.player = 100; },
    m => { m.ipoState!.offers[0].playerQuotaQuantity = 99_999_900; },
  ];
  for (const mutate of mutations) {
    const clone: TestMarket = JSON.parse(JSON.stringify(market)); mutate(clone);
    assert.equal(validateIpoState(clone.ipoState, clone), false);
  }
  opening(market, offer.listingDay); advanceIpo(market, finance);
  const listedMutations: ((m: TestMarket) => void)[] = [
    m => { m.actors.find(actor => actor.id === IPO_ISSUER_ID)!.cash++; },
    m => { m.actors.find(actor => actor.id === IPO_ISSUER_ID)!.positions[offer.stockId].quantity += 100; },
    m => { m.stocks.find(stock => stock.id === offer.stockId)!.listedDay = offer.listingDay + 1; },
    m => { m.stocks.find(stock => stock.id === offer.stockId)!.dailyBars!.push({ day: 0, date: '2026-10-19',
      open: 1000, high: 1000, low: 1000, close: 1000, volume: 100, turnover: 100000, complete: true, origin: 'background' }); },
    m => { m.ipoState!.offers[0].allocations.player = m.ipoState!.offers[0].subscriptions.player + 100; },
  ];
  for (const mutate of listedMutations) {
    const clone: TestMarket = JSON.parse(JSON.stringify(market)); mutate(clone);
    assert.equal(validateIpoState(clone.ipoState, clone), false);
  }
});
