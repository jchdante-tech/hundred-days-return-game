import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_STOCKS } from './stock-catalog.js';
import test, { type TestContext } from 'node:test';
import type { MarketView } from '../shared/types.js';
import { createApplication } from './index.js';
import { createMarket, getView, nextDay, validateMarket } from './engine.js';

interface Reply {
  status: number;
  body: { market: MarketView | null; ok: boolean; message?: string };
  cookie: string | null;
}
interface Running {
  base: string;
  server: Server;
  stop: () => Promise<void>;
}
interface CallOptions {
  method?: 'GET' | 'POST';
  cookie?: string;
  body?: Record<string, unknown>;
  origin?: string;
  raw?: string;
}

async function call(application: Running, path: string, options: CallOptions = {}): Promise<Reply> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (method === 'POST') {
    headers.origin = options.origin ?? application.base;
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(application.base + path, {
    method, headers,
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  return { status: response.status, body: await response.json() as Reply['body'], cookie: response.headers.get('set-cookie') };
}

function action(application: Running, cookie: string, body: Record<string, unknown>) {
  return call(application, '/api/action', {
    method: 'POST', cookie, body: { requestId: randomUUID(), ...body },
  });
}

async function close(application: Running) {
  await application.stop();
  if (application.server.listening) {
    await new Promise<void>((resolve, reject) => application.server.close((error) => error ? reject(error) : resolve()));
  }
}

async function harness(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'youzi-http-'));
  const data = join(root, 'saves');
  let clock = Date.now();
  const running: Running[] = [];
  context.after(async () => {
    for (const application of running) await close(application);
    rmSync(root, { recursive: true, force: true });
  });
  async function launch(production = false, origins: { publicOrigin?: string; publicOriginAliases?: string[] } = {}) {
    const application = createApplication({ dataDirectory: data, now: () => clock, production, openingScenario: false,
      publicOrigin: origins.publicOrigin ?? '', publicOriginAliases: origins.publicOriginAliases ?? [] });
    const server = application.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const entry = { base: `http://127.0.0.1:${address.port}`, server, stop: application.stop };
    running.push(entry);
    return entry;
  }
  async function start(application: Running, seed = 42) {
    const response = await call(application, '/api/start', { method: 'POST', body: { seed } });
    assert.equal(response.status, 200);
    assert.ok(response.cookie);
    const cookie = response.cookie.split(';')[0]!;
    const path = join(data, `${cookie.split('=')[1]}.json`);
    return { ...response, cookie, path };
  }
  return { data, launch, start, addTime: (milliseconds: number) => { clock += milliseconds; } };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'server timer did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('a real day-one fill survives every closing phase, next day and server restart', async (context) => {
  const h = await harness(context);
  const application = await h.launch();
  const player = await h.start(application, 42);
  let view = (await action(application, player.cookie, { type: 'advance' })).body.market!;
  assert.equal(view.phase, 'morning');
  await action(application, player.cookie, { type: 'pause', paused: false });
  const stock = view.stocks.find(s => s.asks[0]?.quantity >= 100)!;
  assert.ok(stock, 'a funded counterparty must offer an executable lot');
  const bought = await action(application, player.cookie, {
    type: 'order', stockId: stock.id, side: 'buy', quantity: 100, price: stock.asks[0].price,
  });
  assert.equal(bought.status, 200);
  view = bought.body.market!;
  assert.equal(view.orders[0].filled, 100, 'submission alone cannot establish a holding');
  assert.ok(view.trades.some(t => t.stockId === stock.id && t.side === 'buy' && t.quantity === 100));
  const cost = view.positions.find(p => p.stockId === stock.id)!.averageCost;
  const cash = view.cash;
  const checkHolding = (market: MarketView, day: number) => {
    assert.equal(market.day, day);
    const holding = market.positions.find(p => p.stockId === stock.id);
    assert.ok(holding, 'filled shares must remain in the public holdings response');
    assert.equal(holding.quantity, 100);
    assert.equal(holding.averageCost, cost);
    assert.equal(holding.todayBought, day === 1 ? 100 : 0);
    assert.equal(holding.available, day === 1 ? 0 : 100);
    assert.equal(market.cash, cash);
  };
  checkHolding(view, 1);
  for (let step = 0; step < 5 && view.phase !== 'night'; step++) {
    view = (await action(application, player.cookie, { type: 'advance' })).body.market!;
    checkHolding(view, 1);
  }
  assert.equal(view.phase, 'night');
  view = (await action(application, player.cookie, { type: 'nextDay' })).body.market!;
  checkHolding(view, 2);
  assert.equal(view.phase, 'auction');
  await close(application);
  const restarted = await h.launch();
  const restored = await call(restarted, '/api/session', { cookie: player.cookie });
  assert.equal(restored.status, 200);
  checkHolding(restored.body.market!, 2);
});

