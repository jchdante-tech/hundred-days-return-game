export type TradeShortcut = { label: string; quantity: number; disabledReason?: string };
export type TradeShortcutInputs = {
  side: 'buy' | 'sell'; price: number; availableCash: number; availableShares: number;
};

/** Quantities only: affordability uses the entered limit, and sell fractions use already-free shares. */
export function tradeShortcutOptions({ side, price, availableCash, availableShares }: TradeShortcutInputs): TradeShortcut[] {
  if (side === 'sell') {
    const available = Number.isSafeInteger(availableShares) && availableShares > 0 ? availableShares : 0;
    return [{ label: '1/4', fraction: .25 }, { label: '1/2', fraction: .5 }, { label: '全部', fraction: 1 }]
      .map(({ label, fraction }) => {
        const quantity = Math.floor(available * fraction / 100) * 100;
        return { label, quantity, ...(quantity === 0 ? { disabledReason: available ? '该比例不足 100 股' : '暂无可卖股份' } : {}) };
      });
  }
  const priceCents = Math.round(price * 100), cashCents = Math.round(availableCash * 100);
  const validPrice = Number.isSafeInteger(priceCents) && priceCents > 0 && Math.abs(price * 100 - priceCents) < .00001;
  const validCash = Number.isSafeInteger(cashCents) && cashCents >= 0;
  return [1_000, 10_000, 100_000].map(quantity => {
    const amount = quantity * priceCents;
    const disabledReason = !validPrice ? '先填写精确到分的有效限价'
      : !validCash || !Number.isSafeInteger(amount) || amount > cashCents ? '按当前限价，可用现金不足' : undefined;
    return { label: `${quantity.toLocaleString('zh-CN')} 股`, quantity, ...(disabledReason ? { disabledReason } : {}) };
  });
}
