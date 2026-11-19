import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Receipt } from '@phosphor-icons/react';
import type { MarketView } from '../shared/types';
import { openingSellTicket } from './opening-guide';
import { api } from './api';
import Story from './Story';
import BrandLogo from './BrandLogo';
import GameIcon from './GameIcon';
import GameDayDial from './GameDayDial';
import PriceChart from './PriceChart';
import PostCloseReview from './PostCloseReview';
import PositionSlip from './PositionSlip';
import ChipStructure from './ChipStructure';
import './chip-structure.css';
import { OrderProgress, OrderCancellation, OrderPriceGuide, RecentStockOrders } from './OrderFeedback';
import './order-feedback.css';
import HowToPlay from './HowToPlay';
import GuidedTour from './GuidedTour';
import OpeningTutorial from './OpeningTutorial';
import OperatorDesk, { OperatorSeat } from './OperatorDesk';
import { NewsImpacts, NewsStage } from './TelegramFeed';
import TradeShortcuts from './TradeShortcuts';
import './challenge.css';
import Modal from './Modal';
import Feedback from './Feedback';
import TimeConsole from './TimeConsole';
import LimitBoardStatus from './LimitBoardStatus';
import IpoDesk from './IpoDesk';
import CreditDesk from './CreditDesk';
import LeverageDesk from './LeverageDesk';
import EndingScreen from './EndingScreen';
import './credit-integration.css';
import { compact, money, signed, sideNames } from './format';

type Page = 'market' | 'portfolio' | 'news' | 'board' | 'ledger' | 'credit' | 'legacyCredit';
const navItems = [
  { id: 'market', label: '交易室', icon: 'trading' }, { id: 'news', label: '电讯', icon: 'news' },
  { id: 'portfolio', label: '持仓', icon: 'holdings' }, { id: 'credit', label: '杠杆交易', icon: 'leverage' }, { id: 'board', label: '龙虎榜', icon: 'board' }, { id: 'ledger', label: '账本', icon: 'ledger' },
] as const;
const statusNames = { open: '待成交', filled: '已成交', cancelled: '已撤销', partial: '部分成交' };
const INTRO_KEY = 'bairi-tour-v6';
const CREDIT_KEY = 'bairi-credit-v16';
const OPENING_GUIDE_KEY = 'bairi-opening-guide-v2';

