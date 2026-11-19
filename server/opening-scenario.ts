import { OPENING_SCENARIO, type OpeningScenarioView } from '../shared/opening-scenario.js';
import type { ActionResult, OrderInput } from '../shared/types.js';
import type { Market } from './engine.js';

export const OPENING_SCENARIO_SEED = 0x42524731;
const LEGS = [{ actorId: 'crowd0', quantity: 100_000, price: 10 },
  { actorId: 'crowd1', quantity: 150_000, price: 10.10 },
  { actorId: 'crowd2', quantity: 250_000, price: 10.30 }] as const;
const LEGACY_EXIT_QUANTITY = 200_000;
const FOLLOW_QUANTITY = 2_000;
const followQuantity = (m: Market) => FOLLOW_QUANTITY + (m.openingScenario?.version === 1 ? LEGACY_EXIT_QUANTITY : 0);
type Order = Market['orders'][number];
export interface OpeningScenarioState extends OpeningScenarioView {
  continuationSeed: number;
  asks: { orderId: string; filled: number }[];
  followAtTick?: number;
  followOrderId?: string;
}
export type ScenarioPlace = (actorId: string, input: OrderInput, created?: (order: Order) => void) => ActionResult;

/** Ordinary NPC orders leave this one finite scenario book alone on day one. */
export function isOpeningScenarioStock(m: Market, stockId: string): boolean {
  return m.day === 1 && m.openingScenario?.stockId === stockId;
}
/** The following fund keeps its own cash budget available while trading the other 17 stocks. */
export function openingFollowReserve(m: Market, actorId: string): number {
  return actorId === 'crowd0' && m.day === 1
    && (m.openingScenario?.stage === 'ready' || m.openingScenario?.stage === 'following')
    ? followQuantity(m) * Math.round(OPENING_SCENARIO.followPrice * 100) : 0;
}

export function openingScenarioForView(m: Market): OpeningScenarioView | undefined {
  const state = m.openingScenario;
  if (!state) return undefined;
  return { version: state.version, stockId: state.stockId, stage: state.stage,
    boughtQuantity: state.boughtQuantity, soldQuantity: state.soldQuantity, saleProceeds: state.saleProceeds / 100 };
}

/** New version-2 games start entirely in cash; all stock inventory stays with its existing holders. */
export function installOpeningScenario(m: Market, continuationSeed: number, place: ScenarioPlace): void {
  const stockId = OPENING_SCENARIO.stockId;
  m.orders = m.orders.filter(order => order.stockId !== stockId);
  m.openingScenario = { version: 2, stockId, stage: 'ready', continuationSeed: continuationSeed >>> 0,
    boughtQuantity: 0, soldQuantity: 0, saleProceeds: 0, asks: [] };
  m.phase = 'morning'; m.phaseElapsed = 0; m.paused = true;
  for (const leg of LEGS) {
    const result = place(leg.actorId, { stockId, side: 'sell', quantity: leg.quantity, price: leg.price },
      order => m.openingScenario!.asks.push({ orderId: order.id, filled: 0 }));
    if (!result.ok) throw new Error(`Opening order unavailable: ${result.message}`);
  }
}

/** Called only after the matcher has actually transferred shares and cash. Constant-size work. */
export function recordOpeningFill(m: Market, bid: Order, ask: Order, price: number, quantity: number): void {
  const state = m.openingScenario;
  if (!state || bid.stockId !== state.stockId) return;
  if (m.day === 1 && state.stage === 'ready' && bid.actorId === 'player' && bid.side === 'buy') {
    const index = state.asks.findIndex(leg => leg.orderId === ask.id);
    // An auction clearing all shares at one price does not demonstrate sweeping three price levels.
    if (index >= 0 && price === Math.round(LEGS[index].price * 100)) {
      state.asks[index].filled += quantity; state.boughtQuantity += quantity;
      if (state.asks.every((leg, i) => leg.filled === LEGS[i].quantity)) {
        state.stage = 'following'; state.followAtTick = m.tickCount + 3; m.paused = true;
      }
    }
  }
  const recordsSales = state.version === 1 ? m.day === 1 : m.day >= 2;
  if (recordsSales && ask.actorId === 'player' && ask.side === 'sell') {
    state.soldQuantity += quantity; state.saleProceeds += price * quantity;
    if (state.version === 2 || ((state.stage === 'exit' || state.stage === 'following')
      && state.soldQuantity >= LEGACY_EXIT_QUANTITY)) state.stage = 'complete';
  }
}