test('HTTP sessions are isolated and expose only the player view', async (context) => {
  const h = await harness(context);
  const application = await h.launch();
  assert.deepEqual((await call(application, '/api/session')).body, { market: null, ok: true });
  assert.deepEqual(readdirSync(h.data), []);
  assert.equal((await call(application, '/api/market')).status, 401);
  const first = await h.start(application);
  const second = await h.start(application, 43);
  assert.notEqual(first.cookie, second.cookie);
  assert.match(first.cookie, /^youzi_session=[A-Za-z0-9_-]{43}$/);
  const cookieResponse = await call(application, '/api/start', { method: 'POST', body: {} });
  assert.match(cookieResponse.cookie!, /HttpOnly/);
  assert.match(cookieResponse.cookie!, /SameSite=Lax/);
  assert.equal(first.body.market!.stocks.length, BASE_STOCKS.length);
  assert.equal(first.body.market!.equity, 10_000_000);
  for (const hidden of ['seed', 'rngState', 'actors', 'requests', 'fingerprint']) {
    assert.equal(hidden in first.body.market!, false);
    assert.equal(hidden in first.body, false);
  }
  const paid = await action(application, first.cookie, { type: 'repayChallenge', amount: 1000 });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.market!.challenge!.paid, 1000);
  assert.equal(paid.body.market!.cash, 9_999_000);
  assert.equal((await call(application, '/api/market', { cookie: second.cookie })).body.market!.challenge!.paid, 0);
});

test('HTTP rejects cross-origin, malformed, unknown-session and invalid requests', async (context) => {
  const h = await harness(context);
  const application = await h.launch();
  assert.equal((await call(application, '/api/start', { method: 'POST', body: {}, origin: 'https://other.example' })).status, 403);
  assert.equal((await call(application, '/api/start', { method: 'POST', body: { seed: -1 } })).status, 400);
  const first = await h.start(application);
  const before = readFileSync(first.path, 'utf8');
  assert.equal((await call(application, '/api/action', { method: 'POST', cookie: first.cookie, body: { type: 'repayChallenge', amount: 100 } })).status, 400);
  assert.equal((await action(application, first.cookie, { type: 'order', stockId: 's1', side: 'buy', quantity: -100, price: 12 })).status, 400);
  assert.equal(readFileSync(first.path, 'utf8'), before);
  assert.equal((await call(application, '/api/market', { cookie: 'youzi_session=../../etc/passwd' })).status, 401);
  assert.equal((await call(application, '/api/action', { method: 'POST', cookie: first.cookie, raw: '{"broken":' })).status, 400);
  assert.equal((await call(application, '/api/action', {
    method: 'POST', cookie: first.cookie,
    raw: JSON.stringify({ requestId: randomUUID(), type: 'pause', paused: true, padding: 'x'.repeat(17_000) }),
  })).status, 413);
  const business = await action(application, first.cookie, { type: 'order', stockId: 'unknown', side: 'buy', quantity: 100, price: 12 });
  assert.equal(business.status, 422);
  assert.deepEqual(JSON.parse(readFileSync(first.path, 'utf8')).state, JSON.parse(before).state);
  const production = await h.launch(true);
  assert.equal((await call(production, '/api/start', { method: 'POST', body: {}, origin: 'http://127.0.0.1:5173' })).status, 403);
});

test('explicit migration origins accept independent new and legacy players without accepting other sites', async (context) => {
  const h = await harness(context);
  const primary = 'https://play.example.test';
  const legacy = 'https://legacy-play.example.test';
  const application = await h.launch(true, { publicOrigin: primary, publicOriginAliases: [legacy] });
  const first = await call(application, '/api/start', { method: 'POST', body: {}, origin: primary });
  const second = await call(application, '/api/start', { method: 'POST', body: {}, origin: legacy });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.cookie!.split(';')[0], second.cookie!.split(';')[0]);
  for (const cookie of [first.cookie!, second.cookie!]) {
    assert.match(cookie, /; Secure(?:;|$)/);
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    assert.match(cookie, /; SameSite=Lax(?:;|$)/);
    assert.doesNotMatch(cookie, /; Domain=/i, 'migration must not broaden host-only cookies');
  }
  const legacyCookie = second.cookie!.split(';')[0]!;
  const repayment = await call(application, '/api/action', {
    method: 'POST', cookie: legacyCookie, origin: legacy,
    body: { requestId: randomUUID(), type: 'repayChallenge', amount: 1000 },
  });
  assert.equal(repayment.status, 200);
  assert.equal(repayment.body.market!.challenge!.paid, 1000);
  assert.equal((await call(application, '/api/market', { cookie: first.cookie!.split(';')[0]! })).body.market!.challenge!.paid, 0);
  const before = readdirSync(h.data).map(name => readFileSync(join(h.data, name), 'utf8'));
  for (const origin of ['https://evil.example', `${primary}.evil.example`, 'https://sub.play.example.test',
    'http://play.example.test', `${legacy}/path`, `${primary}?query=1`, 'null', 'http://127.0.0.1:5173']) {
    assert.equal((await call(application, '/api/start', { method: 'POST', body: {}, origin })).status, 403, origin);
    assert.equal((await call(application, '/api/action', {
      method: 'POST', cookie: legacyCookie, origin,
      body: { requestId: randomUUID(), type: 'repayChallenge', amount: 1000 },
    })).status, 403, origin);
  }
  assert.deepEqual(readdirSync(h.data).map(name => readFileSync(join(h.data, name), 'utf8')), before);
});

