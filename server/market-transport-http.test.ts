import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApplication } from './index.js';
import { writeSnapshot } from './snapshot-store.js';
import { readMarketEnvelope, type MarketSnapshot, type WireApiResponse } from '../shared/market-sync.js';
import { createApiClient } from '../src/api.js';

async function harness(context: TestContext, writer: typeof writeSnapshot = writeSnapshot) {
  const directory = mkdtempSync(join(tmpdir(), 'youzi-transport-http-'));
  let clock = Date.now();
  const application = createApplication({ dataDirectory: directory, production: false, openingScenario: false,
    publicOrigin: '', publicOriginAliases: [], now: () => clock, writeSnapshot: writer });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await application.stop();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  async function call(path: string, cookie?: string, body?: Record<string, unknown>) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) { headers.origin = base; headers['content-type'] = 'application/json'; }
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as WireApiResponse, bytes: Buffer.byteLength(text),
      cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }

  async function start(seed = 42) {
    const reply = await call('/api/start', undefined, { seed });
    assert.equal(reply.status, 200);
    assert.ok(reply.cookie && reply.body.market && reply.body.sync);
    return { ...reply, cookie: reply.cookie };
  }

  function action(cookie: string, body: Record<string, unknown>) {
    return call('/api/action', cookie, { requestId: randomUUID(), ...body });
  }
  return { call, start, action, base, addTime: (duration: number) => { clock += duration; } };
}

const since = (version: string | undefined) => `/api/market?since=${encodeURIComponent(version ?? '')}`;

test('HTTP session seeds polling; actions produce deltas, old clients stay full, and lost baselines recover', async context => {
  const h = await harness(context);
  assert.deepEqual((await h.call('/api/session')).body, { market: null, ok: true });
  const player = await h.start();
  const session = await h.call('/api/session', player.cookie);
  assert.equal(session.status, 200);
  assert.deepEqual(session.body, { market: player.body.market, sync: player.body.sync, ok: true });
  let snapshot = readMarketEnvelope({ market: null }, session.body)!;
  const unchanged = await h.call(since(snapshot.version), player.cookie);
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.sync?.unchanged, true);
  assert.equal(Object.hasOwn(unchanged.body, 'market'), false);
  assert.ok(unchanged.bytes < 140);
  assert.equal(unchanged.headers.get('cache-control'), 'no-store');

  const changed = await h.action(player.cookie, { type: 'speed', speed: 4 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.market?.speed, 4);
  const delta = await h.call(since(snapshot.version), player.cookie);
  assert.ok(delta.body.sync?.patch);
  assert.equal(Object.hasOwn(delta.body, 'market'), false);
  snapshot = readMarketEnvelope(snapshot, delta.body)!;
  assert.deepEqual(snapshot.market, changed.body.market);
  assert.ok(delta.bytes < session.bytes / 100);

  const oldClient = await h.call('/api/market', player.cookie);
  assert.deepEqual(oldClient.body.market, snapshot.market);
  assert.equal(oldClient.body.sync?.version, snapshot.version);
  assert.equal((await h.call(since(snapshot.version), player.cookie)).body.sync?.unchanged, true,
    'an old client read must not invalidate modern client versions');

  await h.action(player.cookie, { type: 'repayChallenge', amount: 1000 });
  const latest = await h.action(player.cookie, { type: 'speed', speed: 12 });
  const recovered = await h.call(since(snapshot.version), player.cookie);
  assert.ok(recovered.body.market, 'two missed baselines return a full view');
  assert.deepEqual(readMarketEnvelope(snapshot, recovered.body)?.market, latest.body.market);
  assert.deepEqual((await h.call(since('unknown:12'), player.cookie)).body.market, latest.body.market);
  assert.ok((await h.call('/api/market?since[]=bad', player.cookie)).body.market);
});

test('HTTP sync baselines and full recovery never cross independent sessions', async context => {
  const h = await harness(context);
  const first = await h.start(21), second = await h.start(22);
  assert.notEqual(first.body.sync?.version, second.body.sync?.version);
  assert.notEqual(first.cookie, second.cookie);
  const changed = await h.action(first.cookie, { type: 'repayChallenge', amount: 5000 });
  assert.equal(changed.body.market?.challenge?.paid, 5000);
  const crossed = await h.call(since(changed.body.sync?.version), second.cookie);
  assert.equal(crossed.status, 200);
  assert.ok(crossed.body.market);
  assert.equal(crossed.body.market.challenge?.paid, 0);
  assert.deepEqual(crossed.body.market, second.body.market);
  assert.equal(crossed.body.sync?.version, second.body.sync?.version);
  assert.equal(JSON.stringify(crossed.body).includes(first.cookie.split('=')[1]), false);
  assert.equal(JSON.stringify(crossed.body).includes(second.cookie.split('=')[1]), false);
});

