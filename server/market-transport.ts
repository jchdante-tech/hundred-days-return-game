import { randomUUID } from 'node:crypto';
import type { MarketView } from '../shared/types.js';
import { diffValues, type ValuePatch, type WireApiResponse } from '../shared/market-sync.js';

interface Snapshot { market: MarketView; version: string }

/** One instance per session. Never derive a public version from its cookie. */
export class MarketTransport {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private current?: Snapshot;
  private previous?: Snapshot;
  private patch?: ValuePatch;

  private update(market: MarketView): Snapshot {
    if (this.current?.market !== market) {
      this.previous = this.current;
      this.current = { market, version: `${this.epoch}:${++this.sequence}` };
      this.patch = undefined;
    }
    return this.current;
  }

  full(market: MarketView): WireApiResponse {
    const current = this.update(market);
    return { market, sync: { version: current.version } };
  }

  poll(market: MarketView, since?: string): WireApiResponse {
    const current = this.update(market);
    if (since === current.version) return { sync: { version: current.version, unchanged: true } };
    if (since && since === this.previous?.version) {
      this.patch ??= diffValues(this.previous.market, market) ?? [1, {}];
      return { sync: { version: current.version, base: since, patch: this.patch } };
    }
    return { market, sync: { version: current.version } };
  }
}
