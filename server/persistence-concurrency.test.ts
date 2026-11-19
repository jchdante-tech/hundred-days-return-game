import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { MarketView } from '../shared/types.js';
import { createApplication } from './index.js';
import { writeSnapshot } from './snapshot-store.js';

interface Reply {
  status: number;
  market: MarketView | null;
  ok: boolean;
  cookie: string | null;
}

interface Snapshot {
  state: { paused: boolean; challenge: { paid: number } };
  requests: { requestId: string }[];
}

interface Running {
  base: string;
  server: Server;
  stop: () => Promise<void>;
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Hold one real atomic write at its durability boundary, without replacing the
// storage behavior being tested. All other players continue to use real files.
function gatedWriter() {
  let selected: {
    matches: (snapshot: Snapshot) => boolean;
    entered: ReturnType<typeof latch>;
    released: ReturnType<typeof latch>;
    failure?: Error;
  } | undefined;
  const held = new Set<ReturnType<typeof latch>>();
  return {
    arm(matches: (snapshot: Snapshot) => boolean) {
      assert.equal(selected, undefined, 'only one write may be selected at a time');
      const gate = { matches, entered: latch(), released: latch(), failure: undefined as Error | undefined };
      selected = gate;
      held.add(gate.released);
      return {
        entered: gate.entered.promise,
        release() { gate.released.resolve(); },
        fail() { gate.failure = new Error('injected write failure'); gate.released.resolve(); },
      };
    },
    async write(destination: string, serialized: string) {
      const gate = selected;
      if (gate && gate.matches(JSON.parse(serialized) as Snapshot)) {
        selected = undefined;
        gate.entered.resolve();
        await gate.released.promise;
        held.delete(gate.released);
        if (gate.failure) throw gate.failure;
      }
      await writeSnapshot(destination, serialized);
    },
    releaseAll() { for (const gate of held) gate.resolve(); },
  };
}

async function call(application: Running, path: string, cookie?: string, body?: Record<string, unknown>): Promise<Reply> {
  const response = await fetch(application.base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { origin: application.base, 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json() as { market: MarketView | null; ok: boolean };
  return { status: response.status, ...payload, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null };
}

async function close(application: Running) {
  await application.stop();
  if (application.server.listening) {
    await new Promise<void>((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
  }
}

async function harness(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'youzi-concurrency-'));
  const dataDirectory = join(root, 'saves');
  let clock = Date.now();
  const applications: Running[] = [];
  const writers: ReturnType<typeof gatedWriter>[] = [];
  context.after(async () => {
    for (const writer of writers) writer.releaseAll();
    for (const application of applications) await close(application);
    await rm(root, { recursive: true, force: true });
  });
  return {
    addTime(milliseconds: number) { clock += milliseconds; },
    writer() { const writer = gatedWriter(); writers.push(writer); return writer; },
    async launch(writer?: ReturnType<typeof gatedWriter>) {
      const application = createApplication({ dataDirectory, now: () => clock, production: false, openingScenario: false,
        publicOrigin: '', publicOriginAliases: [], ...(writer ? { writeSnapshot: writer.write } : {}) });
      const server = application.app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const running = { base: `http://127.0.0.1:${address.port}`, server, stop: application.stop };
      applications.push(running);
      return running;
    },
    async start(application: Running) {
      const reply = await call(application, '/api/start', undefined, { seed: 42 });
      assert.equal(reply.status, 200);
      assert.ok(reply.cookie);
      return reply.cookie;
    },
    async snapshot(cookie: string) {
      return JSON.parse(await readFile(join(dataDirectory, `${cookie.split('=')[1]}.json`), 'utf8')) as Snapshot;
    },
  };
}

test('simultaneous retries wait for durable commit and apply a repayment once', { timeout: 10_000 }, async context => {
  const h = await harness(context), writer = h.writer(), application = await h.launch(writer);
  const cookie = await h.start(application), requestId = randomUUID();
  const body = { type: 'repayChallenge', amount: 1000, requestId };
  const gate = writer.arm(snapshot => snapshot.requests.some(record => record.requestId === requestId));
  let acknowledged = false;
  const first = call(application, '/api/action', cookie, body).then(reply => { acknowledged = true; return reply; });
  await gate.entered;
  const retries = Array.from({ length: 5 }, () => call(application, '/api/action', cookie, body));
  const beforeCommit = await call(application, '/api/market', cookie);
  assert.equal(acknowledged, false, 'success must not be acknowledged while its snapshot is pending');
  assert.equal(beforeCommit.market!.challenge!.paid, 0, 'uncommitted candidate must not be visible');
  gate.release();
  const responses = await Promise.all([first, ...retries]);
  for (const reply of responses) {
    assert.equal(reply.status, 200);
    assert.equal(reply.market!.challenge!.paid, 1000);
  }
  const snapshot = await h.snapshot(cookie);
  assert.equal(snapshot.state.challenge.paid, 100_000);
  assert.deepEqual(snapshot.requests.map(record => record.requestId), [requestId]);
});

test('concurrent different repayments retain every acknowledged result after restart', { timeout: 10_000 }, async context => {
  const h = await harness(context), application = await h.launch(), cookie = await h.start(application);
  const requests = [100, 200, 300, 400, 500, 600].map(amount => ({ type: 'repayChallenge', amount, requestId: randomUUID() }));
  const replies = await Promise.all(requests.map(body => call(application, '/api/action', cookie, body)));
  for (const reply of replies) assert.equal(reply.status, 200);
  const paid = requests.reduce((total, request) => total + request.amount, 0);
  assert.equal((await h.snapshot(cookie)).state.challenge.paid, paid * 100);
  await close(application);
  const restored = await h.launch();
  const market = (await call(restored, '/api/session', cookie)).market!;
  assert.equal(market.challenge!.paid, paid);
  assert.equal(market.paused, true);
  const retried = await Promise.all(requests.map(body => call(restored, '/api/action', cookie, body)));
  for (const reply of retried) assert.equal(reply.market!.challenge!.paid, paid);
  assert.equal((await h.snapshot(cookie)).requests.length, requests.length);
});

test('simultaneous restore and actions use one market without losing committed repayments', { timeout: 10_000 }, async context => {
  const h = await harness(context), original = await h.launch(), cookie = await h.start(original);
  await close(original);
  const writer = h.writer(), restored = await h.launch(writer);
  const gate = writer.arm(snapshot => snapshot.requests.length === 0);
  const loading = call(restored, '/api/session', cookie);
  await gate.entered;
  const requests = [1000, 2000].map(amount => ({ type: 'repayChallenge', amount, requestId: randomUUID() }));
  const actions = requests.map(body => call(restored, '/api/action', cookie, body));
  // Let both HTTP requests arrive while the first restore is still waiting for disk.
  await new Promise(resolve => setTimeout(resolve, 30));
  gate.release();
  assert.equal((await loading).status, 200);
  for (const reply of await Promise.all(actions)) assert.equal(reply.status, 200);
  assert.equal((await call(restored, '/api/market', cookie)).market!.challenge!.paid, 3000);
  const saved = await h.snapshot(cookie);
  assert.equal(saved.state.challenge.paid, 300_000);
  assert.deepEqual(new Set(saved.requests.map(record => record.requestId)), new Set(requests.map(request => request.requestId)));
});

test('one stalled or failed player save does not block another player or consume the failed request ID', { timeout: 10_000 }, async context => {
  const h = await harness(context), writer = h.writer(), application = await h.launch(writer);
  const firstCookie = await h.start(application), secondCookie = await h.start(application);
  const firstRequest = { type: 'repayChallenge', amount: 1000, requestId: randomUUID() };
  const gate = writer.arm(snapshot => snapshot.requests.some(record => record.requestId === firstRequest.requestId));
  const pending = call(application, '/api/action', firstCookie, firstRequest);
  await gate.entered;
  const independent = await call(application, '/api/action', secondCookie,
    { type: 'repayChallenge', amount: 2000, requestId: randomUUID() });
  assert.equal(independent.status, 200);
  assert.equal(independent.market!.challenge!.paid, 2000);
  gate.fail();
  const failed = await pending;
  assert.equal(failed.status, 503);
  assert.equal(failed.market!.challenge!.paid, 0);
  assert.equal(failed.market!.paused, true);
  assert.equal((await h.snapshot(firstCookie)).state.challenge.paid, 0);
  assert.deepEqual((await h.snapshot(firstCookie)).requests, []);
  const retry = await call(application, '/api/action', firstCookie, firstRequest);
  assert.equal(retry.status, 200);
  assert.equal(retry.market!.challenge!.paid, 1000);
  assert.equal((await h.snapshot(firstCookie)).requests.length, 1);
});

test('shutdown drains an accepted pending action and restores it paused and idempotent', { timeout: 10_000 }, async context => {
  const h = await harness(context), writer = h.writer(), application = await h.launch(writer);
  const cookie = await h.start(application);
  assert.equal((await call(application, '/api/action', cookie,
    { type: 'pause', paused: false, requestId: randomUUID() })).status, 200);
  const request = { type: 'repayChallenge', amount: 1000, requestId: randomUUID() };
  const gate = writer.arm(snapshot => snapshot.requests.some(record => record.requestId === request.requestId));
  const pending = call(application, '/api/action', cookie, request);
  await gate.entered;
  let stopped = false;
  const stopping = application.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, 'shutdown must wait for an action already accepted for persistence');
  gate.release();
  assert.equal((await pending).status, 200);
  await stopping;
  const snapshot = await h.snapshot(cookie);
  assert.equal(snapshot.state.paused, true);
  assert.equal(snapshot.state.challenge.paid, 100_000);
  await close(application);
  const restored = await h.launch();
  const replay = await call(restored, '/api/action', cookie, request);
  assert.equal(replay.status, 200);
  assert.equal(replay.market!.challenge!.paid, 1000);
  assert.equal(replay.market!.paused, true);
  assert.equal((await h.snapshot(cookie)).requests.filter(record => record.requestId === request.requestId).length, 1);
});

test('starting a new game keeps accepted actions on the previous game attached to its live session', { timeout: 10_000 }, async context => {
  const h = await harness(context), writer = h.writer(), application = await h.launch(writer);
  const cookie = await h.start(application), resumeId = randomUUID();
  assert.equal((await call(application, '/api/action', cookie,
    { type: 'pause', paused: false, requestId: resumeId })).status, 200);
  const pausing = writer.arm(snapshot => snapshot.state.paused && snapshot.requests.length === 1
    && snapshot.requests[0].requestId === resumeId);
  const newGame = call(application, '/api/start', cookie, { seed: 43 });
  await pausing.entered;
  const request = { type: 'repayChallenge', amount: 1000, requestId: randomUUID() };
  const paying = writer.arm(snapshot => snapshot.requests.some(record => record.requestId === request.requestId));
  const action = call(application, '/api/action', cookie, request);
  await new Promise(resolve => setTimeout(resolve, 30));
  pausing.release();
  await paying.entered;
  const started = await newGame;
  assert.equal(started.status, 200);
  assert.notEqual(started.cookie, cookie);
  // An old tab can still read its prior game while its queued action is saving.
  const oldTab = await call(application, '/api/session', cookie);
  assert.equal(oldTab.status, 200);
  assert.equal(oldTab.market!.challenge!.paid, 0);
  paying.release();
  assert.equal((await action).status, 200);
  assert.equal((await call(application, '/api/market', cookie)).market!.challenge!.paid, 1000);
  assert.equal((await h.snapshot(cookie)).state.challenge.paid, 100_000);
  assert.equal((await call(application, '/api/market', started.cookie!)).market!.challenge!.paid, 0);
});

test('offline eviction cannot detach an accepted action queued behind a slow write', { timeout: 10_000 }, async context => {
  const h = await harness(context), writer = h.writer(), application = await h.launch(writer);
  const cookie = await h.start(application);
  await call(application, '/api/action', cookie, { type: 'pause', paused: false, requestId: randomUUID() });
  const firstRequest = { type: 'repayChallenge', amount: 1000, requestId: randomUUID() };
  const firstGate = writer.arm(snapshot => snapshot.requests.some(record => record.requestId === firstRequest.requestId));
  const first = call(application, '/api/action', cookie, firstRequest);
  await firstGate.entered;
  // Queue eviction behind the first write, then accept a later action behind
  // eviction. Both requests become older than OFFLINE_MS while disk is stalled.
  h.addTime(13_000);
  await new Promise(resolve => setTimeout(resolve, 450));
  const secondRequest = { type: 'repayChallenge', amount: 2000, requestId: randomUUID() };
  const secondGate = writer.arm(snapshot => snapshot.requests.some(record => record.requestId === secondRequest.requestId));
  const second = call(application, '/api/action', cookie, secondRequest);
  await new Promise(resolve => setTimeout(resolve, 30));
  h.addTime(13_000);
  firstGate.release();
  await secondGate.entered;
  // This read would restore a competing Session if eviction detached the queue.
  const duringWrite = await call(application, '/api/session', cookie);
  assert.equal(duringWrite.market!.challenge!.paid, 1000);
  secondGate.release();
  assert.equal((await first).status, 200);
  const acknowledged = await second;
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.market!.challenge!.paid, 3000);
  const third = await call(application, '/api/action', cookie,
    { type: 'repayChallenge', amount: 100, requestId: randomUUID() });
  assert.equal(third.status, 200);
  assert.equal(third.market!.challenge!.paid, 3100, 'subsequent commits retain both acknowledged repayments');
  assert.equal((await h.snapshot(cookie)).state.challenge.paid, 310_000);
});

test('an action accepted during the offline pause write keeps its live session attached', { timeout: 10_000 }, async context => {
  const h = await harness(context), writer = h.writer(), application = await h.launch(writer);
  const cookie = await h.start(application), resumeId = randomUUID();
  await call(application, '/api/action', cookie, { type: 'pause', paused: false, requestId: resumeId });
  const pauseGate = writer.arm(snapshot => snapshot.state.paused && snapshot.requests.length === 1
    && snapshot.requests[0].requestId === resumeId);
  h.addTime(13_000);
  await pauseGate.entered;
  const request = { type: 'repayChallenge', amount: 2000, requestId: randomUUID() };
  const actionGate = writer.arm(snapshot => snapshot.requests.some(record => record.requestId === request.requestId));
  const pending = call(application, '/api/action', cookie, request);
  await new Promise(resolve => setTimeout(resolve, 30));
  h.addTime(13_000);
  pauseGate.release();
  await actionGate.entered;
  assert.equal((await call(application, '/api/session', cookie)).market!.challenge!.paid, 0);
  actionGate.release();
  assert.equal((await pending).market!.challenge!.paid, 2000);
  const third = await call(application, '/api/action', cookie,
    { type: 'repayChallenge', amount: 100, requestId: randomUUID() });
  assert.equal(third.market!.challenge!.paid, 2100);
  assert.equal((await h.snapshot(cookie)).state.challenge.paid, 210_000);
});
