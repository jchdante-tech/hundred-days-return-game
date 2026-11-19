import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, X } from '@phosphor-icons/react';
import { OPENING_SCENARIO } from '../shared/opening-scenario';
import { placeCard, visibleRect } from './GuidedTour';
import { resolveOpeningStep, validOpeningSellOrder, type OpeningGuideContext, type OpeningStep } from './opening-guide';
import { money } from './format';
import './opening-tutorial.css';
import { FLOATING_PANEL_MOVE } from './useFloatingPanel';

export interface OpeningTutorialProps extends OpeningGuideContext { pending: boolean; onClose: () => void }
type Lesson = { target: string; title: string; body: string; instruction?: string; next?: OpeningStep; label?: string; enabled?: boolean };

export function openingLesson(props: OpeningTutorialProps, step: OpeningStep): Lesson {
  const { market, price, quantity } = props;
  const scenario = market.openingScenario!;
  const stock = market.stocks.find(s => s.id === scenario.stockId)!;
  const position = market.positions.find(p => p.stockId === scenario.stockId);
  const remaining = OPENING_SCENARIO.buyQuantity - scenario.boughtQuantity;
  const sellReady = validOpeningSellOrder(stock, position?.available ?? 0, price, quantity)
    && price <= (stock.bids[0]?.price ?? 0);
  const lessons: Record<OpeningStep, Lesson> = {
    stock: { target: 'stock', title: '先选这只股票', body: '你有 1,000 万现金，坐的是游资席位。这只股票的卖盘，你有能力吃掉。其他 17 只股票也可以交易。', instruction: `点击框内的「${stock.name}」` },
    price: { target: 'price', title: '把买入限价填成 10.30', body: '限价是你愿意付的最高价。10.30 元能覆盖这只股票的前三档卖盘。', instruction: '点击框内输入框，输入 10.30', next: 'quantity', enabled: price === OPENING_SCENARIO.buyLimit },
    quantity: { target: 'quantity', title: `这次买 ${remaining.toLocaleString()} 股`, body: `输入 ${remaining}。这笔大单会逐档吃掉卖盘，成交价也会被你推高。`, instruction: `在数量框输入 ${remaining}`, next: 'buy-start', enabled: quantity === remaining },
    'buy-start': { target: 'clock-play', title: '先让行情运行', body: '现在是暂停状态。点开始行情，然后亲手确认刚填好的买单。', instruction: '点击框内「开始行情」' },
    'buy-submit': { target: 'submit', title: '确认这笔买入', body: '价格和数量已经填好。点击买入，看看你的大单实际成交了多少。', instruction: `点击框内「买入 ${stock.name}」` },
    impact: { target: 'receipt', title: '这次涨价，是你买出来的', body: '你已累计买走预设的三档卖盘，把价格从 10.00 推到 10.30。本笔成交数量和价格变化看框内回执；资金和股票已存入账户。', next: 'follow', label: '继续看市场反应' },
    follow: { target: market.paused ? 'clock-play' : 'quote', title: market.paused ? '继续行情，看谁来跟随' : '跟随资金正在成交', body: market.paused ? '你的买单已完成。点开始行情，观察后续买盘怎样改变价格。' : '稍等几个模拟秒。现在的后续上涨来自其他资金成交。', instruction: market.paused ? '点击框内「开始行情」' : '成交后会自动暂停' },
    locked: { target: 'position', title: '今天买的，今天不能卖', body: `现在持有 ${(position?.quantity ?? 0).toLocaleString()} 股，可卖 0 股。价格上涨只是浮盈；普通股票遵循 T+1，要到下一交易日才能卖。`, next: 'overnight', label: '明白了，等下一交易日' },
    overnight: { target: 'clock-next', title: '把持仓带到第二天', body: scenario.boughtQuantity ? '点击这里结束今天。现金和持仓照常保留，下一交易日这批股票会解锁。' : '首日已经结束。没有完成教学也能继续，已有账户照常保留。', instruction: market.phase === 'closing' && scenario.stage !== 'exit' ? '先点击快进收盘，再进入下一交易日' : '点击框内按钮进入下一交易日' },
    unlocked: { target: 'position', title: '第二天，股票可以卖了', body: `昨天买入的股票已解锁，当前可卖 ${(position?.available ?? 0).toLocaleString()} 股。接下来按今天的真实买盘尝试卖出。`, next: 'auction', label: '看看今天的买盘' },
    auction: { target: 'clock-next', title: market.phase === 'lunch' ? '等下午重新开市' : '先进入连续交易', body: market.phase === 'lunch' ? '午间暂时不撮合。点击快进到下午，再继续操作。' : '开盘竞价按统一价格撮合。这一笔先快进到上午交易，再看眼前买盘。', instruction: '点击框内「快进」按钮' },
    'sell-side': { target: 'sell-tab', title: '切换到卖出', body: '昨天买入的股票现在可以出售。点击卖出，准备兑现一部分持仓。', instruction: '点击框内「卖出」' },
    'sell-ticket': { target: 'sell-ticket', title: '按买盘填写卖单', body: '点「按买盘填入」，使用眼前买方愿意接的价格和数量。第二天行情已经随机，成交价取决于提交时的买盘。', instruction: '填入后检查价格与数量，再继续', next: 'sell-start', enabled: sellReady },
    'sell-start': { target: 'clock-play', title: '开始今天的行情', body: '委托已准备好。点开始行情，再确认卖出。', instruction: '点击框内「开始行情」' },
    'sell-submit': { target: 'submit', title: '确认卖出，查看到账', body: '实际卖出价和数量取决于提交时的买盘。未成交的部分会继续挂单，可以撤回。', instruction: `点击框内「卖出 ${stock.name}」` },
    done: { target: 'receipt', title: position?.quantity ? '已卖出一部分，仍有持仓' : '股票已实际卖出', body: `已实际卖出 ${scenario.soldQuantity.toLocaleString()} 股，回款 ${money(scenario.saleProceeds)} 元。${position?.quantity ? `还持有 ${position.quantity.toLocaleString()} 股，未成交的挂单也仍计入持仓。` : ''}回款不是利润，盈亏需扣成交成本。`, label: '完成引导，继续交易' },
    orders: { target: 'receipt', title: '先看这笔未完成的委托', body: '还有挂单正在等待成交。可以在框内撤单，再调整价格和数量；成交后引导会继续。', instruction: '查看实际成交进度，必要时点击撤单' },
    empty: { target: 'position', title: '按你的实际持仓继续', body: position?.todayBought ? '当前可卖数量为 0。今天新买的股票还要等下一交易日，不会为了教程提前解锁。' : '当前没有可用于教学的持仓，或者今天已收盘。你可以结束引导继续自己的交易。', label: '结束引导' },
    'wait-book': { target: market.paused ? 'clock-play' : 'book', title: '先等买盘出现', body: '当前没有可成交的买盘。开始行情，等有人挂出买单；价格上涨也不代表随时能卖掉。', instruction: market.paused ? '点击框内「开始行情」' : '观察买盘出现后继续' },
  };
  return lessons[step];
}

