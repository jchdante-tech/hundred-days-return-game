import type { OrderSide } from '../shared/types';
export const money = (n: number, digits = 2) => n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const compact = (n: number) => Math.abs(n) >= 1e8 ? `${money(n / 1e8)} 亿` : Math.abs(n) >= 1e4 ? `${money(n / 1e4)} 万` : money(n);
export const signed = (n: number) => `${n >= 0 ? '+' : ''}${money(n)}`;
export const sideNames: Record<OrderSide, string> = { buy: '买入', sell: '卖出', finance: '融资买入', short: '融券卖出', cover: '买回还券', creditSell: '卖出还钱', marginBuy: '杠杆做多', marginShort: '杠杆做空', marginSell: '平多仓', marginCover: '平空仓' };
