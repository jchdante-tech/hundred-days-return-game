import type { MarketView } from '../shared/types';
import { compareMarketVersions, readMarketEnvelope, type MarketSnapshot, type WireApiResponse } from '../shared/market-sync';

export interface ApiResponse { market: MarketView | null; ok?: boolean; message?: string }

export function createApiClient(fetcher: typeof fetch = fetch) {
  let snapshot: MarketSnapshot = { market: null };
  let generation = 0;
  let sequence = 0;
  let acceptedSequence = 0;

  return async function request(path: string, body?: Record<string, unknown>): Promise<ApiResponse> {
    // Starting a new market invalidates already-running polls/session requests.
    // Retain the previous snapshot until start succeeds so failures are recoverable.
    if (path === 'start') generation += 1;
    const requestGeneration = generation;
    const requestSequence = ++sequence;

    async function send(full = false): Promise<{ response: Response; result: WireApiResponse }> {
      const since = path === 'market' && !full ? snapshot.version : undefined;
      const response = await fetcher(`/api/${path}${since ? `?since=${encodeURIComponent(since)}` : ''}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
      return { response, result: await response.json() as WireApiResponse };
    }

    let { response, result } = await send();
    function currentResponse(): ApiResponse {
      if (!response.ok) throw new Error(result.message || '连接暂时中断，请稍后重试。');
      return { market: snapshot.market, ok: result.ok, message: result.message };
    }
    if (requestGeneration !== generation) return currentResponse();

    function adopt(): boolean {
      // A slow response from a discarded server epoch must not replace a newer
      // full view. Within one epoch the server version is the authoritative order.
      if (requestSequence < acceptedSequence
        && compareMarketVersions(result.sync?.version, snapshot.version) === undefined) return true;
      const next = readMarketEnvelope(snapshot, result);
      if (!next) return false;
      snapshot = next;
      acceptedSequence = Math.max(acceptedSequence, requestSequence);
      return true;
    }

    if (response.ok && !adopt()) {
      // Only a read may be retried. Never duplicate an order or a start request.
      if (path !== 'market' || body !== undefined) throw new Error('行情同步失败，请刷新页面重试。');
      ({ response, result } = await send(true));
      if (requestGeneration !== generation) return currentResponse();
      if (response.ok && !adopt()) throw new Error('行情同步失败，请刷新页面重试。');
    }
    return currentResponse();
  };
}

export const api = createApiClient();