test('a failed write changes transport version even at the same market revision, returning HTTP 503 and paused state', async context => {
  let failing = false;
  const h = await harness(context, async (destination, serialized) => {
    if (failing) throw new Error('Injected disk write failure');
    await writeSnapshot(destination, serialized);
  });
  const player = await h.start();
  const running = await h.action(player.cookie, { type: 'pause', paused: false });
  let snapshot = readMarketEnvelope({ market: null }, running.body)!;
  assert.equal(snapshot.market?.paused, false);
  failing = true;
  const failure = await h.action(player.cookie, { type: 'speed', speed: 12 });
  assert.equal(failure.status, 503);
  assert.equal(failure.body.market?.revision, snapshot.market?.revision, 'failed candidate never commits');
  assert.equal(failure.body.market?.speed, snapshot.market?.speed);
  assert.equal(failure.body.market?.paused, true);
  assert.notEqual(failure.body.sync?.version, snapshot.version, 'pause override must invalidate sync cache');
  const poll = await h.call(since(snapshot.version), player.cookie);
  assert.equal(poll.status, 503);
  assert.equal(poll.body.ok, false);
  assert.match(poll.body.message!, /存档写入失败/);
  snapshot = readMarketEnvelope(snapshot, poll.body)!;
  assert.deepEqual(snapshot.market, failure.body.market);
  assert.equal(snapshot.market?.paused, true);
  const sameFailure = await h.call(since(snapshot.version), player.cookie);
  assert.equal(sameFailure.status, 503);
  assert.equal(sameFailure.body.sync?.unchanged, true);
  failing = false;
  const repaired = await h.action(player.cookie, { type: 'pause', paused: true });
  assert.equal(repaired.status, 200);
  const recovered = await h.call(since(snapshot.version), player.cookie);
  assert.equal(recovered.status, 200);
  assert.deepEqual(readMarketEnvelope(snapshot, recovered.body)?.market, repaired.body.market);
});

test('browser API reconstructs real HTTP tick deltas and reseeds after actions, missed frames and a fresh game', async context => {
  const h = await harness(context);
  let cookie: string | undefined;
  const requests: { path: string; payload: WireApiResponse; bytes: number }[] = [];
  const browserFetch: typeof fetch = async (input, init) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    if (cookie) headers.set('cookie', cookie);
    if (init?.method === 'POST') headers.set('origin', h.base);
    const reply = await fetch(h.base + path, { ...init, headers });
    cookie = reply.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    const text = await reply.clone().text();
    requests.push({ path, payload: JSON.parse(text) as WireApiResponse, bytes: Buffer.byteLength(text) });
    return reply;
  };
  const api = createApiClient(browserFetch);
  assert.equal((await api('session')).market, null);
  const start = await api('start', { seed: 51 });
  assert.ok(start.market && cookie);
  assert.deepEqual((await api('session')).market, start.market);
  assert.deepEqual((await api('market')).market, start.market);
  assert.equal(requests.at(-1)?.payload.sync?.unchanged, true);
  await api('action', { requestId: randomUUID(), type: 'speed', speed: 4 });
  const resumed = await api('action', { requestId: randomUUID(), type: 'pause', paused: false });
  h.addTime(1200);
  const deadline = Date.now() + 5000;
  let tick: MarketSnapshot = { market: resumed.market };
  do {
    await new Promise(resolve => setTimeout(resolve, 30));
    tick = await api('market');
    assert.ok(Date.now() < deadline, 'background tick did not publish before the timeout');
  } while (tick.market!.revision <= resumed.market!.revision);
  assert.ok(requests.at(-1)?.payload.sync?.patch);
  const full = await h.call('/api/market', cookie);
  assert.deepEqual(tick.market, full.body.market);
  assert.ok(requests.at(-1)!.bytes < full.bytes / 4);
  await h.action(cookie, { type: 'repayChallenge', amount: 2500 });
  await h.action(cookie, { type: 'speed', speed: 12 });
  const recovered = await api('market');
  assert.ok(requests.at(-1)?.payload.market);
  assert.equal(recovered.market?.challenge?.paid, 2500);
  const oldCookie = cookie;
  const fresh = await api('start', { seed: 52 });
  assert.notEqual(cookie, oldCookie);
  assert.equal(fresh.market?.challenge?.paid, 0);
  assert.equal(fresh.market?.speed, 1);
  assert.deepEqual((await api('market')).market, fresh.market);
  assert.equal(requests.at(-1)?.payload.sync?.unchanged, true);
});
