import { BASE_STOCKS } from './stock-catalog.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarket, nextDay, advancePhase, getView, tick, submitOrder, cancelOrder,
  submitIpoSubscription, cancelIpoSubscription, validateMarket, type Market,
} from './engine.js';
import { advanceIpo, IPO_ISSUER_ID } from './ipo.js';
import { limitPrices } from '../shared/market-rules.js';

const cashSupply = (m: Market) => m.actors.reduce((sum, actor) => sum + actor.cash, 0) + m.brokerCash
  + Object.values(m.shorts).reduce((sum, p) => sum + p.proceeds, 0) + (m.challenge?.paid ?? 0);
const shares = (m: Market, stockId: string) => m.actors.reduce((sum, actor) => sum + (actor.positions[stockId]?.quantity ?? 0), 0)
  - (m.shorts[stockId]?.quantity ?? 0);
const player = (m: Market) => m.actors.find(a => a.id === 'player')!;
function firstOffer(seed = 42) {
  const m = createMarket(seed);
  for (let i = 0; i < 12 && !getView(m).ipos?.some(o => o.status === 'subscribing'); i++) nextDay(m);
  const offer = getView(m).ipos?.find(o => o.status === 'subscribing');
  assert.ok(offer, 'initial offer should be announced before trading day 12');
  return { m, offer };
}
function closeDay(m: Market) {
  for (let i = 0; i < 6 && m.phase !== 'night' && m.phase !== 'ended'; i++) advancePhase(m);
  assert.equal(m.phase, 'night');
}
function restore(m: Market): Market {
  const value: unknown = JSON.parse(JSON.stringify(m));
  assert.ok(validateMarket(value), 'legal IPO state must survive saved-data validation');
  return value;
}
function advanceFirstListing(seed = 42, subscribe = true) {
  const { m, offer } = firstOffer(seed);
  if (subscribe) assert.equal(submitIpoSubscription(m, offer.id, offer.quotaQuantity).ok, true);
  nextDay(m);
  const listed = getView(m).ipos!.find(o => o.id === offer.id)!;
  assert.equal(listed.status, 'listed');
  return { m, offer, listed };
}

test('IPO publication discloses only the current offer and never creates a tradable pre-listing stock', () => {
  const fresh = createMarket(42);
  assert.equal(fresh.stocks.length, BASE_STOCKS.length);
  assert.deepEqual(getView(fresh).ipos, []);
  assert.equal(submitIpoSubscription(fresh, 'ipo-1', 100).ok, false, 'guessing a scheduled ID cannot reserve an undisclosed offering');
  const { m, offer } = firstOffer();
  assert.equal(offer.announcementDay, m.day);
  assert.equal(offer.listingDay, m.day + 1);
  assert.equal(getView(m).stocks.some(s => s.id === offer.stockId), false);
  assert.equal(submitOrder(m, { stockId: offer.stockId, side: 'buy', quantity: 100, price: offer.issuePrice }).ok, false);
  assert.equal(m.trades.some(t => t.stockId === offer.stockId), false);
  const text = JSON.stringify(getView(m));
  for (const privateField of ['lotterySeed', 'companyIndex', 'allocations', 'subscriptions', 'rngState', 'ipoState']) {
    assert.equal(text.includes(`"${privateField}"`), false, `private IPO field leaked: ${privateField}`);
  }
  assert.equal(offer.allocatedQuantity, null);
  assert.equal(offer.issuedQuantity, null);
  assert.equal(offer.subscriptionRate, null);
});

test('IPO reservation and cancellation reuse no cash and do not permit a secondary order to spend reserved money', () => {
  const { m, offer } = firstOffer();
  m.paused = false;
  const before = getView(m), total = cashSupply(m), account = player(m).cash;
  assert.ok(offer.quotaQuantity >= 100);
  const reserved = offer.quotaQuantity * Math.round(offer.issuePrice * 100);
  assert.equal(submitIpoSubscription(m, offer.id, offer.quotaQuantity).ok, true);
  let view = getView(m);
  assert.equal(player(m).cash, account, 'reservation does not yet pay issuer');
  assert.equal(Math.round((before.availableCash - view.availableCash) * 100), reserved);
  assert.equal(Math.round(view.ipos![0].reservedAmount * 100), reserved);
  const stock = view.stocks[0];
  const quantity = Math.floor(before.availableCash / stock.limitDown / 100) * 100;
  assert.ok(quantity * stock.limitDown > view.availableCash);
  const blocked = submitOrder(m, { stockId: stock.id, side: 'buy', price: stock.limitDown, quantity });
  assert.equal(blocked.ok, false); assert.match(blocked.message, /现金不足/);
  assert.equal(submitIpoSubscription(m, offer.id, offer.quotaQuantity).ok, true);
  assert.equal(getView(m).availableCash, view.availableCash, 'same subscription is idempotent');
  for (const badQuantity of [0, -100, 101, Infinity, NaN, Number.MAX_SAFE_INTEGER, offer.quotaQuantity + 100]) {
    assert.equal(submitIpoSubscription(m, offer.id, badQuantity).ok, false);
    assert.equal(cashSupply(m), total);
  }
  assert.equal(cancelIpoSubscription(m, offer.id).ok, true);
  view = getView(m);
  assert.equal(view.availableCash, before.availableCash);
  assert.equal(view.ipos![0].reservedAmount, 0);
  assert.equal(cancelIpoSubscription(m, offer.id).ok, false, 'second cancellation cannot refund again');
  assert.equal(cashSupply(m), total);
  assert.ok(validateMarket(m));
});