test('origin aliases remain opt-in and preserve local HTTP and HTTPS cookie behavior', async (context) => {
  const h = await harness(context);
  const application = await h.launch(true, { publicOrigin: 'https://play.example.test' });
  assert.equal((await call(application, '/api/start', { method: 'POST', body: {},
    origin: 'https://legacy-play.example.test' })).status, 403);
  const local = await h.launch();
  const plain = await call(local, '/api/start', { method: 'POST', body: {} });
  assert.equal(plain.status, 200);
  assert.doesNotMatch(plain.cookie!, /; Secure(?:;|$)/);
  assert.equal((await call(local, '/api/start', { method: 'POST', body: {}, origin: 'http://localhost:5173' })).status, 200);
  const httpsAlias = await h.launch(true, { publicOrigin: 'http://example.test', publicOriginAliases: ['https://legacy.example.test'] });
  const secure = await call(httpsAlias, '/api/start', { method: 'POST', body: {}, origin: 'https://legacy.example.test' });
  assert.equal(secure.status, 200);
  assert.match(secure.cookie!, /; Secure(?:;|$)/);
});

test('origin aliases reject malformed configuration eagerly and parse the explicit environment list', async (context) => {
  const h = await harness(context);
  for (const value of ['', '*', 'https://*.example.test', 'https://legacy.example.test/path',
    'https://legacy.example.test?query=1', 'https://legacy.example.test#hash', 'https://user:pass@example.test', 'ftp://example.test', 'null']) {
    assert.throws(() => createApplication({ dataDirectory: h.data, publicOrigin: 'https://example.test',
      publicOriginAliases: [value] }), /PUBLIC_ORIGIN_ALIASES/, value);
  }
  assert.throws(() => createApplication({ dataDirectory: h.data, publicOrigin: '',
    publicOriginAliases: ['https://legacy.example.test'] }), /requires PUBLIC_ORIGIN/);
  const previous = process.env.PUBLIC_ORIGIN_ALIASES;
  try {
    process.env.PUBLIC_ORIGIN_ALIASES = 'https://legacy.example.test, https://another.example.test';
    const configured = createApplication({ dataDirectory: h.data, publicOrigin: 'https://example.test', production: true });
    configured.stop();
    process.env.PUBLIC_ORIGIN_ALIASES = 'https://legacy.example.test,';
    assert.throws(() => createApplication({ dataDirectory: h.data, publicOrigin: 'https://example.test' }), /PUBLIC_ORIGIN_ALIASES/);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN_ALIASES;
    else process.env.PUBLIC_ORIGIN_ALIASES = previous;
  }
});

test('request IDs prevent duplicate repayment and orders across retries and restarts', async (context) => {
  const h = await harness(context);
  const application = await h.launch();
  const first = await h.start(application);
  const repayment = { type: 'repayChallenge', amount: 1000, requestId: randomUUID() };
  const paid = await action(application, first.cookie, repayment);
  const same = await action(application, first.cookie, { requestId: repayment.requestId, amount: 1000, type: 'repayChallenge' });
  assert.equal(same.status, 200);
  assert.equal(same.body.market!.challenge!.paid, paid.body.market!.challenge!.paid);
  assert.equal(same.body.market!.revision, paid.body.market!.revision);
  assert.equal((await action(application, first.cookie, { ...repayment, amount: 2000 })).status, 409);
  assert.equal((await action(application, first.cookie, { type: 'pause', paused: false })).status, 200);
  const order = { type: 'order', stockId: 's1', side: 'buy', quantity: 100, price: 10.8, requestId: randomUUID() };
  const submitted = await action(application, first.cookie, order);
  assert.equal(submitted.status, 200);
  const repeated = await action(application, first.cookie, order);
  assert.deepEqual(repeated.body.market!.orders, submitted.body.market!.orders);
  assert.equal(repeated.body.market!.frozenCash, submitted.body.market!.frozenCash);
  const refusal = { type: 'order', stockId: 'unknown', side: 'buy', quantity: 100, price: 12, requestId: randomUUID() };
  const rejected = await action(application, first.cookie, refusal);
  assert.equal(rejected.status, 422);
  assert.equal((await action(application, first.cookie, refusal)).body.message, rejected.body.message);
  const snapshot = JSON.parse(readFileSync(first.path, 'utf8'));
  assert.equal(snapshot.requests.length, 4);
  await close(application);
  const restarted = await h.launch();
  const replay = await action(restarted, first.cookie, repayment);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.market!.challenge!.paid, paid.body.market!.challenge!.paid);
  assert.equal((await action(restarted, first.cookie, order)).body.market!.orders.length, submitted.body.market!.orders.length);
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).requests.length, 4);
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).state.rngState, snapshot.state.rngState);
});

test('idempotency retains at least the latest 100 processed requests without leaking metadata', async (context) => {
  const h = await harness(context);
  const application = await h.launch();
  const first = await h.start(application);
  const operations: Record<string, unknown>[] = [];
  for (let index = 0; index < 132; index++) {
    const body = { type: 'speed', speed: 1, requestId: randomUUID() };
    operations.push(body);
    assert.equal((await action(application, first.cookie, body)).status, 200);
  }
  const before = JSON.parse(readFileSync(first.path, 'utf8'));
  assert.equal(before.requests.length, 128);
  const replay = await action(application, first.cookie, operations[32]!);
  assert.equal(replay.body.market!.revision, before.state.revision);
  assert.equal('requests' in replay.body.market!, false);
  assert.equal('requests' in replay.body, false);
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).requests.length, 128);
});

