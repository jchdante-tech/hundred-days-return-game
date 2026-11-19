import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './guided-tour.css';
import { FLOATING_PANEL_MOVE } from './useFloatingPanel';

type TourKind = 'beginner' | 'credit';
type TourTarget = 'account' | 'watchlist' | 'chart' | 'chips' | 'position' | 'operator' | 'order' | 'news' | 'clock' | 'credit' | 'credit-collateral' | 'credit-sources' | 'credit-order' | 'credit-risk' | 'credit-positions' | 'credit-margin' | 'contract';
type TourStep = { target: TourTarget; label: string; title: string; body: string; note: string };
type Rect = { left: number; top: number; width: number; height: number };
type Layout = { target: Rect | null; card: { left: number; top: number }; width: number; height: number };

const beginnerSteps: TourStep[] = [
  { target: 'account', label: '账户', title: '先看手里有多少筹码', body: '这里分别显示账户资产、可用现金和还款金额。现金可以下单，股票市值会随价格变化；市值上涨，并不代表已经落袋。', note: '到期前需要备足还款现金。目标金额和剩余日期，以本局账本为准。' },
  { target: 'watchlist', label: '行情牌', title: '同一板块，也各有脾气', body: '在行情牌筛选板块和股票，窄屏可横向滑动股票列表。半导体、光通信、电力、机器人、创新药与大消费，各有不同的市场消息。', note: '板块消息会改变预期，但同板块不一定同涨同跌；还要看各家业务和真实成交。' },
  { target: 'chart', label: '行情图', title: '价格看上面，成交量看下面', body: '日 K 记录一天的开、高、低、收；下面的柱子才是成交量。黄、蓝、紫三条线分别是 MA5、MA10、MA20，帮助观察不同周期的趋势。', note: '用加减按钮或滚轮缩放，横向拖动看历史。均线是过去价格的平均，不是涨跌预告。' },
  { target: 'chips', label: '筹码', title: '看筹码，也要看谁愿意卖', body: '展开“筹码观察”，看局内流通市值、你的持筹占比，以及筹码集中与卖盘松紧的估计。只有买卖成交，才会改变筹码分布。', note: '筹码集中时可能更容易推动价格，拉高也可能引来获利卖盘。今天买入仍要等 T+1 才能卖；浮盈要有买盘承接才能落袋。' },
  { target: 'position', label: '持仓', title: '持有，不一定马上能卖', body: '这里是当前股票的持仓、可卖数量、买入成本和浮动盈亏。切换股票时，这张持仓单也会一起切换。', note: '普通买入遵循 T+1：今天买的股票，下一交易日才能卖。未成交卖单还会冻结可卖数量。' },
  { target: 'operator', label: '盘口', title: '先看价格，再看有多少股', body: '买卖盘口并排展示对手方的价格和数量，点击档位可以填入限价。下方“盘口详情 / 更多操作”默认折叠，展开后可用 100 股试单、扫一档、扫五档和试算；这些只填委托，仍须亲自确认。', note: '买卖方向在委托区切换。连续交易中，大单可能逐档成交；集合竞价统一撮合。卖出要有买盘承接，今天买入的股票下一交易日才可卖。' },
  { target: 'order', label: '委托', title: '看实际成交，再决定下一笔', body: '确认限价和股数后提交。下方回执会显示提交瞬间实际成交了多少、跨了几个价格，以及本单撮合中的价格变化。图上的标记记录你的近期成交。', note: '未成交余量继续挂单，允许撤单时可撤回。只有成交才改变持仓；后续行情也受其他资金影响。' },
  { target: 'news', label: '沪上电讯', title: '消息是线索，成交才是结果', body: '点击左侧“电讯”，查看市场消息、影响板块与相关股票。交易室里只保留看盘和下单。', note: '隔夜热点可能已被定价。读完再看成交量、实际买卖和盘后资金方向，别把利好当成必涨。' },
  { target: 'clock', label: '时间', title: '行情由你掌握节奏', body: '这里保留开始、暂停和倍速。按住顶部时间行可拖动整个框，点“复位”放回右下角。快进会推进到下一个阶段；收盘复盘后，由你进入下一交易日。', note: '引导期间行情已暂停，结束后也不会自动开跑。准备好时，再点“开始行情”。' },
  { target: 'contract', label: '本局目标', title: '赚钱，也要记得归期', body: '点这里查看本局的还款期限与账本。留意可用现金、未成交委托和持仓，不要等到最后一天才考虑卖出。', note: '第 20 个交易日开放融资融券，到时会有单独说明。随时可从“玩法”重新查看引导。' },
];