test('existing order reservations reduce IPO affordability and cancellation does not create income', () => {
  const { m, offer } = firstOffer();
  m.paused = false;
  const before = getView(m), stock = before.stocks[0];
  const quantity = Math.floor((before.availableCash - offer.issuePrice * 100) / stock.limitDown / 100) * 100;
  assert.equal(submitOrder(m, { stockId: stock.id, side: 'buy', quantity, price: stock.limitDown }).ok, true);
  assert.equal(submitIpoSubscription(m, offer.id, offer.quotaQuantity).ok, false);
  const order = getView(m).orders.find(o => o.side === 'buy' && o.stockId === stock.id)!;
  assert.equal(cancelOrder(m, order.id).ok, true);
  assert.equal(submitIpoSubscription(m, offer.id, offer.quotaQuantity).ok, true);
  assert.equal(getView(m).cash, before.cash);
});

test('next-day primary allocation transfers actual cash, releases the remainder, and mints only recorded total shares', () => {
  const { m, offer } = firstOffer();
  const cash = cashSupply(m), playerCash = player(m).cash;
  const oldShares = new Map(m.stocks.map(s => [s.id, shares(m, s.id)]));
  assert.equal(submitIpoSubscription(m, offer.id, offer.quotaQuantity).ok, true);
  closeDay(m);
  assert.equal(getView(m).ipos![0].status, 'awaiting-listing');
  assert.equal(cancelIpoSubscription(m, offer.id).ok, false, 'subscription closes with the trading day');
  assert.equal(submitIpoSubscription(m, offer.id, 100).ok, false);
  nextDay(m);
  const view = getView(m), result = view.ipos!.find(o => o.id === offer.id)!;
  assert.equal(result.status, 'listed'); assert.ok(result.allocatedQuantity! > 0);
  assert.equal(result.reservedAmount, 0);
  const price = Math.round(offer.issuePrice * 100), allocated = result.allocatedQuantity!;
  assert.equal(player(m).cash, playerCash - allocated * price);
  assert.equal(Math.round(result.allocatedAmount! * 100), allocated * price);
  assert.equal(Math.round(result.refundAmount! * 100), (offer.quotaQuantity - allocated) * price);
  assert.equal(cashSupply(m), cash);
  const issuer = m.actors.find(a => a.id === IPO_ISSUER_ID)!;
  assert.equal(issuer.cash, result.issuedQuantity! * price);
  assert.equal(issuer.positions[offer.stockId].quantity, offer.totalShares - result.issuedQuantity!);
  assert.equal(shares(m, offer.stockId), offer.totalShares);
  for (const [id, amount] of oldShares) assert.equal(shares(m, id), amount);
  assert.equal(m.trades.some(t => t.stockId === offer.stockId), false, 'primary allotment is not secondary volume');
  const stock = view.stocks.find(s => s.id === offer.stockId)!;
  assert.equal(stock.volume, 0); assert.equal(stock.open, 0); assert.deepEqual(stock.dailyBars, []);
  assert.equal(stock.dailyHistoryStartDay, m.day);
  assert.equal(stock.limitUp, Math.round(price * 1.3) / 100);
  assert.equal(stock.limitDown, Math.round(price * .7) / 100);
  assert.equal(view.positions.find(p => p.stockId === offer.stockId)!.available, allocated);
  assert.ok(validateMarket(m));
});