test('failed persistence rolls back money and request IDs, then safely retries', async (context) => {
  const h = await harness(context);
  const application = await h.launch();
  const first = await h.start(application);
  const before = JSON.parse(readFileSync(first.path, 'utf8'));
  const repayment = { type: 'repayChallenge', amount: 1000, requestId: randomUUID() };
  renameSync(h.data, `${h.data}-held`);
  writeFileSync(h.data, 'temporarily block the data directory');
  try {
    const failed = await action(application, first.cookie, repayment);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.market!.challenge!.paid, before.state.challenge.paid / 100);
    assert.equal(failed.body.market!.cash, before.state.actors[0].cash / 100);
    assert.equal(failed.body.market!.paused, true);
    const stored = JSON.parse(readFileSync(first.path.replace(h.data, `${h.data}-held`), 'utf8'));
    assert.equal(stored.state.challenge.paid, before.state.challenge.paid);
    assert.equal(stored.state.actors[0].cash, before.state.actors[0].cash);
    assert.deepEqual(stored.requests, []);
  } finally {
    rmSync(h.data);
    renameSync(`${h.data}-held`, h.data);
  }
  const retried = await action(application, first.cookie, repayment);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.market!.challenge!.paid, 1000);
  assert.equal((await action(application, first.cookie, repayment)).body.market!.challenge!.paid, 1000);
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).requests.length, 1);
});

test('markets tick only while active, pause offline, and restore paused with the same RNG', async (context) => {
  const h = await harness(context);
  const application = await h.launch();
  const first = await h.start(application);
  assert.equal(first.body.market!.paused, true);
  assert.equal((await action(application, first.cookie, {
    type: 'order', stockId: 's1', side: 'buy', quantity: 100, price: 10.8,
  })).status, 422);
  const originalTick = JSON.parse(readFileSync(first.path, 'utf8')).state.tickCount;
  h.addTime(1000);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).state.tickCount, originalTick);
  await action(application, first.cookie, { type: 'pause', paused: false });
  await waitFor(() => JSON.parse(readFileSync(first.path, 'utf8')).state.tickCount === originalTick + 1);
  h.addTime(13_000);
  await waitFor(() => JSON.parse(readFileSync(first.path, 'utf8')).state.paused === true);
  const stored = JSON.parse(readFileSync(first.path, 'utf8'));
  assert.equal(stored.state.tickCount, originalTick + 1);
  assert.equal((await call(application, '/api/market', { cookie: first.cookie })).body.market!.paused, true);
  await close(application);
  const restarted = await h.launch();
  const restored = await call(restarted, '/api/session', { cookie: first.cookie });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.market!.paused, true);
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).state.rngState, stored.state.rngState);
});

test('the 100-day contract never settles early and its outcome matches outstanding debt', async (context) => {
  const h = await harness(context);
  const application = await h.launch();
  const first = await h.start(application);
  const initial = first.body.market!;
  assert.equal((Date.parse(initial.deadlineDate) - Date.parse(initial.calendarDate)) / 86_400_000, 100);
  let market = initial;
  let transitions = 0;
  while (market.daysLeft > 0) {
    assert.equal(market.result, null);
    const next = await action(application, first.cookie, { type: 'nextDay' });
    assert.equal(next.status, 200);
    market = next.body.market!;
    assert.equal(market.deadlineDate, initial.deadlineDate);
    assert.equal(market.daysLeft, (Date.parse(market.deadlineDate) - Date.parse(market.calendarDate)) / 86_400_000);
    assert.ok(++transitions <= 100);
  }
  assert.equal(market.calendarDate, initial.deadlineDate);
  assert.equal(market.phase, 'ended');
  const financingCents = Math.round(market.financingDebt * 100);
  const shortCents = Math.round(market.shortLiability * 100);
  const interestCents = Math.round(market.interest * 100);
  assert.ok(financingCents >= 0 && shortCents >= 0 && interestCents >= 0);
  const outstandingCents = financingCents + shortCents + interestCents;
  assert.equal(Math.round(market.debt * 100), outstandingCents);
  assert.equal(Math.round(market.equity * 100), Math.round(market.assets * 100) - outstandingCents);
  assert.equal(market.result, outstandingCents === 0 && market.challenge!.remaining === 0 ? 'won' : 'default');
  assert.equal(market.challenge!.paid, 10_000_000);
  assert.equal(market.challenge!.remaining, 90_000_000);
  assert.equal(market.cash, 0);
  assert.equal(market.paused, true);
});

test('incompatible snapshots are rejected without overwriting the saved file', async (context) => {
  const h = await harness(context);
  const application = await h.launch();
  const first = await h.start(application);
  await close(application);
  const snapshot = JSON.parse(readFileSync(first.path, 'utf8'));
  snapshot.saveVersion = 999;
  writeFileSync(first.path, JSON.stringify(snapshot));
  const before = readFileSync(first.path, 'utf8');
  const restarted = await h.launch();
  assert.equal((await call(restarted, '/api/session', { cookie: first.cookie })).status, 409);
  assert.equal(readFileSync(first.path, 'utf8'), before);
});

