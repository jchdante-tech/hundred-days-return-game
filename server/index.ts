import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMarket, tick, advancePhase, nextDay, submitOrder, cancelOrder,
  repay, repayChallenge, transferCreditCollateral, ensureCreditAccount,
  submitMarginOrder, closeMarginPosition, addMargin,
  submitIpoSubscription, cancelIpoSubscription, getView, validateMarket, type Market,
} from './engine.js';
import type { ActionResult, CollateralTransferInput, MarketView, OrderInput } from '../shared/types.js';
import { writeSnapshot } from './snapshot-store.js';
import { MarketTransport } from './market-transport.js';
import { cloneForTransaction } from './market-transaction.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE_NAME = 'youzi_session';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAVE_VERSION = 1;
const MAX_SAVE_BYTES = 32 * 1024 * 1024;
const OFFLINE_MS = 12_000;
const REQUEST_HISTORY_LIMIT = 128;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RequestRecord {
  requestId: string;
  fingerprint: string;
  result: ActionResult;
}

interface Session {
  token: string;
  state: Market;
  lastSeenAt: number;
  lastTickAt: number;
  storageFailed: boolean;
  requests: RequestRecord[];
  cachedView: MarketView;
  failureView?: MarketView;
  tail: Promise<void>;
  pendingOperations: number;
  backgroundPending: boolean;
  transport: MarketTransport;
}

interface ServerOptions {
  dataDirectory?: string;
  distDirectory?: string;
  production?: boolean;
  publicOrigin?: string;
  publicOriginAliases?: string[];
  now?: () => number;
  writeSnapshot?: typeof writeSnapshot;
  // Internal harnesses can exercise ordinary markets; public new games use the fixed first day.
  openingScenario?: boolean;
}

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function cookieToken(request: Request): string | undefined {
  const matches = (request.headers.cookie ?? '').split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw new ApiError(401, '会话凭据无效，请重新开局。');
  const token = matches[0]!.slice(COOKIE_NAME.length + 1);
  if (!TOKEN_PATTERN.test(token)) throw new ApiError(401, '会话凭据无效，请重新开局。');
  return token;
}

function objectBody(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new ApiError(400, '请求内容必须是 JSON 对象。');
  }
  return request.body as Record<string, unknown>;
}

function money(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e12
    || Math.abs(value * 100 - Math.round(value * 100)) > 0.0001) {
    throw new ApiError(400, `${label}必须是大于零、最多两位小数的有效金额。`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100
    || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new ApiError(400, `${label}无效。`);
  }
  return value;
}

function originOf(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === '' && parsed.password === ''
      && parsed.pathname === '/' && parsed.search === '' && parsed.hash === ''
      && !parsed.hostname.includes('*') ? parsed.origin : undefined;
  } catch { return undefined; }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestIdentity(body: Record<string, unknown>): Pick<RequestRecord, 'requestId' | 'fingerprint'> {
  const { requestId, ...payload } = body;
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new ApiError(400, '每次操作必须提供 requestId（使用 crypto.randomUUID()，重试时保留原编号）。');
  }
  return {
    requestId: requestId.toLowerCase(),
    fingerprint: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
  };
}

function validRequestHistory(value: unknown): value is RequestRecord[] {
  if (!Array.isArray(value) || value.length > REQUEST_HISTORY_LIMIT) return false;
  const identifiers = new Set<string>();
  return value.every((record: unknown) => {
    if (!record || typeof record !== 'object') return false;
    const item = record as RequestRecord;
    if (typeof item.requestId !== 'string' || !REQUEST_ID_PATTERN.test(item.requestId)
      || identifiers.has(item.requestId) || typeof item.fingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(item.fingerprint) || !item.result
      || typeof item.result.ok !== 'boolean' || typeof item.result.message !== 'string') return false;
    identifiers.add(item.requestId);
    return true;
  });
}