test('allotments can be sold on listing day while new secondary purchases remain T+1', () => {
  const { m, offer, listed } = advanceFirstListing();
  const allotted = listed.allocatedQuantity!;
  assert.ok(allotted >= 100);
  advancePhase(m); m.paused = false;
  let view = getView(m), s = view.stocks.find(s => s.id === offer.stockId)!;
  let sold = false;
  for (let i = 0; i < 80 && !sold; i++) {
    const before = m.trades.length;
    const bid = s.bids[0]?.price;
    if (bid) {
      assert.equal(submitOrder(m, { stockId: s.id, side: 'sell', quantity: 100, price: bid }).ok, true);
      sold = m.trades.slice(before).some(t => t.sellerId === 'player' && t.stockId === s.id);
    }
    if (!sold) tick(m);
    s = getView(m).stocks.find(stock => stock.id === offer.stockId)!;
  }
  assert.ok(sold, 'real funded buyer should accept at least one allotted lot');
  for (const order of getView(m).orders.filter(o => o.stockId === offer.stockId && (o.status === 'open' || o.status === 'partial'))) cancelOrder(m, order.id);
  let bought = false;
  for (let i = 0; i < 80 && !bought; i++) {
    s = getView(m).stocks.find(stock => stock.id === offer.stockId)!;
    const before = m.trades.length, ask = s.asks[0]?.price;
    if (ask) {
      assert.equal(submitOrder(m, { stockId: s.id, side: 'buy', quantity: 100, price: ask }).ok, true);
      bought = m.trades.slice(before).some(t => t.buyerId === 'player' && t.stockId === s.id);
    }
    if (!bought) tick(m);
  }
  assert.ok(bought, 'a real ask must execute the secondary purchase');
  const position = getView(m).positions.find(p => p.stockId === offer.stockId)!;
  assert.equal(position.todayBought, 100);
  assert.equal(position.available, allotted - 100);
  assert.equal(submitOrder(m, { stockId: offer.stockId, side: 'sell', quantity: position.quantity, price: s.limitDown }).ok, false);
  nextDay(m);
  view = getView(m); s = view.stocks.find(stock => stock.id === offer.stockId)!;
  assert.equal(view.positions.find(p => p.stockId === offer.stockId)!.todayBought, 0);
  assert.equal(s.limitUp, Math.round(s.previousClose * 100 * 1.1) / 100);
  assert.equal(s.limitDown, Math.round(s.previousClose * 100 * .9) / 100);
  assert.ok(s.dailyBars.length > 0 && s.dailyBars.every(b => b.day >= listed.listingDay && b.origin !== 'background'));
});

test('the order gate permits the first-day 30 percent band and reverts to yesterday-close 10 percent next day', () => {
  const { m, offer } = advanceFirstListing(42, false); m.paused = false;
  let stock = getView(m).stocks.find(s => s.id === offer.stockId)!;
  assert.equal(submitOrder(m, { stockId: stock.id, side: 'buy', quantity: 100,
    price: Math.round((stock.limitUp + .01) * 100) / 100 }).ok, false);
  assert.equal(submitOrder(m, { stockId: stock.id, side: 'buy', quantity: 100,
    price: Math.round(stock.previousClose * 1.15 * 100) / 100 }).ok, true);
  const order = getView(m).orders.find(o => o.stockId === offer.stockId)!;
  assert.equal(cancelOrder(m, order.id).ok, true);
  nextDay(m); m.paused = false;
  stock = getView(m).stocks.find(s => s.id === offer.stockId)!;
  assert.equal(submitOrder(m, { stockId: stock.id, side: 'buy', quantity: 100,
    price: Math.round(stock.previousClose * 1.15 * 100) / 100 }).ok, false);
});

test('IPO restored at allocation is idempotent, deterministic, and rejects fabricated issuer balances or pre-listing history', () => {
  const { m, offer } = advanceFirstListing();
  const clone = restore(m), snapshot = structuredClone(m);
  assert.deepEqual(advanceIpo(m, {
    availableCash: id => m.actors.find(a => a.id === id)!.cash,
    equity: id => m.actors.find(a => a.id === id)!.cash,
  }), []);
  assert.deepEqual(m, snapshot, 'same listing boundary cannot allocate twice');
  closeDay(m); closeDay(clone); nextDay(m); nextDay(clone);
  assert.deepEqual(m, clone, 'restored issuance, orders and random streams should replay identically');
  for (const mutate of [
    (bad: Market) => { bad.actors.find(a => a.id === IPO_ISSUER_ID)!.cash++; },
    (bad: Market) => { bad.actors.find(a => a.id === IPO_ISSUER_ID)!.positions[offer.stockId].quantity += 100; },
    (bad: Market) => { bad.ipoState!.offers[0].lotterySeed++; },
    (bad: Market) => { bad.ipoState!.offers[0].allocations.player += 100; },
    (bad: Market) => { bad.stocks.find(s => s.id === offer.stockId)!.dailyBars![0].day = 0; },
  ]) {
    const bad = structuredClone(m); mutate(bad); assert.equal(validateMarket(bad), false);
  }
});

