const icons = {
  trading: 0, news: 1, holdings: 2, leverage: 3,
  board: 4, ledger: 5, guide: 6, assets: 7,
  cash: 8, debt: 9, deadline: 10, clock: 11,
} as const;

export type GameIconName = keyof typeof icons;

/** The generated atlas has twelve square cells; labels remain accessible HTML. */
export default function GameIcon({ name, className = '' }: { name: GameIconName; className?: string }) {
  const cell = icons[name];
  return <i className={`game-icon ${className}`.trim()} data-icon={name} aria-hidden="true"
    style={{ backgroundPosition: `${cell % 4 / 3 * 100}% ${Math.floor(cell / 4) / 2 * 100}%` }} />;
}
