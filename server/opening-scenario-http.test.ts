import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { readMarketEnvelope, type WireApiResponse } from '../shared/market-sync.js';
import type { MarketView } from '../shared/types.js';
import { createMarket, getView, repayChallenge, validateMarket, type Market } from './engine.js';
import { createApplication } from './index.js';
import { writeSnapshot } from './snapshot-store.js';

interface Snapshot {
  saveVersion: number;
  savedAt: string;
  state: Market;
  requests: { requestId: string; fingerprint: string; result: { ok: boolean; message?: string } }[];
}

interface Running { base: string; server: Server; stop: () => Promise<void> }
interface Reply { status: number; body: WireApiResponse; cookie: string | null }

async function call(application: Running, path: string, cookie?: string, body?: Record<string, unknown>): Promise<Reply> {
  const response = await fetch(application.base + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(cookie ? { cookie } : {}),
      ...(body ? { origin: application.base, 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() as WireApiResponse,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null };
}

function action(application: Running, cookie: string, body: Record<string, unknown>) {
  return call(application, '/api/action', cookie, { requestId: randomUUID(), ...body });
}

async function close(application: Running) {
  await application.stop();
  if (application.server.listening) {
    await new Promise<void>((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
  }
}

async function harness(context: TestContext) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'youzi-opening-http-'));
  const applications: Running[] = [];
  let clock = Date.now();
  const filename = (cookie: string) => join(dataDirectory, `${cookie.split('=')[1]}.json`);
  context.after(async () => {
    for (const application of applications) await close(application);
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return {
    async launch(writer: typeof writeSnapshot = writeSnapshot) {
      // Exercise the production default. Legacy mechanism harnesses explicitly
      // opt out; this one must never disable the opening scenario.
      const application = createApplication({ dataDirectory, now: () => clock, production: false,
        publicOrigin: '', publicOriginAliases: [], writeSnapshot: writer });
      const server = application.app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const running = { base: `http://127.0.0.1:${address.port}`, server, stop: application.stop };
      applications.push(running);
      return running;
    },
    async start(application: Running, seed: number, extra: Record<string, unknown> = {}) {
      const reply = await call(application, '/api/start', undefined, { seed, ...extra });
      assert.equal(reply.status, 200);
      assert.ok(reply.cookie && reply.body.market && reply.body.sync);
      return { cookie: reply.cookie, market: reply.body.market, body: reply.body };
    },
    async snapshot(cookie: string) {
      return JSON.parse(await readFile(filename(cookie), 'utf8')) as Snapshot;
    },
    async replaceSnapshot(cookie: string, snapshot: Snapshot) {
      await writeSnapshot(filename(cookie), JSON.stringify(snapshot));
    },
    async second(application: Running, cookies: string[]) {
      const before = await Promise.all(cookies.map(cookie => call(application, '/api/market', cookie)));
      clock += 1000;
      return Promise.all(cookies.map(async (cookie, index) => {
        const deadline = Date.now() + 5000;
        let reply: Reply;
        do {
          await new Promise(resolve => setTimeout(resolve, 25));
          reply = await call(application, '/api/market', cookie);
          assert.equal(reply.status, 200);
          assert.ok(Date.now() < deadline, 'the real background tick did not commit before the deadline');
        } while (reply.body.market!.revision <= before[index].body.market!.revision);
        return reply;
      }));
    },
  };
}

function position(market: MarketView) {
  const value = market.positions.find(item => item.stockId === market.openingScenario!.stockId);
  assert.ok(value);
  return value;
}

function conserved(state: Market) {
  return {
    cash: state.actors.reduce((sum, actor) => sum + actor.cash, state.brokerCash),
    shares: Object.fromEntries(state.stocks.map(stock => [stock.id,
      state.actors.reduce((sum, actor) => sum + (actor.positions[stock.id]?.quantity ?? 0), 0)])),
  };
}

function assertPublicScenario(market: MarketView) {
  assert.deepEqual(Object.keys(market.openingScenario!).sort(),
    ['boughtQuantity', 'saleProceeds', 'soldQuantity', 'stage', 'stockId', 'version']);
  assert.equal(JSON.stringify(market).includes('continuationSeed'), false);
}

test('the default HTTP start fixes the entire first-day public market while retaining independent future seeds', async context => {
  const h = await harness(context), application = await h.launch();
  const first = await h.start(application, 42), second = await h.start(application, 43, { openingScenario: false });
  assert.notEqual(first.cookie, second.cookie);
  assert.deepEqual(first.market, second.market, 'a client cannot bypass the fixed opening through the request body');
  assert.equal(first.market.stocks.length, 18);
  assert.equal(first.market.day, 1);
  assert.equal(first.market.phase, 'morning');
  assert.equal(first.market.paused, true);
  assert.equal(first.market.cash, 10_000_000);
  assert.equal(first.market.equity, 10_000_000);
  assert.equal(first.market.openingScenario?.version, 2);
  assert.equal(first.market.openingScenario?.stage, 'ready');
  assert.deepEqual(first.market.positions, []);
  assertPublicScenario(first.market);
  const firstSave = await h.snapshot(first.cookie), secondSave = await h.snapshot(second.cookie);
  assert.ok(validateMarket(firstSave.state) && validateMarket(secondSave.state));
  assert.equal(firstSave.state.openingScenario?.continuationSeed, 42);
  assert.equal(secondSave.state.openingScenario?.continuationSeed, 43);
  assert.deepEqual((await call(application, '/api/session', first.cookie)).body.market, first.market);
});

test('real first-day fills stay T+1 locked until day two and a real sale completes the saved opening', { timeout: 20_000 }, async context => {
  const h = await harness(context);
  let application = await h.launch();
  const players = [await h.start(application, 101), await h.start(application, 202)];
  const cookies = players.map(player => player.cookie);
  const totals = conserved((await h.snapshot(cookies[0])).state);
  for (const cookie of cookies) assert.equal((await action(application, cookie, { type: 'pause', paused: false })).status, 200);
  const buy = { type: 'order', side: 'buy', stockId: players[0].market.openingScenario!.stockId,
    quantity: 500_000, price: 10.30, requestId: randomUUID() };
  const buys = await Promise.all(cookies.flatMap(cookie => [action(application, cookie, buy), action(application, cookie, buy)]));
  for (const reply of buys) {
    assert.equal(reply.status, 200);
    assert.equal(reply.body.market!.cash, 4_910_000);
    assert.equal(reply.body.market!.openingScenario?.stage, 'following');
    assert.equal(reply.body.market!.paused, true);
    assert.equal(position(reply.body.market!).quantity, 500_000);
    assert.equal(position(reply.body.market!).todayBought, 500_000);
    assert.equal(position(reply.body.market!).available, 0);
    const receipt = reply.body.market!.orders.find(order => order.side === 'buy')!.execution!;
    assert.equal(receipt.filled, 500_000);
    assert.equal(receipt.amount, 5_090_000);
    assert.equal(receipt.priceLevels, 3);
  }
  assert.deepEqual(buys[0].body.market, buys[2].body.market);
  await close(application);
  application = await h.launch();
  for (const cookie of cookies) {
    const restored = await call(application, '/api/session', cookie);
    assert.deepEqual(restored.body.market, buys[0].body.market);
    assert.deepEqual((await action(application, cookie, buy)).body.market, restored.body.market);
    assert.equal((await h.snapshot(cookie)).requests.filter(record => record.requestId === buy.requestId).length, 1);
    assert.equal((await action(application, cookie, { type: 'pause', paused: false })).status, 200);
  }
  const beforeFollow = await call(application, '/api/market', cookies[0]);
  let followed: Reply[] = [];
  for (let second = 0; second < 3; second += 1) {
    followed = await h.second(application, cookies);
    if (second < 2) for (const reply of followed) assert.equal(reply.body.market!.openingScenario?.stage, 'following');
  }
  assert.deepEqual(followed[0].body.market, followed[1].body.market);
  for (const reply of followed) {
    assert.equal(reply.body.market!.openingScenario?.stage, 'exit');
    assert.equal(reply.body.market!.paused, true);
    assert.equal(reply.body.market!.stocks.find(stock => stock.id === buy.stockId)!.price, 10.8);
    assert.equal(reply.body.market!.cash, 4_910_000, 'other seats following must not credit the player');
    assert.equal(reply.body.market!.equity, 10_310_000, 'price appreciation is still unrealized portfolio value');
    assert.equal(position(reply.body.market!).available, 0);
    assert.deepEqual(reply.body.market!.stocks.find(stock => stock.id === buy.stockId)!.bids, [],
      'the first day must not install a guaranteed exit bid');
  }
  const poll = await call(application, `/api/market?since=${encodeURIComponent(beforeFollow.body.sync!.version)}`, cookies[0]);
  assert.deepEqual(readMarketEnvelope(readMarketEnvelope({ market: null }, beforeFollow.body)!, poll.body)!.market,
    followed[0].body.market, 'polling must carry the scenario stage and resulting real market together');
  assertPublicScenario(followed[0].body.market!);
  const lockedSell = { type: 'order', side: 'sell', stockId: buy.stockId, quantity: 100, price: 10.8, requestId: randomUUID() };
  const firstDay: MarketView[] = [];
  for (const cookie of cookies) {
    assert.equal((await action(application, cookie, { type: 'pause', paused: false })).status, 200);
    const beforeRejection = await h.snapshot(cookie);
    const replies = await Promise.all([action(application, cookie, lockedSell), action(application, cookie, lockedSell)]);
    for (const reply of replies) {
      assert.equal(reply.status, 422, 'today\'s purchased shares must not be sellable on day one');
      assert.match(reply.body.message!, /T\+1|可卖/);
      assert.equal(reply.body.market!.cash, 4_910_000);
      assert.equal(reply.body.market!.openingScenario?.stage, 'exit');
      assert.equal(reply.body.market!.openingScenario?.soldQuantity, 0);
      assert.equal(reply.body.market!.openingScenario?.saleProceeds, 0);
      assert.equal(position(reply.body.market!).quantity, 500_000);
      assert.equal(position(reply.body.market!).available, 0);
      assert.equal(position(reply.body.market!).todayBought, 500_000);
    }
    assert.deepEqual((await h.snapshot(cookie)).state, beforeRejection.state,
      'a rejected sale must not change money, shares, orders, RNG or scenario progress');
    assert.equal((await h.snapshot(cookie)).requests.filter(record => record.requestId === lockedSell.requestId).length, 1);
    const paused = await action(application, cookie, { type: 'pause', paused: true });
    firstDay.push(paused.body.market!);
    assert.deepEqual(conserved((await h.snapshot(cookie)).state), totals);
    assert.deepEqual((await call(application, '/api/session', cookie)).body.market, paused.body.market);
  }
  assert.deepEqual(firstDay[0], firstDay[1]);
  await close(application);
  application = await h.launch();
  const nextRequest = { type: 'nextDay', requestId: randomUUID() };
  const secondDay: MarketView[] = [];
  for (const cookie of cookies) {
    assert.deepEqual((await call(application, '/api/session', cookie)).body.market, firstDay[0]);
    const next = await action(application, cookie, nextRequest);
    assert.equal(next.status, 200);
    assert.equal(next.body.market!.day, 2);
    assert.equal(next.body.market!.cash, 4_910_000);
    assert.equal(next.body.market!.openingScenario?.stage, 'exit', 'unlocking is not a sale or completion');
    assert.equal(next.body.market!.openingScenario?.saleProceeds, 0);
    assert.equal(position(next.body.market!).quantity, 500_000);
    assert.equal(position(next.body.market!).todayBought, 0);
    assert.equal(position(next.body.market!).available, 500_000);
    secondDay.push(next.body.market!);
    const rejectedRetry = await action(application, cookie, lockedSell);
    assert.equal(rejectedRetry.status, 422, 'retrying the rejected first-day request cannot become a new sale after T+1 unlock');
    assert.deepEqual(rejectedRetry.body.market, next.body.market);
  }
  await close(application);
  application = await h.launch();
  const completed: { cookie: string; market: MarketView; sell: Record<string, unknown> }[] = [];
  for (const [index, cookie] of cookies.entries()) {
    assert.deepEqual((await call(application, '/api/session', cookie)).body.market, secondDay[index]);
    assert.deepEqual((await action(application, cookie, nextRequest)).body.market, secondDay[index]);
    const opened = await action(application, cookie, { type: 'advance' });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.market!.phase, 'morning');
    const target = opened.body.market!.stocks.find(stock => stock.id === buy.stockId)!;
    assert.ok(target.bids.length > 0, 'the random second-day market must expose a real available bid');
    await action(application, cookie, { type: 'pause', paused: false });
    assert.ok(target.limitUp > target.bids[0].price);
    const resting = await action(application, cookie,
      { type: 'order', side: 'sell', stockId: buy.stockId, quantity: 100, price: target.limitUp });
    assert.equal(resting.status, 200);
    const pendingSale = resting.body.market!.orders.find(order => order.side === 'sell')!;
    assert.equal(pendingSale.filled, 0);
    assert.equal(resting.body.market!.openingScenario?.stage, 'exit', 'submitting an unfilled sell is not completion');
    assert.equal(resting.body.market!.openingScenario?.saleProceeds, 0);
    assert.equal(resting.body.market!.cash, 4_910_000);
    assert.equal((await action(application, cookie, { type: 'cancel', orderId: pendingSale.id })).status, 200);
    const sell = { type: 'order', side: 'sell', stockId: buy.stockId, quantity: 100,
      price: target.bids[0].price, requestId: randomUUID() };
    const replies = await Promise.all([action(application, cookie, sell), action(application, cookie, sell)]);
    for (const reply of replies) {
      assert.equal(reply.status, 200);
      const receipt = reply.body.market!.orders.find(order => order.side === 'sell')!.execution!;
      assert.equal(receipt.filled, 100);
      assert.equal(reply.body.market!.openingScenario?.stage, 'complete');
      assert.equal(reply.body.market!.openingScenario?.soldQuantity, receipt.filled);
      assert.equal(reply.body.market!.openingScenario?.saleProceeds, receipt.amount);
      assert.equal(reply.body.market!.cash, 4_910_000 + receipt.amount);
      assert.equal(position(reply.body.market!).quantity, 500_000 - receipt.filled);
      assert.equal(position(reply.body.market!).available, 500_000 - receipt.filled);
    }
    assert.deepEqual(conserved((await h.snapshot(cookie)).state), totals);
    assert.equal((await h.snapshot(cookie)).requests.filter(record => record.requestId === sell.requestId).length, 1);
    const paused = await action(application, cookie, { type: 'pause', paused: true });
    completed.push({ cookie, market: paused.body.market!, sell });
  }
  await close(application);
  application = await h.launch();
  for (const { cookie, market, sell } of completed) {
    assert.deepEqual((await call(application, '/api/session', cookie)).body.market, market);
    assert.deepEqual((await action(application, cookie, sell)).body.market, market);
  }
});

test('a version-one opening save retains its existing bottom holding and same-day exit rules', { timeout: 10_000 }, async context => {
  const h = await harness(context);
  let application = await h.launch();
  const player = await h.start(application, 909);
  await close(application);
  const previous = await h.snapshot(player.cookie);
  const old = previous.state;
  // Reconstruct the historic v1 transfer using existing NPC cash and inventory.
  // This is a fixture for the saved format, not a client-visible creation option.
  old.openingScenario!.version = 1;
  const owner = old.actors.find(actor => actor.id === 'player')!;
  const donor = old.actors.find(actor => actor.id === 'crowd2')!;
  const holding = donor.positions[old.openingScenario!.stockId];
  holding.cost -= Math.floor(holding.cost * 200_000 / holding.quantity);
  holding.quantity -= 200_000;
  donor.cash += 200_000_000;
  owner.cash -= 200_000_000;
  owner.positions[old.openingScenario!.stockId] = { quantity: 200_000, today: 0, financed: 0, cost: 200_000_000 };
  assert.ok(validateMarket(old));
  await h.replaceSnapshot(player.cookie, { ...previous, state: old, requests: [] });
  const expected = JSON.parse(JSON.stringify(getView(old))) as MarketView;
  application = await h.launch();
  const restored = await call(application, '/api/session', player.cookie);
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.market, expected, 'v1 holdings and cash must not be migrated to the v2 empty account');
  assert.equal(restored.body.market!.cash, 8_000_000);
  assert.equal(position(restored.body.market!).available, 200_000);
  await action(application, player.cookie, { type: 'pause', paused: false });
  const buy = await action(application, player.cookie,
    { type: 'order', side: 'buy', stockId: old.openingScenario!.stockId, quantity: 500_000, price: 10.30 });
  assert.equal(buy.status, 200);
  assert.equal(buy.body.market!.cash, 2_910_000);
  await action(application, player.cookie, { type: 'pause', paused: false });
  for (let second = 0; second < 3; second += 1) await h.second(application, [player.cookie]);
  await action(application, player.cookie, { type: 'pause', paused: false });
  const sold = await action(application, player.cookie,
    { type: 'order', side: 'sell', stockId: old.openingScenario!.stockId, quantity: 200_000, price: 10.8 });
  assert.equal(sold.status, 200);
  assert.equal(sold.body.market!.day, 1);
  assert.equal(sold.body.market!.cash, 5_070_000);
  assert.equal(sold.body.market!.openingScenario?.version, 1);
  assert.equal(sold.body.market!.openingScenario?.stage, 'complete');
  assert.equal(sold.body.market!.openingScenario?.saleProceeds, 2_160_000);
  assert.equal(position(sold.body.market!).available, 0);
  const paused = await action(application, player.cookie, { type: 'pause', paused: true });
  await close(application);
  application = await h.launch();
  assert.deepEqual((await call(application, '/api/session', player.cookie)).body.market, paused.body.market);
});

test('an uncommitted first-day buy cannot change holdings or consume its request ID', async context => {
  const h = await harness(context), requestId = randomUUID();
  let failOnce = true;
  const application = await h.launch(async (destination, serialized) => {
    const snapshot = JSON.parse(serialized) as Snapshot;
    if (failOnce && snapshot.requests.some(record => record.requestId === requestId)) {
      failOnce = false;
      throw new Error('injected opening trade persistence failure');
    }
    await writeSnapshot(destination, serialized);
  });
  const player = await h.start(application, 404);
  await action(application, player.cookie, { type: 'pause', paused: false });
  const before = await h.snapshot(player.cookie);
  const order = { type: 'order', side: 'buy', stockId: player.market.openingScenario!.stockId,
    quantity: 500_000, price: 10.30, requestId };
  const failed = await action(application, player.cookie, order);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.market!.cash, 10_000_000);
  assert.equal(failed.body.market!.openingScenario?.stage, 'ready');
  assert.deepEqual(failed.body.market!.positions, []);
  assert.deepEqual(await h.snapshot(player.cookie), before);
  assert.equal((await call(application, '/api/session', player.cookie)).body.market!.cash, 10_000_000);
  // Storage failure deliberately pauses orders; the normal resume action repairs
  // that condition before retrying the very same unacknowledged order.
  assert.equal((await action(application, player.cookie, { type: 'pause', paused: false })).status, 200);
  const retry = await action(application, player.cookie, order);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.market!.cash, 4_910_000);
  assert.equal(position(retry.body.market!).quantity, 500_000);
  assert.equal((await h.snapshot(player.cookie)).requests.filter(record => record.requestId === requestId).length, 1);
  assert.deepEqual((await action(application, player.cookie, order)).body.market, retry.body.market);
});

