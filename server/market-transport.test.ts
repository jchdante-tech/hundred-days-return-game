import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePhase, createMarket, getView, nextDay, submitOrder, tick } from './engine.js';
import { MarketTransport } from './market-transport.js';
import { applyValuePatch, diffValues, readMarketEnvelope, type MarketSnapshot, type WireApiResponse } from '../shared/market-sync.js';
import { createApiClient } from '../src/api.js';
import type { MarketView } from '../shared/types.js';

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const response = (value: WireApiResponse, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('patches retain unchanged history, edit live bar, append and truncate without changing the previous snapshot', () => {
  const before = { dailyBars: [{ close: 10, complete: true }, { close: 12, complete: false }],
    history: [{ price: 10 }], obsolete: 1, optional: undefined };
  const after = { dailyBars: [{ close: 10, complete: true }, { close: 13, complete: true }, { close: 14, complete: false }],
    history: [{ price: 10 }, { price: 14 }], extra: true };
  const patch = wire(diffValues(before, after)!);
  const reconstructed = applyValuePatch(wire(before), patch) as typeof after;
  assert.deepEqual(reconstructed, after);
  assert.deepEqual(before.history, [{ price: 10 }]);
  const unchangedReference = applyValuePatch(before, patch) as typeof after;
  assert.equal(unchangedReference.dailyBars[0], before.dailyBars[0]);
  const reset = { dailyBars: [], history: [] };
  assert.deepEqual(applyValuePatch(after, wire(diffValues(after, reset)!)), reset);
  assert.equal(diffValues({ optional: undefined }, {}), undefined);
});

test('real market tick, order, phase and next-day payloads reconstruct exactly, with small polling payloads', () => {
  const market = createMarket(7813);
  const transport = new MarketTransport();
  let snapshot: MarketSnapshot = { market: null };
  let fullBytes = 0, deltaBytes = 0;
  const check = () => {
    const current = getView(market);
    const payload = wire(transport.poll(current, snapshot.version));
    snapshot = readMarketEnvelope(snapshot, payload)!;
    assert.ok(snapshot);
    assert.deepEqual(snapshot.market, wire(current));
    return { current, payload };
  };
  check();
  market.paused = false;
  market.speed = 4;
  for (let index = 0; index < 12; index += 1) {
    tick(market);
    const { current, payload } = check();
    assert.ok(payload.sync?.patch);
    fullBytes += bytes({ market: current });
    deltaBytes += bytes(payload);
  }
  assert.ok(deltaBytes < fullBytes * 0.25, `delta ${deltaBytes} / full ${fullBytes}`);
  advancePhase(market); check();
  const stock = getView(market).stocks.find(item => item.asks.length > 0)!;
  if (stock) submitOrder(market, { stockId: stock.id, side: 'buy', quantity: 100, price: stock.asks[0].price });
  check();
  market.speed = 12; tick(market); check();
  nextDay(market); check();
  assert.equal(snapshot.market?.day, 2);
});

test('unchanged views, missing baselines, action full views, reconnects and distinct games remain compatible', () => {
  const transport = new MarketTransport();
  const firstView = getView(createMarket(2));
  const first = wire(transport.full(firstView));
  const firstSnapshot = readMarketEnvelope({ market: null }, first)!;
  assert.deepEqual(transport.poll(firstView), transport.full(firstView));
  const unchanged = wire(transport.poll(firstView, firstSnapshot.version));
  assert.ok(bytes(unchanged) < 120);
  assert.equal(readMarketEnvelope(firstSnapshot, unchanged), firstSnapshot);
  assert.equal(readMarketEnvelope({ market: null }, unchanged), undefined);
  const secondView = { ...firstView, revision: firstView.revision + 1, speed: 4 as const };
  const second = wire(transport.full(secondView));
  const actionSnapshot = readMarketEnvelope(firstSnapshot, second)!;
  const delta = wire(transport.poll(secondView, firstSnapshot.version));
  assert.ok(delta.sync?.patch);
  assert.deepEqual(readMarketEnvelope(firstSnapshot, delta), actionSnapshot);
  assert.equal(readMarketEnvelope({ market: firstView, version: 'unknown:1' }, delta), undefined);
  assert.deepEqual(transport.poll(secondView, 'unknown:1'), transport.full(secondView));
  assert.equal(readMarketEnvelope(actionSnapshot, first), actionSnapshot);
  const thirdView = { ...secondView, revision: secondView.revision + 1 };
  transport.full(thirdView);
  assert.ok(transport.poll(thirdView, firstSnapshot.version).market, 'only one older baseline is retained');
  const otherGame = wire(new MarketTransport().full(getView(createMarket(3))));
  assert.notEqual(otherGame.sync?.version.split(':')[0], first.sync?.version.split(':')[0]);
  assert.deepEqual(readMarketEnvelope(actionSnapshot, otherGame)?.market, otherGame.market);
  assert.deepEqual(readMarketEnvelope(actionSnapshot, { market: firstView }), { market: firstView, version: undefined });
});

test('API repairs a missed delta using one full read and reseeds after actions', async () => {
  const market = getView(createMarket(4));
  const transport = new MarketTransport();
  const first = wire(transport.full(market));
  const secondMarket = { ...market, revision: market.revision + 1, speed: 4 as const };
  const second = wire(transport.full(secondMarket));
  const thirdMarket = { ...secondMarket, revision: secondMarket.revision + 1, paused: false };
  const thirdDelta = wire(transport.poll(thirdMarket, second.sync!.version));
  const paths: string[] = [];
  const replies = [first, thirdDelta, wire(transport.full(thirdMarket)), wire(transport.full(thirdMarket))];
  const api = createApiClient((async (url: string) => {
    paths.push(url);
    return response(replies.shift()!);
  }) as typeof fetch);
  assert.deepEqual((await api('session')).market, wire(market));
  assert.deepEqual((await api('market')).market, wire(thirdMarket));
  assert.equal(paths[1], `/api/market?since=${encodeURIComponent(first.sync!.version)}`);
  assert.equal(paths[2], '/api/market');
  await api('action', { type: 'pause', paused: true });
  assert.equal(paths.filter(path => path === '/api/action').length, 1);
});

test('an older overlapping poll cannot regress an action response', async () => {
  const market = getView(createMarket(5));
  const transport = new MarketTransport();
  const first = wire(transport.full(market));
  const nextMarket = { ...market, revision: market.revision + 1, speed: 12 as const };
  const next = wire(transport.full(nextMarket));
  let finishPoll!: (value: Response) => void;
  const api = createApiClient((async (url: string) => {
    if (url === '/api/session') return response(first);
    if (url === '/api/action') return response(next);
    return new Promise<Response>(resolve => { finishPoll = resolve; });
  }) as typeof fetch);
  await api('session');
  const pending = api('market');
  await api('action', { type: 'speed', speed: 12 });
  finishPoll(response(first));
  assert.deepEqual((await pending).market, wire(nextMarket));
});

test('a pending old-game poll cannot replace a newly started market or its sync baseline', async () => {
  const first = wire(new MarketTransport().full(getView(createMarket(6))));
  const nextTransport = new MarketTransport();
  const nextMarket = getView(createMarket(7));
  const next = wire(nextTransport.full(nextMarket));
  let finishPoll!: (value: Response) => void;
  const paths: string[] = [];
  const api = createApiClient((async (url: string) => {
    paths.push(url);
    if (url === '/api/session') return response(first);
    if (url === '/api/start') return response(next);
    if (paths.length === 2) return new Promise<Response>(resolve => { finishPoll = resolve; });
    return response(nextTransport.poll(nextMarket, next.sync!.version));
  }) as typeof fetch);
  await api('session');
  const pending = api('market');
  await api('start', {});
  finishPoll(response(first));
  assert.deepEqual((await pending).market, wire(nextMarket));
  assert.deepEqual((await api('market')).market, wire(nextMarket));
  assert.equal(paths.at(-1), `/api/market?since=${encodeURIComponent(next.sync!.version)}`);
});

test('failed actions are never automatically replayed and legacy full responses still work', async () => {
  const market: MarketView = getView(createMarket(8));
  const calls: string[] = [];
  const api = createApiClient((async (url: string) => {
    calls.push(url);
    return url === '/api/action' ? response({ market, ok: false, message: '委托未成交' }, 422)
      : response({ market, ok: true });
  }) as typeof fetch);
  assert.deepEqual((await api('session')).market, wire(market));
  await assert.rejects(api('action', { type: 'order' }), /委托未成交/);
  assert.equal(calls.filter(path => path === '/api/action').length, 1);
  assert.deepEqual((await api('market')).market, wire(market));
  assert.equal(calls.at(-1), '/api/market');
});

test('an obsolete failed poll still rejects and cannot corrupt the new game baseline', async () => {
  const first = wire(new MarketTransport().full(getView(createMarket(9))));
  const nextTransport = new MarketTransport();
  const nextMarket = getView(createMarket(10));
  const next = wire(nextTransport.full(nextMarket));
  let finishPoll!: (value: Response) => void;
  let polls = 0;
  const api = createApiClient((async (url: string) => {
    if (url === '/api/session') return response(first);
    if (url === '/api/start') return response(next);
    if (++polls === 1) return new Promise<Response>(resolve => { finishPoll = resolve; });
    assert.equal(url, `/api/market?since=${encodeURIComponent(next.sync!.version)}`);
    return response(nextTransport.poll(nextMarket, next.sync!.version));
  }) as typeof fetch);
  await api('session');
  const pending = api('market');
  await api('start', {});
  const rejected = assert.rejects(pending, /旧市场写入失败/);
  finishPoll(response({ ...first, ok: false, message: '旧市场写入失败' }, 503));
  await rejected;
  assert.deepEqual((await api('market')).market, wire(nextMarket));
});