test('HTTP credit access follows trading day 20 and target repayment validates amounts without saving invalid input', async (context) => {
  const h = await harness(context), application = await h.launch(), first = await h.start(application);
  const before = readFileSync(first.path, 'utf8');
  for (const amount of [0, -1, .001, '1000', null]) {
    assert.equal((await action(application, first.cookie, { type: 'repayChallenge', amount })).status, 400);
    assert.equal(readFileSync(first.path, 'utf8'), before);
  }
  const finance = { type: 'order', stockId: 's1', side: 'finance', quantity: 100, price: 12 };
  const short = { type: 'order', stockId: 's5', side: 'short', quantity: 100, price: 22 };
  await action(application, first.cookie, { type: 'pause', paused: false });
  assert.equal((await action(application, first.cookie, finance)).status, 422);
  assert.equal((await action(application, first.cookie, short)).status, 422);
  let market = first.body.market!;
  while (market.day < 19) market = (await action(application, first.cookie, { type: 'nextDay' })).body.market!;
  await action(application, first.cookie, { type: 'pause', paused: false });
  const blocked = await action(application, first.cookie, finance);
  assert.equal(blocked.status, 422); assert.match(blocked.body.message!, /第 20 个交易日/);
  assert.equal((await action(application, first.cookie, short)).status, 422);
  market = (await action(application, first.cookie, { type: 'nextDay' })).body.market!;
  assert.equal(market.day, 20); assert.equal(market.creditUnlocked, true); assert.equal(market.creditUnlockDay, 20);
  await action(application, first.cookie, { type: 'pause', paused: false });
  assert.equal(market.credit.financeAvailable, 0, 'unlock does not automatically pledge assets');
  assert.equal((await action(application, first.cookie, { type: 'collateral', direction: 'in', cash: 100_000 })).status, 200);
  assert.equal((await action(application, first.cookie, { ...finance, price: market.stocks[0].price })).status, 200);
  assert.equal((await action(application, first.cookie, { ...short, price: market.stocks[4].price })).status, 200);
  const targetBlocked = await action(application, first.cookie, { type: 'repayChallenge', amount: 1000 });
  assert.equal(targetBlocked.status, 422); assert.equal(targetBlocked.body.market!.challenge!.paid, 0);
});

test('HTTP restore preserves old credit contracts and accepts their ordinary repayments without changing the challenge', async (context) => {
  const h = await harness(context), application = await h.launch(), first = await h.start(application);
  await close(application);
  const snapshot = JSON.parse(readFileSync(first.path, 'utf8'));
  delete snapshot.state.challenge;
  delete snapshot.state.creditAccount;
  snapshot.state.principal = 1_000_000_000; snapshot.state.actors[0].cash = 400_000_000;
  snapshot.state.actors[0].positions.s1 = { quantity: 1_000_000, today: 0, financed: 1_000_000, cost: 1_600_000_000 };
  writeFileSync(first.path, JSON.stringify(snapshot));
  const restarted = await h.launch();
  const restored = await call(restarted, '/api/session', { cookie: first.cookie });
  assert.equal(restored.status, 200); assert.equal(restored.body.market!.challenge, null);
  assert.equal(restored.body.market!.cash, 4_000_000); assert.equal(restored.body.market!.financingDebt, 10_000_000);
  assert.equal(restored.body.market!.positions[0].quantity, 1_000_000);
  assert.equal((await action(restarted, first.cookie, { type: 'repayChallenge', amount: 1000 })).status, 422);
  const paid = await action(restarted, first.cookie, { type: 'repay', amount: 1000 });
  assert.equal(paid.status, 200); assert.equal(paid.body.market!.financingDebt, 9_999_000);
  assert.equal(paid.body.market!.cash, 3_999_000); assert.equal(paid.body.market!.challenge, null);
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).state.challenge, undefined);
});

