import type { OrderView, Phase, StockView } from '../shared/types';
import { compact, money, signed, sideNames } from './format';

const statusNames = { open: '待成交', filled: '全部成交', cancelled: '已撤销', partial: '部分成交' };
const cancelReasons = { user: '你已撤销未成交部分。', 'day-expired': '当日委托收盘到期，未成交部分已撤销。', 'game-ended': '本局已结束，未成交部分已撤销。' };
export const isPendingOrder = (order: OrderView) => order.status === 'open' || order.status === 'partial';
const isHoldingSale = (order: OrderView) => ['sell', 'creditSell', 'marginSell'].includes(order.side);

export function OrderProgress({ order }: { order: OrderView }) {
  if (isHoldingSale(order)) return <span className="order-progress">
    已卖出 {order.filled.toLocaleString()} / {order.quantity.toLocaleString()} 股
    {order.status === 'cancelled' ? ` · 已撤销 ${order.remaining.toLocaleString()} 股` : isPendingOrder(order) ? ` · ${order.remaining.toLocaleString()} 股还未卖出` : ''}
  </span>;
  return <span className="order-progress">已成交 {order.filled.toLocaleString()} 股
    {order.status === 'cancelled' ? ` · 已撤销 ${order.remaining.toLocaleString()} 股` : isPendingOrder(order) ? ` · 待成交 ${order.remaining.toLocaleString()} 股` : ''}
  </span>;
}

export function OrderCancellation({ order }: { order: OrderView }) {
  return order.status === 'cancelled' ? <span className="order-cancel-note">{order.cancelReason ? cancelReasons[order.cancelReason] : '未成交部分已撤销。'}{isHoldingSale(order) && '撤单只解除冻结，不会卖出股票。'}</span> : null;
}

export function OrderImpact({ order }: { order: OrderView }) {
  const execution = order.execution;
  if (!execution) return null;
  const hasPrices = execution.beforePrice !== undefined && execution.afterPrice !== undefined;
  const move = hasPrices ? (execution.afterPrice! / execution.beforePrice! - 1) * 100 : 0;
  return <div className="operator-impact" aria-label="本单即时成交影响">
    <strong>提交瞬间</strong> · {execution.filled ? <>
      实际成交 {execution.filled.toLocaleString()} 股 / {compact(execution.amount)} 元，跨 {execution.priceLevels} 个成交价位，均价 {money(execution.averagePrice!)} 元。
      {hasPrices && <div>本次撮合的最新价 <strong>{money(execution.beforePrice!)} → {money(execution.afterPrice!)}</strong>（{signed(move)}%）</div>}
      <div>这是本单即时成交的记录；后续涨跌还取决于其他席位的买卖。</div>
    </> : <>没有即时成交，提交时未推动价格。后续成交进度见上方。</>}
  </div>;
}

export function EmptyPositionNote({ orders }: { orders: OrderView[] }) {
  const buys = orders.filter(order => order.side === 'buy');
  const pending = buys.filter(isPendingOrder).reduce((sum, order) => sum + order.remaining, 0);
  const latest = buys[0];
  if (pending) return <p className="position-locks position-order-note">尚未持有本股。买入委托尚有 {pending.toLocaleString()} 股待成交；冻结资金仍在账户内，成交后才计入持仓。</p>;
  if (latest?.status === 'cancelled' && latest.filled === 0) return <p className="position-locks position-order-note">最近一笔买入未成交{latest.cancelReason === 'day-expired' ? '，已在收盘时到期撤销' : '，已撤销'}；资金已解冻，没有形成持仓。</p>;
  return <p className="position-locks position-order-note">尚未持有本股。委托成交后才计入持仓，买入次日可卖。</p>;
}

export function RecentStockOrders({ orders, disabled, onCancel, onAll }: {
  orders: OrderView[]; disabled: boolean; onCancel: (id: string) => void; onAll: () => void;
}) {
  if (!orders.length) return null;
  const visible = [...orders.filter(isPendingOrder), ...orders.filter(order => !isPendingOrder(order))].slice(0, 3);
  return <section className="recent-stock-orders" aria-label="本股最近委托">
    <header><h2>本股最近委托</h2><button type="button" className="text-button" onClick={onAll}>全部记录 →</button></header>
    <ol>{visible.map(order => <li key={order.id} data-order-status={order.status}>
      <div className="order-receipt-title"><span><time>{order.day ? `第 ${order.day} 日 · ` : ''}{order.time}</time><b>{sideNames[order.side]} · {money(order.price)} 元</b></span><strong>{statusNames[order.status]}</strong></div>
      <div className="order-receipt-progress"><OrderProgress order={order} />{isPendingOrder(order) && <button type="button" className="order-cancel-action" disabled={disabled} onClick={() => onCancel(order.id)}>撤销剩余 {order.remaining.toLocaleString()} 股</button>}</div>
      {isHoldingSale(order) && isPendingOrder(order) && <p className="order-sale-pending"><strong>{order.filled ? '仅部分成交' : '尚未卖出'}</strong> · 剩余 {order.remaining.toLocaleString()} 股仍在持仓中，等待买盘成交。</p>}
      <OrderImpact order={order} />
      <OrderCancellation order={order} />
      {isPendingOrder(order) && order.frozenCash > 0 && <span className="order-frozen-note">冻结 ¥ {money(order.frozenCash)} · 尚未支出</span>}
      {isHoldingSale(order) && isPendingOrder(order) && order.frozenQuantity > 0 && <span className="order-frozen-note">委托冻结 {order.frozenQuantity.toLocaleString()} 股 · 不可重复卖出，撤单后解除冻结。</span>}
    </li>)}</ol>
  </section>;
}

export function OrderPriceGuide({ stock, side, price, phase, onPrice }: {
  stock: StockView; side: 'buy' | 'sell'; price: number; phase: Phase; onPrice: (price: string) => void;
}) {
  const opposite = side === 'buy' ? stock.asks[0] : stock.bids[0];
  const name = side === 'buy' ? '卖一' : '买一';
  const auction = phase === 'auction' || phase === 'closing';
  const outside = opposite && Number.isFinite(price) && price > 0 && (side === 'buy' ? price < opposite.price : price > opposite.price);
  return <div className="order-price-guide">
    <div><span>当前{name} {opposite ? <><b>{money(opposite.price)} 元</b><small> · {opposite.quantity.toLocaleString()} 股</small></> : '暂无报价'}</span><button type="button" className="text-button" disabled={!opposite} onClick={() => opposite && onPrice(opposite.price.toFixed(2))}>按{name}填价</button></div>
    <p>{auction ? '竞价委托等待集中撮合，挂单不代表成交。' : outside ? `你的${side === 'buy' ? '买价低于卖一' : '卖价高于买一'}，当前需等待对手盘。` : `${side === 'buy' ? '买价不低于卖价' : '卖价不高于买价'}时才可能成交，仍受排队与数量限制。`}</p>
  </div>;
}
