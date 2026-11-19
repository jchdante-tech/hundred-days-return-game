import type { DailyBar, Phase, PricePoint } from './types';

export interface ChartWindow { start: number; size: number }
export const MIN_CHART_DAYS = 12;

export interface ChartPriceChange {
  reference: number;
  amount: number;
  percent: number;
  basis: 'previous-close' | 'issue-price';
}

/** Monetary chart values are yuan; compare quoted cents to avoid float residue. */
export function priceChange(price: number, reference: number, basis: ChartPriceChange['basis'] = 'previous-close'): ChartPriceChange | null {
  if (!Number.isFinite(price) || !Number.isFinite(reference) || price <= 0 || reference <= 0) return null;
  const referenceCents = Math.round(reference * 100);
  if (referenceCents <= 0) return null;
  const amountCents = Math.round(price * 100) - referenceCents;
  return { reference, amount: amountCents / 100, percent: amountCents * 100 / referenceCents, basis };
}

/** Calculate before slicing the viewport; a missing prior session has no known return. */
export function dailyPriceChanges(
  bars: readonly Pick<DailyBar, 'day' | 'close'>[],
  listing: { listedDay?: number; issuePrice?: number } = {},
): (ChartPriceChange | null)[] {
  return bars.map((bar, index) => {
    if (bar.day === listing.listedDay && listing.issuePrice !== undefined) return priceChange(bar.close, listing.issuePrice, 'issue-price');
    const previous = bars[index - 1];
    return previous && previous.day + 1 === bar.day ? priceChange(bar.close, previous.close) : null;
  });
}

/** Clamp a viewport to recorded bars, without allocating space for future days. */
export function normalizeChartWindow(total: number, window: ChartWindow): ChartWindow {
  if (total <= 0) return { start: 0, size: 0 };
  const size = Math.min(total, Math.max(Math.min(total, MIN_CHART_DAYS), Math.round(window.size)));
  return { start: Math.max(0, Math.min(total - size, Math.round(window.start))), size };
}

export function latestChartWindow(total: number, size = 40): ChartWindow {
  return normalizeChartWindow(total, { start: total - size, size });
}

/** Keep the date under the pointer fixed while changing the visible day count. */
export function zoomChartWindow(total: number, window: ChartWindow, size: number, anchor = 1): ChartWindow {
  const current = normalizeChartWindow(total, window);
  const next = normalizeChartWindow(total, { ...current, size });
  const fraction = Math.max(0, Math.min(1, anchor));
  return normalizeChartWindow(total, { start: current.start + (current.size - next.size) * fraction, size: next.size });
}

export function panChartWindow(total: number, window: ChartWindow, days: number): ChartWindow {
  return normalizeChartWindow(total, { ...window, start: window.start + days });
}

/** Follow live sessions only if the reader was already looking at the latest bar. */
export function extendChartWindow(previousTotal: number, total: number, window: ChartWindow): ChartWindow {
  return window.start + window.size >= previousTotal
    ? normalizeChartWindow(total, { ...window, start: total - window.size })
    : normalizeChartWindow(total, window);
}

/** A live closing quote participates in today's MA, like a chart during trading. */
export function simpleMovingAverage(values: readonly number[], period: number): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('MA period must be a positive integer');
  let total = 0;
  return values.map((value, index) => {
    total += value;
    if (index >= period) total -= values[index - period];
    return index >= period - 1 ? total / period : null;
  });
}

/** A migrated save may lack played sessions; never bridge those unknown closes. */
export function dailyMovingAverage(bars: readonly Pick<DailyBar, 'day' | 'close'>[], period: number): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('MA period must be a positive integer');
  let total = 0, segmentStart = 0;
  return bars.map((bar, index) => {
    if (index > 0 && bar.day !== bars[index - 1].day + 1) { total = 0; segmentStart = index; }
    total += bar.close;
    if (index - segmentStart >= period) total -= bars[index - period].close;
    return index - segmentStart >= period - 1 ? total / period : null;
  });
}

/** Aggregate only executed fills; yesterday's reference price is not a trade. */
export function minuteTrades(history: readonly PricePoint[]): PricePoint[] {
  const buckets = new Map<string, PricePoint>();
  for (const point of history) {
    if (!/^\d{2}:\d{2}$/.test(point.time) || point.volume <= 0) continue;
    const previous = buckets.get(point.time);
    buckets.set(point.time, { ...point, volume: (previous?.volume ?? 0) + point.volume });
  }
  return [...buckets.values()];
}

export interface IntradayPoint extends PricePoint { executed: boolean }
export interface IntradayTimeline {
  points: IntradayPoint[];
  trades: PricePoint[];
  lastTradeTime: string | null;
  cursor: number;
}

/** Fixed trading-session coordinate; the lunch recess occupies no horizontal time. */
export function intradayMinute(time: string): number {
  const absolute = clockMinute(time);
  if (absolute === null) return 0;
  return Math.max(0, Math.min(245, absolute - 565 - Math.max(0, Math.min(90, absolute - 690))));
}

function clockMinute(time: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(time)) return null;
  const [hour, minute] = time.split(':').map(Number);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

/**
 * Carry the latest executed price through quiet minutes without creating trades.
 * The chart clock is independent of the last fill; volume and OHLC stay execution-only.
 */
export function intradayTimeline(history: readonly PricePoint[], time: string, phase: Phase): IntradayTimeline {
  const cursor = phase === 'night' || phase === 'ended' ? 245 : phase === 'lunch' ? 125 : intradayMinute(time);
  const cutoff = phase === 'night' || phase === 'ended' ? 900 : phase === 'lunch' ? 690 : Math.min(900, clockMinute(time) ?? 0);
  const trades = minuteTrades(history.filter(point => {
    const minute = clockMinute(point.time);
    return minute !== null && minute >= 565 && minute <= cutoff && (minute <= 690 || minute >= 780);
  })).sort((a, b) => a.time.localeCompare(b.time));
  const points: IntradayPoint[] = [];
  const firstTrade = trades[0];
  if (firstTrade) {
    const byMinute = new Map(trades.map(point => [point.time, point]));
    let price = firstTrade.price;
    for (let minute = clockMinute(firstTrade.time)!; minute <= cutoff; minute++) {
      if (minute > 690 && minute < 780) continue;
      const label = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      const trade = byMinute.get(label);
      if (trade) price = trade.price;
      points.push({ time: label, price, volume: trade?.volume ?? 0, executed: !!trade });
    }
  }
  return { points, trades, lastTradeTime: trades.at(-1)?.time ?? null, cursor };
}