const creditSteps: TourStep[] = [
  { target: 'credit', label: '股票杠杆', title: '选股票、方向和自己的投入', body: '第 20 个交易日起，可以用 1 倍、2 倍或 3 倍交易。看涨做多，是买入股票；看跌做空，是向券商借股票卖出，之后买回归还。', note: '这里交易的仍是真实撮合的股票，不是永续合约。借款、券源和 T+1 都继续生效。' },
  { target: 'credit-margin', label: '逐仓与全仓', title: '先决定，这笔风险由谁承担', body: '逐仓把每次投入单独管理，一笔仓位单独计算风险。全仓让所有全仓仓位共用已经投入的保证金，一笔亏损会影响其他全仓仓位。', note: '普通账户的现金不会自动加入全仓。默认逐仓；需要增加保障时，由你主动补保证金。' },
  { target: 'credit-order', label: '投入与倍数', title: '10 万元、2 倍，做约 20 万元仓位', body: '填写本次使用的自有资金，再选倍数。2 倍做多时，一半资金来自自己，一半向券商借；1 倍做多不借钱。确认后自动划入所需资金，不必先填写担保表。', note: '按 100 股取整，多余资金留在普通账户。融券按当日最高价预留保证金，实际杠杆可能低于所选倍数。' },
  { target: 'credit-sources', label: '开仓预览', title: '借了多少，每天花多少，先看清楚', body: '这里列出股票数量、实际使用的自有资金、预计借款或借券，以及每天的费用。做空只展示券商有券源的股票，余券不足时不能继续借。', note: '委托需要对手盘才会成交。融券卖出款留作担保，不能转回普通账户继续买股。' },
  { target: 'credit-positions', label: '仓位管理', title: '平仓时，自动把该还的还掉', body: '成交后，这里显示方向、数量、盈亏和保证金比例。点“平仓”，可以全部平掉可平数量，也可以少填一些；点“补保证金”，增加该账户的安全余量。', note: '今天新开的股票仓位，下个交易日才可平。仓位及相关委托全部结清后，余款自动回到普通账户。' },
  { target: 'credit-risk', label: '风险', title: '保证金比例越低，离强平越近', body: '本局按账户权益除以持仓与开仓挂单总市值计算保证金比例，低于 20% 预警，低于 10% 强平线时开始提交平仓委托。逐仓显示单仓参考价，全仓看共用账户风险。', note: '这是本局券商约定。遇到 T+1、涨跌停或没有对手盘，强平可能无法及时完成，亏损也可能超过投入。' },
];

function findTarget(target: TourTarget) {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)).find(element => element.getClientRects().length > 0)
    ?? (target === 'contract' ? document.querySelector<HTMLElement>('[data-tour="account"]') : null)
    ?? (target === 'credit' ? document.querySelector<HTMLElement>('[data-tour="order"]') : null);
}

export function visibleRect(element: HTMLElement, width: number, height: number): Rect | null {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  let left = Math.max(6, rect.left - 6), right = Math.min(width - 6, rect.right + 6);
  let top = Math.max(6, rect.top - 6), bottom = Math.min(height - 6, rect.bottom + 6);
  // A mobile game room scrolls inside its own container, above the fixed clock.
  // Its hidden portion must not be presented as an exposed spotlight.
  for (let parent = getComputedStyle(element).position === 'fixed' ? null : element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
    }
    // Children of the fixed clock are outside the mobile room's scrolling clip.
    if (style.position === 'fixed') break;
  }
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

export function placeCard(target: Rect | null, width: number, height: number, cardWidth: number, cardHeight: number, clock: boolean): Layout {
  const edge = width <= 600 ? 12 : 16, gap = 14;
  const clampX = (x: number) => Math.max(edge, Math.min(width - cardWidth - edge, x));
  const clampY = (y: number) => Math.max(edge, Math.min(height - cardHeight - edge, y));
  if (!target) return { target, width, height, card: { left: clampX((width - cardWidth) / 2), top: clampY((height - cardHeight) / 2) } };
  const right = target.left + target.width, bottom = target.top + target.height;
  if (width > 600) {
    if (right + gap + cardWidth <= width - edge) return { target, width, height, card: { left: right + gap, top: clampY(target.top) } };
    if (target.left - gap - cardWidth >= edge) return { target, width, height, card: { left: target.left - gap - cardWidth, top: clampY(target.top) } };
    if (bottom + gap + cardHeight <= height - edge) return { target, width, height, card: { left: clampX(target.left), top: bottom + gap } };
    if (target.top - gap - cardHeight >= edge) return { target, width, height, card: { left: clampX(target.left), top: target.top - gap - cardHeight } };
  }
  // In narrow rooms the explanation occupies one end of the viewport. Only the
  // part of a tall target that is actually clear of the card is highlighted.
  const above = clock || (width > 600 && target.top > height / 2);
  const cardTop = above ? edge : height - cardHeight - edge;
  const clearTop = above ? Math.max(target.top, cardTop + cardHeight + gap) : target.top;
  const clearBottom = above ? bottom : Math.min(bottom, cardTop - gap);
  const exposed = clearBottom > clearTop ? { ...target, top: clearTop, height: clearBottom - clearTop } : null;
  return { target: exposed, width, height, card: { left: clampX((width - cardWidth) / 2), top: cardTop } };
}

