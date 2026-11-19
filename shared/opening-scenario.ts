/** The same finite first-day setup is used by every newly created game. Values are yuan/shares. */
export const OPENING_SCENARIO = {
  version: 2, stockId: 's1', initialPrice: 10, initialCash: 10_000_000, initialShares: 0,
  buyQuantity: 500_000, buyLimit: 10.30, followPrice: 10.80,
  // Version-1 compatibility only. Version 2 sells into the live book on a later day.
  sellQuantity: 200_000, sellLimit: 10.80,
} as const;
export interface OpeningScenarioView {
  version: 1 | 2; stockId: string; stage: 'ready' | 'following' | 'exit' | 'complete';
  /** Actual player purchases from the three finite opening sell orders. */
  boughtQuantity: number;
  /** Actual ordinary target-stock sales: day one in v1, from day two in v2. Proceeds are yuan. */
  soldQuantity: number; saleProceeds: number;
}