test('HTTP IPO subscriptions roll back failed saves, retry once, and preserve allocation across restart', async (context) => {
  const h = await harness(context), application = await h.launch(), session = await h.start(application, 42);
  let market = session.body.market!;
  for (let day = 0; day < 12 && !market.ipos?.length; day++) {
    const next = await action(application, session.cookie, { type: 'nextDay' });
    assert.equal(next.status, 200); market = next.body.market!;
  }
  const offer = market.ipos!.find(o => o.status === 'subscribing')!;
  assert.ok(offer);
  assert.ok(market.news.some(n => n.stockIds?.includes(offer.stockId)), 'IPO news retains the public company association');
  const initial = market, request = { type: 'subscribeIpo', offerId: offer.id, quantity: offer.quotaQuantity, requestId: randomUUID() };
  assert.equal((await action(application, session.cookie, { ...request, requestId: randomUUID(), quantity: 101 })).status, 422);
  assert.equal((await action(application, session.cookie, { ...request, requestId: randomUUID(), quantity: -100 })).status, 400);
  renameSync(h.data, `${h.data}-held`); writeFileSync(h.data, 'block IPO persistence');
  try {
    const failed = await action(application, session.cookie, request);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.market!.ipos![0].reservedAmount, 0);
    assert.equal(failed.body.market!.availableCash, initial.availableCash);
  } finally {
    rmSync(h.data); renameSync(`${h.data}-held`, h.data);
  }
  const subscribed = await action(application, session.cookie, request);
  assert.equal(subscribed.status, 200);
  const frozen = subscribed.body.market!;
  assert.equal(frozen.cash, initial.cash); assert.equal(frozen.equity, initial.equity);
  assert.equal(Math.round((initial.availableCash - frozen.availableCash) * 100), Math.round(offer.quotaQuantity * offer.issuePrice * 100));
  const replay = await action(application, session.cookie, request);
  assert.equal(replay.body.market!.revision, frozen.revision);
  assert.equal((await action(application, session.cookie, { ...request, quantity: request.quantity + 100 })).status, 409);
  await close(application);
  const restarted = await h.launch();
  assert.equal((await call(restarted, '/api/session', { cookie: session.cookie })).body.market!.ipos![0].reservedAmount, frozen.ipos![0].reservedAmount);
  assert.equal((await action(restarted, session.cookie, request)).body.market!.availableCash, frozen.availableCash);
  const cancel = { type: 'cancelIpo', offerId: offer.id, requestId: randomUUID() };
  const cancelled = await action(restarted, session.cookie, cancel);
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.market!.availableCash, initial.availableCash);
  assert.equal((await action(restarted, session.cookie, cancel)).body.market!.revision, cancelled.body.market!.revision);
  await action(restarted, session.cookie, { ...request, requestId: randomUUID() });
  const listed = await action(restarted, session.cookie, { type: 'nextDay' });
  assert.equal(listed.status, 200);
  const allocation = listed.body.market!.ipos![0];
  assert.equal(allocation.status, 'listed'); assert.equal(allocation.reservedAmount, 0);
  assert.equal(Math.round((allocation.allocatedAmount! + allocation.refundAmount!) * 100), Math.round(frozen.ipos![0].reservedAmount * 100));
  const stock = listed.body.market!.stocks.find(s => s.id === offer.stockId)!;
  assert.equal(stock.volume, 0); assert.deepEqual(stock.dailyBars, []);
  await close(restarted);
  const final = await h.launch();
  const restored = (await call(final, '/api/session', { cookie: session.cookie })).body.market!;
  assert.deepEqual(restored.ipos![0], allocation);
  assert.equal(restored.cash, listed.body.market!.cash);
  assert.deepEqual(restored.positions, listed.body.market!.positions);
});

async function creditSession(context: TestContext, ownShares = 0) {
  const h = await harness(context), original = await h.launch(), session = await h.start(original);
  await close(original);
  const snapshot = JSON.parse(readFileSync(session.path, 'utf8'));
  while (snapshot.state.day < 20) { snapshot.state.phase = 'night'; nextDay(snapshot.state); }
  if (ownShares) {
    const donor = snapshot.state.actors.find((actor: { id: string; positions: Record<string, { quantity: number }> }) => actor.id !== 'player' && actor.positions.s1?.quantity >= ownShares);
    const holding = donor.positions.s1;
    const cost = Math.round(holding.cost * ownShares / holding.quantity);
    holding.quantity -= ownShares; holding.cost -= cost;
    snapshot.state.actors[0].positions.s1 = { quantity: ownShares, today: 0, financed: 0, cost };
  }
  assert.equal(validateMarket(snapshot.state), true);
  writeFileSync(session.path, JSON.stringify(snapshot));
  return { h, session, application: await h.launch() };
}

test('HTTP explicit cash collateral preserves equity, cannot fund ordinary orders, and replays once after restart', async context => {
  const { h, session, application } = await creditSession(context);
  const before = (await call(application, '/api/market', { cookie: session.cookie })).body.market!;
  assert.equal(before.credit.collateralTotal, 0);
  const request = { type: 'collateral', direction: 'in', cash: 9_999_900, requestId: randomUUID() };
  const deposited = await action(application, session.cookie, request);
  assert.equal(deposited.status, 200);
  assert.equal(deposited.body.market!.equity, before.equity);
  assert.equal(deposited.body.market!.cash, before.cash);
  assert.equal(deposited.body.market!.availableCash, 100);
  assert.equal(deposited.body.market!.credit.cashBalance, 9_999_900);
  assert.equal(deposited.body.market!.debt, 0);
  assert.equal(deposited.body.market!.dailyInterest, 0);
  await action(application, session.cookie, { type: 'pause', paused: false });
  const stock = deposited.body.market!.stocks[0];
  const refused = await action(application, session.cookie, { type: 'order', side: 'buy', stockId: stock.id, quantity: 100, price: stock.price });
  assert.equal(refused.status, 422);
  const target = await action(application, session.cookie, { type: 'repayChallenge', amount: 200 });
  assert.equal(target.status, 422);
  await close(application);
  const restarted = await h.launch();
  const replay = await action(restarted, session.cookie, request);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.market!.credit.cashBalance, 9_999_900);
  assert.equal(replay.body.market!.availableCash, 100);
  const withdrawn = await action(restarted, session.cookie, { type: 'collateral', direction: 'out', cash: 999_900 });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.market!.availableCash, 1_000_000);
  assert.equal(withdrawn.body.market!.equity, before.equity);
});