export default function App() {
  const [market, setMarket] = useState<MarketView | null>(null);
  const [mode, setMode] = useState<'loading' | 'story' | 'market'>('loading');
  const [page, setPage] = useState<Page>('market');
  const [stockId, setStockId] = useState('');
  const [sector, setSector] = useState('全部');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('100');
  const [pending, setPending] = useState(false);
  const commandLock = useRef(false);
  const ticketPreset = useRef<{ stockId: string; side: 'buy' | 'sell'; price: number; quantity: number } | null>(null);
  const marketEpoch = useRef(0);
  const guideEnterOnDismiss = useRef(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [connection, setConnection] = useState(false);
  const [modal, setModal] = useState<'guide' | 'help' | 'repay' | 'challenge' | 'new' | null>(null);
  const [openingGuide, setOpeningGuide] = useState(() => {
    try { return localStorage.getItem(OPENING_GUIDE_KEY) !== 'hidden'; } catch { return true; }
  });
  const [repayAmount, setRepayAmount] = useState('');
  const [tour, setTour] = useState<'beginner' | 'credit' | null>(null);
  const [endingDismissed, setEndingDismissed] = useState(false);
  const creditIntroRequested = useRef(false);
  const introChecked = useRef(false);
  const reviewedDay = useRef<number | null>(null);
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const accept = useCallback((next: MarketView | null, epoch = marketEpoch.current) => {
    if (epoch !== marketEpoch.current) return;
    if (next) setMarket(prev => !prev || next.revision >= prev.revision ? next : prev);
  }, []);

  useEffect(() => {
    const keyboard = () => { document.documentElement.dataset.input = 'keyboard'; };
    const pointer = () => { document.documentElement.dataset.input = 'pointer'; };
    document.documentElement.dataset.input = 'pointer';
    window.addEventListener('keydown', keyboard, true);
    window.addEventListener('pointerdown', pointer, true);
    return () => { window.removeEventListener('keydown', keyboard, true); window.removeEventListener('pointerdown', pointer, true); };
  }, []);
  useEffect(() => {
    api('session').then(({ market: saved }) => {
      setMarket(saved);
      if (saved?.openingScenario?.version === 2 && saved.day <= 2) setStockId(saved.openingScenario.stockId);
      const state = new URLSearchParams(location.search).get('state');
      let remembered = false;
      try { remembered = localStorage.getItem('bairi-screen') === 'market'; } catch { /* optional preference */ }
      setMode(saved && state !== 'cover' && state !== 'story' && (remembered || state === 'market') ? 'market' : 'story');
    }).catch(() => { setMode('story'); setConnection(true); });
  }, []);
  useEffect(() => {
    if (mode !== 'market') return;
    let active = true, polling = false;
    const poll = async () => {
      if (polling || commandLock.current) return;
      polling = true;
      const epoch = marketEpoch.current;
      try { const response = await api('market'); if (active && epoch === marketEpoch.current) { accept(response.market, epoch); setConnection(false); } }
      catch { if (active && epoch === marketEpoch.current) setConnection(true); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(poll, 1200);
    return () => { active = false; clearInterval(timer); };
  }, [mode, accept]);
  useEffect(() => { window.scrollTo(0, 0); document.querySelector('.game-shell')?.scrollTo(0, 0); }, [page, mode]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(null), 6000); return () => clearTimeout(timer); } }, [toast]);
  const stock = market?.stocks.find(s => s.id === stockId) ?? market?.stocks[0];
  useEffect(() => {
    if (!stock) return;
    const preset = ticketPreset.current;
    if (preset?.stockId === stock.id) {
      setPrice(preset.price.toFixed(2)); setQuantity(String(preset.quantity)); setSide(preset.side);
    } else setPrice(stock.price.toFixed(2));
    ticketPreset.current = null;
  }, [stock?.id]);

  const action = useCallback(async (body: Record<string, unknown>, silent = false) => {
    if (commandLock.current) return;
    commandLock.current = true;
    setPending(true);
    try {
      const response = await api('action', { ...body, requestId: crypto.randomUUID() });
      accept(response.market);
      setConnection(false);
      if (!silent || response.ok === false) notify(response.message || '操作已保存', response.ok === false);
      if (response.ok !== false && ['repay', 'repayChallenge'].includes(String(body.type))) setModal(null);
      if (body.type === 'advance' && response.market?.phase === 'night') setPage('board');
      if (body.type === 'nextDay') setPage('market');
      return response.ok !== false;
    } catch (error) { notify((error as Error).message, true); return false; }
    finally { commandLock.current = false; setPending(false); }
  }, [accept, notify]);
  const openTour = useCallback(async (kind: 'beginner' | 'credit') => {
    if (!market || pending || connection) return false;
    if (!market.paused && !await action({ type: 'pause', paused: true }, true)) return false;
    setModal(null); setPage(kind === 'credit' ? 'credit' : 'market');
    setTour(kind);
    return true;
  }, [market, pending, connection, action]);
  useEffect(() => {
    if (mode !== 'market' || !market || market.result || pending || connection || introChecked.current) return;
    introChecked.current = true;
    let seen = false;
    try { seen = localStorage.getItem(INTRO_KEY) === 'seen'; } catch { /* optional preference */ }
    // The first-day guide is separate from this optional interface tour.
    if (!seen) { try { localStorage.setItem(INTRO_KEY, 'seen'); } catch { /* optional preference */ } }
  }, [mode, market, pending, connection]);
  useEffect(() => {
    if (mode !== 'market' || !market?.creditUnlocked || market.result || pending || connection || tour || modal || creditIntroRequested.current || !introChecked.current) return;
    let beginnerSeen = false, creditSeen = false;
    try { beginnerSeen = localStorage.getItem(INTRO_KEY) === 'seen'; creditSeen = localStorage.getItem(CREDIT_KEY) === 'seen'; } catch { beginnerSeen = true; }
    if (!beginnerSeen || creditSeen) return;
    creditIntroRequested.current = true;
    void openTour('credit').then(opened => { if (!opened) creditIntroRequested.current = false; });
  }, [mode, market, pending, connection, tour, modal, openTour]);
  const closeTour = () => {
    try { localStorage.setItem(tour === 'credit' ? CREDIT_KEY : INTRO_KEY, 'seen'); } catch { /* optional preference */ }
    if (tour === 'credit') creditIntroRequested.current = true;
    setTour(null);
  };

  useEffect(() => {
    if (!market?.result) return;
    setTour(null); setModal(null); setEndingDismissed(false);
  }, [market?.result]);

  useEffect(() => {
    if (mode === 'market' && market?.phase === 'night' && reviewedDay.current !== market.day) {
      reviewedDay.current = market.day; setPage('board');
    }
  }, [mode, market?.phase, market?.day]);

  const enter = (next?: MarketView) => {
    if (next) setMarket(next);
    setMode('market'); setPage('market'); setModal(null);
    try { localStorage.setItem('bairi-screen', 'market'); } catch { /* optional preference */ }
  };
  const start = async () => {
    if (commandLock.current) return;
    commandLock.current = true; marketEpoch.current += 1; setPending(true);
    try {
      const response = await api('start', {});
      if (response.market) {
        const next = response.market;
        ticketPreset.current = null;
        introChecked.current = true; creditIntroRequested.current = false; setTour(null); setEndingDismissed(false);
        setOpeningGuide(true);
        try { localStorage.removeItem(CREDIT_KEY); localStorage.removeItem(OPENING_GUIDE_KEY); localStorage.setItem(INTRO_KEY, 'seen'); } catch { /* optional preference */ }
        reviewedDay.current = null; setStockId(next.openingScenario?.stockId ?? ''); setSector('全部'); setSide('buy');
        setQuantity('100'); setPrice(next.stocks[0].price.toFixed(2));
        enter(next); setConnection(false);
        notify(next.openingScenario ? '第一天买入，第二天卖出。跟着框选位置操作，也可随时跳过。' : '你已坐上游资席位，准备开始交易。');
      }
      else notify(response.message || '开局未完成，请重试。', true);
    } catch (error) { notify((error as Error).message, true); }
    finally { commandLock.current = false; setPending(false); }
  };
  const beginStart = start;
  const showOpeningGuide = () => {
    if (market?.openingScenario?.version !== 2 || market.day > 2) { setModal('guide'); return; }
    setModal(null); setTour(null); setOpeningGuide(true); setPage('market');
    setSector('全部'); setStockId(market.openingScenario.stockId);
    if (market.day === 1) setSide('buy');
    try { localStorage.removeItem(OPENING_GUIDE_KEY); } catch { /* optional preference */ }
  };
  const hideOpeningGuide = () => {
    setOpeningGuide(false);
    try { localStorage.setItem(OPENING_GUIDE_KEY, 'hidden'); } catch { /* optional preference */ }
    notify('已关闭引导。行情、资金与持仓保持不变，可继续自由交易。');
  };
  const selectStock = (id: string) => {
    const selected = market?.stocks.find(s => s.id === id);
    if (!selected) return;
    setStockId(id); setPrice(selected.price.toFixed(2)); setPage('market');
    if (openingGuide && market?.day === 1 && market.openingScenario?.version === 2) setSide('buy');
  };
  const selectSector = (value: string) => {
    setSector(value); setPage('market');
    const first = market?.stocks.find(s => value === '全部' || s.sector === value);
    if (first) setStockId(first.id);
  };
  const closeGuide = () => {
    setModal(null);
    if (guideEnterOnDismiss.current && mode === 'story') {
      guideEnterOnDismiss.current = false;
      if (market) enter(); else void beginStart();
    }
  };
  const showGuide = () => {
    guideEnterOnDismiss.current = false;
    if (mode === 'market' && market) setModal('help');
    else setModal('guide');
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = Number(quantity), p = Number(price);
    if (!Number.isInteger(q) || q <= 0 || q % 100 !== 0) return notify('委托数量须为 100 股的正整数倍。', true);
    if (!Number.isFinite(p) || p <= 0) return notify('请输入有效的委托价格。', true);
    void action({ type: 'order', stockId: stock?.id, side, quantity: q, price: p });
  };
  const backToStory = async () => {
    if (commandLock.current) return;
    if (market && !market.paused) {
      const paused = await action({ type: 'pause', paused: true }, true);
      if (!paused) return;
    }
    setMode('story'); try { localStorage.setItem('bairi-screen', 'story'); } catch { /* optional */ }
  };
  const feedback = <Feedback toast={toast} onClose={() => setToast(null)} />;
  const guide = modal === 'guide' && <Modal title="怎么玩" close={closeGuide}>{dismiss => <HowToPlay legacy={!!market && !market.challenge} onClose={dismiss} onStart={() => {
    guideEnterOnDismiss.current = true; dismiss();
  }} />}</Modal>;

  if (mode === 'loading') return <div className="loading-screen"><BrandLogo /><p>正在打开交易室…</p></div>;
  if (mode === 'story' || !market || !stock) return <>
    <Story account={market ?? undefined} onStart={async () => { if (market) enter(); else await beginStart(); }} onResume={() => enter()} onHelp={showGuide} hasSave={!!market} />
    {pending && <div className="starting-overlay" role="status">正在准备你的市场…</div>}
    {connection && <div className="story-connection">交易室暂时未连接，请稍后重试。</div>}{guide}{feedback}
  </>;

  const position = market.positions.find(p => p.stockId === stock.id);
  const opening = market.day <= 2 && market.openingScenario?.version === 2 ? market.openingScenario : undefined;
  const sellTicket = openingSellTicket(stock, position?.available ?? 0);
  const guideVisible = !!opening && stock.id === opening.stockId && openingGuide && page === 'market' && !tour && !modal && !market.result;
  const sectors = ['全部', ...new Set(market.stocks.map(s => s.sector))];
  const visibleStocks = market.stocks.filter(s => sector === '全部' || s.sector === sector);
  const selectedOrders = market.orders.filter(o => o.stockId === stock.id);
  const activeOrders = market.orders.filter(o => o.status === 'open' || o.status === 'partial');
  const isClosed = ['night', 'ended', 'lunch'].includes(market.phase);
  const selling = side === 'sell';
  const seriousRisk = !['normal', 'warning', 'repaid'].includes(market.riskLevel);
  const riskyMarginAccounts = market.margin.accounts.filter(a => a.riskLevel !== 'normal');
  const showRepay = () => { setRepayAmount(''); setModal('repay'); };
  const showChallengeRepay = () => { setRepayAmount(''); setModal('challenge'); };
  const startingCapital = market.challenge?.startingCapital ?? 6000000;
  const earned = market.equity + (market.challenge?.paid ?? 0) - startingCapital;
  const creditOutstanding = market.debt > 0 || activeOrders.some(o => ['finance', 'short', 'marginShort'].includes(o.side) || (o.side === 'marginBuy' && (market.margin.positions.find(p => p.id === o.marginPositionId)?.leverage ?? 2) > 1));
  const hasLegacyCredit = market.credit.debt > 0 || market.credit.cashBalance > 0 || market.credit.positions.length > 0 || activeOrders.some(o => ['finance', 'short', 'cover', 'creditSell'].includes(o.side));
  const orders = (all = false) => <div className="table-scroll"><table><thead><tr><th>股票 / 方向</th><th>委托价</th><th>成交进度</th><th>状态</th><th /></tr></thead><tbody>
    {(all ? market.orders : activeOrders).slice(0, 15).map(o => <tr key={o.id}>
      <td>{market.stocks.find(s => s.id === o.stockId)?.name}<small>{sideNames[o.side]} · {o.day ? `第 ${o.day} 日 · ` : ''}{o.time}</small></td><td>{money(o.price)}</td>
      <td><OrderProgress order={o} /></td><td>{statusNames[o.status]}<OrderCancellation order={o} /></td>
      <td>{(o.status === 'open' || o.status === 'partial') && <button className="text-button" disabled={pending || connection} onClick={() => void action({ type: 'cancel', orderId: o.id })}>撤单</button>}</td>
    </tr>)}</tbody></table>{!(all ? market.orders : activeOrders).length && <p className="empty-state">暂无{all ? '委托记录' : '待成交委托'}</p>}</div>;

  return <div className="game-shell" data-page={page}>
    <div className="room-backdrop" aria-hidden="true" />
    <header className="app-header">
      <button className="wordmark" disabled={pending} onClick={() => void backToStory()} aria-label="百日回归，返回序章"><BrandLogo decorative /></button>
      <section className="account-line" aria-label="账户总览" data-tour="account">
        <div><GameIcon name="assets" /><div><span>{market.challenge ? '交易净资产' : '净资产'}</span><strong>{compact(market.equity)}</strong></div><small className={earned >= 0 ? 'up' : 'down'} title="累计交易收益，含已支付目标款">{signed(earned / startingCapital * 100)}%</small></div>
        <div><GameIcon name="cash" /><div><span>可用现金</span><strong>{compact(market.availableCash)}</strong></div></div>
        <button className="debt-resource" data-tour="contract" onClick={() => market.challenge ? setPage('ledger') : showRepay()} aria-label={market.challenge ? `待还目标 ${compact(market.challenge.remaining)}，查看清偿账本` : `待还负债 ${compact(market.debt)}，偿还融资`}><GameIcon name="debt" /><div><span>{market.challenge ? '待还目标' : '待还负债'} <ArrowRight size={11} /></span><strong>{compact(market.challenge?.remaining ?? market.debt)}</strong></div></button>
      </section>
      <GameDayDial day={market.day} />
    </header>
    <nav className="game-nav" aria-label="游戏导航">{navItems.map(item => <button key={item.id} aria-current={page === item.id || (page === 'legacyCredit' && item.id === 'credit') ? 'page' : undefined} data-tour={item.id === 'news' ? 'news' : undefined} onClick={() => setPage(item.id)}><GameIcon name={item.icon} /><span>{item.label}</span></button>)}<button className="help-button" onClick={showGuide}><GameIcon name="guide" /><span>玩法</span></button></nav>
    <main className="workspace">
      {connection && <div className="notice danger" role="alert">连接中断，正在重连。恢复后会读取服务器进度，请勿重复提交。<button className="text-button" disabled={pending} onClick={() => void action({ type: 'pause', paused: true }, true)}>重试连接</button></div>}
      <section className="room-heading" aria-label="游戏进度">
        <div><h1>{page === 'market' ? '交易室' : page === 'legacyCredit' ? '旧信用账户' : navItems.find(item => item.id === page)?.label}<span>{market.calendarDate.replaceAll('-', '.')}</span></h1></div>
        <button className="contract-countdown" onClick={() => setPage('ledger')}><GameIcon name="deadline" /><span>距还款日</span><strong>{market.daysLeft}</strong><span>天 <ArrowRight size={13} /></span></button>
      </section>
      {!market.challenge && <p className="legacy-contract-note">当前沿用旧合同存档。<button onClick={() => setModal('new')}>重新开局</button>体验 1,000 万起步、一亿目标的新挑战。</p>}
      {seriousRisk && <div className="notice danger" role="alert">{market.riskMessage}{!market.result && page !== 'credit' && riskyMarginAccounts.length > 0 && <button className="text-button" onClick={() => setPage('credit')}>查看并补保证金 →</button>}</div>}
      {!seriousRisk && !market.result && page !== 'credit' && riskyMarginAccounts.length > 0 && <div className="notice danger" role="alert">{riskyMarginAccounts.length} 个杠杆账户已进入风险区。<button className="text-button" onClick={() => setPage('credit')}>查看并补保证金 →</button></div>}

      {page === 'market' && <div className="market-screen">
        <div className="room-layout">
        <div className="market-layout">
          <section className="watchlist" aria-label="股票列表" data-tour="watchlist">
            <div className="section-heading"><h2>行情牌</h2><span>{sector === '全部' ? `${market.stocks.length} 只股票` : `${visibleStocks.length} / ${market.stocks.length} 只`}</span></div>
            <div className="sector-tabs" role="group" aria-label="按板块筛选股票">{sectors.map(s => <button key={s} aria-pressed={sector === s} onClick={() => selectSector(s)}>{s}</button>)}</div>
            <div className="stock-label"><span>股票</span><span>现价</span><span>涨跌幅</span></div>
            <div className="stock-list" role="region" aria-label={`${sector}股票，${visibleStocks.length} 只`}>{visibleStocks.map(s => <button className={`stock-row ${stock.id === s.id ? 'active' : ''} ${opening?.stockId === s.id ? 'opening-target-stock' : ''}`} key={s.id} data-opening-target={opening?.stockId === s.id ? 'stock' : undefined} aria-pressed={stock.id === s.id} onClick={() => selectStock(s.id)}><span><strong>{s.name}</strong><small>{s.code}{opening?.stockId === s.id && <span className="opening-target-badge">教学目标</span>}</small></span><b className={s.changePercent >= 0 ? 'up' : 'down'}>{money(s.price)}</b><span className={s.changePercent >= 0 ? 'up' : 'down'}>{signed(s.changePercent)}%</span></button>)}</div>
            
          </section>
          <section className="trade-desk" aria-label="股票详情与交易">
            <header className="stock-heading" data-opening-target="quote"><div><h1>{stock.name}<span>{stock.code}</span></h1><p>{stock.sector}<span> / </span>{stock.concepts.join(' · ')}</p></div><div className={`quote ${stock.changePercent >= 0 ? 'up' : 'down'}`}><strong>{money(stock.price)}</strong><span>{signed(stock.changePercent)}%</span></div></header>
            {stock.listedDay === market.day && <p className="ipo-listing-note">上市首日 · 游戏涨跌幅上限 30% · 发行价 {money(stock.issuePrice ?? stock.previousClose)} 元</p>}
            {stock.limitBoard && <LimitBoardStatus board={stock.limitBoard} />}
            <OperatorSeat stock={stock} cash={market.availableCash} onTraining={showOpeningGuide} trainingLabel={opening ? '操盘引导 ↗' : '操盘说明 ↗'} />
            {market.day === 1 && market.phase === 'auction' && !market.orders.length && <p className="operator-opening-note">正式局从开盘竞价开始。用右下角“快进至上午交易”，再点“开始行情”，就能在连续交易中试盘、扫档。</p>}
            <div className="operator-workbench"><div className="operator-observe">
            <PriceChart stock={stock} time={market.time} phase={market.phase} paused={market.paused} day={market.day} trades={market.trades} />
            <div className="stock-facts"><span>总市值 <b>{compact(stock.marketCap)}</b></span><span>市盈率 <b>{money(stock.pe)} 倍</b></span><span>成交量 <b>{compact(stock.volume / 100)} 手</b></span><span>成交额 <b>{compact(stock.turnover)}</b></span></div>
            <PositionSlip stock={stock} position={position} orders={selectedOrders} creditQuantity={(market.credit.positions.find(p => p.stockId === stock.id)?.quantity ?? 0) + market.margin.positions.filter(p => p.stockId === stock.id && p.direction === 'long').reduce((n,p) => n + p.quantity, 0)} onOpen={() => setPage('portfolio')} onCredit={() => setPage('credit')} />
            <ChipStructure chips={stock.chips} stockName={stock.name} />
            <details className="stock-more"><summary>公司资料与交易范围</summary><div className="company-info"><h3>{stock.name}</h3><p>{stock.description}</p><dl><div><dt>涨停 / 跌停</dt><dd>{money(stock.limitUp)} / {money(stock.limitDown)}</dd></div><div><dt>最高 / 最低</dt><dd>{stock.volume ? `${money(stock.high)} / ${money(stock.low)}` : '— / —'}</dd></div><div><dt>今日买入</dt><dd>{position?.todayBought.toLocaleString() ?? 0} 股</dd></div></dl></div></details>
            </div><div className="operator-act">
            <form className="order-form simple-trade-ticket" onSubmit={submit} data-tour="order">
              <div className="side-tabs" role="group" aria-label="买卖方向">
                <button type="button" aria-pressed={!selling} className={!selling ? 'active buy' : ''} onClick={() => setSide('buy')}>买入</button>
                <button type="button" data-opening-target="sell-tab" aria-pressed={selling} className={selling ? 'active sell' : ''} onClick={() => setSide('sell')}>卖出</button>
              </div>
              <div data-opening-target="sell-ticket">
                <div className="order-input-row">
                  <label data-opening-target="price">价格 <span>元</span><input type="number" aria-label="委托价格" value={price} onChange={e => setPrice(e.target.value)} min={stock.limitDown} max={stock.limitUp} step=".01" required /></label>
                  <label data-opening-target="quantity">数量 <span>股</span><input type="number" aria-label="委托数量" value={quantity} onChange={e => setQuantity(e.target.value)} min="100" step="100" required /></label>
                </div>
                <TradeShortcuts side={side} quantity={quantity} price={Number(price)} availableCash={market.availableCash} availableShares={position?.available ?? 0} disabled={pending || connection} onQuantity={setQuantity} />
                {selling && <button type="button" className="ticket-fill" disabled={!sellTicket || pending || connection} onClick={() => { if (sellTicket) { setPrice(sellTicket.price.toFixed(2)); setQuantity(String(sellTicket.quantity)); } }}>按买盘填入</button>}
              </div>
              <div className="order-foot"><span>委托金额 ¥ {money(Number(price || 0) * Number(quantity || 0))}</span><span>{selling ? `可卖 ${position?.available.toLocaleString() ?? 0} 股` : '100 股起 · 下一交易日可卖'}</span></div>
              <button type="submit" data-opening-target="submit" className={`submit-order ${selling ? 'sell' : 'buy'}`} disabled={pending || connection || market.paused || isClosed || (selling && !position?.available)}>{pending ? '提交中…' : selling && !position?.available ? position?.quantity && selectedOrders.some(o => o.side === 'sell' && ['open', 'partial'].includes(o.status)) ? '剩余持仓已挂单，等待成交' : position?.todayBought ? '今日买入，次日可卖' : '暂无可卖持仓' : isClosed ? '休市中' : market.paused ? '先开始行情' : `${sideNames[side]} ${stock.name}`}<ArrowRight size={16} /></button>
              <details className="ticket-help"><summary>限价与成交说明</summary><OrderPriceGuide stock={stock} side={side} price={Number(price)} phase={market.phase} onPrice={setPrice} /></details>
            </form>
            <OperatorDesk stock={stock} market={market} side={side} price={Number(price)} quantity={Number(quantity)} orders={selectedOrders}
              disabled={pending || connection} onTicket={(p,q) => { setPrice(p.toFixed(2)); setQuantity(String(q)); }} onPrice={setPrice} onSide={setSide} />
            <div className="trade-receipts" data-opening-target="receipt"><RecentStockOrders orders={selectedOrders} disabled={pending || connection} onCancel={orderId => void action({ type: 'cancel', orderId })} onAll={() => setPage('portfolio')} /></div>
            </div></div>
          </section>
        </div>
          {!!market.ipos?.length && <aside className="room-sidebar"><IpoDesk offers={market.ipos} stocks={market.stocks} availableCash={market.availableCash}
            disabled={pending || connection || !!market.result} onSubscribe={(offerId, quantity) => action({ type: 'subscribeIpo', offerId, quantity })}
            onCancel={offerId => action({ type: 'cancelIpo', offerId })} onStock={id => { setSector('全部'); selectStock(id); }} /></aside>}
        </div>
      </div>}

      {page === 'credit' && <><LeverageDesk market={market} disabled={pending || connection} onAction={action} onGuide={() => void openTour('credit')} onStock={selectStock} />{hasLegacyCredit && <section className="legacy-credit-link"><div><h2>旧信用账户</h2><p>原有担保、融资与欠券仍按旧规则归还。</p></div><button className="text-button" onClick={() => setPage('legacyCredit')}>查看并归还旧债<ArrowRight size={16} /></button></section>}</>}
      {page === 'legacyCredit' && <><button className="text-button legacy-credit-back" onClick={() => setPage('credit')}>← 返回杠杆交易</button><CreditDesk market={market} initialStockId={stock.id} disabled={pending || connection} onAction={action} onGuide={() => void openTour('credit')} onStock={selectStock} legacyOnly /></>}

      {page === 'news' && <section className="news-page"><div className="page-heading"><h1>市场消息</h1></div><p className="news-disclaimer">消息可能已被竞价或前期上涨消化。看成交额是否跟上、资金是否持续承接，再判断热点能走多远。</p>{market.news.map(n => <article className="news-article" key={n.id}><span className="dateline">{n.day ? `第 ${n.day} 个交易日` : '历史消息'} · {n.time} · {n.sector || '交易室'}</span><NewsStage news={n} /><h2>{n.headline}</h2><p>{n.body}</p><NewsImpacts news={n} onSector={selectSector} />{n.impacts?.length > 0 && <div className="related-stocks"><span>相关股票</span>{market.stocks.filter(s => n.stockIds?.length ? n.stockIds.includes(s.id) : n.impacts.some(i => i.sector === s.sector)).map(s => <button key={s.id} onClick={() => { setSector(s.sector); selectStock(s.id); }}>{s.name}<span className={s.changePercent >= 0 ? 'up' : 'down'}>{signed(s.changePercent)}%</span><span>成交 {compact(s.turnover)}</span></button>)}</div>}</article>)}</section>}

      {page === 'portfolio' && <div className="wide-page"><section><div className="page-heading"><h1>我的持仓</h1><p>普通账户与信用账户合计；杠杆仓位与旧担保在杠杆交易中管理。</p></div><PositionTable market={market} onSelect={id => { setSector('全部'); selectStock(id); }} onCredit={() => setPage('credit')} /></section><section><div className="section-heading"><h2>委托记录</h2></div>{orders(true)}</section><section><div className="section-heading"><h2>成交回报</h2><span>最近 30 笔</span></div><div className="table-scroll"><table><thead><tr><th>时间</th><th>股票</th><th>方向</th><th>成交价</th><th>数量</th><th>成交金额</th></tr></thead><tbody>{market.trades.filter(t => t.side !== 'market').slice(0, 30).map(t => <tr key={t.id}><td>{t.day ? `第 ${t.day} 日 · ` : ''}{t.time}</td><td>{market.stocks.find(s => s.id === t.stockId)?.name}</td><td>{t.side === 'market' ? '市场' : sideNames[t.side]}</td><td>{money(t.price)}</td><td>{t.quantity.toLocaleString()} 股</td><td>{compact(t.price * t.quantity)}</td></tr>)}</tbody></table>{!market.trades.length && <p className="empty-state">暂无成交回报</p>}</div></section></div>}

      {page === 'board' && <div className="wide-page post-close-page"><div className="page-heading"><h1>盘后复盘</h1><p>板块的钱往哪走，游资又买了什么。</p>{market.postClose && <p className="review-dateline">第 {market.postClose.day} 个交易日 · {market.postClose.date} 收盘{market.postClose.day < market.day ? ' · 最近一期，本日收盘后更新' : ''}</p>}</div>
        <PostCloseReview report={market.postClose ?? null} day={market.day} onStock={id => { setSector('全部'); selectStock(id); }} onSector={selectSector} />
        {market.phase === 'night' && <section className="after-hours"><h2>盘后消息</h2>{market.news.filter(n => n.day === market.day && n.time >= '18:00' && /^\d{2}:\d{2}$/.test(n.time)).slice(0, 2).map(n => <article key={n.id}><NewsStage news={n} /><h3>{n.headline}</h3><p>{n.body}</p><NewsImpacts news={n} onSector={selectSector} /></article>)}<button className="text-button" onClick={() => setPage('news')}>查看全部消息<ArrowRight size={14} /></button></section>}</div>}

      {page === 'ledger' && <div className="ledger-page"><section className="debt-summary"><div className="page-heading"><h1>{market.challenge ? '清偿账本' : '融资账本'}</h1><p>{market.deadlineDate} 开盘前到期结算，请在此前准备现金清偿。</p></div>{market.challenge && <div className="challenge-summary"><p className="challenge-kicker">百日之约 · 一千万起步</p><h2>偿还一亿旧账</h2><dl><div><dt>开局资金</dt><dd>{compact(market.challenge.startingCapital)}</dd></div><div><dt>已付目标款</dt><dd>{compact(market.challenge.paid)}</dd></div><div><dt>剩余目标款</dt><dd>{compact(market.challenge.remaining)}</dd></div></dl><progress aria-label="目标还款进度" value={market.challenge.paid} max={market.challenge.target} /><p>目标款是旧账清算约定，不计入交易账户的维持担保比例。到期先清交易信用债务，再用现金偿还目标款；持仓不会自动变成现金。</p><button className="primary-button" onClick={showChallengeRepay} disabled={market.challenge.remaining <= 0 || !!market.result}>偿还目标欠款<ArrowRight size={16} /></button>{creditOutstanding && <p className="table-note">支付目标款前，请先在“杠杆交易”结清借款与欠券，并撤销会新增借款的委托。</p>}</div>}<div className="ledger-credit-link"><div><h2>证券信用账户</h2><p>信用债务 {compact(market.debt)} · 查看逐仓、全仓及旧信用账户。</p></div><button className="text-button" onClick={() => setPage('credit')}>前往杠杆交易<ArrowRight size={16} /></button></div></section><section><div className="section-heading"><h2>资金流水</h2></div>{market.ledger.slice(0, 40).map(item => <div className="ledger-row" key={item.id}><Receipt size={18} /><div><strong>{item.description}</strong><small>第 {item.day} 日 · {item.time}</small></div><b className={item.amount > 0 ? 'up' : item.amount < 0 ? 'down' : ''}>{signed(item.amount)}</b></div>)}</section></div>}

      {market.result && <section className="ending-review-note"><div><h2>{market.result === 'won' ? '旧账已清，牌局未散。' : '你离席了，传闻还在。'}</h2><p>本局已结算，账本与交易记录留在这里。</p></div><button className="primary-button" onClick={() => setEndingDismissed(false)}>重看结局<ArrowRight size={16} /></button></section>}
      <footer className="desk-footer"><span><span className="save-state">{connection ? '连接中断' : pending ? '保存中…' : '进度已保存'}</span></span><button onClick={() => setModal('new')}>重新开局</button></footer>
    </main>
    {!market.result && <TimeConsole market={market} pending={pending} connection={connection} onAction={action} openingNextDay={guideVisible && market.day === 1 && opening?.stage === 'exit'} />}
    {market.result && !endingDismissed && <EndingScreen market={market} onClose={() => { setEndingDismissed(true); setPage('ledger'); }} onRestart={() => { setEndingDismissed(true); setModal('new'); }} />}
    {feedback}{guide}
    {modal === 'help' && <Modal title="坐上游资席位" close={() => setModal(null)}><div className="operator-help-actions">
      {opening && <button type="button" onClick={showOpeningGuide}>两日操盘引导<small>第一天买入，第二天再卖出。重新打开只显示提示，不重置行情、资金或持仓。</small></button>}
      <button type="button" disabled={pending || connection} onClick={() => void openTour('beginner')}>交易室界面导览<small>账户、图表、持仓、时间控制与还款目标。</small></button>
      <button type="button" onClick={() => setModal('guide')}>本局规则<small>一千万起步、百日还款与杠杆交易。</small></button>
    </div></Modal>}
    {tour && <GuidedTour kind={tour} onClose={closeTour} />}
    {guideVisible && <OpeningTutorial market={market} side={side} price={Number(price)} quantity={Number(quantity)} pending={pending || connection} onClose={hideOpeningGuide} />}
    {modal === 'repay' && <Modal title="偿还融资" close={() => setModal(null)}><p className="modal-description">可用于偿债现金 ¥ {money(market.credit.repayAvailable)}<br />融资及应付费用 ¥ {money(market.credit.financingDebt + market.credit.interest)}</p><form onSubmit={e => { e.preventDefault(); void action({ type: 'repay', amount: Number(repayAmount) }); }}><label className="repay-label">还款金额（元）<input aria-label="还款金额" autoFocus required min=".01" step=".01" type="number" max={market.credit.repayAvailable} value={repayAmount} onChange={e => setRepayAmount(e.target.value)} placeholder="输入金额" /></label><button type="button" className="text-button" onClick={() => setRepayAmount(market.credit.repayAvailable.toFixed(2))}>填入当前可偿还金额</button><button type="submit" className="primary-button full" disabled={pending || !repayAmount || Number(repayAmount) <= 0}>确认还款<ArrowRight size={16} /></button></form></Modal>}
    {modal === 'challenge' && market.challenge && <Modal title="偿还目标欠款" close={() => setModal(null)}><p className="modal-description">可用现金 ¥ {money(market.availableCash)}<br />剩余目标款 ¥ {money(market.challenge.remaining)}<br />{creditOutstanding ? '请先结清证券信用债务并撤销信用委托，再支付目标款。' : '目标款按固定金额清偿，不额外计息。已支付款项会计入目标进度。'}</p><form onSubmit={e => { e.preventDefault(); void action({ type: 'repayChallenge', amount: Number(repayAmount) }); }}><label className="repay-label">目标还款金额（元）<input aria-label="目标还款金额" autoFocus required min=".01" step=".01" type="number" max={Math.min(market.availableCash, market.challenge.remaining)} value={repayAmount} onChange={e => setRepayAmount(e.target.value)} placeholder="输入金额" /></label><button type="button" className="text-button" onClick={() => setRepayAmount(Math.min(market.availableCash, market.challenge!.remaining).toFixed(2))}>填入当前可偿还金额</button><button type="submit" className="primary-button full" disabled={pending || creditOutstanding || !repayAmount || Number(repayAmount) <= 0}>确认支付目标款<ArrowRight size={16} /></button></form></Modal>}
    {modal === 'new' && <Modal title="重新开局" close={() => setModal(null)}>{dismiss => <><p className="modal-description">新局持有 1,000 万现金，从空仓开始。今天买入的股票，下一交易日才能卖。第一日固定开局，第二日起随机行情；100 个自然日内偿还 1 亿元目标欠款。新局会替换当前存档，当前进度不会保留。</p><div className="modal-actions"><button className="quiet" onClick={dismiss}>继续这一局</button><button className="primary-button" disabled={pending} onClick={() => void beginStart()}>确认重新开局</button></div></>}</Modal>}
  </div>;
}

