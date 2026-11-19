/**
 * Isolated capacity test: a real application child process and an independent HTTP
 * load generator. Never points at a running production server or its saves.
 * Run: npx tsx scripts/capacity-benchmark.ts --clients=5,10,20 --speed=4 --seconds=30
 */
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

const script = fileURLToPath(import.meta.url);
const args = new Map(process.argv.slice(2).map(value => {
  const [key, ...parts] = value.replace(/^--/, '').split('=');
  return [key!, parts.length ? parts.join('=') : 'true'];
}));
const target = resolve(args.get('target') ?? join(dirname(script), '..'));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const moduleAt = (relative: string) => import(pathToFileURL(join(target, relative)).href);
const numeric = (key: string, fallback: number) => {
  const value = Number(args.get(key) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${key} must be positive`);
  return value;
};
const list = (key: string, fallback: string) => (args.get(key) ?? fallback).split(',').map(value => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid --${key}`);
  return parsed;
});
const percentile = (values: number[], quantile: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
};
const rounded = (value: number) => Math.round(value * 1000) / 1000;
const distribution = (values: number[]) => ({ count: values.length,
  p50: rounded(percentile(values, .5)), p95: rounded(percentile(values, .95)),
  max: rounded(values.length ? Math.max(...values) : 0),
  mean: rounded(values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0) });

type View = { day: number; phase: string; phaseProgress: number; time: string; speed: number; paused: boolean;
  availableCash: number; stocks: Array<{ id: string; limitUp: number; limitDown: number;
    bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }> }>;
  positions: Array<{ stockId: string; available: number }>;
  orders: Array<{ stockId: string; side: string; status: string }> };
type Snapshot = { market: View | null; version?: string };
type Envelope = { market?: View | null; ok?: boolean; message?: string; sync?: unknown };
type Telemetry = { at: number; rssBytes: number; cpuPercentOneCore: number; eventLoopP95Ms: number;
  eventLoopMaxMs: number; eventLoopUtilization: number };
const phases: Record<string, [number, number]> = { auction: [0, 45], morning: [45, 180],
  lunch: [225, 30], afternoon: [255, 180], closing: [435, 15], night: [450, 150], ended: [450, 1] };
function simulationPoint(view: View) {
  const phase = phases[view.phase];
  if (!phase) throw new Error(`Unknown phase ${view.phase}`);
  // Count the 450 active simulation seconds, excluding the explicit 150-second
  // overnight nextDay jump. Revision also increments for trades and is not a clock.
  return (view.day - 1) * 450 + phase[0] + (view.phase === 'night' || view.phase === 'ended' ? 0 : phase[1] * view.phaseProgress);
}

function smallOrder(view: View | null, rotation: number): Record<string, unknown> | undefined {
  if (!view || view.paused || !['auction', 'morning', 'afternoon', 'closing'].includes(view.phase)) return;
  const openOrders = view.orders.filter(order => ['open', 'partial'].includes(order.status));
  if (openOrders.length >= 95) return;
  const stocks = [...view.stocks.slice(rotation % view.stocks.length), ...view.stocks.slice(0, rotation % view.stocks.length)];
  // Ordinary shares obey T+1. Prefer an available sell; otherwise buy one board lot.
  // A marketable limit remains valid if the best quote moves before the POST arrives.
  const sell = stocks.find(stock => view.positions.some(position => position.stockId === stock.id && position.available >= 100)
    && stock.bids.some(level => level.quantity >= 100)
    && !openOrders.some(order => order.stockId === stock.id && ['buy', 'finance', 'cover'].includes(order.side)));
  if (sell) return { type: 'order', stockId: sell.id, side: 'sell', quantity: 100, price: sell.limitDown };
  const buy = stocks.find(stock => stock.asks.some(level => level.quantity >= 100)
    && view.availableCash >= stock.limitUp * 100 * 1.01
    && !openOrders.some(order => order.stockId === stock.id && ['sell', 'short', 'creditSell'].includes(order.side)));
  if (buy) return { type: 'order', stockId: buy.id, side: 'buy', quantity: 100, price: buy.limitUp };
}

