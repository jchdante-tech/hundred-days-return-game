import { useState } from 'react';
import type { IpoOfferView, StockView } from '../shared/types';
import { compact, money, signed } from './format';
import './ipo-desk.css';

export default function IpoDesk({ offers, stocks, availableCash, disabled, onSubscribe, onCancel, onStock }: {
  offers: IpoOfferView[]; stocks: StockView[]; availableCash: number; disabled: boolean;
  onSubscribe: (id: string, quantity: number) => Promise<unknown>;
  onCancel: (id: string) => Promise<unknown>; onStock: (id: string) => void;
}) {
  if (!offers.length) return null;
  const latest = [...offers].sort((a, b) => b.announcementDay - a.announcementDay)[0];
  return <aside className="ipo-desk" aria-label="新股申购">
    <div className="ipo-desk-heading"><span>新股簿</span><small>第 {latest.listingDay} 日上市</small></div>
    <IpoOffer key={latest.id} offer={latest} stock={stocks.find(s => s.id === latest.stockId)} availableCash={availableCash}
      disabled={disabled} onSubscribe={onSubscribe} onCancel={onCancel} onStock={onStock} />
    {offers.length > 1 && <details className="ipo-archive"><summary>此前配售记录</summary>{offers.filter(o => o.id !== latest.id).map(o => <p key={o.id}>
      <button disabled={o.status !== 'listed'} onClick={() => onStock(o.stockId)}>{o.name}</button><span>{o.status === 'cancelled' ? '已取消' : `获配 ${money(o.allocatedQuantity ?? 0, 0)} 股`}</span>
    </p>)}</details>}
  </aside>;
}

function IpoOffer({ offer, stock, availableCash, disabled, onSubscribe, onCancel, onStock }: {
  offer: IpoOfferView; stock?: StockView; availableCash: number; disabled: boolean;
  onSubscribe: (id: string, quantity: number) => Promise<unknown>;
  onCancel: (id: string) => Promise<unknown>; onStock: (id: string) => void;
}) {
  const [quantity, setQuantity] = useState(String(offer.subscribedQuantity || 100));
  const max = Math.min(offer.quotaQuantity, Math.floor((availableCash + offer.reservedAmount) / offer.issuePrice / 100) * 100);
  const eligible = offer.status === 'subscribing';
  const change = stock ? (stock.price / offer.issuePrice - 1) * 100 : null;
  return <>
    <div className="ipo-offer-title"><strong>{offer.name}</strong><span>{eligible ? '申购中' : offer.status === 'awaiting-listing' ? '待配售' : offer.status === 'cancelled' ? offer.cancelReason === 'no-demand' ? '流标' : '已取消' : '已上市'}</span></div>
    <p className="ipo-price">发行价 ¥ {money(offer.issuePrice)}{change !== null && <span className={change >= 0 ? 'up' : 'down'}>较发行价 {signed(change)}%</span>}</p>
    {offer.status === 'cancelled' ? <p className="ipo-quota">{offer.cancelReason === 'no-demand' ? '没有有效认购，本次发行取消。' : '本局结束，申购冻结已全部释放。'}</p> : offer.status !== 'listed' ? <p className="ipo-quota">本次额度 {compact(offer.quotaAmount)} 元 · 已冻结 {compact(offer.reservedAmount)} 元</p>
      : <p className="ipo-quota">获配 {money(offer.allocatedQuantity ?? 0, 0)} 股 · 支付 {compact(offer.allocatedAmount ?? 0)} 元</p>}
    <details className="ipo-prospectus">
      <summary>{eligible ? '看发行资料 · 申购' : '发行资料与配售'}</summary>
      <p>{offer.description}</p>
      <dl><div><dt>需求线索</dt><dd>{{ weak: '偏弱', steady: '平稳', strong: '偏强' }[offer.demand]}</dd></div>
        <div><dt>发行 PE / 同业参考</dt><dd>{money(offer.issuePe, 1)} / {money(offer.peerPe, 1)} 倍</dd></div>
        <div><dt>本期发行供给</dt><dd>{compact(offer.offeredShares)} 股</dd></div></dl>
      <p className="ipo-risk">{offer.issuePe > offer.peerPe * 1.15 ? '发行估值偏高，需要后续业绩和买盘承接。' : offer.issuePe < offer.peerPe * .85 ? '发行估值低于同业参考，仍需核实需求和成交承接。' : '发行估值接近同业参考，留意需求变化与卖出压力。'}中签不保证盈利。</p>
      {eligible ? <form onSubmit={event => { event.preventDefault(); void onSubscribe(offer.id, Number(quantity)); }}>
        <label>申购数量（股）<input aria-label="新股申购数量" type="number" min="100" max={max} step="100" required value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
        <div className="ipo-form-actions"><button type="button" disabled={disabled || max < 100} onClick={() => setQuantity(String(max))}>按可用额度</button>
          <button className="ipo-subscribe" type="submit" disabled={disabled || max < 100}>{offer.subscribedQuantity ? '修改申购' : '冻结资金申购'}</button></div>
        {offer.subscribedQuantity > 0 && <button type="button" className="ipo-cancel" disabled={disabled} onClick={() => void onCancel(offer.id)}>撤销本次申购</button>}
        <p className="ipo-rules">今日收盘截止，次交易日开盘配售。未获配部分释放冻结资金，发行价不保底。</p>
      </form> : offer.status === 'awaiting-listing' ? <p className="ipo-rules">申购已截止，等待第 {offer.listingDay} 日开盘配售。</p>
        : offer.status === 'cancelled' ? <p className="ipo-rules">本次没有配售；释放冻结 {compact(offer.refundAmount ?? 0)} 元。</p>
          : <p className="ipo-rules">释放冻结 {compact(offer.refundAmount ?? 0)} 元；有效认购为供给的 {money(offer.subscriptionRate ?? 0, 1)} 倍。</p>}
      <p className="ipo-rules">游戏规则：上市首日涨跌幅上限 30%，此后 10%。配售股份上市即可卖出，当天在市场买入的股份仍需下一交易日才能卖。</p>
    </details>
    {stock && <button className="ipo-open-stock" onClick={() => onStock(stock.id)}>进入 {offer.name} 盘口 →</button>}
  </>;
}
