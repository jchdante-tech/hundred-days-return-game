import type { MarketView, OrderView, StockView } from '../shared/types';
import { continuousPhase, crossesOwnOrder, previewBook, sweepTicket } from '../shared/order-book-preview';
import { compact, money } from './format';
import './operator-desk.css';

export function OperatorSeat({ stock, cash, onTraining, trainingLabel = '操盘说明 ↗' }: { stock: StockView; cash: number; onTraining: () => void; trainingLabel?: string }) {
  return <section className="operator-seat" aria-label="你的游资席位" data-opening-target="seat">
    <dl><div><dt>可用现金</dt><dd>{compact(cash)}</dd></div><div><dt title="你的筹码占局内流通盘比例">持筹</dt><dd>{stock.chips ? `${money(stock.chips.playerRatio * 100)}%` : '—'}</dd></div></dl>
    <button type="button" onClick={onTraining}>{trainingLabel}</button>
  </section>;
}

export default function OperatorDesk({ stock, market, side, price, quantity, orders, disabled, onTicket, onPrice }: {
  stock: StockView; market: MarketView; side: 'buy' | 'sell'; price: number; quantity: number;
  orders: OrderView[]; disabled: boolean; onTicket: (price: number, quantity: number) => void; onPrice: (price: string) => void;
  onSide: (side: 'buy' | 'sell') => void;
}) {
  const levels = side === 'buy' ? stock.asks : stock.bids;
  const available = market.positions.find(p => p.stockId === stock.id)?.available ?? 0;
  const preview = previewBook(levels, side, price, quantity);
  const crossing = crossesOwnOrder(orders, side, price);
  const continuous = continuousPhase(market.phase);
  const affordable = side === 'buy' ? price * quantity <= market.availableCash + .001 : quantity <= available;
  const tickets = [1, 5].map(depth => sweepTicket(levels, side, depth, market.availableCash, available));
  const maxDepth = Math.max(1, ...stock.asks.map(l => l.quantity), ...stock.bids.map(l => l.quantity));
  const row = (kind: 'buy' | 'sell') => {
    const list = (kind === 'buy' ? stock.bids : stock.asks).slice(0, 5);
    return <div className="operator-book-side"><h3 className={kind === 'sell' ? 'up' : 'down'}>{kind === 'sell' ? '卖盘' : '买盘'}<span>价格 / 元 · 数量 / 股</span></h3>{list.length ? list.map((l, i) => <button key={`${kind}-${l.price}`} type="button" onClick={() => onPrice(l.price.toFixed(2))} disabled={disabled}
      className={`operator-level ${kind === 'sell' ? 'up' : 'down'} ${continuous && !crossing && kind !== side && preview?.fills.some(f => f.price === l.price) ? 'operator-level-hit' : ''}`}
      aria-label={`${kind === 'sell' ? '卖' : '买'}${i + 1} ${money(l.price)}元 ${l.quantity.toLocaleString()}股，填入限价`}>
      <i aria-hidden="true" style={{ width: `${l.quantity / maxDepth * 100}%` }} /><span>{kind === 'sell' ? '卖' : '买'}{i + 1}</span><b>{money(l.price)}</b><span>{l.quantity.toLocaleString('zh-CN')}</span>
    </button>) : <p className="operator-empty">暂无挂单</p>}</div>;
  };
  return <section className="operator-desk" aria-label="操盘盘口" data-tour="operator" data-opening-target="book">
    <header><h2>买卖盘口</h2><span>{continuous ? '点价格，填入限价' : market.phase === 'auction' || market.phase === 'closing' ? '集合竞价 · 统一撮合' : '休市 · 仅供观察'}</span></header>
    <div className="operator-book">{row('sell')}{row('buy')}</div>
    <details className="operator-more">
    <summary>盘口详情 / 更多操作</summary>
    <div className="operator-presets" role="group" aria-label="填入操盘委托">
      <button type="button" disabled={disabled || !levels[0] || (side === 'sell' ? available < 100 : market.availableCash < (levels[0]?.price ?? 0) * 100)} onClick={() => onTicket(levels[0].price, 100)}>100 股试单</button>
      {tickets.map((ticket, i) => <button type="button" key={i} disabled={disabled || !ticket || crossesOwnOrder(orders, side, ticket.price)} onClick={() => ticket && onTicket(ticket.price, ticket.quantity)}>{side === 'buy' ? '扫' : '卖给'}{i === 0 ? '一档' : '五档'}{ticket && <small>{compact(ticket.quantity)} 股</small>}</button>)}
    </div>
    <p className="operator-ticket-note">快捷操作只填价格和数量；检查下方委托单，再确认{side === 'buy' ? '买入' : '卖出'}。按可用{side === 'buy' ? '现金' : '股份'}取整。</p>
    <div className="operator-preview" aria-label="可见盘口试算">
      <strong>本单能吃到多少盘口</strong>
      {!continuous ? <p>{market.phase === 'auction' || market.phase === 'closing' ? '竞价按统一成交价结算，当前五档不能用来预测扫档结果。连续交易开始后再看本单试算。' : '休市不撮合，开市后按当时盘口试算。'}</p>
        : crossing ? <p>限价会碰到自己的反向挂单。先撤掉冲突委托，再安排扫档。</p>
          : !preview ? <p>填入有效限价与 100 股整数倍的数量后，查看可见五档试算。</p>
            : <><dl><div><dt>五档内可匹配</dt><dd>{preview.filled.toLocaleString()} 股</dd></div><div><dt>涉及价格档位</dt><dd>{preview.fills.length} 档</dd></div><div><dt>末笔成交价试算</dt><dd>{preview.lastPrice === null ? '—' : money(preview.lastPrice)}</dd></div></dl>
              <p>{preview.filled ? `可见部分金额 ${compact(preview.amount)} 元，均价 ${money(preview.averagePrice!)} 元。` : `当前限价碰不到对手盘，加大股数也不会自动${side === 'buy' ? '扫到更高的卖价' : '接受更低的买价'}。`}{preview.remaining > 0 && `另有 ${preview.remaining.toLocaleString()} 股未被可见五档覆盖，可能等待或在更深档位成交。`}</p>
              {!affordable && <p className="operator-shortfall">{side === 'buy' ? '可用现金不足以按限价冻结这笔委托，请减少数量。' : '可卖股份不足；今日买入须等下一交易日，请减少数量。'}</p>}
            </>}
      <small>这是当前可见盘口的试算；提交前挂单可能变化，实际结果看成交回执。</small>
    </div>
    </details>
  </section>;
}