test('a failed issue creates no shares, while a player-only allotment cannot manufacture a first-day price move', () => {
  const m = createMarket(20261020);
  for (let guard = 0; guard < 65 && !getView(m).ipos?.some(o => o.id === 'ipo-3' && o.status === 'subscribing'); guard++) nextDay(m);
  const offer = getView(m).ipos!.find(o => o.id === 'ipo-3' && o.status === 'subscribing');
  assert.ok(offer, 'the public third subscription window should arrive');
  const noDemand = restore(m), issuerBefore = noDemand.actors.find(a => a.id === IPO_ISSUER_ID)!.cash;
  assert.equal(submitIpoSubscription(m, offer.id, 100).ok, true);
  nextDay(noDemand); nextDay(m);
  const cancelled = getView(noDemand).ipos!.find(o => o.id === offer.id)!;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.cancelReason, 'no-demand');
  assert.equal(noDemand.stocks.some(s => s.id === offer.stockId), false);
  assert.equal(noDemand.actors.find(a => a.id === IPO_ISSUER_ID)!.cash, issuerBefore);
  const listed = getView(m).ipos!.find(o => o.id === offer.id)!;
  assert.equal(listed.status, 'listed'); assert.equal(listed.issuedQuantity, 100); assert.equal(listed.allocatedQuantity, 100);
  closeDay(m);
  const stock = getView(m).stocks.find(s => s.id === offer.stockId)!;
  assert.equal(stock.volume, 0); assert.equal(stock.price, offer.issuePrice);
  assert.deepEqual(stock.dailyBars, []);
  assert.equal(m.trades.some(t => t.stockId === offer.stockId), false);
  assert.ok(validateMarket(m)); assert.ok(validateMarket(noDemand));
});

test('at most four irregularly timed issues expand the finite market without manufactured bars or off-band executions', () => {
  const m = createMarket(20261020), cash = cashSupply(m), original = new Map(m.stocks.map(s => [s.id, shares(m, s.id)]));
  const counts: number[] = [], listingDays: number[] = [];
  for (let day = 1; day <= 71; day++) {
    const before = m.stocks.length; closeDay(m);
    assert.equal(cashSupply(m), cash);
    for (const s of m.stocks) {
      const issued = getView(m).ipos?.find(o => o.stockId === s.id);
      assert.equal(shares(m, s.id), original.get(s.id) ?? issued!.totalShares);
      const bounds = limitPrices(s, m.day);
      for (const trade of m.trades.filter(t => t.day === m.day && t.stockId === s.id)) {
        assert.ok(trade.price >= bounds.low && trade.price <= bounds.high);
      }
      if (s.listedDay !== undefined) assert.ok(s.dailyBars!.every(bar => bar.day >= s.listedDay! && bar.origin !== 'background'));
    }
    assert.ok(validateMarket(m));
    counts.push(m.stocks.length);
    if (day < 71) {
      nextDay(m);
      if (m.stocks.length > before) listingDays.push(m.day);
    }
  }
  const offers = getView(m).ipos!;
  const listed = offers.filter(offer => offer.status === 'listed');
  assert.equal(offers.length, 4, 'all four initial offering windows should have resolved by the end');
  assert.equal(m.stocks.length, BASE_STOCKS.length + listed.length); assert.equal(listingDays.length, listed.length);
  assert.ok(counts.every(count => count >= BASE_STOCKS.length && count <= BASE_STOCKS.length + 4));
  assert.equal(new Set(m.stocks.map(s => s.id)).size, m.stocks.length);
  const offerDates = offers.map(offer => offer.listingDay).sort((a, b) => a - b);
  const intervals = offerDates.slice(1).map((day, i) => day - offerDates[i]);
  assert.ok(new Set(intervals).size > 1, 'this seed should not produce a fixed-period listing schedule');
  assert.equal(m.actors.filter(a => a.id === IPO_ISSUER_ID).length, listed.length ? 1 : 0);
  for (const offer of offers.filter(offer => offer.status === 'cancelled')) {
    assert.equal(offer.cancelReason, 'no-demand');
    assert.equal(m.stocks.some(stock => stock.id === offer.stockId), false);
    assert.equal(m.actors.some(actor => (actor.positions[offer.stockId]?.quantity ?? 0) > 0), false);
  }
  assert.equal(m.orders.some(o => o.actorId === IPO_ISSUER_ID), false);
  assert.equal(m.trades.some(t => t.buyerId === IPO_ISSUER_ID || t.sellerId === IPO_ISSUER_ID), false);
});
