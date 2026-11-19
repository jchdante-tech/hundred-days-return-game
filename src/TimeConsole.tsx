import { ArrowRight, FastForward, Pause, Play } from '@phosphor-icons/react';
import type { MarketView, Phase } from '../shared/types';
import './time-console.css';
import GameIcon from './GameIcon';
import { useFloatingPanel } from './useFloatingPanel';

type TimeConsoleProps = {
  market: MarketView;
  openingNextDay?: boolean;
  pending: boolean;
  connection: boolean;
  onAction: (body: Record<string, unknown>, silent?: boolean) => unknown;
};

const nextPhase: Record<Phase, string> = {
  auction: '上午交易',
  morning: '午间休市',
  lunch: '下午开盘',
  afternoon: '收盘竞价',
  closing: '收盘复盘',
  night: '下一交易日',
  ended: '本局已结束',
};

export default function TimeConsole({ market, pending, connection, onAction, openingNextDay = false }: TimeConsoleProps) {
  const floating = useFloatingPanel();
  const ended = market.phase === 'ended';
  const night = market.phase === 'night';
  const disabled = pending || connection || ended;
  const running = !market.paused && !night && !ended;
  const stateLabel = connection ? '连接中断' : ended ? '已结束' : night ? '已收盘' : running ? '运行中' : '已暂停';

  return (
    <section ref={floating.panelRef} style={floating.style} className="time-console" data-tour="clock" aria-label="行情时间控制" data-running={running} data-dragging={floating.dragging}>
      <div className="time-console-clock">
        <button type="button" className="time-console-time time-console-drag-handle" {...floating.handleProps}
          aria-label="移动时间控制框：按住拖动，方向键微调，Home 键复位" title="按住时间这一行拖动 · 方向键微调">
          <span className="time-console-grip" aria-hidden="true">⠿</span>
          <GameIcon name="clock" />
          <span className="time-console-day">第 {market.day} 日</span>
          <strong>{market.time}</strong>
          <span className="time-console-phase">{market.phaseLabel}</span>
        </button>
        <span className="time-console-status-tools"><span className="time-console-state">
          <i aria-hidden="true" />{stateLabel}
        </span><button type="button" className="time-console-reset" onClick={floating.reset} disabled={!floating.moved}
          title="恢复到右下角" aria-label="时间控制框复位到右下角">复位</button></span>
      </div>

      <div className="time-console-controls">
        <button
          type="button"
          className="time-console-play"
          data-opening-target="clock-play"
          disabled={disabled || night}
          onClick={() => void onAction({ type: 'pause', paused: !market.paused }, true)}
        >
          {running ? <Pause size={16} weight="fill" aria-hidden="true" /> : <Play size={16} weight="fill" aria-hidden="true" />}
          {ended ? '本局已结束' : night ? '已收盘' : running ? '暂停行情' : '开始行情'}
        </button>
        <div className="time-console-speeds" role="group" aria-label="行情速度">
          {([1, 4, 12] as const).map((speed) => (
            <button
              key={speed}
              type="button"
              aria-label={`${speed} 倍速度`}
              aria-pressed={market.speed === speed}
              disabled={disabled}
              onClick={() => void onAction({ type: 'speed', speed }, true)}
            >
              {speed}<span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="time-console-next"
        data-opening-target="clock-next"
        disabled={disabled}
        onClick={() => void onAction({ type: night || openingNextDay ? 'nextDay' : 'advance' }, true)}
      >
        <span>
          <FastForward size={14} weight="fill" aria-hidden="true" />
          {ended ? nextPhase.ended : openingNextDay ? '收盘并进入第 2 天' : night ? '开始下一交易日' : `快进至${nextPhase[market.phase]}`}
        </span>
        <ArrowRight size={15} aria-hidden="true" />
      </button>
    </section>
  );
}
