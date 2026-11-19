import { ArrowUpRight } from '@phosphor-icons/react';
import type { OrderView, PositionView, StockView } from '../shared/types';
import { EmptyPositionNote, isPendingOrder } from './OrderFeedback';
import { compact, money } from './format';

export default function PositionSlip({ stock, position, creditQuantity = 0, orders = [], onOpen, onCredit }: {
  stock: StockView;
  position?: PositionView;
  creditQuantity?: number;
  orders?: OrderView[];
  onOpen: () => void;
  onCredit: () => void;
}) {
  const quantity = position?.quantity ?? 0;
  const profit = position?.profit ?? 0;
  const pendingSales = orders.filter(order => order.stockId === stock.id && order.side === 'sell' && isPendingOrder(order));
  const unsold = pendingSales.reduce((sum, order) => sum + order.remaining, 0);
  const partiallySold = pendingSales.some(order => order.filled > 0);
  return <section className="position-slip" data-tour="position" data-opening-target="position" aria-label={`${stock.name}持仓窗口`}>
    <header>
      <h2>本股持仓</h2>
      <button type="button" onClick={onOpen}>全部持仓<ArrowUpRight size={13} /></button>
    </header>
    <dl className="position-quantity-grid">
      <div><dt>总持仓 <span>股</span></dt><dd>{quantity.toLocaleString()}</dd></div>
      <div><dt>普通可卖 <span>股</span></dt><dd>{(position?.available ?? 0).toLocaleString()}</dd></div>
      <div><dt>委托冻结 <span>股</span></dt><dd>{(position?.frozen ?? 0).toLocaleString()}</dd></div>
      <div><dt>今日锁定 <span>股</span></dt><dd>{(position?.todayBought ?? 0).toLocaleString()}</dd></div>
    </dl>
    <dl className="position-valuation">
      <div><dt>成本 <span>元</span></dt><dd>{quantity ? money(position!.averageCost) : '—'}</dd></div>
      <div><dt>浮动盈亏 <span>元</span></dt><dd className={quantity ? profit >= 0 ? 'up' : 'down' : undefined}>{quantity ? `${profit >= 0 ? '+' : ''}${compact(profit)}` : '—'}</dd></div>
    </dl>
    {!!unsold && <div className="position-sale-pending" role="status">
      <p><strong>{partiallySold ? '仅部分成交' : '卖单尚未成交'}</strong> · {unsold.toLocaleString()} 股还未卖出，仍计入持仓。</p>
      <button type="button" onClick={onOpen}>查看挂单 / 撤单<ArrowUpRight size={12} /></button>
    </div>}
    {!quantity && !position?.shortQuantity && <EmptyPositionNote orders={orders} />}
    {(!!position?.todayBought || !!position?.frozen || !!position?.shortQuantity) && <p className="position-locks position-lock-explanation">
      {!!position?.todayBought && <span>今日锁定：下一交易日才可卖。</span>}
      {!!position?.frozen && <span>委托冻结：尚未卖出，撤单后解除。</span>}
      {!!position?.shortQuantity && <span>待还券 {position.shortQuantity.toLocaleString()} 股</span>}
    </p>}
    {creditQuantity > 0 && <p className="position-locks"><span>其中 {creditQuantity.toLocaleString()} 股在杠杆或旧信用账户</span><button type="button" className="text-button" onClick={onCredit}>管理杠杆仓位 →</button></p>}
  </section>;
}
