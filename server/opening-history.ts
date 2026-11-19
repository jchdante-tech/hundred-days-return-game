import type { DailyBar } from '../shared/types.js';

export const OPENING_HISTORY_LENGTH = 60;
export const OPENING_HISTORY_VERSION = 2;
export const GAME_START_DATE = '2026-10-20';

// This is the fictional market's opening calendar, not a feed of exchange data.
const OPENING_BREAKS = new Set(['2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']);
export function openingHistoryDates(): string[] {
  const dates: string[] = [];
  const date = new Date(`${GAME_START_DATE}T00:00:00Z`);
  while (dates.length < OPENING_HISTORY_LENGTH) {
    date.setUTCDate(date.getUTCDate() - 1);
    const value = date.toISOString().slice(0, 10);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !OPENING_BREAKS.has(value)) dates.unshift(value);
  }
  return dates;
}

function randomStream(seed: number, salt: string) {
  let state = (seed ^ 0x811c9dc5) >>> 0;
  for (const letter of salt) state = Math.imul(state ^ letter.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

type SimulatedFill = { price: number; quantity: number };

/**
 * Simulate a small independent market history before the player takes the seat.
 * Prices and turnover use cents. The isolated streams never advance live RNG,
 * submit orders, or touch the player's cash, inventory, debt, news or clock.
 */
export function generateOpeningHistory(seed: number, stockId: string, sector: string, anchorClose: number): DailyBar[] {
  const marketRandom = randomStream(seed, 'opening-market');
  const sectorRandom = randomStream(seed, `opening-sector:${sector}`);
  const stockRandom = randomStream(seed, `opening-stock:${stockId}`);
  const marketPhase = marketRandom() * Math.PI * 2;
  const sectorPhase = sectorRandom() * Math.PI * 2;
  const beta = .8 + stockRandom() * .4;
  const liquidity = .7 + stockRandom() * .9;
  const stockPhase = stockRandom() * Math.PI * 2;
  const days: SimulatedFill[][] = [];
  let previousClose = 1;

  for (let day = 0; day < OPENING_HISTORY_LENGTH; day++) {
    // Quiet and active stretches are shared by a sector. Individual news-like
    // shocks retain outliers without multiplying every old candle by a constant.
    // These are fictional pregame regimes calibrated against the live simulator.
    const regime = .55 + (1 + Math.sin(day / 6.5 + sectorPhase)) * .55;
    const marketMove = Math.sin(day / 11 + marketPhase) * .008 + (marketRandom() - .5) * .026;
    const sectorMove = Math.sin(day / 7 + sectorPhase) * .021 + (sectorRandom() - .5) * .058;
    const stockMove = Math.sin(day / 10 + stockPhase) * .003 + (stockRandom() - .5) * .018;
    const shock = stockRandom() < .065 ? (stockRandom() < .5 ? -1 : 1) * (.025 + stockRandom() * .04) : 0;
    const move = Math.max(-.09, Math.min(.09, (marketMove + sectorMove) * beta * regime + stockMove + shock));
    const close = previousClose * (1 + move);
    const open = previousClose * (1 + (stockRandom() - .5) * .025 * Math.sqrt(regime));
    const deviations = [0];
    for (let fill = 1; fill < 32; fill++) deviations.push(deviations[fill - 1] + (stockRandom() - .5) * .01 * Math.sqrt(regime));
    const activity = .85 + regime * .25 + Math.abs(move) * 22;
    const fills = deviations.map((deviation, index) => {
      const progress = index / (deviations.length - 1);
      const bridge = deviation - progress * deviations.at(-1)!;
      const target = open + (close - open) * progress + previousClose * bridge;
      return {
        price: Math.max(previousClose * .905, Math.min(previousClose * 1.095, target)),
        quantity: Math.max(100, Math.round((28 + stockRandom() * 100) * liquidity * activity) * 100),
      };
    });
    days.push(fills);
    previousClose = fills.at(-1)!.price;
  }

  // A common scale preserves each simulated path while meeting the game's
  // original previous close exactly. Rounding happens before OHLC and turnover.
  const scale = anchorClose / previousClose;
  const dates = openingHistoryDates();
  return days.map((fills, index) => {
    const scaled = fills.map(fill => ({ ...fill, price: Math.max(1, Math.round(fill.price * scale)) }));
    const prices = scaled.map(fill => fill.price);
    return {
      day: index - OPENING_HISTORY_LENGTH + 1, date: dates[index], origin: 'background', complete: true,
      open: prices[0], high: Math.max(...prices), low: Math.min(...prices), close: prices.at(-1)!,
      volume: scaled.reduce((sum, fill) => sum + fill.quantity, 0),
      turnover: scaled.reduce((sum, fill) => sum + fill.quantity * fill.price, 0),
    };
  });
}
