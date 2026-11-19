import type { ChipView } from '../shared/types';
import { compact, money } from './format';

const concentrationNames: Record<ChipView['concentration'], string> = {
  dispersed: '筹码分散', concentrated: '筹码集中', high: '高度集中',
};
const supplyNames: Record<ChipView['supply'], string> = {
  ample: '卖盘较松', balanced: '卖盘适中', tight: '卖盘偏紧',
};
const profitNames: Record<ChipView['profitPressure'], string> = {
  low: '较轻', medium: '适中', high: '较重',
};
const percent = (ratio: number, digits = 0) => `${money(Math.max(0, Math.min(1, ratio)) * 100, digits)}%`;

export default function ChipStructure({ chips, stockName }: { chips?: ChipView; stockName: string }) {
  if (!chips) return null;
  return <details className="chip-structure" aria-label={`${stockName}筹码观察`}>
    <summary data-tour="chips">
      <span className="chip-summary-title">筹码观察</span>
      <span className={`chip-concentration chip-concentration-${chips.concentration}`}>{concentrationNames[chips.concentration]}</span>
      <span className="chip-supply">{supplyNames[chips.supply]}</span>
      <span className="chip-estimate">游戏估算</span>
      <span className="chip-toggle" aria-hidden="true" />
    </summary>
    <div className="chip-content">
      <dl className="chip-metrics">
        <div><dt>局内流通市值</dt><dd>{compact(chips.floatMarketCap)}<span>元</span></dd></div>
        <div><dt>你的筹码占流通盘</dt><dd>{percent(chips.playerRatio, 2)}</dd></div>
        <div><dt>筹码集中度估计</dt><dd>约 {percent(chips.concentrationRatio)}</dd></div>
        <div><dt>获利抛压估计</dt><dd>{profitNames[chips.profitPressure]}</dd></div>
      </dl>
      <p className="chip-share-counts">总股本 {compact(chips.totalShares)} 股<span>·</span>局内流通 {compact(chips.floatShares)} 股</p>
      <p className="chip-share-counts">长期未入场 {compact(chips.inactiveShares)} 股<span>·</span>流通盘中约 {percent(chips.t1LockedRatio)} 今日买入、待 T+1 解锁</p>
      <div className="chip-reading">
        <p>买入成交才会改变筹码分布。筹码集中、持有人惜售时，卖盘可能更薄；继续拉高，也可能引来获利卖盘。</p>
        <p>你的占比包含普通、信用及杠杆多仓，不含融券义务。浮盈不等于现金，卖出还需要买盘承接。</p>
        <p className="chip-reading-note">集中度与抛压是游戏估算，不展示其他席位的精确持仓。T+1 暂时不能卖，和持有人主动惜售是两回事；长期未入场股份在本局不参与交易。</p>
      </div>
    </div>
  </details>;
}