export default function GuidedTour({ kind, onClose }: { kind: TourKind; onClose: () => void }) {
  const steps = kind === 'credit' ? creditSteps : beginnerSteps;
  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[stepIndex] ?? steps[0];
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);

  useLayoutEffect(() => { setStepIndex(0); }, [kind]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const card = cardRef.current, target = findTarget(step.target);
    if (!card) return;
    let frame = 0;
    const measure = () => {
      const width = document.documentElement.clientWidth;
      const height = window.visualViewport?.height ?? window.innerHeight;
      setLayout(placeCard(target ? visibleRect(target, width, height) : null, width, height, card.offsetWidth, card.offsetHeight, step.target === 'clock'));
    };
    const scheduleMeasure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };

    if (target && step.target !== 'clock') {
      target.scrollIntoView({ block: window.innerWidth <= 600 ? 'start' : 'center', inline: 'nearest', behavior: 'instant' });
      if (window.innerWidth <= 600) {
        // Leave a small border around the active area in a nested mobile scroller.
        for (let parent = target.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
            parent.scrollTop -= 12;
            break;
          }
        }
      }
    }
    measure();
    titleRef.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(card);
    if (target) observer.observe(target);
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('scroll', scheduleMeasure, true);
    window.addEventListener(FLOATING_PANEL_MOVE, scheduleMeasure);
    window.visualViewport?.addEventListener('resize', scheduleMeasure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('scroll', scheduleMeasure, true);
      window.removeEventListener(FLOATING_PANEL_MOVE, scheduleMeasure);
      window.visualViewport?.removeEventListener('resize', scheduleMeasure);
    };
  }, [step.target, stepIndex, kind]);

  const target = layout?.target;
  const last = stepIndex === steps.length - 1;
  return createPortal(
    <dialog ref={dialogRef} className="guided-tour" aria-labelledby="tour-title" aria-describedby="tour-body tour-note"
      data-kind={kind} data-step={stepIndex + 1} data-target={step.target}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const stops = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'));
        const first = stops[0], final = stops.at(-1);
        if (event.shiftKey && (document.activeElement === first || !stops.includes(document.activeElement as HTMLElement))) {
          event.preventDefault(); final?.focus();
        } else if (!event.shiftKey && document.activeElement === final) {
          event.preventDefault(); first?.focus();
        }
      }}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      {layout && (target ? <div className="tour-shades" aria-hidden="true">
        <div style={{ left: 0, top: 0, width: layout.width, height: target.top }} />
        <div style={{ left: 0, top: target.top, width: target.left, height: target.height }} />
        <div style={{ left: target.left + target.width, top: target.top, width: Math.max(0, layout.width - target.left - target.width), height: target.height }} />
        <div style={{ left: 0, top: target.top + target.height, width: layout.width, height: Math.max(0, layout.height - target.top - target.height) }} />
      </div> : <div className="tour-shade-full" aria-hidden="true" />)}
      {target && <div className="tour-spotlight" style={target} aria-hidden="true"><span>{String(stepIndex + 1).padStart(2, '0')} · {step.label}</span></div>}
      <section ref={cardRef} className="tour-card" style={layout ? layout.card : { visibility: 'hidden' }}>
        <div className="tour-topline"><span>{kind === 'credit' ? '进阶交易指引' : '交易室新手指引'}</span><span aria-label={`第 ${stepIndex + 1} 步，共 ${steps.length} 步`}>{String(stepIndex + 1).padStart(2, '0')} / {String(steps.length).padStart(2, '0')}</span></div>
        <div className="tour-copy" key={`${kind}-${stepIndex}`} tabIndex={0}>
          <h2 ref={titleRef} id="tour-title" tabIndex={-1}>{step.title}</h2>
          <p id="tour-body">{step.body}</p>
          <p id="tour-note" className="tour-note">{step.note}</p>
        </div>
        <div className="tour-progress" aria-hidden="true">{steps.map((item, index) => <span key={`${item.target}-${index}`} className={index <= stepIndex ? 'complete' : undefined} />)}</div>
        <footer className="tour-actions">
          <button type="button" className="tour-skip" onClick={onClose}>{last ? '关闭' : '跳过引导'}</button>
          <div>{stepIndex > 0 && <button type="button" className="tour-back" onClick={() => setStepIndex((index) => Math.max(0, index - 1))}>上一步</button>}
            <button type="button" className="tour-next" onClick={last ? onClose : () => setStepIndex((index) => Math.min(steps.length - 1, index + 1))}>{last ? '完成引导' : '下一步'}<span aria-hidden="true"> →</span></button></div>
        </footer>
      </section>
    </dialog>, document.body,
  );
}
