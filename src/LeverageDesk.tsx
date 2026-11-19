import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowRight, Bank, Question, ShieldCheck } from '@phosphor-icons/react';
import type { MarketView } from '../shared/types';
import { compact, money, signed } from './format';
import './leverage-desk.css';

type Props = {
  market: MarketView;
  disabled: boolean;
  onAction: (body: Record<string, unknown>, silent?: boolean) => Promise<boolean | undefined>;
  onGuide: () => void;
  onStock?: (stockId: string) => void;
};
type Direction = 'long' | 'short';
type MarginMode = 'isolated' | 'cross';
type PositionAction = { positionId: string; kind: 'close' | 'add' } | null;
const phaseClosed = (market: MarketView) => ['lunch', 'night', 'ended'].includes(market.phase);
const accountRiskName = (level: string) => level === 'liquidating' ? '强平处理中' : level === 'warning' ? '接近强平线' : '安全';
const defaultPrice = (stock: MarketView['stocks'][number] | undefined, direction: Direction) => !stock ? 0 : direction === 'long' ? stock.asks[0]?.price ?? stock.price : Math.max(stock.price, stock.bids[0]?.price ?? stock.price);

export default function LeverageDesk({ market, disabled, onAction, onGuide, onStock }: Props) {
  const margin = market.margin;
  const [direction, setDirection] = useState<Direction>('long');
  const [mode, setMode] = useState<MarginMode>('isolated');
  const [leverage, setLeverage] = useState<1 | 2 | 3>(2);
  const [stockId, setStockId] = useState(market.stocks.find(item => item.financeEligible)?.id ?? market.stocks[0]?.id ?? '');
  const [principal, setPrincipal] = useState('100000');
  const [price, setPrice] = useState('');
  const [customPrice, setCustomPrice] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [positionAction, setPositionAction] = useState<PositionAction>(null);
  const [actionQuantity, setActionQuantity] = useState('');
  const [actionAmount, setActionAmount] = useState('');
  const [actionPrice, setActionPrice] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionFeedback, setActionFeedback] = useState('');
  const stock = market.stocks.find(item => item.id === stockId) ?? market.stocks[0];
  const stockOptions = market.stocks.filter(item => direction === 'short' ? item.shortEligible : leverage === 1 || item.financeEligible);
  const pool = market.credit.pools.find(item => item.stockId === stock?.id);
  const principalCents = Math.round(Number(principal) * 100);
  const priceCents = Math.round(Number(price) * 100);
  const reservePriceCents = direction === 'short' ? Math.round((stock?.limitUp ?? 0) * 100) : priceCents;
  const quantity = principalCents > 0 && reservePriceCents > 0 ? Math.floor(principalCents * leverage / reservePriceCents / 100) * 100 : 0;
  const notional = quantity * priceCents / 100;
  const usedPrincipal = Math.ceil(quantity * reservePriceCents / leverage) / 100;
  const estimatedLoan = direction === 'long' ? notional - usedPrincipal : 0;
  const estimatedFee = direction === 'long' ? estimatedLoan * market.annualInterestRate / 365 : notional * market.credit.borrowAnnualRate / 365;
  const crossAccount = margin.accounts.find(item => item.mode === 'cross');
  const projectedEquity = (mode === 'cross' ? crossAccount?.equity ?? 0 : 0) + usedPrincipal;
  const projectedExposure = (mode === 'cross' ? crossAccount?.grossExposure ?? 0 : 0) + notional;
  const projectedRatio = projectedExposure > 0 ? projectedEquity / projectedExposure * 100 : null;
  const shortCapacity = stock && priceCents > 0 ? Math.floor(Math.min(pool?.available ?? 0, margin.shortAvailable / stock.limitUp) / 100) * 100 : 0;
  const availableCash = market.availableCash;
  const eligible = stockOptions.some(item => item.id === stock?.id);
  const locked = !market.creditUnlocked;
  const crossRiskBlocked = mode === 'cross' && !!crossAccount && crossAccount.marginRatio < margin.warningRatio;
  const openUnavailable = crossRiskBlocked || locked || !eligible || quantity < 100 || Number(principal) > availableCash || (direction === 'long' && estimatedLoan > margin.financeAvailable + .005) || (direction === 'short' && quantity > shortCapacity);
  const debt = margin.accounts.reduce((sum, item) => sum + item.debt, 0);
  const marginEquity = margin.accounts.reduce((sum, item) => sum + item.equity, 0);
  const riskyAccounts = margin.accounts.filter(item => item.riskLevel !== 'normal');
  const activePosition = margin.positions.find(item => item.id === positionAction?.positionId);
  const activeAccount = margin.accounts.find(item => item.id === activePosition?.accountId);
  const activeStock = market.stocks.find(item => item.id === activePosition?.stockId);
  const pending = market.orders.filter(item => (item.status === 'open' || item.status === 'partial') && item.marginAccountId);

  useEffect(() => {
    if (!stockOptions.some(item => item.id === stockId) && stockOptions[0]) setStockId(stockOptions[0].id);
  }, [direction, leverage, stockId, market.stocks]);
  useEffect(() => { setPrice(defaultPrice(stock, direction).toFixed(2)); setCustomPrice(false); }, [stock?.id, direction]);
  useEffect(() => { if (!customPrice) setPrice(defaultPrice(stock, direction).toFixed(2)); }, [stock?.price, stock?.asks[0]?.price, stock?.bids[0]?.price, direction, customPrice]);
  useEffect(() => { setError(''); setFeedback(''); }, [stockId, direction, mode, leverage, principal]);

  const fillMaximum = () => {
    let maximum = availableCash;
    if (direction === 'long' && leverage > 1) maximum = Math.min(maximum, margin.financeAvailable / (leverage - 1));
    if (direction === 'short') maximum = Math.min(maximum, shortCapacity * stock.limitUp / leverage);
    const lots = reservePriceCents > 0 ? Math.floor(Math.round(maximum * 100) * leverage / reservePriceCents / 100) : 0;
    setPrincipal((Math.ceil(lots * 100 * reservePriceCents / leverage) / 100).toFixed(2));
  };
  const openPosition = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!Number.isFinite(Number(principal)) || Number(principal) <= 0) return setError('请输入本次投入的自有资金。');
    if (quantity < 100) return setError('资金不足以买入或借入 100 股，请增加投入。');
    if (openUnavailable) return setError(crossRiskBlocked ? '全仓账户处于风险区，请先补保证金或减仓。' : direction === 'short' ? '超过当前现金、借券额度或实际券源，请减少投入。' : '超过当前现金或融资额度，请减少投入。');
    const ok = await onAction({ type: 'marginOpen', stockId: stock.id, direction, mode, leverage, principal: Number(principal), price: Number(price) });
    if (ok) setFeedback('委托已提交。实际成交后形成仓位，未成交部分可撤单。');
    else setError('未能提交，输入已保留，请查看提示后重试。');
  };
  const selectPositionAction = (id: string, kind: 'close' | 'add') => {
    const selected = margin.positions.find(item => item.id === id);
    const selectedStock = market.stocks.find(item => item.id === selected?.stockId);
    setPositionAction(positionAction?.positionId === id && positionAction.kind === kind ? null : { positionId: id, kind });
    setActionQuantity(String(selected?.availableQuantity ?? 0)); setActionAmount('');
    setActionPrice(selectedStock ? (selected?.direction === 'long' ? selectedStock.bids[0]?.price ?? selectedStock.price : selectedStock.asks[0]?.price ?? selectedStock.price).toFixed(2) : '');
    setActionError(''); setActionFeedback('');
  };
  const submitPositionAction = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activePosition || !activeAccount || !positionAction) return;
    if (positionAction.kind === 'close') {
      const q = Number(actionQuantity);
      if (!Number.isInteger(q) || q <= 0 || q % 100 || q > activePosition.availableQuantity) return setActionError('平仓数量须为 100 股的整数倍，且不能超过今日可平数量。');
      const ok = await onAction({ type: 'marginClose', positionId: activePosition.id, quantity: q, price: Number(actionPrice) });
      if (ok) setActionFeedback('平仓委托已提交，等待成交。'); else setActionError('平仓未提交，输入已保留，请查看提示后重试。');
    } else {
      const amount = Number(actionAmount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > availableCash) return setActionError('请输入不超过普通账户可用现金的金额。');
      const ok = await onAction({ type: 'marginAdd', accountId: activeAccount.id, amount });
      if (ok) setActionFeedback(activeAccount.mode === 'cross' ? '保证金已加入全仓账户，全部全仓仓位共用。' : '保证金已补入这个逐仓仓位。'); else setActionError('追加未完成，输入已保留，请查看提示后重试。');
    }
  };

  if (!stock) return null;
  return <div className="leverage-desk" aria-label="股票杠杆柜台">
    <header className="lev-heading" data-tour="credit"><div><h2>股票杠杆柜台</h2><p>选一只股票，决定方向和投入。</p></div><button type="button" className="lev-text-button lev-guide" onClick={onGuide} disabled={disabled}><Question size={17} />使用说明</button></header>
    {locked && <div className="lev-lock" role="status"><Bank size={23} /><p><strong>第 {market.creditUnlockDay} 个交易日开放</strong><span>现有仓位仍可归还，普通买卖不受影响。</span></p></div>}
    <section className={`lev-account-line ${riskyAccounts.length ? 'at-risk' : ''}`} data-tour="credit-risk" aria-label="杠杆账户概况"><span><ShieldCheck size={18} />{riskyAccounts.length ? `${riskyAccounts.length} 个账户需要留意风险` : margin.positions.some(item => item.quantity > 0) ? '当前仓位处于安全区' : margin.accounts.length ? '已预留本金，等待成交' : '尚未借款'}</span><dl><div><dt>杠杆账户权益</dt><dd>{compact(marginEquity)} 元</dd></div><div><dt>信用债务</dt><dd>{compact(debt)} 元</dd></div></dl><p className="lev-risk-terms">保证金比例低于 {margin.warningRatio}% 预警 · {margin.liquidationRatio}% 强平线</p></section>

    <form onSubmit={openPosition} className="lev-open-form" data-tour="credit-order">
      <div className="lev-direction" role="group" aria-label="交易方向" style={{ '--lev-tab': direction === 'long' ? 0 : 1 } as CSSProperties}><span className="lev-selector" aria-hidden="true" /><button type="button" aria-pressed={direction === 'long'} onClick={() => setDirection('long')}><strong>做多</strong><span>看涨 · 买入股票</span></button><button type="button" aria-pressed={direction === 'short'} onClick={() => setDirection('short')}><strong>做空</strong><span>看跌 · 借股卖出</span></button></div>
      <div className="lev-form-body"><div className="lev-input-area">
        <label>选择股票<select aria-label="杠杆交易股票" value={eligible ? stock.id : ''} onChange={event => setStockId(event.target.value)} disabled={disabled || !!market.result}>{!eligible && <option value="">暂无合适标的</option>}{stockOptions.map(item => <option value={item.id} key={item.id}>{item.name}{direction === 'short' ? ` · 余券 ${money(market.credit.pools.find(pool => pool.stockId === item.id)?.available ?? 0, 0)} 股` : ` · ${item.sector}`}</option>)}</select></label>
        <div className="lev-stock-line"><span className={stock.changePercent >= 0 ? 'up' : 'down'}>{money(stock.price)} <small>{signed(stock.changePercent)}%</small></span>{onStock && <button type="button" className="lev-text-button" onClick={() => onStock(stock.id)}>看行情 →</button>}</div>
        <div className="lev-margin-settings" data-tour="credit-margin"><div className="lev-mode-row"><span>保证金方式</span><div className="lev-mode-buttons" role="group" aria-label="保证金方式" style={{ '--lev-tab': mode === 'isolated' ? 0 : 1 } as CSSProperties}><span className="lev-selector" aria-hidden="true" /><button type="button" aria-pressed={mode === 'isolated'} onClick={() => setMode('isolated')}>逐仓</button><button type="button" aria-pressed={mode === 'cross'} onClick={() => setMode('cross')}>全仓</button></div></div><p>{mode === 'isolated' ? '本次投入单独担保，风险与其他仓位分开。' : '全部全仓仓位共用已投入的保证金；普通账户现金不会自动加入。'}</p></div>
        <div className="lev-input-heading"><label htmlFor="lev-principal">这次投入多少</label><span>自有资金 · 元</span></div><input id="lev-principal" aria-label="开仓自有资金" type="number" min="0.01" step="0.01" required value={principal} onChange={event => setPrincipal(event.target.value)} disabled={disabled || locked || !!market.result} />
        <div className="lev-cash-line"><span>可用现金 {compact(availableCash)} 元</span><button type="button" className="lev-text-button" onClick={fillMaximum} disabled={disabled || locked || availableCash <= 0 || !!market.result}>填入上限</button></div>
        <div className="lev-leverage-row"><span>杠杆倍数</span><div role="group" aria-label="杠杆倍数">{([1, 2, 3] as const).map(value => <button type="button" key={value} aria-pressed={leverage === value} onClick={() => setLeverage(value)}>{value}×</button>)}</div></div>
        <details className="lev-price"><summary>委托价 {money(Number(price) || 0)} 元 · {customPrice ? '已自定' : '按当前盘口'}，点击修改</summary><label>限价<span>元</span><input aria-label="杠杆委托价格" type="number" min={direction === 'short' ? stock.price : stock.limitDown} max={stock.limitUp} step="0.01" required value={price} onChange={event => { setPrice(event.target.value); setCustomPrice(true); setError(''); setFeedback(''); }} disabled={disabled || locked || !!market.result} /></label><button type="button" className="lev-text-button" onClick={() => { setPrice(defaultPrice(stock, direction).toFixed(2)); setCustomPrice(false); }}>恢复当前盘口</button></details>
      </div><aside className="lev-preview" data-tour="credit-sources" aria-label="杠杆委托预览"><span className="lev-eyebrow">{mode === 'isolated' ? '逐仓' : '全仓'} · {leverage} 倍{direction === 'long' ? '做多' : '做空'}</span><strong>{compact(notional)}<small>元仓位</small></strong><dl><div><dt>本单使用自有资金</dt><dd>{compact(usedPrincipal)} 元</dd></div><div><dt>股票数量</dt><dd>{money(quantity, 0)} 股</dd></div><div><dt>{direction === 'long' ? '预计借款' : '实际借券'}</dt><dd>{direction === 'long' ? `${compact(estimatedLoan)} 元` : `${money(quantity, 0)} 股`}</dd></div>{direction === 'long' && leverage > 1 && <div><dt>剩余借款额度</dt><dd>{compact(margin.financeAvailable)} 元</dd></div>}<div><dt>预计每日费用</dt><dd>{money(estimatedFee)} 元</dd></div><div><dt>预计保证金比例</dt><dd>{projectedRatio === null ? '—' : `${money(projectedRatio, 1)}%`}</dd></div>{direction === 'short' && <div><dt>本股最多可借</dt><dd>{money(shortCapacity, 0)} 股</dd></div>}</dl></aside>
      <div className="lev-open-actions"><p className="lev-preview-explainer">{direction === 'long' ? `投入 ${compact(usedPrincipal)} 元，按 ${leverage} 倍形成股票仓位。${leverage === 1 ? '1 倍做多不借款。' : '超出自有资金的部分向券商借入。'}` : '按当日最高价预留保证金，实际杠杆不超过所选倍数。卖出款受限，平仓买回股票归还。'}</p><p className="lev-note">按 100 股取整，多余资金留在普通账户。比例按开仓委托全部成交估算；今日新开仓位遵循 T+1。</p>{!eligible && <p className="lev-error">{direction === 'short' ? '当前没有可借的股票。' : '请选择允许融资的股票，或改用 1 倍。'}</p>}{openUnavailable && !locked && eligible && <p className="lev-error">{crossRiskBlocked ? '全仓账户已进入风险区，请先补保证金或减仓。' : Number(principal) > availableCash ? '超过普通账户可用现金。' : quantity < 100 ? '资金尚不足 100 股。' : direction === 'short' ? '超过实际券源或借券额度。' : '超过可用融资额度。'}</p>}{error && <p className="lev-error" role="alert">{error}</p>}<button type="submit" className="primary-button lev-submit" disabled={disabled || locked || openUnavailable || market.paused || phaseClosed(market) || !!market.result}>{disabled ? '请稍候…' : market.result ? '本局已结束' : locked ? `第 ${market.creditUnlockDay} 日开放` : market.paused ? '先开始行情' : phaseClosed(market) ? '休市中' : `确认${mode === 'isolated' ? '逐仓' : '全仓'}${direction === 'long' ? '做多' : '做空'}`}<ArrowRight size={17} /></button>{feedback && <p className="lev-feedback" role="status">{feedback}</p>}</div></div>
    </form>

    <section className="lev-positions" data-tour="credit-positions"><div className="lev-section-heading"><h3>我的杠杆仓位</h3><span>{margin.positions.length} 个仓位</span></div>{margin.positions.length === 0 ? <p className="lev-empty">还没有仓位。先选股票和投入，成交后会出现在这里。</p> : <div className="lev-position-list">{margin.positions.map(item => { const account = margin.accounts.find(row => row.id === item.accountId); const heldStock = market.stocks.find(row => row.id === item.stockId); const expanded = positionAction?.positionId === item.id; if (!account) return null; return <article key={item.id} className={`lev-position ${account.riskLevel}`}><div className="lev-position-heading"><div><h4>{heldStock?.name ?? item.stockId}</h4><span className={item.direction === 'long' ? 'up' : 'down'}>{item.direction === 'long' ? '做多' : '做空'} {item.leverage}×</span><span>{account.mode === 'isolated' ? '逐仓' : '全仓'}</span></div><strong className={item.unrealizedPnl >= 0 ? 'up' : 'down'}>{item.unrealizedPnl >= 0 ? '+' : ''}{compact(item.unrealizedPnl)}<small>元浮动盈亏</small></strong></div><dl className="lev-position-facts"><div><dt>持仓 / 今日可平</dt><dd>{money(item.quantity, 0)} / {money(item.availableQuantity, 0)} 股</dd></div><div><dt>成交均价 / 现价</dt><dd>{money(item.entryPrice)} / {money(item.currentPrice)}</dd></div><div><dt>{account.mode === 'cross' ? '全仓共用保证金比例' : '保证金比例'}</dt><dd>{account.grossExposure > 0 ? `${money(account.marginRatio, 1)}% · ${accountRiskName(account.riskLevel)}` : account.debt > 0 ? '尚有债务，需补入现金' : '等待开仓成交'}</dd></div><div><dt>{account.mode === 'cross' ? '全仓账户权益' : '强平参考价'}</dt><dd>{account.mode === 'cross' ? `${compact(account.equity)} 元` : item.liquidationPrice === null ? '暂无强平参考价' : item.liquidationPrice <= 0 ? '现金足以偿还借款' : `${money(item.liquidationPrice)} 元`}</dd></div></dl><div className="lev-position-footer"><p>{item.todayQuantity > 0 ? `今日新开 ${money(item.todayQuantity, 0)} 股，下个交易日可平。` : item.quantity <= 0 ? item.loan > 0 ? '股票已平，仍有欠款；请补入现金偿还。' : '本金已预留，等待开仓委托成交。' : account.mode === 'cross' ? '风险按全部全仓仓位一起计算。' : '本仓保证金与其他仓位分开。'}{account.riskLevel === 'liquidating' ? ' 已提交或等待强平；T+1、涨跌停与缺少对手盘可能阻止及时成交。' : ''}</p><div><button type="button" className="lev-outline" onClick={() => selectPositionAction(item.id, 'add')} disabled={disabled || !!market.result}>补保证金</button><button type="button" className="lev-outline" onClick={() => selectPositionAction(item.id, 'close')} disabled={disabled || item.availableQuantity <= 0 || !!market.result}>{item.availableQuantity <= 0 ? item.quantity <= 0 ? item.loan > 0 ? '尚有欠款' : '等待成交' : item.todayQuantity > 0 ? '次日可平' : '委托处理中' : '平仓'}</button></div></div>
      {expanded && <form className="lev-position-action" onSubmit={submitPositionAction}><div className="lev-section-heading"><h4>{positionAction.kind === 'close' ? `${item.direction === 'long' ? '卖出' : '买回'}平仓` : '补入保证金'}</h4><button type="button" className="lev-text-button" onClick={() => setPositionAction(null)}>收起</button></div>{positionAction.kind === 'close' ? <><label>平仓数量<span>股</span><input aria-label="平仓数量" type="number" min="100" step="100" required value={actionQuantity} onChange={event => { setActionQuantity(event.target.value); setActionError(''); setActionFeedback(''); }} disabled={disabled || !!market.result} /></label><div className="lev-cash-line"><span>今日可平 {money(item.availableQuantity, 0)} 股</span><button type="button" className="lev-text-button" onClick={() => setActionQuantity(String(item.availableQuantity))}>全部可平</button></div><details className="lev-price"><summary>平仓限价 {money(Number(actionPrice) || 0)} 元，点击修改</summary><input aria-label="平仓委托价格" type="number" min={activeStock?.limitDown} max={activeStock?.limitUp} step="0.01" required value={actionPrice} onChange={event => { setActionPrice(event.target.value); setActionError(''); }} /></details><p className="lev-note">成交后自动还钱或还券。仓位与相关委托全部结清后，剩余资金自动退回普通账户。</p></> : <><label>追加金额<span>元</span><input aria-label="追加保证金金额" type="number" min="0.01" step="0.01" required value={actionAmount} onChange={event => { setActionAmount(event.target.value); setActionError(''); setActionFeedback(''); }} disabled={disabled || !!market.result} /></label><p className="lev-note">普通账户可用 {compact(availableCash)} 元。{account.mode === 'cross' ? '追加后，全部全仓仓位共用这笔资金。' : '只补入当前逐仓账户，不替其他仓位承担风险。'}</p></>}{actionError && <p className="lev-error" role="alert">{actionError}</p>}{actionFeedback && <p className="lev-feedback" role="status">{actionFeedback}</p>}<button type="submit" className="lev-outline lev-action-submit" disabled={disabled || !!market.result || (positionAction.kind === 'close' ? market.paused || phaseClosed(market) || Number(actionQuantity) <= 0 || Number(actionQuantity) > item.availableQuantity : Number(actionAmount) <= 0 || Number(actionAmount) > availableCash)}>{disabled ? '正在提交…' : positionAction.kind === 'close' ? market.paused ? '先开始行情' : phaseClosed(market) ? '休市中' : '确认平仓' : '确认补入'}<ArrowRight size={16} /></button></form>}
      </article>; })}</div>}</section>
    {pending.length > 0 && <section className="lev-pending"><div className="lev-section-heading"><h3>待成交委托</h3><span>{pending.length} 笔</span></div>{pending.map(order => <div className="lev-pending-row" key={order.id}><span><strong>{market.stocks.find(item => item.id === order.stockId)?.name}</strong><small>{order.side === 'marginBuy' ? '买入开仓' : order.side === 'marginShort' ? '借券开仓' : order.side === 'marginCover' ? '买回平仓' : '卖出平仓'} · 限价 {money(order.price)} · 剩余 {money(order.remaining, 0)} 股</small></span><button type="button" className="lev-outline" disabled={disabled || !!market.result} onClick={() => void onAction({ type: 'cancel', orderId: order.id })}>撤单</button></div>)}</section>}
    <details className="lev-contract"><summary>全仓、逐仓与强平规则</summary><p>逐仓：每次开仓单独计算风险。全仓：只有你投入全仓账户的资金与全仓仓位共用担保，普通账户现金不会自动补入；一个仓位亏损可能影响其他全仓仓位。</p><p>本局保证金比例 = 账户权益 ÷ 持仓与开仓挂单总市值。低于 {margin.warningRatio}% 预警，低于 {margin.liquidationRatio}% 强平线时，券商开始提交平仓委托。比例随全部相关仓位价格变化；逐仓参考价假设其他条件不变。</p><p>做多真实买入股票，做空真实借券后卖出。新旧账户共用 {compact(margin.financeLimit)} 元借款额度、{compact(margin.shortLimit)} 元借券市值额度，券源有限。开仓、平仓均按实际成交结算，T+1、涨跌停和缺少对手盘可能让强平无法及时完成；亏损仍可能超过投入。</p><p>本局融资年费率 {money(market.annualInterestRate * 100, 1)}%，融券年费率 {money(market.credit.borrowAnnualRate * 100, 1)}%。杠杆账户信用债务与一亿元旧账分别记账。</p></details>
  </div>;
}
