/** Simplified game limits. Prices are integer cents; these are not live exchange rules. */
export function limitPrices(stock: { previousClose: number; listedDay?: number }, day: number) {
  const rate = stock.listedDay === day ? .30 : .10;
  return { low: Math.round(stock.previousClose * (1 - rate)), high: Math.round(stock.previousClose * (1 + rate)) };
}
