import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { Phase, StockView, TradeView } from '../shared/types';
import { dailyMovingAverage, dailyPriceChanges, extendChartWindow, intradayMinute, intradayTimeline, latestChartWindow, panChartWindow, priceChange, zoomChartWindow, type ChartPriceChange, type ChartWindow } from '../shared/chart-math';
import { money, signed } from './format';
import './price-chart.css';

type ChartMode = 'intraday' | 'daily';
const periods = [5, 10, 20] as const;
const maColors: Record<number, string> = { 5: '#f2cf79', 10: '#8ed3e6', 20: '#df9ce5' };
const upColor = '#e89582', downColor = '#8cc3aa';
const volumeLabel = (shares: number) => shares / 100 >= 10000 ? `${money(shares / 1000000, 1)}万` : money(shares / 100, 0);

type PlayerTradeGroup = { key: string; day: number; time?: string; side: 'buy' | 'sell'; quantity: number; valueCents: number; fills: number };
const buySides = new Set(['buy', 'finance', 'cover', 'marginBuy', 'marginCover']);
const sellSides = new Set(['sell', 'short', 'creditSell', 'marginShort', 'marginSell']);

/** The API exposes recent fills, so these groups are never whole-day totals. */
export function groupPlayerTrades(trades: readonly TradeView[], stockId: string, mode: ChartMode, day?: number): PlayerTradeGroup[] {
  const groups = new Map<string, PlayerTradeGroup>();
  for (const trade of trades) {
    // Historical saves can lack the session day; do not place them on an invented date.
    if (trade.stockId !== stockId || !Number.isSafeInteger(trade.day) || trade.day! <= 0
      || !Number.isFinite(trade.quantity) || trade.quantity <= 0 || !Number.isFinite(trade.price) || trade.price <= 0) continue;
    const side = buySides.has(trade.side) ? 'buy' : sellSides.has(trade.side) ? 'sell' : null;
    if (!side) continue;
    const minute = /^\d{2}:\d{2}$/.test(trade.time) ? Number(trade.time.slice(0, 2)) * 60 + Number(trade.time.slice(3)) : NaN;
    if (mode === 'intraday' && (trade.day !== day || Number(trade.time.slice(3)) >= 60
      || !(minute >= 565 && minute <= 690 || minute >= 780 && minute <= 900))) continue;
    const time = mode === 'intraday' ? trade.time : undefined;
    const key = `${trade.day}-${time ?? 'day'}-${side}`;
    const group = groups.get(key) ?? { key, day: trade.day!, time, side, quantity: 0, valueCents: 0, fills: 0 };
    group.quantity += trade.quantity;
    group.valueCents += Math.round(trade.price * 100) * trade.quantity;
    group.fills += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function tradeGroupDescription(group: PlayerTradeGroup): string {
  return `你的近期${group.side === 'buy' ? '买入' : '卖出'}成交 · 第 ${group.day} 日${group.time ? ` ${group.time}` : ''} · ${money(group.quantity, 0)} 股 · ${group.fills} 笔撮合 · 成交均价 ${money(group.valueCents / group.quantity / 100, 4)} 元`;
}

function ChangeReadout({ change }: { change: ChartPriceChange | null }) {
  if (!change) return <span className="chart-change chart-change--missing" title="缺少前一交易日的收盘记录，无法计算这一日的涨跌幅">涨跌 — <span>缺少前日收盘</span></span>;
  const direction = change.amount > 0 ? 'up' : change.amount < 0 ? 'down' : 'flat';
  const reference = change.basis === 'issue-price' ? '发行价' : '前收';
  return <span className={`chart-change chart-change--${direction}`} data-change-percent={change.percent}
    title={`相对${reference} ${money(change.reference)} 元；涨跌幅 =（最新价 − ${reference}）÷ ${reference}`}>
    <span>涨跌</span><strong>{signed(change.amount)}</strong><strong>{signed(change.percent)}%</strong>
    {change.basis === 'issue-price' && <span className="chart-change-basis">较发行价</span>}
  </span>;
}

export default function PriceChart({ stock, time, phase, paused, day, trades = [] }: { stock: StockView; time: string; phase: Phase; paused: boolean; day?: number; trades?: TradeView[] }) {
  const [mode, setMode] = useState<ChartMode>('daily');
  const [visibleMA, setVisibleMA] = useState<Set<number>>(() => new Set(periods));
  const [hover, setHover] = useState<number | null>(null);
  const [{ width, height }, setChartSize] = useState({ width: 520, height: 178 });
  const allBars = stock.dailyBars ?? [];
  const [savedWindow, setSavedWindow] = useState(() => ({ stockId: stock.id, total: allBars.length, value: latestChartWindow(allBars.length) }));
  const range = savedWindow.stockId === stock.id
    ? extendChartWindow(savedWindow.total, allBars.length, savedWindow.value)
    : latestChartWindow(allBars.length);
  const chart = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; range: ChartWindow; moved: boolean } | null>(null);
  const wheelDelta = useRef(0);
  const id = useId().replace(/:/g, '');
  useEffect(() => {
    const element = chart.current;
    if (!element) return;
    const measure = () => {
      // SVG ResizeObserver entries can describe its graphics bounds. Use the
      // CSS viewport so changing plot coordinates cannot trigger a resize loop.
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const next = { width: Math.max(240, Math.round(rect.width)), height: Math.max(120, Math.round(rect.height)) };
      setChartSize(previous => previous.width === next.width && previous.height === next.height ? previous : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setHover(null); drag.current = null; }, [stock.id, mode]);
  useEffect(() => {
    setSavedWindow(previous => ({
      stockId: stock.id,
      total: allBars.length,
      value: previous.stockId === stock.id ? extendChartWindow(previous.total, allBars.length, previous.value) : latestChartWindow(allBars.length),
    }));
    setHover(null);
  }, [stock.id, allBars.length]);

  const timeline = intradayTimeline(stock.history, time, phase);
  const points = timeline.points;
  const intradayStatus = phase === 'lunch' ? '午间休市 · 分时暂停'
    : phase === 'night' || phase === 'ended' ? '已收盘'
      : paused ? '行情已暂停'
        : phase === 'auction' ? '开盘竞价 · 等待集中成交'
          : phase === 'closing' ? '收盘竞价 · 等待集中成交'
            : timeline.lastTradeTime === time ? '本分钟有成交' : '暂无新增成交';
  const bars = allBars.slice(range.start, range.start + range.size);
  // Calculate from full history before slicing, so zooming does not discard earlier MA inputs.
  const movingAverages = periods.map(period => ({
    period,
    values: dailyMovingAverage(allBars, period).slice(range.start, range.start + range.size),
  }));
  const base = stock.previousClose;
  const isDaily = mode === 'daily';
  const playerTrades = groupPlayerTrades(trades, stock.id, mode, day).filter(group => isDaily
    ? bars.some(bar => bar.day === group.day)
    : intradayMinute(group.time!) <= timeline.cursor);
  const count = isDaily ? bars.length : points.length;
  const selectedIndex = hover === null ? count - 1 : Math.min(hover, count - 1);
  const selectedBar = bars[selectedIndex];
  const selectedPoint = hover === null ? null : points[selectedIndex];
  const selectedDailyChange = dailyPriceChanges(allBars, stock)[range.start + selectedIndex] ?? null;
  const intradayQuote = selectedPoint ?? points.at(-1);
  const isListingSession = stock.listedDay !== undefined && allBars.at(-1)?.day === stock.listedDay && points.length > 0;
  const intradayChange = intradayQuote ? priceChange(intradayQuote.price, base, isListingSession ? 'issue-price' : 'previous-close') : null;
  const dailyValues = bars.flatMap(bar => [bar.high, bar.low]);
  for (const ma of movingAverages) {
    if (visibleMA.has(ma.period)) dailyValues.push(...ma.values.filter((value): value is number => value !== null));
  }
  // Minute quotes retain their final execution, while a player's fills may span other prices.
  const values = [...(isDaily ? dailyValues : [base, ...points.map(point => point.price)]), ...playerTrades.map(group => group.valueCents / group.quantity / 100)];
  const lowest = values.length ? Math.min(...values) : base;
  const highest = values.length ? Math.max(...values) : base;
  const margin = Math.max((highest - lowest) * .12, base * .002, .01);
  const hi = highest + margin, lo = Math.max(.001, lowest - margin);
  const plotWidth = width - 48;
  // Keep the volume band and labels readable; extra room expands the price plot.
  // At the original 178px height these retain the existing chart coordinates.
  const priceTop = 24, priceBottom = height - 67;
  const dividerY = height - 57, volumeLabelY = height - 43;
  const volumeTop = height - 36, volumeBottom = height - 7;
  const y = (value: number) => priceTop + (hi - value) / (hi - lo) * (priceBottom - priceTop);
  const dailyStep = (plotWidth - 8) / Math.max(1, bars.length);
  const intradayX = (minute: number) => 4 + minute / 245 * (plotWidth - 8);
  const x = (index: number) => isDaily ? 4 + (index + .5) * dailyStep : intradayX(intradayMinute(points[index].time));
  const maxVolume = Math.max(100, ...(isDaily ? bars : points).map(point => point.volume));
  const lineColor = stock.price >= base ? upColor : downColor;
  const line = points.map((point, index) => `${x(index)},${y(point.price)}`).join(' ');
  const updateRange = (value: ChartWindow) => {
    setSavedWindow({ stockId: stock.id, total: allBars.length, value });
    setHover(null);
  };
  const zoom = (factor: number, anchor = 1) => updateRange(zoomChartWindow(allBars.length, range, Math.round(range.size * factor), anchor));
  const pan = (days: number) => updateRange(panChartWindow(allBars.length, range, days));
  const selectAt = (clientX: number, element: SVGSVGElement) => {
    if (!count) return;
    const rect = element.getBoundingClientRect();
    const pointerX = (clientX - rect.left) / rect.width * width;
    let nearest = 0;
    for (let i = 1; i < count; i++) if (Math.abs(x(i) - pointerX) < Math.abs(x(nearest) - pointerX)) nearest = i;
    setHover(nearest);
  };
  const toggleMA = (period: number) => setVisibleMA(previous => {
    const next = new Set(previous);
    if (next.has(period)) next.delete(period); else next.add(period);
    return next;
  });
  useEffect(() => {
    const element = chart.current;
    if (!element || !isDaily || !allBars.length) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
      wheelDelta.current = Math.sign(delta) !== Math.sign(wheelDelta.current) ? delta : wheelDelta.current + delta;
      if (Math.abs(wheelDelta.current) < 35) return;
      const rect = element.getBoundingClientRect();
      const anchor = ((event.clientX - rect.left) / rect.width * width - 4) / (plotWidth - 8);
      const factor = wheelDelta.current > 0 ? 1.25 : .8;
      wheelDelta.current = 0;
      setSavedWindow({ stockId: stock.id, total: allBars.length, value: zoomChartWindow(allBars.length, range, Math.round(range.size * factor), anchor) });
      setHover(null);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [isDaily, stock.id, allBars.length, range.start, range.size, width, height, plotWidth]);

  return <div className="chart-wrap market-chart" data-tour="chart">
    <div className="chart-toolbar">
      <div className="chart-mode-buttons" role="group" aria-label="走势图类型">
        <button type="button" className="chart-mode" aria-pressed={!isDaily} onClick={() => setMode('intraday')}>分时</button>
        <button type="button" className="chart-mode" aria-pressed={isDaily} onClick={() => setMode('daily')}>日 K</button>
      </div>
      <span className="chart-note">{isDaily ? selectedBar && !selectedBar.complete ? '今日未收盘' : selectedBar?.day <= 0 ? '开局前行情' : '每日实际成交' : intradayStatus}</span>
    </div>
    {isDaily && <>
      <div className="chart-ma-legend" role="group" aria-label="显示均线">
        {movingAverages.map(ma => {
          const value = ma.values[selectedIndex];
          return <button type="button" key={ma.period} aria-pressed={visibleMA.has(ma.period)} onClick={() => toggleMA(ma.period)}
            style={{ '--ma-color': maColors[ma.period] } as CSSProperties}
            title={`${ma.period} 个连续交易日收盘价的简单平均；当日未收盘时采用最新成交价`}>
            <i />MA{ma.period} <span>{value == null ? `待 ${ma.period} 日` : money(value)}</span>
          </button>;
        })}
      </div>
      <div className="chart-range-controls" role="group" aria-label="日 K 显示范围">
        <button type="button" aria-label="查看更早行情" title="查看更早行情" disabled={range.start === 0} onClick={() => pan(-Math.max(1, Math.round(range.size / 3)))}>‹</button>
        <button type="button" aria-label="缩小日K" title="缩小，查看更多交易日" disabled={range.size >= allBars.length} onClick={() => zoom(1.25)}>−</button>
        <span className="chart-range-count" aria-live="polite">{range.size} 日</span>
        <button type="button" aria-label="放大日K" title="放大，查看更少交易日" disabled={range.size <= Math.min(12, allBars.length)} onClick={() => zoom(.8)}>＋</button>
        <button type="button" aria-label="查看更晚行情" title="查看更晚行情" disabled={range.start + range.size >= allBars.length} onClick={() => pan(Math.max(1, Math.round(range.size / 3)))}>›</button>
        <button type="button" className="chart-range-latest" aria-label="回到最新行情" title="恢复最近 40 个交易日" onClick={() => updateRange(latestChartWindow(allBars.length))}>最新</button>
        <span className="chart-range-hint">滚轮缩放 · 横拖查看</span>
      </div>
    </>}
    <div className="chart-readout" aria-live="off">
      {isDaily ? selectedBar ? <><span className="chart-readout-date">{selectedBar.date.slice(5)} · {selectedBar.day <= 0 ? '开局前' : `第 ${selectedBar.day} 日`}</span><span>开 {money(selectedBar.open)}</span><span>高 {money(selectedBar.high)}</span><span>低 {money(selectedBar.low)}</span><span>{selectedBar.complete ? '收' : '现'} {money(selectedBar.close)}</span><ChangeReadout change={selectedDailyChange} /></> : <span>等待首笔成交，日 K 将由实际成交累积</span>
        : selectedPoint ? <><span>{selectedPoint.time}</span><span>{selectedPoint.executed ? '成交价' : '沿用最新价'} {money(selectedPoint.price)} 元</span><span>{selectedPoint.executed ? `成交量 ${volumeLabel(selectedPoint.volume)} 手` : '本分钟无成交 · 0 手'}</span><ChangeReadout change={intradayChange} /></>
          : <><span>{isListingSession ? '发行价' : '昨收'} {money(base)}</span><span>{points.length ? `均价 ${stock.volume ? money(stock.turnover / stock.volume) : '—'}` : '等待首笔成交'}</span><span>最新成交 {timeline.lastTradeTime ?? '—'}</span>{intradayQuote && <ChangeReadout change={intradayChange} />}</>}
    </div>
    <svg ref={chart} viewBox={`0 0 ${width} ${height}`} className={`price-chart${isDaily ? ' price-chart--daily' : ''}`} role="img" tabIndex={0}
      data-window-start={range.start} data-window-size={range.size}
      data-market-time={time} data-last-trade-time={timeline.lastTradeTime ?? ''}
      aria-label={`${stock.name}${isDaily ? '日 K 蜡烛图及成交量，可用左右键查看每日开高低收和涨跌幅，加减键缩放，PageUp 和 PageDown 移动范围' : '分时成交价格及成交量，可用左右方向键查看成交和涨跌幅'}`}
      aria-describedby={`${id}-description`}
      onPointerLeave={event => { if (event.pointerType === 'mouse' && !drag.current) setHover(null); }}
      onPointerMove={event => {
        const gesture = drag.current;
        if (isDaily && gesture && gesture.pointerId === event.pointerId) {
          const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
          if (gesture.moved || Math.abs(dx) > 5 && Math.abs(dx) > Math.abs(dy)) {
            gesture.moved = true;
            const plotPixels = event.currentTarget.getBoundingClientRect().width * (plotWidth - 8) / width;
            updateRange(panChartWindow(allBars.length, gesture.range, -Math.round(dx / plotPixels * gesture.range.size)));
            return;
          }
        }
        selectAt(event.clientX, event.currentTarget);
      }}
      onPointerDown={event => {
        selectAt(event.clientX, event.currentTarget);
        if (isDaily && event.button === 0) {
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, range, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onPointerUp={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null;
      }}
      onPointerCancel={() => { drag.current = null; setHover(null); }}
      onKeyDown={event => {
        if (isDaily && ['+', '=', '-', 'PageUp', 'PageDown'].includes(event.key)) {
          event.preventDefault();
          if (event.key === 'PageUp' || event.key === 'PageDown') pan(Math.round(range.size / 3) * (event.key === 'PageUp' ? -1 : 1));
          else zoom(event.key === '-' ? 1.25 : .8);
          return;
        }
        if (!count || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Escape') setHover(null);
        else if (event.key === 'Home') setHover(0);
        else if (event.key === 'End') setHover(count - 1);
        else setHover(Math.max(0, Math.min(count - 1, selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1))));
      }}>
      <desc id={`${id}-description`}>{isDaily ? '每根蜡烛表示一个交易日的开盘、最高、最低和收盘价。开局前为模拟历史，开局后采用实际成交。MA5、MA10、MA20 为图中的黄、蓝、紫色均线。滚轮缩放、横向拖动查看历史。' : '上方折线随交易时间延伸，无成交分钟沿用最后成交价。下方柱状图只表示真实成交量；无成交时为零。午休不延伸。'}红色上涨，绿色下跌。成交量单位手，1 手为 100 股。金色圆点、蓝色三角分别表示你的近期买入、卖出成交，按{isDaily ? '日' : '分钟'}合并，位置为这些成交的加权均价。悬停标记可查看数量和均价，仅包含近期记录。</desc>
      <defs><linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1"><stop stopColor={lineColor} stopOpacity=".13" /><stop offset="1" stopColor={lineColor} stopOpacity="0" /></linearGradient></defs>
      <text x="0" y="12" className="chart-pane-label">{isDaily ? '日 K · 开高低收' : '成交价格'}</text><text x={plotWidth + 8} y="12" className="chart-unit">元</text>
      {[0, 1, 2, 3].map(i => <g key={i}><line x1="0" x2={plotWidth} y1={priceTop + i / 3 * (priceBottom - priceTop)} y2={priceTop + i / 3 * (priceBottom - priceTop)} className="grid-line" /><text x={plotWidth + 8} y={priceTop + 4 + i / 3 * (priceBottom - priceTop)}>{money(hi - i / 3 * (hi - lo))}</text></g>)}
      {[.25, .5, .75].map(i => <line key={i} x1={plotWidth * i} x2={plotWidth * i} y1={priceTop} y2={priceBottom} className="grid-line vertical" />)}
      {!isDaily && <line x1="0" x2={plotWidth} y1={y(base)} y2={y(base)} className="previous-line" />}
      {!isDaily && <line x1={intradayX(timeline.cursor)} x2={intradayX(timeline.cursor)} y1={priceTop} y2={volumeBottom} className="chart-time-cursor" />}
      {!isDaily && points.length > 0 && <><polygon fill={`url(#${id}-fill)`} points={`${x(0)},${priceBottom} ${line} ${x(points.length - 1)},${priceBottom}`} /><polyline points={line} className="price-line" style={{ stroke: lineColor }} /><circle cx={x(points.length - 1)} cy={y(points[points.length - 1].price)} r="2.5" fill={lineColor} /></>}
      {isDaily && bars.map((bar, index) => {
        const color = bar.close >= bar.open ? upColor : downColor;
        const candleWidth = Math.max(1, Math.min(22, dailyStep * .65));
        const bodyHeight = Math.max(1, Math.abs(y(bar.open) - y(bar.close)));
        return <g key={bar.day} className="daily-candle" data-day={bar.day} data-complete={bar.complete}>
          <line x1={x(index)} x2={x(index)} y1={y(bar.high)} y2={y(bar.low)} stroke={color} strokeWidth="1" />
          <rect x={x(index) - candleWidth / 2} y={Math.min(y(bar.open), y(bar.close))} width={candleWidth} height={bodyHeight} fill={bar.close > bar.open ? '#172b2c' : color} stroke={color} strokeWidth="1" />
        </g>;
      })}
      {isDaily && movingAverages.filter(ma => visibleMA.has(ma.period)).flatMap(ma => {
        const segments: { points: string[]; start: number }[] = [];
        let segment: { points: string[]; start: number } | undefined;
        ma.values.forEach((value, index) => {
          if (value === null) { segment = undefined; return; }
          if (!segment) { segment = { points: [], start: index }; segments.push(segment); }
          segment.points.push(`${x(index)},${y(value)}`);
        });
        return segments.map(segment => segment.points.length > 1
          ? <polyline key={`${ma.period}-${segment.start}`} points={segment.points.join(' ')} fill="none" stroke={maColors[ma.period]} strokeWidth="1.9" className={`ma-line ma-${ma.period}`} />
          : <circle key={`${ma.period}-${segment.start}`} cx={x(segment.start)} cy={y(ma.values[segment.start]!)} r="2" fill={maColors[ma.period]} className={`ma-line ma-${ma.period}`} />);
      })}
      {playerTrades.map(group => {
        const markerX = isDaily ? x(bars.findIndex(bar => bar.day === group.day)) : intradayX(intradayMinute(group.time!));
        const markerY = y(group.valueCents / group.quantity / 100);
        return <g key={group.key} className={`chart-player-trade chart-player-trade--${group.side}`}
          data-trade-day={group.day} data-trade-time={group.time} data-trade-quantity={group.quantity}
          role="img" aria-label={tradeGroupDescription(group)}>
          <title>{tradeGroupDescription(group)}</title>
          {group.side === 'buy' ? <circle cx={markerX} cy={markerY} r="4.2" />
            : <path d={`M ${markerX} ${markerY - 5} L ${markerX + 5} ${markerY + 4} L ${markerX - 5} ${markerY + 4} Z`} />}
        </g>;
      })}
      <line x1="0" x2={plotWidth} y1={dividerY} y2={dividerY} className="grid-line chart-pane-divider" />
      <text x="0" y={volumeLabelY} className="chart-pane-label">成交量 · 手</text><text x={plotWidth} y={volumeLabelY} textAnchor="end" className="chart-volume-value">{selectedIndex >= 0 && (isDaily || hover !== null) ? `${volumeLabel((isDaily ? bars : points)[selectedIndex].volume)} 手` : '1 手 = 100 股'}</text>
      {(isDaily ? bars : points).map((point, index) => {
        if (!isDaily && point.volume === 0) return null;
        const color = isDaily ? bars[index].close >= bars[index].open ? upColor : downColor : points[index].price >= (points[index - 1]?.price ?? base) ? upColor : downColor;
        const barWidth = isDaily ? Math.max(1, Math.min(22, dailyStep * .65)) : Math.max(1, (plotWidth - 8) / 245 * .7);
        const barHeight = point.volume / maxVolume * (volumeBottom - volumeTop);
        return <rect key={index} x={x(index) - barWidth / 2} y={volumeBottom - barHeight} width={barWidth} height={Math.max(.5, barHeight)} fill={color} opacity=".72" className="volume-bar" />;
      })}
      <line x1="0" x2={plotWidth} y1={volumeBottom + 1} y2={volumeBottom + 1} className="grid-line" />
      <text x={plotWidth + 8} y={volumeTop + 4}>{volumeLabel(maxVolume)}</text><text x={plotWidth + 8} y={volumeBottom + 3}>0</text>
      {hover !== null && count > 0 && <g><line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={priceTop - 3} y2={volumeBottom} stroke="#c4c9b0" strokeDasharray="3 4" />{!isDaily && selectedPoint && <circle cx={x(selectedIndex)} cy={y(selectedPoint.price)} r="3" fill={lineColor} />}</g>}
      {!count && !playerTrades.length && <text x={plotWidth / 2} y={(priceTop + priceBottom) / 2} textAnchor="middle" className="chart-empty">{isDaily ? '成交后，留下第一根日 K' : phase === 'auction' ? '竞价结束后记录首笔成交' : '尚无成交，等待买卖报价撮合'}</text>}
    </svg>
    {isDaily ? <div className="chart-time chart-daily-range"><span>{bars.length ? `${bars[0].date.slice(5)}${bars.length > 1 ? ` — ${bars.at(-1)?.date.slice(5)}` : ''}` : '—'}</span><span>共 {allBars.length} 个交易日{range.start + range.size === allBars.length ? ' · 最新' : ''}</span></div>
      : <><div className="chart-time"><span>09:25</span><span>11:30 / 13:00</span><span>15:00</span></div><p className="chart-history-note chart-live-note"><span>市场时间 {time}</span><span>无成交时横向延续，成交量为 0</span></p></>}
    <div className="chart-player-legend" aria-label="你的近期成交标记">
      <span>你的近期成交</span><span><i className="chart-player-key chart-player-key--buy" />买入</span><span><i className="chart-player-key chart-player-key--sell" />卖出</span>
      <small>按{isDaily ? '日' : '分钟'}合并 · 仅含近期记录</small>
    </div>
    {isDaily && <p className="chart-history-note">{stock.listedDay ? `第 ${stock.listedDay} 交易日上市；日 K 从首笔成交开始记录。积累满 5 / 10 / 20 日后显示对应均线。`
      : <>开局前为模拟历史{stock.dailyHistoryStartDay > 1 ? `；本存档第 ${stock.dailyHistoryStartDay} 日起记录实际行情，缺失日期不补造。` : '，开局后由实际成交延续。'}</>}</p>}
  </div>;
}