/** The follow-through is a single finite, funded order, never a direct price/cash adjustment. */
export function advanceOpeningScenario(m: Market, place: ScenarioPlace): void {
  const state = m.openingScenario;
  if (!state || m.day !== 1 || state.stage !== 'following' || m.tickCount < state.followAtTick!
    || !['morning', 'afternoon'].includes(m.phase)) return;
  // Move the durable state before matching: a resting player sell can fill during this call.
  state.stage = 'exit';
  for (const price of [10.50, 10.80]) {
    place('crowd2', { stockId: state.stockId, side: 'sell', quantity: 1_000, price });
  }
  // Version 2 consumes only the 2,000 NPC shares. There is no scripted exit bid:
  // today's purchases stay T+1 locked and tomorrow's ordinary market sets the exit price.
  // Historical version-1 games keep their original finite 200,000-share exit liquidity.
  place('crowd0', { stockId: state.stockId, side: 'buy', quantity: followQuantity(m), price: OPENING_SCENARIO.followPrice },
    order => { state.followOrderId = order.id; });
  m.paused = true;
}

/** Keep the original seed as the immutable history anchor; only future random streams change. */
export function continueOpeningMarket(m: Market): void {
  if (m.day !== 2 || !m.openingScenario) return;
  m.rngState = m.openingScenario.continuationSeed || 1;
  if (m.storyState) m.storyState.rngState = (m.openingScenario.continuationSeed ^ 0x6e657773) >>> 0;
}

export function validateOpeningScenario(m: Market): boolean {
  const state = m.openingScenario;
  if (state === undefined) return true;
  if (!state || typeof state !== 'object' || (state.version !== 1 && state.version !== 2) || state.stockId !== OPENING_SCENARIO.stockId
    || m.seed !== OPENING_SCENARIO_SEED || m.simulationVersion !== 2
    || !Number.isSafeInteger(state.continuationSeed) || state.continuationSeed < 0 || state.continuationSeed > 0xffffffff
    || !['ready', 'following', 'exit', 'complete'].includes(state.stage)
    || !Array.isArray(state.asks) || state.asks.length !== LEGS.length) return false;
  const quantity = (value: number) => Number.isSafeInteger(value) && value >= 0 && value % 100 === 0;
  if (!state.asks.every((leg, i) => leg && typeof leg.orderId === 'string' && leg.orderId.length > 0
    && quantity(leg.filled) && leg.filled <= LEGS[i].quantity)
    || new Set(state.asks.map(leg => leg.orderId)).size !== LEGS.length
    || !quantity(state.boughtQuantity) || state.boughtQuantity !== state.asks.reduce((sum, leg) => sum + leg.filled, 0)
    || !quantity(state.soldQuantity)
    || !Number.isSafeInteger(state.saleProceeds) || state.saleProceeds < 0
    || (state.soldQuantity === 0 ? state.saleProceeds !== 0 : state.saleProceeds < state.soldQuantity)) return false;
  if (state.followAtTick !== undefined && (!Number.isSafeInteger(state.followAtTick)
    || state.followAtTick < 3 || state.followAtTick > m.tickCount + 3)) return false;
  if (state.followOrderId !== undefined && (typeof state.followOrderId !== 'string' || !state.followOrderId)) return false;

  if (state.version === 1) {
    // Do not migrate historical holdings, progress, price bounds or completion rules.
    if (state.soldQuantity > 202_000 || state.saleProceeds < state.soldQuantity * 900
      || state.saleProceeds > state.soldQuantity * 1100) return false;
    if (state.stage === 'ready') return state.boughtQuantity < OPENING_SCENARIO.buyQuantity
      && state.soldQuantity === 0 && state.followAtTick === undefined && state.followOrderId === undefined;
    if (state.boughtQuantity !== OPENING_SCENARIO.buyQuantity || state.followAtTick === undefined) return false;
    if (state.stage === 'following') return state.soldQuantity === 0 && state.followOrderId === undefined;
    return state.stage === 'complete' ? state.soldQuantity >= LEGACY_EXIT_QUANTITY
      : state.soldQuantity < LEGACY_EXIT_QUANTITY;
  }

  // Version 2 may finish after skipping the scripted sweep, and may keep selling
  // on later days at prices outside day one's band. No tutorial price/volume cap applies.
  if (m.day === 1 && state.soldQuantity !== 0) return false;
  if (state.stage === 'complete') {
    if (m.day < 2 || state.soldQuantity === 0) return false;
    return state.boughtQuantity === OPENING_SCENARIO.buyQuantity
      ? state.followAtTick !== undefined
      : state.followAtTick === undefined && state.followOrderId === undefined;
  }
  if (state.soldQuantity !== 0) return false;
  if (state.stage === 'ready') return state.boughtQuantity < OPENING_SCENARIO.buyQuantity
    && state.followAtTick === undefined && state.followOrderId === undefined;
  if (state.boughtQuantity !== OPENING_SCENARIO.buyQuantity || state.followAtTick === undefined) return false;
  return state.stage !== 'following' || state.followOrderId === undefined;
}
