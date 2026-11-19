import { useState } from 'react';
import { ArrowUpRight, CaretDown } from '@phosphor-icons/react';
import type { PostCloseReport, SeatActivityView } from '../shared/types';
import { compact, money } from './format';
import './post-close-review.css';

const directionClass = (value: number) => value > 0 ? 'up' : value < 0 ? 'down' : 'flow-flat';
const signedAmount = (value: number) => `${value > 0 ? '+' : ''}${compact(value)}`;

type Props = {
  report: PostCloseReport | null;
  day: number;
  onStock: (id: string) => void;
  onSector: (sector: string) => void;
};

export default function PostCloseReview({ report, day, onStock, onSector }: Props) {
  if (!report) return <>
    <section aria-labelledby="sector-flow-title"><div className="section-heading"><h2 id="sector-flow-title">板块资金流向</h2><span>收盘后公布</span></div><p className="empty-state">{day === 1 ? '完成今天的交易，收盘后查看各板块的资金动向。' : '暂无完整盘后记录，本日收盘后生成。'}</p></section>
    <section aria-labelledby="seat-activity-title"><div className="section-heading"><h2 id="seat-activity-title">龙虎榜 · 游资动向</h2></div><p className="empty-state">收盘后公开每个游资买了、卖了哪些股票。</p></section>
  </>;

  return <>
    <section className="sector-flow-section" aria-labelledby="sector-flow-title">
      <div className="section-heading"><h2 id="sector-flow-title">板块资金流向</h2><span>按成交方向估算</span></div>
      <div className="sector-flow-grid">
        {report.sectorFlows.map(flow => <article key={flow.sector} className="sector-flow-card">
          <button className="flow-sector-link" onClick={() => onSector(flow.sector)} aria-label={`查看${flow.sector}板块行情`}>{flow.sector}<ArrowUpRight size={14} aria-hidden="true" /></button>
          <div className="flow-net"><span>估算净流入</span><strong className={directionClass(flow.net)}>{signedAmount(flow.net)}</strong></div>
          <div className="flow-strip" role="img" aria-label={`${flow.sector}：流入 ${money(flow.inflow)} 元，流出 ${money(flow.outflow)} 元，中性 ${money(flow.neutral)} 元`}>
            {[{ key: 'in', value: flow.inflow }, { key: 'out', value: flow.outflow }, { key: 'neutral', value: flow.neutral }].map(item => <i key={item.key} className={`flow-strip-${item.key}`} style={{ width: `${flow.turnover ? item.value / flow.turnover * 100 : 0}%` }} />)}
          </div>
          <dl className="flow-amounts"><div><dt><i className="flow-dot-in" />流入</dt><dd>{compact(flow.inflow)}</dd></div><div><dt><i className="flow-dot-out" />流出</dt><dd>{compact(flow.outflow)}</dd></div><div><dt><i className="flow-dot-neutral" />中性</dt><dd>{compact(flow.neutral)}</dd></div></dl>
          <p className="flow-turnover">成交额 <span>{compact(flow.turnover)}</span></p>
        </article>)}
      </div>
      <details className="flow-method"><summary>流向怎么算？</summary><p>按每只股票的逐笔成交价格估算：高于上一笔计流入，低于上一笔计流出；平价沿用上一次方向。首笔、集合竞价及无法判断方向的成交计中性。净流入 = 流入 − 流出，三类金额相加等于成交额。</p><p>这反映成交方向，不表示有等额的新资金进入市场；每笔成交都有买卖双方。</p></details>
    </section>
    <section className="seat-activity-section" aria-labelledby="seat-activity-title">
      <div className="section-heading"><h2 id="seat-activity-title">龙虎榜 · 游资动向</h2><span>{report.seats.length} 个游资席位</span></div>
      <p className="seat-activity-intro">看看谁在持续买入，谁的买卖发生了变化。展开席位，查看逐股成交。</p>
      <div className="seat-activity-list">{report.seats.map((seat, index) => <SeatActivity key={`${report.day}-${seat.seatId}`} seat={seat} initiallyOpen={index === 0} onStock={onStock} />)}</div>
      <p className="table-note">游戏内公开全部游资当日成交，不设上榜门槛。买入、卖出均为实际成交金额；净买入 = 买入 − 卖出，不代表当前持仓。</p>
    </section>
  </>;
}

function SeatActivity({ seat, initiallyOpen, onStock }: { seat: SeatActivityView; initiallyOpen: boolean; onStock: (id: string) => void }) {
  const [open, setOpen] = useState(initiallyOpen);
  const bought = seat.stocks.filter(stock => stock.buy > 0).reduce<typeof seat.stocks[number] | null>((best, stock) => !best || stock.buy > best.buy ? stock : best, null);
  const sold = seat.stocks.filter(stock => stock.sell > 0).reduce<typeof seat.stocks[number] | null>((best, stock) => !best || stock.sell > best.sell ? stock : best, null);
  return <details className="seat-activity" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <div className="seat-activity-summary"><div className="seat-activity-heading"><h3>{seat.name}</h3><span className={`seat-net ${directionClass(seat.net)}`}>净买入 {signedAmount(seat.net)}</span></div>
        <div className="seat-stock-highlights"><span><small>买入最多</small>{bought?.stockName ?? '暂无买入'}</span><span><small>卖出最多</small>{sold?.stockName ?? '暂无卖出'}</span></div>
      </div><span className="seat-expand-label">{open ? '收起' : `${seat.stocks.length} 只`}</span><CaretDown className="seat-expand-icon" size={15} aria-hidden="true" />
    </summary>
    {!!seat.observations?.length && <ul className="seat-observations" aria-label={`${seat.name}成交变化`}>{seat.observations.map(observation => <li key={`${observation.stockId}-${observation.kind}`}>
      <span className="seat-observation-label">{{ concentration: '买入集中', continuation: '连续净买', reduced: '买入减少', reversed: '净卖转向' }[observation.kind]}</span>
      <button onClick={() => onStock(observation.stockId)}>{observation.text}<ArrowUpRight size={12} aria-hidden="true" /></button>
    </li>)}</ul>}
    {seat.stocks.length > 0 ? <div className="table-scroll seat-stock-table" tabIndex={0} role="region" aria-label={`${seat.name}逐股成交明细`}><table><thead><tr><th scope="col">股票</th><th scope="col">买入金额</th><th scope="col">卖出金额</th><th scope="col">净买入</th></tr></thead><tbody>{seat.stocks.map(stock => <tr key={stock.stockId}>
      <td><button className="seat-stock-link" onClick={() => onStock(stock.stockId)} aria-label={`查看${stock.stockName}行情`}>{stock.stockName}<ArrowUpRight size={11} aria-hidden="true" /></button><small>{stock.sector}</small></td>
      <td data-label="买入金额">{compact(stock.buy)}<small>{money(stock.buyQuantity / 100, 0)} 手</small></td><td data-label="卖出金额">{compact(stock.sell)}<small>{money(stock.sellQuantity / 100, 0)} 手</small></td><td data-label="净买入" className={directionClass(stock.net)}>{signedAmount(stock.net)}</td>
    </tr>)}</tbody><tfoot><tr><th scope="row">席位合计</th><td data-label="买入金额">{compact(seat.buy)}</td><td data-label="卖出金额">{compact(seat.sell)}</td><td data-label="净买入" className={directionClass(seat.net)}>{signedAmount(seat.net)}</td></tr></tfoot></table></div> : <p className="empty-state">该席位当日没有成交。</p>}
  </details>;
}