async function serve() {
  const data = args.get('data');
  if (!data) throw new Error('Child requires --data');
  const { createApplication } = await moduleAt('server/index.ts');
  const application = createApplication({ dataDirectory: data, production: false,
    publicOrigin: '', publicOriginAliases: [], distDirectory: join(data, 'no-frontend') });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  let previousCpu = process.cpuUsage();
  let previousAt = performance.now();
  let previousElu = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const at = performance.now();
    const cpu = process.cpuUsage();
    const elu = performance.eventLoopUtilization();
    process.send?.({ kind: 'telemetry', at: Date.now(), rssBytes: process.memoryUsage().rss,
      cpuPercentOneCore: ((cpu.user - previousCpu.user) + (cpu.system - previousCpu.system)) / ((at - previousAt) * 10),
      eventLoopP95Ms: lag.percentile(95) / 1e6, eventLoopMaxMs: lag.max / 1e6,
      eventLoopUtilization: performance.eventLoopUtilization(elu, previousElu).utilization });
    previousCpu = cpu; previousAt = at; previousElu = elu; lag.reset();
  }, 1000);
  timer.unref();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true; clearInterval(timer); lag.disable();
    await application.stop();
    server.closeIdleConnections();
    server.close(() => process.exit(0));
  };
  process.on('message', message => { if (message === 'stop') void stop(); });
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  process.send?.({ kind: 'ready', base: `http://127.0.0.1:${address.port}`, pid: process.pid });
}

type Response = { status: number; body: Envelope; wireBytes: number; decodedBytes: number;
  encoding: string; latencyMs: number };
