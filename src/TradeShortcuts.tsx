import { tradeShortcutOptions } from './trade-shortcuts';
import './trade-shortcuts.css';

export interface TradeShortcutsProps {
  side: 'buy' | 'sell';
  quantity: string;
  price: number;
  availableCash: number;
  /** Ordinary shares available for a new sell, after T+1 and existing sell reservations. */
  availableShares: number;
  disabled: boolean;
  onQuantity: (quantity: string) => void;
}

export default function TradeShortcuts(props: TradeShortcutsProps) {
  const options = tradeShortcutOptions(props);
  const selling = props.side === 'sell';
  return <div className="trade-shortcuts" data-side={props.side}>
    <div className="trade-shortcuts-buttons" role="group" aria-label={selling ? '按可卖股份填写数量' : '快捷填写买入数量'}>
      {options.map(option => {
        const disabled = props.disabled || !!option.disabledReason;
        const shares = `${option.quantity.toLocaleString('zh-CN')} 股`;
        return <button key={option.label} type="button" disabled={disabled}
          aria-pressed={option.quantity > 0 && Number(props.quantity) === option.quantity}
          aria-label={`${selling ? `${option.label}可卖股份，${shares}` : shares}，${option.disabledReason ?? '填入数量'}`}
          title={option.disabledReason ?? `填入 ${shares}`}
          onClick={() => { if (!disabled) props.onQuantity(String(option.quantity)); }}>
          <span>{option.label}</span>{selling && <small>{shares}</small>}
        </button>;
      })}
    </div>
    <p className="trade-shortcuts-note">{selling
      ? '按可卖股数取整，不含今日买入和冻结股份。'
      : '仅填写数量；超出当前可用现金的档位不可选。'}</p>
  </div>;
}
