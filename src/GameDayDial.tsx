export default function GameDayDial({ day }: { day: number }) {
  return <div className="day-dial game-day-dial" aria-label={`第 ${day} 个交易日`}>
    <img src="/art/day-dial-v18.png" width={1254} height={1254} alt="" aria-hidden="true" draggable={false} />
    <div className="game-day-dial-face"><span>交易日</span><strong>{String(day).padStart(2, '0')}</strong></div>
  </div>;
}