export function createApplication(options: ServerOptions = {}) {
  const dataDirectory = resolve(options.dataDirectory ?? process.env.DATA_DIR ?? resolve(ROOT, 'data'));
  const distDirectory = resolve(options.distDirectory ?? resolve(ROOT, 'dist'));
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const configuredOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  const publicOrigin = configuredOrigin ? originOf(configuredOrigin) : undefined;
  if (configuredOrigin && !publicOrigin) throw new Error('PUBLIC_ORIGIN must be a valid http(s) origin.');
  const configuredAliases = options.publicOriginAliases
    ?? (process.env.PUBLIC_ORIGIN_ALIASES?.trim() ? process.env.PUBLIC_ORIGIN_ALIASES.split(',').map(value => value.trim()) : []);
  const publicOriginAliases = configuredAliases.map(value => originOf(value));
  if (publicOriginAliases.some(value => !value) || (publicOriginAliases.length > 0 && !publicOrigin)) {
    throw new Error('PUBLIC_ORIGIN_ALIASES must contain only exact http(s) origins and requires PUBLIC_ORIGIN.');
  }
  const allowedPublicOrigins = new Set([publicOrigin, ...publicOriginAliases].filter((value): value is string => value !== undefined));
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const loading = new Map<string, Promise<Session>>();
  const requestsInFlight = new Set<Promise<unknown>>();
  const persistSnapshot = options.writeSnapshot ?? writeSnapshot;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

  function filename(token: string): string {
    if (!TOKEN_PATTERN.test(token)) throw new ApiError(401, '会话凭据无效。');
    return resolve(dataDirectory, `${token}.json`);
  }

  async function save(token: string, state: Market, requests: RequestRecord[]): Promise<void> {
    const destination = filename(token);
    const serialized = JSON.stringify({ saveVersion: SAVE_VERSION, savedAt: new Date(now()).toISOString(), state, requests });
    if (Buffer.byteLength(serialized) > MAX_SAVE_BYTES) throw new Error('Snapshot too large');
    await persistSnapshot(destination, serialized);
  }

  function view(session: Session): MarketView {
    if (!session.storageFailed) return session.cachedView;
    return session.failureView ??= { ...session.cachedView, paused: true };
  }

  function makeSession(token: string, state: Market, requests: RequestRecord[], cachedView: MarketView): Session {
    return { token, state, requests, cachedView, lastSeenAt: now(), lastTickAt: now(), storageFailed: false,
      tail: Promise.resolve(), pendingOperations: 0, backgroundPending: false, transport: new MarketTransport() };
  }

  function enqueue<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    session.pendingOperations += 1;
    const job = session.tail.then(operation);
    // A failed write must not poison later retries for this player.
    session.tail = job.then(
      () => { session.pendingOperations -= 1; },
      () => { session.pendingOperations -= 1; },
    );
    return job;
  }

  function route(handler: (request: Request, response: Response) => Promise<unknown>) {
    return (request: Request, response: Response, next: NextFunction) => {
      if (stopping) return next(new ApiError(503, '服务正在重启，请稍后重试。'));
      const job = handler(request, response);
      requestsInFlight.add(job);
      void job.then(() => { requestsInFlight.delete(job); }, error => {
        requestsInFlight.delete(job);
        next(error);
      });
    };
  }

  function load(token: string): Promise<Session> {
    const cached = sessions.get(token);
    if (cached) return Promise.resolve(cached);
    const pending = loading.get(token);
    if (pending) return pending;
    const job = restore(token).finally(() => { loading.delete(token); });
    loading.set(token, job);
    return job;
  }

  async function restore(token: string): Promise<Session> {
    const path = filename(token);
    let parsed: unknown;
    try {
      if ((await stat(path)).size > MAX_SAVE_BYTES) throw new ApiError(409, '存档过大，无法恢复；原文件已保留。');
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ApiError(401, '未找到这个会话的存档，请重新开局。');
      }
      if (error instanceof SyntaxError) throw new ApiError(409, '存档格式损坏，无法恢复；原文件已保留。');
      throw new ApiError(503, '暂时无法读取存档，请稍后重试。');
    }
    if (!parsed || typeof parsed !== 'object'
      || (parsed as { saveVersion?: unknown }).saveVersion !== SAVE_VERSION) {
      throw new ApiError(409, '存档版本不兼容，未覆盖原文件。');
    }
    const state = (parsed as { state?: unknown }).state;
    if (!validateMarket(state)) throw new ApiError(409, '市场存档校验失败，未覆盖原文件。');
    // Snapshots created before request IDs were introduced have no history.
    const requests = (parsed as { requests?: unknown }).requests ?? [];
    if (!validRequestHistory(requests)) throw new ApiError(409, '存档中的请求记录校验失败，未覆盖原文件。');
    let cachedView: MarketView;
    try {
      state.paused = true;
      ensureCreditAccount(state);
      cachedView = getView(state);
      await save(token, state, requests);
    } catch {
      throw new ApiError(503, '恢复存档时无法保存暂停状态，请稍后重试。');
    }
    const session = makeSession(token, state, requests, cachedView);
    sessions.set(token, session);
    return session;
  }

  async function requireSession(request: Request): Promise<Session> {
    const token = cookieToken(request);
    if (!token) throw new ApiError(401, '尚未开局，请先开始游戏。');
    const session = await load(token);
    session.lastSeenAt = now();
    return session;
  }

  async function mutate(
    session: Session,
    action: (candidate: Market) => ActionResult | void,
    identity?: Pick<RequestRecord, 'requestId' | 'fingerprint'>,
  ): Promise<ActionResult> {
    const candidate = cloneForTransaction(session.state);
    if (session.storageFailed) candidate.paused = true;
    const result = action(candidate) ?? { ok: true, message: '' };
    if (!result.ok && !identity) return result;
    const committedState = result.ok ? candidate : cloneForTransaction(session.state);
    if (session.storageFailed && !result.ok) committedState.paused = true;
    const requests = identity
      ? [...session.requests, { ...identity, result }].slice(-REQUEST_HISTORY_LIMIT)
      : session.requests;
    let cachedView: MarketView;
    try {
      cachedView = getView(committedState);
      await save(session.token, committedState, requests);
    } catch {
      session.storageFailed = true;
      session.failureView = undefined;
      throw new ApiError(503, '存档写入失败，本次操作未生效，市场已停止推进。请重试暂停或操作。');
    }
    session.state = committedState;
    session.requests = requests;
    session.cachedView = cachedView;
    session.storageFailed = false;
    session.failureView = undefined;
    return result;
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (request, _response, next) => {
    if (request.method !== 'POST') return next();
    const supplied = request.get('origin');
    const origin = supplied ? originOf(supplied) : undefined;
    const requestOrigin = originOf(`${request.protocol}://${request.get('host') ?? ''}`);
    const localRequest = ['127.0.0.1', 'localhost', '::1'].includes(request.hostname);
    const developmentOrigin = !production && localRequest
      && (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173');
    if (!origin || !((publicOrigin ? allowedPublicOrigins.has(origin) : origin === requestOrigin) || developmentOrigin)) {
      return next(new ApiError(403, '请求来源不匹配，请从游戏页面操作。'));
    }
    if (!request.is('application/json')) return next(new ApiError(415, '请使用 application/json 请求。'));
    next();
  });
  app.use('/api', express.json({ limit: '16kb', strict: true }));

  app.get('/api/session', route(async (request, response) => {
      if (!cookieToken(request)) return response.json({ market: null, ok: true });
      const session = await requireSession(request);
      if (session.storageFailed) {
        return response.status(503).json({ ...session.transport.full(view(session)), ok: false, message: '存档写入失败，市场已停止推进，请重试暂停操作。' });
      }
      return response.json({ ...session.transport.full(view(session)), ok: true });
  }));

  app.post('/api/start', route(async (request, response) => {
      const body = objectBody(request);
      if (body.seed !== undefined && (typeof body.seed !== 'number'
        || !Number.isSafeInteger(body.seed) || body.seed < 0 || body.seed > 0xffff_ffff)) {
        throw new ApiError(400, '随机种子必须是 0 至 4294967295 的整数。');
      }
      let previous: Session | undefined;
      try {
        const oldToken = cookieToken(request);
        if (oldToken) previous = sessions.get(oldToken);
      } catch { /* A fresh start can replace an invalid or expired cookie. */ }
      const token = randomBytes(32).toString('base64url');
      const state = createMarket((body.seed as number | undefined) ?? randomBytes(4).readUInt32BE(0),
        { openingScenario: options.openingScenario !== false });
      const currentView = getView(state);
      try { await save(token, state, []); }
      catch { throw new ApiError(503, '无法创建存档，本次开局未生效。'); }
      if (previous) {
        const oldSession = previous;
        oldSession.lastSeenAt = now();
        await enqueue(oldSession, async () => {
          if (sessions.get(oldSession.token) !== oldSession) return;
          if (!oldSession.state.paused) await mutate(oldSession, candidate => { candidate.paused = true; });
          // Keep this object until offline eviction: accepted requests must not
          // race with a second restored copy of the same player's save.
        });
      }
      const session = makeSession(token, state, [], currentView);
      sessions.set(token, session);
      const sourceOrigin = originOf(request.get('origin') ?? '');
      response.cookie(COOKIE_NAME, token, {
        httpOnly: true, sameSite: 'lax', secure: request.secure || publicOrigin?.startsWith('https://') === true
          || sourceOrigin?.startsWith('https://') === true,
        path: '/', maxAge: 365 * 24 * 60 * 60 * 1000,
      });
      return response.json({ ...session.transport.full(currentView), ok: true, message: '独立市场已创建，存档已保存。' });
  }));

  app.get('/api/market', route(async (request, response) => {
      const session = await requireSession(request);
      return response.status(session.storageFailed ? 503 : 200).json({
        ...session.transport.poll(view(session), typeof request.query.since === 'string' ? request.query.since : undefined),
        ok: !session.storageFailed,
        ...(session.storageFailed ? { message: '存档写入失败，市场已停止推进，请重试暂停操作。' } : {}),
      });
  }));

  app.post('/api/action', route(async (request, response) => {
    const session = await requireSession(request);
    return enqueue(session, async () => {
    try {
      const body = objectBody(request);
      const identity = requestIdentity(body);
      const previous = session.requests.find((record) => record.requestId === identity.requestId);
      if (previous) {
        if (previous.fingerprint !== identity.fingerprint) {
          throw new ApiError(409, '同一 requestId 已用于不同操作；新操作必须使用新的编号。');
        }
        return response.status(previous.result.ok ? 200 : 422).json({ ...session.transport.full(view(session)), ...previous.result });
      }
      let action: (candidate: Market) => ActionResult | void;
      switch (body.type) {
        case 'order': {
          const stockId = identifier(body.stockId, '股票代码');
          if (!['buy', 'sell', 'finance', 'short', 'cover', 'creditSell'].includes(String(body.side))) throw new ApiError(400, '委托方向无效。');
          if (typeof body.quantity !== 'number' || !Number.isSafeInteger(body.quantity)
            || body.quantity <= 0 || body.quantity > 1_000_000_000) throw new ApiError(400, '委托数量必须是有效的正整数。');
          const order: OrderInput = {
            stockId, side: body.side as OrderInput['side'], quantity: body.quantity,
            price: money(body.price, '委托价格'),
          };
          action = (candidate) => submitOrder(candidate, order);
          break;
        }
        case 'cancel': {
          const orderId = identifier(body.orderId, '委托编号');
          action = (candidate) => cancelOrder(candidate, orderId);
          break;
        }
        case 'repay': {
          const amount = money(body.amount, '还款金额');
          action = (candidate) => repay(candidate, amount);
          break;
        }
        case 'collateral': {
          if (body.direction !== 'in' && body.direction !== 'out') throw new ApiError(400, '请选择放入或取回担保。');
          const cashTransfer = body.cash !== undefined;
          if (cashTransfer === (body.stockId !== undefined || body.quantity !== undefined)) {
            throw new ApiError(400, '每次只能划转现金或一只股票。');
          }
          const transfer: CollateralTransferInput = { direction: body.direction };
          if (cashTransfer) transfer.cash = money(body.cash, '划转金额');
          else {
            transfer.stockId = identifier(body.stockId, '担保股票');
            if (typeof body.quantity !== 'number' || !Number.isSafeInteger(body.quantity)
              || body.quantity <= 0 || body.quantity > 1_000_000_000 || body.quantity % 100 !== 0) {
              throw new ApiError(400, '划转股数须为 100 股的正整数倍。');
            }
            transfer.quantity = body.quantity;
          }
          action = candidate => transferCreditCollateral(candidate, transfer);
          break;
        }
        case 'marginOpen': {
          const stockId = identifier(body.stockId, '股票代码');
          if (body.direction !== 'long' && body.direction !== 'short') throw new ApiError(400, '请选择做多或做空。');
          if (body.mode !== 'isolated' && body.mode !== 'cross') throw new ApiError(400, '请选择逐仓或全仓。');
          if (body.leverage !== 1 && body.leverage !== 2 && body.leverage !== 3) throw new ApiError(400, '杠杆倍数只能为 1、2 或 3。');
          const input = { stockId, direction: body.direction, mode: body.mode, leverage: body.leverage,
            principal: money(body.principal, '投入本金'), price: money(body.price, '委托价格') };
          action = candidate => submitMarginOrder(candidate, input as Parameters<typeof submitMarginOrder>[1]);
          break;
        }
        case 'marginClose': {
          const positionId = identifier(body.positionId, '杠杆仓位');
          if (typeof body.quantity !== 'number' || !Number.isSafeInteger(body.quantity)
            || body.quantity <= 0 || body.quantity > 1_000_000_000 || body.quantity % 100 !== 0) throw new ApiError(400, '平仓数量须为 100 股的正整数倍。');
          const input = { positionId, quantity: body.quantity, price: money(body.price, '平仓委托价格') };
          action = candidate => closeMarginPosition(candidate, input);
          break;
        }
        case 'marginAdd': {
          const accountId = identifier(body.accountId, '保证金账户');
          const amount = money(body.amount, '追加保证金');
          action = candidate => addMargin(candidate, { accountId, amount });
          break;
        }
        case 'repayChallenge': {
          const amount = money(body.amount, '目标还款金额');
          action = (candidate) => repayChallenge(candidate, amount);
          break;
        }
        case 'subscribeIpo': {
          const offerId = identifier(body.offerId, '新股申购编号');
          if (typeof body.quantity !== 'number' || !Number.isSafeInteger(body.quantity)
            || body.quantity <= 0 || body.quantity > 1_000_000_000) throw new ApiError(400, '申购数量必须是有效的正整数。');
          const quantity = body.quantity;
          action = candidate => submitIpoSubscription(candidate, offerId, quantity);
          break;
        }
        case 'cancelIpo': {
          const offerId = identifier(body.offerId, '新股申购编号');
          action = candidate => cancelIpoSubscription(candidate, offerId);
          break;
        }
        case 'advance': action = advancePhase; break;
        case 'nextDay': action = nextDay; break;
        case 'pause': {
          if (typeof body.paused !== 'boolean') throw new ApiError(400, '暂停状态必须是布尔值。');
          const paused = body.paused;
          action = (candidate) => { candidate.paused = paused; candidate.revision += 1; };
          break;
        }
        case 'speed': {
          if (body.speed !== 1 && body.speed !== 4 && body.speed !== 12) throw new ApiError(400, '速度只能为 1、4 或 12。');
          const speed = body.speed;
          action = (candidate) => { candidate.speed = speed; candidate.revision += 1; };
          break;
        }
        default: throw new ApiError(400, '未知操作类型。');
      }
      const result = await mutate(session, action, identity);
      return response.status(result.ok ? 200 : 422).json({ ...session.transport.full(view(session)), ...result });
    } catch (error) {
      if (error instanceof ApiError && session) {
        return response.status(error.status).json({ ...session.transport.full(view(session)), ok: false, message: error.message });
      }
      throw error;
    }
    });
  }));

  app.use('/api', (_request, response) => {
    response.status(404).json({ market: null, ok: false, message: '接口不存在。' });
  });
  if (existsSync(resolve(distDirectory, 'index.html'))) {
    app.use(express.static(distDirectory, { index: false }));
    app.get('/{*path}', (_request, response) => response.sendFile(resolve(distDirectory, 'index.html')));
  } else {
    app.get('/', (_request, response) => response.status(503).type('text').send('前端尚未构建。开发时访问 http://127.0.0.1:5173，或先运行 npm run build。'));
  }
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    let status = 500;
    let message = '服务器暂时无法处理请求。';
    if (error instanceof ApiError) { status = error.status; message = error.message; }
    else if ((error as { type?: string })?.type === 'entity.too.large') { status = 413; message = '请求内容超过 16 KB。'; }
    else if ((error as { type?: string })?.type === 'entity.parse.failed') { status = 400; message = 'JSON 格式无效。'; }
    // Never serialize errors or engine state: they can contain hidden agents or file paths.
    response.status(status).json({ market: null, ok: false, message });
  });

  const timer = setInterval(() => {
    const timestamp = now();
    for (const [token, session] of sessions) {
      if (session.backgroundPending) continue;
      if (timestamp - session.lastSeenAt <= OFFLINE_MS
        && (session.storageFailed || session.state.paused || timestamp - session.lastTickAt < 1000)) continue;
      session.backgroundPending = true;
      void enqueue(session, async () => {
        if (sessions.get(token) !== session) return;
        const timestamp = now();
        if (timestamp - session.lastSeenAt > OFFLINE_MS) {
          // Accepted work can outlive OFFLINE_MS behind a slow disk write. Keep
          // its Session attached until the queue drains, otherwise a read can
          // restore a second copy and overwrite an acknowledged transaction.
          if (session.pendingOperations > 1) return;
          if (!session.storageFailed && !session.state.paused) {
            await mutate(session, (candidate) => { candidate.paused = true; candidate.revision += 1; });
          }
          // Paused snapshots are restored on demand, keeping abandoned sessions out of memory.
          // A read may have arrived while the final save was waiting for disk.
          if (session.pendingOperations === 1 && now() - session.lastSeenAt > OFFLINE_MS
            && sessions.get(token) === session) sessions.delete(token);
          return;
        }
        if (!session.storageFailed && !session.state.paused && timestamp - session.lastTickAt >= 1000) {
          await mutate(session, tick);
          session.lastTickAt += 1000;
          if (timestamp - session.lastTickAt >= 1000) session.lastTickAt = timestamp;
        }
      }).catch(() => {
        session.storageFailed = true;
        session.failureView = undefined;
        console.error('市场存档失败，已停止该市场推进。');
      }).finally(() => { session.backgroundPending = false; });
    }
  }, 400);
  timer.unref();

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearInterval(timer);
    stopPromise = (async () => {
      await Promise.allSettled([...requestsInFlight]);
      await Promise.all([...sessions.values()].map(session => enqueue(session, async () => {
        if (!session.state.paused && !session.storageFailed) {
          try { await mutate(session, candidate => { candidate.paused = true; candidate.revision += 1; }); }
          catch { console.error('停止服务时无法保存暂停状态；保留上次成功存档。'); }
        }
      })));
    })();
    return stopPromise;
  }
  return { app, stop };
}

export function startServer() {
  const port = Number(process.env.PORT ?? 5174);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const host = process.env.HOST ?? '127.0.0.1';
  const { app, stop } = createApplication();
  const server = app.listen(port, host, () => {
    console.log(`游资模拟器：http://${host}:${port}`);
  });
  const shutdown = () => {
    server.close();
    void stop().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { app, server, stop };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
