import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowRight, Bank, Question, ShieldCheck } from '@phosphor-icons/react';
import type { MarketView, OrderSide } from '../shared/types';
import { compact, money, signed, sideNames } from './format';
import './credit-desk.css';

type CreditSide = Extract<OrderSide, 'finance' | 'short' | 'cover' | 'creditSell'>;
type Props = {
  market: MarketView;
  initialStockId?: string;
  disabled: boolean;
  onAction: (body: Record<string, unknown>, silent?: boolean) => Promise<boolean | undefined>;
  onGuide: () => void;
  onStock?: (stockId: string) => void;
  legacyOnly?: boolean;
};
const creditSides: CreditSide[] = ['finance', 'short', 'cover', 'creditSell'];
const modeNames: Record<CreditSide, string> = { finance: '借钱买股', short: '借股卖出', cover: '买回还券', creditSell: '卖出还钱' };
const liveOrder = (order: MarketView['orders'][number]) => order.status === 'open' || order.status === 'partial';
const riskName = (ratio: number | null) => ratio === null ? '暂无债务' : ratio < 145 ? '需要补担保' : ratio < 165 ? '接近追保线' : '安全';

export default function CreditDesk({ market, initialStockId, disabled, onAction, onGuide, onStock, legacyOnly = false }: Props) {
  const credit = market.credit;
  const [side, setSide] = useState<CreditSide>(legacyOnly ? credit.positions.length ? 'creditSell' : 'cover' : 'finance');
  const [stockId, setStockId] = useState(market.stocks.find(item => item.id === initialStockId && item.financeEligible)?.id ?? market.stocks.find(item => item.financeEligible)?.id ?? market.stocks[0]?.id ?? '');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('100');
  const [amount, setAmount] = useState('10000');
  const [priceEdited, setPriceEdited] = useState(false);
  const [repayAmount, setRepayAmount] = useState('');
  const [showRepay, setShowRepay] = useState(false);
  const [inputError, setInputError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferDirection, setTransferDirection] = useState<'in' | 'out'>('in');
  const [transferAsset, setTransferAsset] = useState('cash');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferError, setTransferError] = useState('');
  const [transferMessage, setTransferMessage] = useState('');
  const orderRef = useRef<HTMLElement>(null);
  const collateralRef = useRef<HTMLElement>(null);
  const stock = market.stocks.find(item => item.id === stockId) ?? market.stocks[0];
  const position = market.positions.find(item => item.stockId === stock?.id);
  const creditPosition = credit.positions.find(item => item.stockId === stock?.id);
  const pool = credit.pools.find(item => item.stockId === stock?.id);
  const activeOrders = market.orders.filter(order => liveOrder(order) && creditSides.includes(order.side as CreditSide));
  const reservedCover = activeOrders.filter(order => order.stockId === stock?.id && order.side === 'cover').reduce((sum, order) => sum + order.remaining, 0);
  const coverAvailable = Math.max(0, (position?.shortQuantity ?? 0) - (position?.shortToday ?? 0) - reservedCover);
  const returning = side === 'cover' || side === 'creditSell';
  const closed = ['lunch', 'night', 'ended'].includes(market.phase);
  const locked = !market.creditUnlocked && !returning;
  const eligibility = side === 'finance' ? stock?.financeEligible : side === 'short' ? stock?.shortEligible : side === 'cover' ? (position?.shortQuantity ?? 0) > 0 : (creditPosition?.quantity ?? 0) > 0;
  const numericPrice = Number(price);
  const priceCents = Math.round(numericPrice * 100);
  const orderQuantity = side === 'finance' ? priceCents > 0 ? Math.floor(Math.round(Number(amount) * 100) / priceCents / 100) * 100 : 0 : Number(quantity);
  const estimate = Math.max(0, numericPrice * orderQuantity || 0);
  const maximum = !stock || locked ? 0 : side === 'finance'
    ? stock.financeEligible && priceCents > 0 ? Math.floor(Math.round(credit.financeAvailable * 100) / priceCents / 100) * 100 : 0
    : side === 'short' ? pool?.playerMaxQuantity ?? 0 : side === 'cover' ? coverAvailable : creditPosition?.available ?? 0;
  const maxRepayment = Math.max(0, Math.min(credit.repayAvailable, credit.financingDebt + credit.interest));
  const ratio = credit.debt > 0 ? credit.maintenance : null;
  const projectedDebt = side === 'finance' ? credit.debt + estimate : side === 'short' ? credit.debt + orderQuantity * (stock?.price ?? 0) : side === 'cover' ? credit.debt - orderQuantity * (stock?.price ?? 0) : credit.debt - Math.min(estimate, credit.financingDebt + credit.interest);
  const projectedAssets = returning ? credit.accountAssets - (side === 'cover' ? estimate : Math.min(estimate, credit.financingDebt + credit.interest)) : credit.accountAssets + estimate;
  const projectedRatio = projectedDebt > 0 ? projectedAssets / projectedDebt * 100 : null;
  const dailyFee = !returning ? estimate * (side === 'finance' ? market.annualInterestRate : credit.borrowAnnualRate) / 365 : 0;
  const selectedStocks = market.stocks.filter(item => side === 'finance' ? item.financeEligible : side === 'short' ? item.shortEligible : side === 'cover' ? market.positions.some(pos => pos.stockId === item.id && pos.shortQuantity > 0) : credit.positions.some(pos => pos.stockId === item.id && pos.quantity > 0));
  const creditRows = market.stocks.filter(item => credit.positions.some(pos => pos.stockId === item.id && pos.quantity > 0) || market.positions.some(pos => pos.stockId === item.id && pos.shortQuantity > 0));
  const isCashTransfer = transferAsset === 'cash';
  const transferLocked = transferDirection === 'in' && !market.creditUnlocked && credit.debt <= 0;
  const transferOptions = transferDirection === 'in' ? credit.transferablePositions : credit.positions.filter(item => item.pledgedQuantity > 0).map(item => ({ ...item, quantity: item.pledgedQuantity, ratio: credit.collateralPositions.find(own => own.stockId === item.stockId)?.ratio ?? 0 }));
  const transferStock = transferOptions.find(item => item.stockId === transferAsset);
  const transferLimit = isCashTransfer ? transferDirection === 'in' ? credit.ordinaryCash : credit.withdrawableCash : transferDirection === 'in' ? transferStock?.quantity ?? 0 : credit.positions.find(item => item.stockId === transferAsset)?.withdrawableQuantity ?? 0;
  const transferValue = Math.max(0, Number(transferAmount) || 0) * (isCashTransfer ? 1 : market.stocks.find(item => item.id === transferAsset)?.price ?? 0);
  const transferCredit = transferValue * (isCashTransfer ? 1 : transferStock?.ratio ?? 0);
  const extraFinance = transferDirection === 'in' ? Math.min(Math.max(0, credit.financeLimit - credit.financeUsed - credit.financePending), Math.max(0, credit.collateralTotal - credit.collateralOccupied - credit.collateralPending + transferCredit) / credit.financeMarginRatio) : 0;

  useEffect(() => {
    if (stock) setPrice(stock.price.toFixed(2));
    setPriceEdited(false); setInputError(''); setSubmitted(false);
  }, [stock?.id]);
  useEffect(() => {
    if (stock && !priceEdited) setPrice(stock.price.toFixed(2));
  }, [stock?.price, priceEdited]);
  useEffect(() => { setSubmitted(false); setInputError(''); }, [side, quantity, amount]);
  useEffect(() => { setTransferError(''); setTransferMessage(''); }, [transferDirection, transferAsset, transferAmount]);

  const selectMode = (next: CreditSide, nextStock?: string) => {
    setSide(next);
    const eligible = market.stocks.filter(item => next === 'finance' ? item.financeEligible : next === 'short' ? item.shortEligible : next === 'cover' ? market.positions.some(pos => pos.stockId === item.id && pos.shortQuantity > 0) : credit.positions.some(pos => pos.stockId === item.id && pos.quantity > 0));
    if (nextStock) setStockId(nextStock);
    else if (!eligible.some(item => item.id === stock?.id) && eligible[0]) setStockId(eligible[0].id);
    setQuantity('100'); setPriceEdited(false);
    if (nextStock) requestAnimationFrame(() => orderRef.current?.scrollIntoView({ block: 'center', behavior: 'instant' }));
  };
  const openTransfer = (direction: 'in' | 'out' = 'in') => {
    setTransferOpen(true); setTransferDirection(direction); setTransferAsset('cash'); setTransferAmount('');
    requestAnimationFrame(() => collateralRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }));
  };
  const submitTransfer = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number(transferAmount);
    if (!Number.isFinite(value) || value <= 0 || (!isCashTransfer && (!Number.isInteger(value) || value % 100 !== 0))) return setTransferError(isCashTransfer ? '请输入要划转的金额。' : '请按 100 股的整数倍放入或取回。');
    if (value > transferLimit) return setTransferError('超过当前可划转数量，请调整后重试。');
    const ok = await onAction({ type: 'collateral', direction: transferDirection, ...(isCashTransfer ? { cash: value } : { stockId: transferAsset, quantity: value }) });
    if (ok) setTransferMessage(transferDirection === 'in' ? '担保已放入信用账户，尚未产生借款。' : '已取回普通账户。');
    else setTransferError('划转未完成，输入已保留；请查看提示后重试。');
  };
  const submitOrder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!Number.isInteger(orderQuantity) || orderQuantity <= 0 || orderQuantity % 100 !== 0) return setInputError(side === 'finance' ? '金额至少要够买 100 股，请增加买入金额。' : '数量须为 100 股的正整数倍。');
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) return setInputError('请输入有效的委托价格。');
    if (orderQuantity > maximum) return setInputError(side === 'finance' ? '超过可融资额度，请降低金额或放入更多担保。' : side === 'short' ? '超过当前可借数量，请降低数量或放入更多担保。' : '超过今日可归还数量，请检查 T+1 和待成交委托。');
    const ok = await onAction({ type: 'order', stockId: stock.id, side, quantity: orderQuantity, price: numericPrice });
    if (ok) setSubmitted(true);
    else setInputError('委托未提交，输入已保留，请查看提示后重试。');
  };

  if (!stock) return null;
  return <div className="credit-desk" aria-label="融资融券柜台">
    <header className="credit-heading" data-tour="credit"><div><h2>{legacyOnly ? '旧信用账户' : '证券信用柜台'}</h2><p>{legacyOnly ? '保留原来的持仓与债务，按旧约定归还。' : '先放担保，再借钱或借股票。'}</p></div>{!legacyOnly && <button type="button" className="credit-guide" onClick={onGuide} disabled={disabled}><Question size={18} />使用说明</button>}</header>
    {!market.creditUnlocked && <div className="credit-lock" role="status"><Bank size={23} /><div><strong>第 {market.creditUnlockDay} 个交易日开放借款</strong><p>还有 {Math.max(0, market.creditUnlockDay - market.day)} 个交易日。已有债务仍可归还。</p></div></div>}
    {credit.migrationNotice && <p className="credit-migration" role="status">{credit.migrationNotice}</p>}

    <section className={`credit-risk-panel ${credit.risk.level}`} data-tour="credit-risk" aria-label="信用账户风险">
      <div className="credit-risk-heading"><h3><ShieldCheck size={19} />{riskName(ratio)}</h3><span>{ratio === null ? '没有借款，不产生借款费用' : `维持担保比例 ${money(ratio)}%`}</span></div>
      <div className="credit-risk-track" aria-hidden="true"><span className="risk-zone safe" /><span className="risk-zone warning" /><span className="risk-zone call" /><span className="risk-zone forced" /><i style={{ left: `${ratio === null ? 3 : ratio >= 165 ? Math.max(3, 24 - (ratio - 165) / 5) : ratio >= 145 ? 26 + (165 - ratio) / 20 * 24 : 63}%` }} /></div>
      <div className="credit-risk-legend"><span>安全</span><span>预警 <small>165%</small></span><span>追保 <small>145%</small></span><span>强平</span></div>
      {ratio !== null && <p className="credit-risk-explanation">{credit.risk.level === 'normal' ? '担保股下跌、融资持仓下跌或融券股上涨，都会让安全余量减少。' : credit.risk.level === 'warning' ? '已经进入预警区。可补入担保或减少信用债务。' : '已触发追保：下一交易日未恢复至 150%，券商将提交强平委托。'}{credit.risk.marginCallDay !== null && credit.risk.level !== 'margin-call' && (ratio ?? 0) < credit.risk.restoreLine ? ' 追保仍未解除，需恢复至 150%。' : ''}</p>}
      {credit.debt > 0 && (credit.risk.topUpAmount > 0 || credit.risk.repayAmount > 0) && <div className="credit-rescue"><p>补入现金 <strong>{compact(credit.risk.topUpAmount)} 元</strong>{credit.risk.repayAmount > 0 && <>，或偿还债务 <strong>{compact(credit.risk.repayAmount)} 元</strong></>}，可恢复至 {credit.risk.targetLine}% 安全目标。</p><div><button type="button" onClick={() => openTransfer('in')} disabled={disabled || !!market.result}>补担保</button><button type="button" onClick={() => document.querySelector('[data-tour="credit-positions"]')?.scrollIntoView({ block: 'start', behavior: 'instant' })}>减仓还债</button></div></div>}
    </section>

    <section className="credit-collateral" data-tour="credit-collateral" ref={collateralRef}>
      <div className="credit-collateral-top"><div><span className="credit-eyebrow">我放入的担保</span><strong>{compact(credit.collateralTotal)}<small>元 · 折算后</small></strong><p>{credit.collateralTotal > 0 ? `现金 ${compact(credit.collateralCash)} 元 / 股票折算 ${compact(credit.collateralStockValue)} 元` : '普通账户的现金和股票，需由你主动放入。'}</p></div><div className="credit-collateral-actions"><button type="button" className={credit.collateralTotal === 0 ? 'primary-button' : 'credit-outline-button'} onClick={() => transferOpen && transferDirection === 'in' ? setTransferOpen(false) : openTransfer('in')} disabled={disabled || (!market.creditUnlocked && credit.debt <= 0) || !!market.result}>放入担保<ArrowRight size={17} /></button>{(credit.cashBalance > 0 || credit.positions.some(item => item.pledgedQuantity > 0)) && <button type="button" className="credit-text-button" onClick={() => openTransfer('out')} disabled={disabled || !!market.result}>取回担保</button>}</div></div>
      <dl className="credit-capacities"><div><dt>还能借钱买股</dt><dd>{compact(credit.financeAvailable)}<small>元</small></dd></div><div><dt>还能借股卖出</dt><dd>{compact(credit.shortAvailableAmount)}<small>元市值</small></dd></div><div><dt>担保已用 / 预占</dt><dd>{compact(credit.collateralOccupied)} / {compact(credit.collateralPending)}<small>元</small></dd></div></dl>
      {transferOpen && <form className="credit-transfer" onSubmit={submitTransfer} aria-label={transferDirection === 'in' ? '放入担保' : '取回担保'}>
        <div className="credit-section-title"><h3>{transferDirection === 'in' ? '从普通账户放入' : '取回普通账户'}</h3><button type="button" className="credit-text-button" onClick={() => setTransferOpen(false)}>收起</button></div>
        <div className="credit-transfer-fields"><label>选择资产<select aria-label="担保资产" value={transferAsset} onChange={event => { setTransferAsset(event.target.value); setTransferAmount(''); }} disabled={disabled || !!market.result}><option value="cash">现金</option>{transferOptions.map(item => <option key={item.stockId} value={item.stockId}>{market.stocks.find(entry => entry.id === item.stockId)?.name} · {money(item.quantity, 0)} 股</option>)}</select></label><label>{isCashTransfer ? '划转金额' : '划转数量'}<span>{isCashTransfer ? '元' : '股'}</span><input aria-label="担保划转数量" type="number" min={isCashTransfer ? '0.01' : '100'} step={isCashTransfer ? '0.01' : '100'} value={transferAmount} onChange={event => setTransferAmount(event.target.value)} required disabled={disabled || !!market.result} placeholder={isCashTransfer ? '输入金额' : '输入股数'} /></label></div>
        <div className="credit-available-line"><span>最多可{transferDirection === 'in' ? '放入' : '取回'} {money(transferLimit, isCashTransfer ? 2 : 0)} {isCashTransfer ? '元' : '股'}</span><button type="button" className="credit-text-button" onClick={() => setTransferAmount(String(isCashTransfer ? transferLimit : Math.floor(transferLimit / 100) * 100))} disabled={disabled || transferLimit <= 0 || !!market.result}>填入全部</button></div>
        {transferDirection === 'in' ? <><dl className="credit-transfer-preview"><div><dt>{isCashTransfer ? '放入现金' : '股票市值'}</dt><dd>{compact(transferValue)} 元</dd></div><div><dt>折算比例</dt><dd>{money((isCashTransfer ? 1 : transferStock?.ratio ?? 0) * 100, 0)}%</dd></div><div><dt>增加保证金</dt><dd>{compact(transferCredit)} 元</dd></div><div><dt>放入后可融资上限</dt><dd>{compact(market.creditUnlocked && (credit.debt <= 0 || (credit.accountAssets + transferValue) / credit.debt >= 1.5) ? extraFinance : 0)} 元</dd></div></dl><p className="credit-caption">额度按本局授信与担保估算。放入不借款、不计息；股票仍属于你。股票按 100 股划转，今天买入的股票下个交易日才能放入。</p></> : <p className="credit-caption">只取回自有资产。需为债务和挂单留下足够担保，并保持安全比例；融资买入的股票不能直接取回。</p>}
        {transferError && <p className="credit-input-error" role="alert">{transferError}</p>}{transferMessage && <p className="credit-submitted" role="status">{transferMessage}</p>}
        <button type="submit" className="credit-outline-button credit-transfer-submit" disabled={disabled || transferLocked || !(Number(transferAmount) > 0) || Number(transferAmount) > transferLimit || !!market.result}>{disabled ? '正在划转…' : transferLocked ? `第 ${market.creditUnlockDay} 日开放` : transferDirection === 'in' ? '确认放入担保' : '确认取回担保'}<ArrowRight size={17} /></button>
      </form>}
    </section>

    {(!legacyOnly || eligibility) && <section className="credit-order" data-tour="credit-order" ref={orderRef}>
      {!legacyOnly && <div className="credit-primary-modes" role="group" aria-label="信用交易方向" style={{ '--credit-tab': side === 'short' || side === 'cover' ? 1 : 0 } as CSSProperties}><span className="credit-mode-indicator" aria-hidden="true" /><button type="button" aria-pressed={side === 'finance' || side === 'creditSell'} onClick={() => selectMode('finance')}><strong>借钱买股 <small>融资</small></strong><span>借的是钱，卖出后还钱</span></button><button type="button" aria-pressed={side === 'short' || side === 'cover'} onClick={() => selectMode('short')}><strong>借股卖出 <small>融券</small></strong><span>借的是股票，买回来还券</span></button></div>}
      {returning && <div className="credit-return-mode"><strong>{modeNames[side]}</strong>{!legacyOnly && <button type="button" className="credit-text-button" onClick={() => selectMode(side === 'cover' ? 'short' : 'finance')}>返回开仓</button>}</div>}
      <form onSubmit={submitOrder} className="credit-order-layout credit-order-form"><div className="credit-order-main">
        <label className="credit-stock-select">{side === 'short' ? '选择有券的股票' : returning ? '选择要归还的仓位' : '选择融资股票'}<select aria-label="信用交易股票" value={selectedStocks.some(item => item.id === stock.id) ? stock.id : ''} onChange={event => setStockId(event.target.value)} disabled={disabled || selectedStocks.length === 0 || !!market.result}>{!selectedStocks.some(item => item.id === stock.id) && <option value="">请选择股票</option>}{selectedStocks.map(item => <option key={item.id} value={item.id}>{item.name}{side === 'short' ? ` · 余券 ${money(credit.pools.find(entry => entry.stockId === item.id)?.available ?? 0, 0)} 股` : ` · ${item.sector}`}</option>)}</select></label>
        <div className="credit-selected-heading"><div><strong>{stock.name}</strong>{onStock && <button type="button" className="credit-text-button" onClick={() => onStock(stock.id)}>看行情 →</button>}</div><span className={stock.changePercent >= 0 ? 'up' : 'down'}>{money(stock.price)} <small>{signed(stock.changePercent)}%</small></span></div>
        <p className="credit-mode-description">{side === 'finance' ? '成交后才借款计息。买入股票留在信用账户，卖出所得优先还债。' : side === 'short' ? '先卖出借来的股票，之后买回归还。股价上涨会亏损；卖出款受限，不能拿去买股。' : side === 'cover' ? '买回同一只股票交还券商。今天新借的券，下个交易日才能归还。' : '卖出信用账户的股票，成交所得优先偿还融资本金和费用，余款留在信用账户。'}</p>
        <div className="credit-order-inputs"><label>{side === 'finance' ? '想买多少金额' : side === 'short' ? '想借多少股' : side === 'cover' ? '买回股数' : '卖出股数'}<span>{side === 'finance' ? '元' : '股'}</span><input aria-label={side === 'finance' ? '融资买入金额' : '信用委托数量'} type="number" min={side === 'finance' ? '0.01' : '100'} step={side === 'finance' ? '0.01' : '100'} required value={side === 'finance' ? amount : quantity} onChange={event => side === 'finance' ? setAmount(event.target.value) : setQuantity(event.target.value)} disabled={!eligibility || locked || !!market.result} /></label>
          <div className="credit-available-line"><span>{side === 'finance' ? `按 100 股取整，本单 ${money(orderQuantity, 0)} 股` : `${returning ? '今日可还' : '你最多可借'} ${money(maximum, 0)} 股`}</span><button type="button" className="credit-text-button" onClick={() => side === 'finance' ? setAmount((maximum * numericPrice).toFixed(2)) : setQuantity(String(maximum))} disabled={disabled || maximum < 100 || !!market.result}>填入上限</button></div>
          <details className="credit-price-details"><summary>委托价 {money(numericPrice || 0)} 元{priceEdited ? ' · 已自定' : ' · 跟随现价'}，点击修改</summary><label>限价<span>元</span><input aria-label="信用委托价格" type="number" min={side === 'short' ? stock.price : stock.limitDown} max={stock.limitUp} step="0.01" required value={price} onChange={event => { setPrice(event.target.value); setPriceEdited(true); setInputError(''); setSubmitted(false); }} disabled={!eligibility || locked || !!market.result} /></label><button type="button" className="credit-text-button" onClick={() => { setPrice(stock.price.toFixed(2)); setPriceEdited(false); }}>恢复跟随现价</button></details>

        </div>
      </div><aside className="credit-ticket" aria-label="本次交易预览" data-tour="credit-sources"><span className="credit-eyebrow">本次委托</span><strong>{compact(estimate)}<small>元</small></strong><dl><div><dt>{side === 'finance' ? '借款本金' : side === 'short' ? '借入股票' : side === 'cover' ? '归还股票' : '卖出股票'}</dt><dd>{side === 'finance' ? `${compact(estimate)} 元` : `${money(orderQuantity || 0, 0)} 股`}</dd></div>{!returning && <div><dt>预计每日费用</dt><dd>{money(dailyFee)} 元</dd></div>}{side === 'short' && <><div><dt>券商剩余券源</dt><dd>{money(pool?.available ?? 0, 0)} 股</dd></div><div><dt>你的可借上限</dt><dd>{money(maximum, 0)} 股</dd></div></>}{side === 'cover' && <div><dt>受限卖出款</dt><dd>{compact(position?.shortProceeds ?? 0)} 元</dd></div>}<div><dt>成交后担保比例</dt><dd>{projectedRatio === null ? '暂无债务' : `${money(projectedRatio)}%`}</dd></div></dl><p className="credit-ticket-risk">预计状态：{riskName(projectedRatio)}</p><p className="credit-caption">按委托全额成交测算。成交价格、费用和后续行情，会改变实际风险。</p>{side === 'short' && <p className="credit-caption">只列出券商有券源的股票。券源、个人额度与担保，都会限制可借数量。</p>}</aside><div className="credit-order-actions">          {!eligibility && <p className="credit-unavailable">{side === 'finance' ? '请选择可融资的股票。' : side === 'short' ? '券商没有这只股票的券源。' : '没有可归还的信用仓位。'}</p>}
          {!returning && credit.collateralTotal === 0 && <p className="credit-unavailable">先放入担保，才有借款额度。<button type="button" className="credit-text-button" onClick={() => openTransfer('in')} disabled={disabled || (!market.creditUnlocked && credit.debt <= 0) || !!market.result}>放入担保 →</button></p>}
          {inputError && <p className="credit-input-error" role="alert">{inputError}</p>}
          <button type="submit" className="primary-button credit-submit" disabled={disabled || market.paused || closed || locked || !eligibility || maximum < 100 || !!market.result}>{disabled ? '请稍候…' : market.result ? '本局已结束' : locked ? `第 ${market.creditUnlockDay} 日开放` : !eligibility ? '当前股票不可操作' : maximum < 100 ? returning ? '暂无可还数量' : '可用额度不足' : market.paused ? '先开始行情' : closed ? '休市中' : `确认${modeNames[side]}`}<ArrowRight size={17} /></button>
          {submitted && <p className="credit-submitted" role="status">委托已提交，等待真实撮合。未成交部分可在下方撤单。</p>}</div></form>
    </section>}

    <section className="credit-positions" data-tour="credit-positions"><div className="credit-section-title"><h3>我的信用仓位</h3><span>融资欠款 {compact(credit.financingDebt)} 元</span></div>
      {creditRows.length === 0 ? <p className="credit-empty">尚无信用仓位。放入担保后，再决定是否借款交易。</p> : <div className="credit-position-list">{creditRows.map(item => { const own = credit.positions.find(entry => entry.stockId === item.id), short = market.positions.find(entry => entry.stockId === item.id); return <div className="credit-position-row" key={item.id}><div><strong>{item.name}</strong>{(own?.quantity ?? 0) > 0 && <p>信用持仓 {money(own!.quantity, 0)} 股 · 其中融资买入 {money(own!.financedQuantity, 0)} 股<br /><span>今日可卖 {money(own!.available, 0)} 股</span></p>}{(short?.shortQuantity ?? 0) > 0 && <p>待还券 {money(short!.shortQuantity, 0)} 股<br /><span>今日新借 {money(short!.shortToday, 0)} 股</span></p>}</div><div className="credit-position-actions">{(own?.quantity ?? 0) > 0 && <button type="button" className="credit-outline-button" onClick={() => selectMode('creditSell', item.id)} disabled={disabled || !!market.result}>卖出还钱</button>}{(short?.shortQuantity ?? 0) > 0 && <button type="button" className="credit-outline-button" onClick={() => selectMode('cover', item.id)} disabled={disabled || !!market.result}>买回还券</button>}</div></div>; })}</div>}
      <div className="credit-debt-summary"><span>应付费用 {money(credit.interest)} 元 · 预计每日 {money(credit.dailyInterest)} 元</span><button type="button" className="credit-text-button" onClick={() => setShowRepay(!showRepay)} aria-expanded={showRepay}>用现金还款 {showRepay ? '−' : '+'}</button></div>
      {showRepay && <form className="credit-cash-repay" onSubmit={async event => { event.preventDefault(); await onAction({ type: 'repay', amount: Number(repayAmount) }); }}><label>偿还金额<span>元</span><input aria-label="信用还款金额" type="number" min="0.01" step="0.01" max={maxRepayment} required value={repayAmount} onChange={event => setRepayAmount(event.target.value)} disabled={disabled || maxRepayment <= 0 || !!market.result} /></label><button type="button" className="credit-text-button" onClick={() => setRepayAmount(maxRepayment.toFixed(2))} disabled={disabled || maxRepayment <= 0 || !!market.result}>填入可偿还金额 {compact(maxRepayment)} 元</button><button type="submit" className="credit-outline-button" disabled={disabled || !(Number(repayAmount) > 0) || Number(repayAmount) > maxRepayment || !!market.result}>确认现金还款<ArrowRight size={17} /></button><p className="credit-caption">使用信用账户现金偿还本金与费用。余额不足时先放入现金；融券需买回还券。</p><button type="button" className="credit-text-button" onClick={() => openTransfer('in')} disabled={disabled || !!market.result}>放入现金 →</button></form>}
    </section>

    {activeOrders.length > 0 && <section className="credit-pending"><div className="credit-section-title"><h3>待成交委托</h3><span>{activeOrders.length} 笔</span></div>{activeOrders.map(order => <div className="credit-pending-row" key={order.id}><span><strong>{market.stocks.find(item => item.id === order.stockId)?.name} · {modeNames[order.side as CreditSide] ?? sideNames[order.side]}</strong><small>限价 {money(order.price)} · 待成交 {money(order.remaining, 0)} 股</small></span><button type="button" className="credit-outline-button" disabled={disabled || !!market.result} onClick={() => void onAction({ type: 'cancel', orderId: order.id })}>撤单</button></div>)}</section>}
    <details className="credit-contract"><summary>担保明细与本局信用约定</summary><dl className="credit-contract-facts"><div><dt>普通账户可用现金</dt><dd>{compact(credit.ordinaryCash)} 元</dd></div><div><dt>信用账户现金 / 可取回</dt><dd>{compact(credit.cashBalance)} / {compact(credit.withdrawableCash)} 元</dd></div><div><dt>信用账户资产 / 信用债务</dt><dd>{compact(credit.accountAssets)} / {compact(credit.debt)} 元</dd></div></dl>{credit.collateralPositions.map(item => <p key={item.stockId}>{market.stocks.find(entry => entry.id === item.stockId)?.name}：担保 {money(item.quantity, 0)} 股，市值 {compact(item.marketValue)} 元，按 {money(item.ratio * 100, 0)}% 折算为 {compact(item.collateralValue)} 元。</p>)}<p>你主动放入的现金和自有股票作为担保。融资买入的股票、融券卖出款不能重复用于新增借款；股票下跌，担保价值也会减少。</p><p>本局融资授信 {compact(credit.financeLimit)} 元，融券市值额度 {compact(credit.shortLimit)} 元，共用担保。保证金比例分别为 {money(credit.financeMarginRatio * 100, 0)}% 和 {money(credit.shortMarginRatio * 100, 0)}%；融资年费率 {money(market.annualInterestRate * 100, 1)}%，融券年费率 {money(credit.borrowAnnualRate * 100, 1)}%。</p><p>现金按 100% 折算，普通自有股票按 60%；新股上市前 5 个交易日不计担保，此后按 50%。这是本局券商约定。</p><p>维持担保比例 = 信用账户资产 ÷ 信用债务。低于 165% 预警，低于 145% 追保，下一交易日未恢复到 150% 会提交强平。涨跌停或缺少对手盘时，强平未必及时成交。普通账户资产与一亿元旧账，不纳入这条风险线。</p></details>
  </div>;
}