test('day two changes random continuation once, even after write failure, concurrent retry and restart', async context => {
  const h = await harness(context), requestId = randomUUID();
  let failedCandidate: Snapshot | undefined;
  let failOnce = true;
  let application = await h.launch(async (destination, serialized) => {
    const snapshot = JSON.parse(serialized) as Snapshot;
    if (failOnce && snapshot.requests.some(record => record.requestId === requestId)) {
      failOnce = false;
      failedCandidate = snapshot;
      throw new Error('injected first rollover persistence failure');
    }
    await writeSnapshot(destination, serialized);
  });
  const first = await h.start(application, 505), second = await h.start(application, 606);
  const before = await h.snapshot(first.cookie);
  const next = { type: 'nextDay', requestId };
  const failed = await action(application, first.cookie, next);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.market!.day, 1);
  assert.equal(failed.body.market!.cash, 10_000_000);
  assert.deepEqual(await h.snapshot(first.cookie), before);
  assert.ok(failedCandidate && failedCandidate.state.day === 2);
  const retried = await Promise.all([action(application, first.cookie, next), action(application, first.cookie, next)]);
  for (const reply of retried) { assert.equal(reply.status, 200); assert.equal(reply.body.market!.day, 2); }
  const committed = await h.snapshot(first.cookie);
  assert.deepEqual(committed.state, failedCandidate.state, 'retry must reuse the persisted continuation seed and produce the same market');
  assert.equal(committed.requests.filter(record => record.requestId === requestId).length, 1);
  assert.ok(validateMarket(committed.state));
  const other = await action(application, second.cookie, { type: 'nextDay' });
  assert.equal(other.status, 200);
  assert.equal(other.body.market!.day, 2);
  const otherSave = await h.snapshot(second.cookie);
  assert.notEqual(committed.state.rngState, otherSave.state.rngState, 'different supplied seeds must drive different later markets');
  assert.equal(retried[0].body.market!.cash, 10_000_000);
  assert.deepEqual(retried[0].body.market!.positions, []);
  await close(application);
  application = await h.launch();
  assert.deepEqual((await call(application, '/api/session', first.cookie)).body.market, retried[0].body.market);
  assert.deepEqual((await action(application, first.cookie, next)).body.market, retried[0].body.market);
  assert.deepEqual((await h.snapshot(first.cookie)).state, committed.state);
  assertPublicScenario(retried[0].body.market!);
  // The opening price remains yesterday's close. The new random stream changes
  // actual subsequent auction orders instead of rewriting that historical price.
  const opening = await action(application, first.cookie, { type: 'advance' });
  const otherOpening = await action(application, second.cookie, { type: 'advance' });
  assert.equal(opening.status, 200);
  assert.equal(otherOpening.status, 200);
  assert.notDeepEqual(opening.body.market!.stocks, otherOpening.body.market!.stocks);
});

test('restoring an old day-one save does not apply the new opening or replace existing money', async context => {
  const h = await harness(context);
  let application = await h.launch();
  const player = await h.start(application, 707);
  await close(application);
  const old = createMarket(808);
  assert.equal(old.openingScenario, undefined);
  assert.equal(repayChallenge(old, 12_345).ok, true);
  assert.ok(validateMarket(old));
  const previous = await h.snapshot(player.cookie);
  await h.replaceSnapshot(player.cookie, { ...previous, state: old, requests: [] });
  const expected = JSON.parse(JSON.stringify(getView(old))) as MarketView;
  application = await h.launch();
  for (const path of ['/api/session', '/api/market', '/api/session']) {
    const restored = await call(application, path, player.cookie);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.market, expected);
    assert.equal(restored.body.market!.openingScenario, undefined);
  }
  assert.deepEqual((await h.snapshot(player.cookie)).state, old);
  assert.equal((await h.snapshot(player.cookie)).state.seed, 808);
});