test('HTTP collateral validates asset shapes and retains inputs unchanged on persistence failure', async context => {
  const { h, session, application } = await creditSession(context);
  await call(application, '/api/market', { cookie: session.cookie });
  const before = readFileSync(session.path, 'utf8');
  for (const body of [
    { direction: 'up', cash: 100 }, { direction: 'in' }, { direction: 'in', cash: 0 },
    { direction: 'in', cash: .001 }, { direction: 'in', cash: '100' },
    { direction: 'in', cash: 100, stockId: 's1', quantity: 100 },
    { direction: 'in', stockId: 's1' }, { direction: 'out', quantity: 100 },
    { direction: 'in', stockId: 's1', quantity: 101 },
  ]) {
    assert.equal((await action(application, session.cookie, { type: 'collateral', ...body })).status, 400);
    assert.equal(readFileSync(session.path, 'utf8'), before);
  }
  const request = { type: 'collateral', direction: 'in', cash: 10_000, requestId: randomUUID() };
  renameSync(h.data, `${h.data}-held`); writeFileSync(h.data, 'block collateral persistence');
  try {
    const failed = await action(application, session.cookie, request);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.market!.credit.cashBalance, 0);
  } finally { rmSync(h.data); renameSync(`${h.data}-held`, h.data); }
  assert.equal((await action(application, session.cookie, request)).status, 200);
  assert.equal((await action(application, session.cookie, request)).body.market!.credit.cashBalance, 10_000);
  const state = JSON.parse(readFileSync(session.path, 'utf8')).state;
  assert.equal((await action(application, session.cookie, { type: 'collateral', direction: 'out', cash: 10_001 })).status, 422);
  assert.deepEqual(JSON.parse(readFileSync(session.path, 'utf8')).state, state);
});

test('HTTP ordinary and credit sales reserve their own shares and pending collateral survives restart', async context => {
  const { h, session, application } = await creditSession(context, 2000);
  const pledged = await action(application, session.cookie, { type: 'collateral', direction: 'in', stockId: 's1', quantity: 1500 });
  assert.equal(pledged.status, 200);
  assert.equal(pledged.body.market!.positions.find(p => p.stockId === 's1')!.available, 500);
  assert.equal(pledged.body.market!.credit.positions.find(p => p.stockId === 's1')!.available, 1500);
  await action(application, session.cookie, { type: 'pause', paused: false });
  const stock = pledged.body.market!.stocks[0];
  assert.equal((await action(application, session.cookie, { type: 'order', side: 'sell', stockId: 's1', quantity: 600, price: stock.limitUp })).status, 422);
  const sold = await action(application, session.cookie, { type: 'order', side: 'creditSell', stockId: 's1', quantity: 1000, price: stock.limitUp });
  assert.equal(sold.status, 200);
  assert.equal(sold.body.market!.credit.positions[0].available, 500);
  assert.equal((await action(application, session.cookie, { type: 'collateral', direction: 'out', stockId: 's1', quantity: 1000 })).status, 422);
  await close(application);
  const restarted = await h.launch();
  const restored = await call(restarted, '/api/market', { cookie: session.cookie });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.market!.credit.positions[0].available, 500);
  const order = restored.body.market!.orders.find(o => o.side === 'creditSell')!;
  assert.equal((await action(restarted, session.cookie, { type: 'cancel', orderId: order.id })).status, 200);
  const out = await action(restarted, session.cookie, { type: 'collateral', direction: 'out', stockId: 's1', quantity: 1500 });
  assert.equal(out.status, 200);
  assert.equal(out.body.market!.positions[0].available, 2000);
});

test('HTTP rejects unknown or corrupt credit ledger versions without replacing saves', async context => {
  const { h, session, application } = await creditSession(context);
  await close(application);
  const snapshot = JSON.parse(readFileSync(session.path, 'utf8'));
  for (const creditAccount of [null, { version: 2, cash: 0, positions: {} }, { version: 1, cash: snapshot.state.actors[0].cash + 1, positions: {} }]) {
    snapshot.state.creditAccount = creditAccount;
    writeFileSync(session.path, JSON.stringify(snapshot));
    const before = readFileSync(session.path, 'utf8'), restarted = await h.launch();
    assert.equal((await call(restarted, '/api/session', { cookie: session.cookie })).status, 409);
    assert.equal(readFileSync(session.path, 'utf8'), before);
    await close(restarted);
  }
});