/** Highlighted real controls remain clickable. This view never submits a trade. */
export default function OpeningTutorial(props: OpeningTutorialProps) {
  const [requested, setRequested] = useState<OpeningStep>('stock');
  const step = resolveOpeningStep(props, requested);
  const lesson = openingLesson(props, step);
  const cardRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [layout, setLayout] = useState<ReturnType<typeof placeCard> | null>(null);
  const id = useId();
  const selector = `[data-opening-target="${lesson.target}"]`;
  useEffect(() => { if (step !== requested) setRequested(step); }, [step, requested]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [props.onClose]);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    let frame = 0;
    const target = document.querySelector<HTMLElement>(selector);
    const clock = lesson.target.startsWith('clock');
    const measure = () => {
      const width = document.documentElement.clientWidth, height = window.visualViewport?.height ?? window.innerHeight;
      setLayout(placeCard(target ? visibleRect(target, width, height) : null, width, height, card.offsetWidth, card.offsetHeight, clock));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    if (target && !clock) target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    measure();
    titleRef.current?.focus({ preventScroll: true });
    const onTargetClick = () => {
      if (step === 'stock') setRequested('price');
    };
    target?.addEventListener('click', onTargetClick);
    const observer = new ResizeObserver(schedule);
    observer.observe(card);
    if (target) observer.observe(target);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener(FLOATING_PANEL_MOVE, schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); target?.removeEventListener('click', onTargetClick);
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true);
      window.removeEventListener(FLOATING_PANEL_MOVE, schedule);
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [selector, step]);
  if (typeof document === 'undefined') return null;
  const target = layout?.target;
  const final = step === 'done' || step === 'empty';
  return createPortal(<div className="opening-spotlight-guide" data-opening-step={step}>
    {layout && (target ? <div className="opening-shades" aria-hidden="true">
      <div style={{ left: 0, top: 0, width: layout.width, height: target.top }} />
      <div style={{ left: 0, top: target.top, width: target.left, height: target.height }} />
      <div style={{ left: target.left + target.width, top: target.top, width: Math.max(0, layout.width - target.left - target.width), height: target.height }} />
      <div style={{ left: 0, top: target.top + target.height, width: layout.width, height: Math.max(0, layout.height - target.top - target.height) }} />
    </div> : <div className="opening-shade-full" aria-hidden="true" />)}
    {target && <div className="opening-spotlight" style={target} aria-hidden="true" />}
    <section ref={cardRef} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
      className="opening-coach" style={layout ? layout.card : { visibility: 'hidden' }}>
      <header><span>{props.market.day === 1 ? '第 1 天 · 学会买入' : '第 2 天 · 学会卖出'}</span><button type="button" onClick={props.onClose} aria-label="跳过引导，保留当前进度"><X size={16} /></button></header>
      <h2 ref={titleRef} id={`${id}-title`} tabIndex={-1}>{lesson.title}</h2>
      <p id={`${id}-body`}>{lesson.body}</p>
      {lesson.instruction && <p className="opening-instruction"><ArrowRight size={14} aria-hidden="true" />{lesson.instruction}</p>}
      {props.pending && <p role="status" className="opening-saving">正在同步，请稍候…</p>}
      <footer><button type="button" className="opening-skip" onClick={props.onClose}>跳过引导</button>
        {(lesson.next || final) && <button type="button" className="opening-next" disabled={props.pending || lesson.enabled === false}
          onClick={final ? props.onClose : () => setRequested(lesson.next!)}>{lesson.label ?? '下一步'}<ArrowRight size={13} /></button>}
        {!target && <button type="button" className="opening-next" onClick={() => document.querySelector(selector)?.scrollIntoView({ block: 'center', behavior: 'instant' })}>定位操作</button>}
      </footer>
    </section>
  </div>, document.body);
}
