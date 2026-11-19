import type { LimitBoardView } from '../shared/types';
import { compact, money } from './format';
import './limit-board.css';

export default function LimitBoardStatus({ board }: { board: LimitBoardView }) {
  if (!board.touched && !board.upStreak && !board.queuedBuyQuantity) return null;
  const label = board.status === 'closed-limit'
    ? board.upStreak > 1 ? `收盘 ${board.upStreak} 连板` : '收盘涨停'
    : board.status === 'sealed' ? '涨停排队'
      : board.status === 'opened' ? '触板后回落'
        : board.status === 'touched' ? '今日触板'
          : board.upStreak > 0 ? `此前 ${board.upStreak} 连板` : '涨停价有买单';

  return <details className={`limit-board-status limit-board-${board.status}`}>
    <summary>
      <strong>{label}</strong>
      {board.candidateStreak > 1 && <span>争取 {board.candidateStreak} 连板</span>}
      {board.breakCount !== null && board.breakCount > 0 && <span>开板 {board.breakCount} 次</span>}
      {board.queuedBuyQuantity > 0 && <span className="limit-board-queue">排队 {compact(board.queuedBuyQuantity)} 股</span>}
      <span className="limit-board-explain">说明</span>
    </summary>
    <div className="limit-board-description">
      {board.queuedBuyQuantity > 0 && <p>涨停价未成交买单 {money(board.queuedBuyQuantity, 0)} 股，约 {compact(board.queuedBuyAmount)} 元。买单可以撤回，排队金额不等于已成交资金。</p>}
      <p>{board.status === 'closed-limit' ? '连板只计算连续交易日的实际收盘涨停。收盘后委托已撤销，此处不代表仍有封单。'
        : board.status === 'sealed' ? '最新成交在涨停价，涨停价有真实买单排队，当前没有可与之成交的卖单。盘中排队不保证收盘涨停。'
          : board.status === 'opened' ? '本日曾在涨停价成交，随后又有低于涨停价的成交。开板次数按逐笔成交计算。'
            : board.status === 'touched' ? '本日已在涨停价实际成交。触板不等于封住，只有收盘仍在涨停价才计入连板。'
              : '昨日的连板不代表今日已经涨停。挂在涨停价的买单也不代表已经成交。'}</p>
      {board.breakCount === null && <p>旧记录的当日逐笔数据不完整，暂不显示确切开板次数。</p>}
    </div>
  </details>;
}