test('HTTP leverage opening is explicit, idempotent, persistent, and refunds unfilled principal on cancel', async context => {
  const { h, session, application } = await creditSession(context);
  const original = (await call(application, '/api/market', { cookie: session.cookie })).body.market!;
  await action(application, session.cookie, { type: 'pause', paused: false });
  const request = { type: 'marginOpen', stockId: 's1', direction: 'long', mode: 'isolated', leverage: 2,
    principal: 1200, price: original.stocks[0].limitDown, requestId: randomUUID() };
  const opened = await action(application, session.cookie, request);
  assert.equal(opened.status, 200, opened.body.message);
  assert.equal(opened.body.market!.debt, 0, 'unfilled order cannot create debt');
  assert.equal(opened.body.market!.cash, original.cash);
  assert.equal(opened.body.market!.equity, original.equity);
  assert.equal(opened.body.market!.margin.accounts.length, 1);
  const order = opened.body.market!.orders.find(o => o.side === 'marginBuy')!;
  const committed = Math.ceil(Math.round(order.price * 100) * order.quantity / 2) / 100;
  assert.equal(opened.body.market!.availableCash, original.availableCash - committed);
  assert.ok(order.marginAccountId);
  const repeat = await action(application, session.cookie, request);
  assert.equal(repeat.body.market!.revision, opened.body.market!.revision);
  assert.equal((await action(application, session.cookie, { ...request, leverage: 3 })).status, 409);
  assert.equal((await action(application, session.cookie, { type: 'repayChallenge', amount: 1 })).status, 422);
  await close(application);
  const restarted = await h.launch();
  const reloaded = await action(restarted, session.cookie, request);
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.body.market!.margin.accounts.length, 1);
  assert.equal(reloaded.body.market!.availableCash, original.availableCash - committed);
  const added = await action(restarted, session.cookie, { type: 'marginAdd', accountId: order.marginAccountId!, amount: 125.25 });
  assert.equal(added.status, 200, added.body.message);
  assert.equal(added.body.market!.availableCash, original.availableCash - committed - 125.25);
  const cancelled = await action(restarted, session.cookie, { type: 'cancel', orderId: order.id });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.market!.availableCash, original.availableCash);
  assert.equal(cancelled.body.market!.equity, original.equity);
});

test('HTTP leverage validates contracts and rolls back a failed saved opening', async context => {
  const { h, session, application } = await creditSession(context);
  await action(application, session.cookie, { type: 'pause', paused: false });
  const valid = { type: 'marginOpen', stockId: 's1', direction: 'long', mode: 'cross', leverage: 2, principal: 1200, price: 10.8 };
  const before = readFileSync(session.path, 'utf8');
  for (const body of [
    {...valid,mode:'all'}, {...valid,leverage:20}, {...valid,leverage:'2'},
    {...valid,principal:.001}, {...valid,principal:-100}, {...valid,direction:'buy'},
    {type:'marginClose',positionId:'any',quantity:101,price:12},
    {type:'marginAdd',accountId:'any',amount:'100'},
  ]) {
    assert.equal((await action(application, session.cookie, body)).status, 400);
    assert.equal(readFileSync(session.path, 'utf8'), before);
  }
  const request = {...valid,requestId:randomUUID()};
  renameSync(h.data, `${h.data}-held`); writeFileSync(h.data, 'block leverage persistence');
  try {
    const failed = await action(application, session.cookie, request);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.market!.margin.accounts.length, 0);
    assert.equal(failed.body.market!.availableCash, 10_000_000);
  } finally { rmSync(h.data); renameSync(`${h.data}-held`, h.data); }
  await action(application, session.cookie, { type: 'pause', paused: false });
  const opened = await action(application, session.cookie, request);
  assert.equal(opened.status, 200, opened.body.message);
  assert.equal((await action(application, session.cookie, request)).body.market!.margin.accounts.length, 1);
  assert.equal((await action(application, session.cookie, {type:'marginClose',positionId:'unknown',quantity:100,price:12})).status, 422);
  assert.equal((await action(application, session.cookie, {type:'order',stockId:'s1',side:'marginBuy',quantity:100,price:12})).status, 400);
});


test('old twelve-stock HTTP save expands at the next opening and survives a process restart with its old report', async (context) => {
  const h = await harness(context), application = await h.launch(), session = await h.start(application);
  await close(application);
  const saved = JSON.parse(readFileSync(session.path, 'utf8'));
  const old = createMarket(42, { legacySimulation: true });
  old.stocks = old.stocks.filter(s => Number(s.id.slice(1)) <= 12);
  for (const actor of old.actors) for (const id of Object.keys(actor.positions)) if (Number(id.slice(1)) > 12) delete actor.positions[id];
  delete old.stockUniverseVersion; delete old.simulationVersion;
  old.orders = []; old.news = []; old.phase = 'night';
  const donor = old.actors[1].positions.s1;
  donor.quantity -= 100; donor.cost -= 120_000;
  old.actors[0].positions.s1 = { quantity: 100, today: 0, financed: 0, cost: 120_000 };
  const before = getView(old);
  assert.ok(validateMarket(old));
  saved.state = old; writeFileSync(session.path, JSON.stringify(saved));
  const restored = await h.launch();
  const first = await call(restored, '/api/market', { cookie: session.cookie });
  assert.equal(first.status, 200); assert.equal(first.body.market!.stocks.length, 12);
  const opened = await action(restored, session.cookie, { type: 'nextDay' });
  assert.equal(opened.status, 200); assert.equal(opened.body.market!.stocks.length, 18);
  assert.equal(opened.body.market!.cash, before.cash);
  assert.deepEqual(opened.body.market!.positions, before.positions);
  assert.deepEqual(opened.body.market!.postClose, before.postClose);
  assert.equal(opened.body.market!.postClose!.sectorFlows.length, 3);
  const persisted = JSON.parse(readFileSync(session.path, 'utf8')).state;
  assert.equal(persisted.stockUniverseVersion, 1); assert.ok(validateMarket(persisted));
  await close(restored);
  const restarted = await h.launch();
  const final = await call(restarted, '/api/market', { cookie: session.cookie });
  assert.equal(final.status, 200); assert.deepEqual(final.body.market, opened.body.market);
});