function request(base: string, path: string, cookie: string, agent: http.Agent, timeoutMs: number,
  body?: Record<string, unknown>): Promise<Response> {
  const startedAt = performance.now();
  return new Promise((resolveResponse, reject) => {
    const req = http.request(new URL(path, base), { method: body ? 'POST' : 'GET', agent,
      headers: { cookie, 'accept-encoding': 'gzip, deflate, br', ...(body ? {
        origin: base, 'content-type': 'application/json' } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => {
        clearTimeout(timer);
        try {
          const wire = Buffer.concat(chunks);
          const encoding = String(response.headers['content-encoding'] ?? 'identity');
          const decoded = encoding === 'gzip' ? gunzipSync(wire) : encoding === 'deflate'
            ? inflateSync(wire) : encoding === 'br' ? brotliDecompressSync(wire) : wire;
          resolveResponse({ status: response.statusCode ?? 0, body: JSON.parse(decoded.toString()),
            wireBytes: wire.length, decodedBytes: decoded.length, encoding, latencyMs: performance.now() - startedAt });
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`Request deadline ${timeoutMs}ms`)), timeoutMs);
    req.once('error', error => { clearTimeout(timer); reject(error); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (child.connected) child.send('stop');
  else child.kill('SIGTERM');
  const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
  await exited; clearTimeout(killer);
}

async function run() {
  const levels = list('clients', '5,10,20,30');
  const speeds = list('speed', '4');
  if (speeds.some(speed => ![1, 4, 12].includes(speed))) throw new Error('Speed must be 1, 4, or 12');
  const seconds = numeric('seconds', 30), intervalMs = numeric('poll-ms', 1200);
  const tradeEveryMs = Number(args.get('trade-every-ms') ?? 0);
  if (!Number.isFinite(tradeEveryMs) || tradeEveryMs < 0) throw new Error('trade-every-ms must be nonnegative');
  const timeoutMs = numeric('timeout-ms', 12000), seed = numeric('seed', 26783);
  const startTick = args.has('start-tick') ? Number(args.get('start-tick')) : (speeds.includes(12) ? 60 : 300);
  if (!Number.isInteger(startTick) || startTick < 0 || startTick >= 450) throw new Error('start-tick must be in [0,449]');
  const output = resolve(args.get('output') ?? `capacity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(dirname(output), { recursive: true });
  const transport = args.get('transport') ?? 'auto';
  if (!['auto', 'full', 'sync'].includes(transport)) throw new Error('Transport must be auto, full, sync');
  const hasSync = existsSync(join(target, 'shared/market-sync.ts'));
  if (transport === 'sync' && !hasSync) throw new Error('Requested sync protocol is unavailable in target');
  const useSync = transport !== 'full' && hasSync;
  const syncModule = useSync ? await moduleAt('shared/market-sync.ts') : undefined;
  const apply = (snapshot: Snapshot, envelope: Envelope): Snapshot | undefined => useSync
    ? syncModule.readMarketEnvelope(snapshot, envelope)
    : (envelope.market === undefined ? undefined : { market: envelope.market });
  const engine = await moduleAt('server/engine.ts');
  const state = engine.createMarket(seed);
  state.paused = false; state.speed = 1;
  while (state.tickCount < startTick) engine.tick(state);
  state.paused = true;
  if (!engine.validateMarket(state)) throw new Error('Generated synthetic fixture fails validation');
  const template = JSON.stringify(state);
  let gitHead: string | null = null;
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Archive. */ }
  const report: Record<string, any> = {
    startedAt: new Date().toISOString(), target, gitHead, label: args.get('label') ?? null,
    host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(), node: process.version },
    configuration: { levels, speeds, seconds, intervalMs, tradeEveryMs, timeoutMs, transport: useSync ? 'sync' : 'full',
      seed, startTick, stopP95Ms: numeric('stop-p95-ms', 5000), stopMinProgress: .5, stopMinPolling: .5 },
    fixture: { tickCount: state.tickCount, phase: state.phase, phaseElapsed: state.phaseElapsed,
      trades: state.trades.length, orders: state.orders.length, stockCount: state.stocks.length,
      stateBytes: Buffer.byteLength(template), publicViewBytes: Buffer.byteLength(JSON.stringify(engine.getView(state))) },
    method: ['Synthetic saves only; one randomly named temporary directory per stage.',
      'Actual HTTP application and load generator run in separate Node processes on the same host; no public-network or browser rendering cost.',
      'One non-overlapping request per client; poll slots are 1200ms by default, overdue slots are skipped and counted.',
      'Simulation progress is reconstructed from phaseProgress and phase durations, never revision.',
      'Nightly review is resumed with nextDay and pause:false, measured separately as action requests.',
      'Optional mixed trading submits 100-share marketable limit orders on an independent cadence, serialized with that client polling; T+1 and available cash are respected.',
      'CPU percentage is relative to one CPU core; child telemetry is sampled about once per second.',
      'Wire bytes exclude HTTP headers, TCP, TLS; no reverse proxy unless app compression implements it.',
      'All clients begin with the same deterministic market state, but independent tokens and save files.'],
    stages: [],
  };
  const persist = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  persist();
  for (const speed of speeds) for (const clientCount of levels) {
    const directory = mkdtempSync(join(tmpdir(), 'hundred-days-capacity-'));
    const cookies = Array.from({ length: clientCount }, () => `youzi_session=${randomBytes(32).toString('base64url')}`);
    const fixture = { ...JSON.parse(template), speed };
    for (const cookie of cookies) writeFileSync(join(directory, cookie.split('=')[1] + '.json'),
      JSON.stringify({ saveVersion: 1, savedAt: new Date().toISOString(), state: fixture, requests: [] }), { mode: 0o600 });
    const child = fork(script, ['--serve', `--target=${target}`, `--data=${directory}`],
      { execArgv: process.execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PUBLIC_ORIGIN: '', PUBLIC_ORIGIN_ALIASES: '' } });
    let logs = '';
    child.stdout?.on('data', chunk => { logs = (logs + chunk.toString()).slice(-12000); });
    child.stderr?.on('data', chunk => { logs = (logs + chunk.toString()).slice(-12000); });
    const telemetry: Telemetry[] = [];
    child.on('message', (message: any) => { if (message.kind === 'telemetry') telemetry.push(message); });
    const agent = new http.Agent({ keepAlive: true, maxSockets: clientCount + 2 });
    try {
      const base = await new Promise<string>((resolveReady, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Child did not start: ${logs}`)), 30000);
        child.on('message', (message: any) => { if (message.kind === 'ready') { clearTimeout(timeout); resolveReady(message.base); } });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Child exited ${code}: ${logs}`)); });
      });
      const clients = cookies.map(cookie => ({ cookie, snapshot: { market: null } as Snapshot,
        first: undefined as undefined | { at: number; point: number }, last: undefined as undefined | { at: number; point: number },
        polls: 0, missedSlots: 0, nextDays: 0, pausedObservations: 0,
        tradeAttempts: 0, tradeAccepted: 0, tradeRejected: 0, buys: 0, sells: 0, tradeMissedSlots: 0, tradeSkippedNoOrder: 0 }));
      // Loading and unpausing are outside the measured steady-state interval.
      for (const client of clients) {
        const response = await request(base, '/api/session', client.cookie, agent, timeoutMs);
        if (response.status !== 200) throw new Error(`Load: ${response.status} ${response.body.message}`);
        client.snapshot = apply(client.snapshot, response.body)!;
      }
      const callAction = async (client: typeof clients[number], body: Record<string, unknown>) => {
        const response = await request(base, '/api/action', client.cookie, agent, timeoutMs,
          { ...body, requestId: randomUUID() });
        if (response.status !== 200) throw new Error(`Action: ${response.status} ${response.body.message}`);
        const next = apply(client.snapshot, response.body);
        if (!next) throw new Error('Action could not apply full snapshot');
        client.snapshot = next;
        return response;
      };
      await Promise.all(clients.map(client => callAction(client, { type: 'pause', paused: false })));
      const started = Date.now(), end = started + seconds * 1000;
      const generatorCpuAtStart = process.cpuUsage();
      const requests: Array<Response & { client: number; at: number; kind: string }> = [];
      const errors: Array<{ client: number; at: number; message: string; kind: 'poll' | 'trade' | 'control' }> = [];
      const tradeOutcomes: Array<{ client: number; at: number; side: unknown; stockId: unknown;
        status: number; ok: boolean; message?: string; latencyMs: number }> = [];
      let abortReason: string | undefined;
      await Promise.all(clients.map(async (client, index) => {
        let due = started + index * Math.min(intervalMs / clientCount, 20);
        let tradeDue = tradeEveryMs ? due + tradeEveryMs : Infinity;
        while (Math.min(due, tradeDue) < end && !abortReason) {
          await sleep(Math.min(due, tradeDue) - Date.now());
          if (Date.now() >= end || abortReason) break;
          if (tradeDue < due) {
            const order = smallOrder(client.snapshot.market, index + client.tradeAttempts);
            if (!order) client.tradeSkippedNoOrder++;
            else {
              client.tradeAttempts++;
              if (order.side === 'buy') client.buys++; else client.sells++;
              try {
                const response = await request(base, '/api/action', client.cookie, agent, timeoutMs,
                  { ...order, requestId: randomUUID() });
                requests.push({ ...response, body: undefined as any, client: index, at: Date.now(), kind: 'trade' });
                tradeOutcomes.push({ client: index, at: Date.now(), side: order.side, stockId: order.stockId,
                  status: response.status, ok: response.body.ok === true,
                  message: response.body.message, latencyMs: response.latencyMs });
                const next = apply(client.snapshot, response.body);
                if (next?.market) client.snapshot = next;
                if (response.status === 422) client.tradeRejected++;
                else if (response.status !== 200 || response.body.ok !== true || !next?.market) {
                  throw new Error(`Trade HTTP ${response.status}: ${response.body.message ?? 'missing market'}`);
                } else client.tradeAccepted++;
              } catch (error) {
                errors.push({ client: index, at: Date.now(), message: String(error), kind: 'trade' });
                if (errors.length >= Math.max(3, Math.ceil(clientCount / 4))) abortReason = 'Error threshold reached';
              }
            }
            tradeDue += tradeEveryMs;
            if (Date.now() > tradeDue) {
              const skipped = Math.ceil((Date.now() - tradeDue) / tradeEveryMs);
              client.tradeMissedSlots += skipped; tradeDue += skipped * tradeEveryMs;
            }
            // Polls retain their original cadence; action time can consume a slot.
            if (Date.now() > due) {
              const skipped = Math.ceil((Date.now() - due) / intervalMs);
              client.missedSlots += skipped; due += skipped * intervalMs;
            }
            continue;
          }
          let failureKind: 'poll' | 'control' = 'poll';
          try {
            const path = '/api/market' + (useSync && client.snapshot.version ? `?since=${encodeURIComponent(client.snapshot.version)}` : '');
            let response = await request(base, path, client.cookie, agent, timeoutMs);
            requests.push({ ...response, body: undefined as any, client: index, at: Date.now(), kind: 'poll' });
            if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${response.body.message}`);
            let next = apply(client.snapshot, response.body);
            if (!next) {
              response = await request(base, '/api/market', client.cookie, agent, timeoutMs);
              requests.push({ ...response, body: undefined as any, client: index, at: Date.now(), kind: 'resync' });
              if (response.status !== 200) throw new Error(`Resync HTTP ${response.status}`);
              next = apply({ market: null }, response.body);
            }
            if (!next?.market) throw new Error('Missing market after poll');
            client.snapshot = next; client.polls++;
            const point = { at: Date.now(), point: simulationPoint(next.market) };
            client.first ??= point; client.last = point;
            if (next.market.paused) {
              failureKind = 'control';
              client.pausedObservations++;
              if (next.market.phase === 'night') {
                const transition = await callAction(client, { type: 'nextDay' }); client.nextDays++;
                requests.push({ ...transition, body: undefined as any, client: index, at: Date.now(), kind: 'nextDay' });
              }
              if (client.snapshot.market?.phase !== 'ended') {
                const resume = await callAction(client, { type: 'pause', paused: false });
                requests.push({ ...resume, body: undefined as any, client: index, at: Date.now(), kind: 'resume' });
              }
            }
          } catch (error) {
            errors.push({ client: index, at: Date.now(), message: String(error), kind: failureKind });
            if (errors.length >= Math.max(3, Math.ceil(clientCount / 4))) abortReason = 'Error threshold reached';
          }
          due += intervalMs;
          if (Date.now() > due) {
            const skipped = Math.ceil((Date.now() - due) / intervalMs);
            client.missedSlots += skipped; due += skipped * intervalMs;
          }
        }
      }));
      const finished = Date.now();
      const polls = requests.filter(request => request.kind === 'poll');
      const actionRequests = requests.filter(request => ['nextDay', 'resume', 'trade'].includes(request.kind));
      const tradeRequests = actionRequests.filter(request => request.kind === 'trade');
      const measuredTelemetry = telemetry.filter(sample => sample.at >= started && sample.at <= finished);
      const progress = clients.map((client, index) => {
        const elapsed = client.first && client.last ? (client.last.at - client.first.at) / 1000 : 0;
        const advanced = client.first && client.last ? client.last.point - client.first.point : 0;
        return { client: index, observedSeconds: rounded(elapsed), simulatedSeconds: rounded(advanced),
          expectedSimulatedSeconds: rounded(elapsed * speed), simulationRatio: elapsed > 0 ? rounded(advanced / (elapsed * speed)) : 0,
          polls: client.polls, missedSlots: client.missedSlots, nextDays: client.nextDays, pausedObservations: client.pausedObservations,
          tradeAttempts: client.tradeAttempts, tradeAccepted: client.tradeAccepted, tradeRejected: client.tradeRejected,
          buys: client.buys, sells: client.sells, tradeMissedSlots: client.tradeMissedSlots, tradeSkippedNoOrder: client.tradeSkippedNoOrder,
          final: client.snapshot.market ? { day: client.snapshot.market.day, phase: client.snapshot.market.phase,
            phaseProgress: client.snapshot.market.phaseProgress, time: client.snapshot.market.time } : null };
      });
      const desiredPolls = clients.reduce((sum, _client, index) => sum + Math.max(0,
        Math.ceil((seconds * 1000 - index * Math.min(intervalMs / clientCount, 20)) / intervalMs)), 0);
      const pollingRatio = clients.reduce((sum, client) => sum + client.polls, 0) / desiredPolls;
      const generatorCpu = process.cpuUsage(generatorCpuAtStart);
      const minProgress = Math.min(...progress.map(client => client.simulationRatio));
      const latency = distribution(polls.map(request => request.latencyMs));
      const saturated = !!abortReason || latency.p95 > numeric('stop-p95-ms', 5000) || minProgress < .5 || pollingRatio < .5;
      const stage = { clients: clientCount, speed, startedAt: new Date(started).toISOString(), measuredSeconds: rounded((finished - started) / 1000),
        configuredSeconds: seconds, polls: polls.length, desiredPolls, latencyMs: latency,
        pollingRatio: rounded(pollingRatio), requestsPerSecond: rounded(polls.length / seconds),
        totalRequestsPerSecond: rounded(requests.length / seconds),
        errors: errors.length, resyncs: requests.filter(request => request.kind === 'resync').length,
        pollErrors: errors.filter(error => error.kind === 'poll').length,
        actions: actionRequests.length, actionLatencyMs: distribution(actionRequests.map(request => request.latencyMs)),
        actionErrors: errors.filter(error => error.kind !== 'poll').length + clients.reduce((sum, client) => sum + client.tradeRejected, 0),
        trading: { enabled: tradeEveryMs > 0, intervalMs: tradeEveryMs,
          attempts: clients.reduce((sum, client) => sum + client.tradeAttempts, 0),
          accepted: clients.reduce((sum, client) => sum + client.tradeAccepted, 0),
          rejected: clients.reduce((sum, client) => sum + client.tradeRejected, 0),
          errors: errors.filter(error => error.kind === 'trade').length,
          buys: clients.reduce((sum, client) => sum + client.buys, 0),
          sells: clients.reduce((sum, client) => sum + client.sells, 0),
          missedSlots: clients.reduce((sum, client) => sum + client.tradeMissedSlots, 0),
          skippedNoOrder: clients.reduce((sum, client) => sum + client.tradeSkippedNoOrder, 0),
          latencyMs: distribution(tradeRequests.map(request => request.latencyMs)),
          wireBytes: distribution(tradeRequests.map(request => request.wireBytes)) },
        wireBytesPerPoll: distribution(polls.map(request => request.wireBytes)),
        decodedBytesPerPoll: distribution(polls.map(request => request.decodedBytes)),
        responseWireMbps: rounded(requests.reduce((sum, request) => sum + request.wireBytes, 0) * 8 / seconds / 1e6),
        simulationRatio: distribution(progress.map(client => client.simulationRatio)), minSimulationRatio: minProgress,
        cpuPercentOneCore: distribution(measuredTelemetry.map(sample => sample.cpuPercentOneCore)),
        rssMiB: distribution(measuredTelemetry.map(sample => sample.rssBytes / 1048576)),
        eventLoopP95Ms: distribution(measuredTelemetry.map(sample => sample.eventLoopP95Ms)),
        eventLoopMaxMs: distribution(measuredTelemetry.map(sample => sample.eventLoopMaxMs)),
        loadGenerator: { cpuPercentOneCore: rounded((generatorCpu.user + generatorCpu.system) / ((finished - started) * 10)),
          rssMiB: rounded(process.memoryUsage().rss / 1048576) },
        saturated, abortReason, progress, rawRequests: requests, rawTradeOutcomes: tradeOutcomes,
        rawErrors: errors, rawTelemetry: measuredTelemetry,
        serverLogTail: logs };
      report.stages.push(stage); persist();
      console.log(JSON.stringify({ clients: clientCount, speed, p95Ms: latency.p95,
        pollingRatio: stage.pollingRatio, minSimulationRatio: minProgress, errors: errors.length,
        wireKiB: rounded(stage.wireBytesPerPoll.mean / 1024), cpuPercent: stage.cpuPercentOneCore.mean,
        rssMiB: stage.rssMiB.max, tradeAttempts: stage.trading.attempts, tradeAccepted: stage.trading.accepted,
        tradeP95Ms: stage.trading.latencyMs.p95, saturated, output }));
      if (saturated && args.get('continue-after-saturation') !== 'true') break;
    } catch (error) {
      report.stages.push({ clients: clientCount, speed, failed: true, error: String(error),
        serverExitCode: child.exitCode, serverSignal: child.signalCode, serverLogTail: logs,
        rawTelemetry: telemetry });
      report.failedAt = new Date().toISOString(); persist();
      throw error;
    } finally {
      agent.destroy();
      await stopChild(child);
      rmSync(directory, { recursive: true, force: true });
    }
  }
  report.finishedAt = new Date().toISOString(); persist();
  console.log(`Saved ${output}`);
}

if (args.has('serve')) await serve();
else await run();