function PositionTable({ market, onSelect, onCredit }: { market: MarketView; onSelect: (id: string) => void; onCredit: () => void }) {
  const positions = market.stocks.flatMap(stock => {
    const own = market.positions.find(p => p.stockId === stock.id);
    const shorts = market.margin.positions.filter(p => p.stockId === stock.id && p.direction === 'short').reduce((n, p) => n + p.quantity, 0);
    if (!own && !shorts) return [];
    return [{ stockId: stock.id, quantity: 0, available: 0, averageCost: 0, marketValue: 0, profit: 0, ...own, shortQuantity: (own?.shortQuantity ?? 0) + shorts }];
  });
  return <div className="table-scroll"><table><thead><tr><th>股票</th><th>总持仓 / 普通可卖</th><th>杠杆 / 旧信用</th><th>成本价</th><th>市值</th><th>浮动盈亏</th><th>待还券</th></tr></thead><tbody>{positions.map(p => {
    const creditQuantity = (market.credit.positions.find(c => c.stockId === p.stockId)?.quantity ?? 0) + market.margin.positions.filter(c => c.stockId === p.stockId && c.direction === 'long').reduce((n,c) => n + c.quantity, 0);
    return <tr key={p.stockId}><td><button className="stock-link" onClick={() => onSelect(p.stockId)}>{market.stocks.find(s => s.id === p.stockId)?.name}</button></td><td>{p.quantity.toLocaleString()} / {p.available.toLocaleString()}</td><td>{creditQuantity ? <button className="stock-link" onClick={onCredit}>{creditQuantity.toLocaleString()} 股 →</button> : '—'}</td><td>{money(p.averageCost)}</td><td>{compact(p.marketValue)}</td><td className={p.profit >= 0 ? 'up' : 'down'}>{signed(p.profit)}</td><td>{p.shortQuantity ? <button className="stock-link" onClick={onCredit}>{p.shortQuantity.toLocaleString()} 股 →</button> : '—'}</td></tr>;
  })}</tbody></table>{!positions.length && <p className="empty-state">暂无持仓。买入委托成交后才会出现在这里；待成交或已撤销的委托见下方记录。</p>}</div>;
}
