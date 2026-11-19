import type { PostCloseReport, SeatActivityView, SeatStockActivityView, SectorFlowView } from '../shared/types.js';
import type { Market } from './engine.js';

const yuan = (cents: number) => cents / 100;
const namedSeat = (id: string) => /^ai[0-5]$/.test(id);
type Observation = { stockId: string; text: string; kind: 'concentration' | 'continuation' | 'reduced' | 'reversed' };

/** Describes executed transactions only. Missing days break continuity; no private AI plans are read. */
function observationsFor(market: Market, seat: SeatActivityView): Observation[] {
  const reports = new Map<number, PostCloseReport>();
  for (const report of [...(market.postCloseHistory ?? []), ...(market.postClose ? [market.postClose] : [])]) {
    if (report.day < market.day) reports.set(report.day, report);
  }
  const yesterday = reports.get(market.day - 1)?.seats.find(prior => prior.seatId === seat.seatId);
  const candidates: (Observation & { priority: number; amount: number })[] = [];
  const currentStocks = new Map(seat.stocks.map(stock => [stock.stockId, stock]));
  const ids = new Set([...currentStocks.keys(), ...(yesterday?.stocks.map(stock => stock.stockId) ?? [])]);
  for (const stockId of ids) {
    const current = currentStocks.get(stockId), previous = yesterday?.stocks.find(stock => stock.stockId === stockId);
    const name = current?.stockName ?? previous!.stockName;
    let consecutive = (current?.net ?? 0) > 0 ? 1 : 0;
    if (consecutive) {
      for (let day = market.day - 1; day >= 1; day--) {
        const row = reports.get(day)?.seats.find(prior => prior.seatId === seat.seatId)?.stocks.find(stock => stock.stockId === stockId);
        if (!row || row.net <= 0) break;
        consecutive++;
      }
    }
    if (previous && previous.net > 0 && current && current.net < 0) {
      candidates.push({ stockId, kind: 'reversed', text: `${name}由昨日净买入转为今日净卖出。`, priority: 4, amount: current.buy + current.sell });
    } else if (previous && previous.buy > 0 && cents(current?.buy ?? 0) * 100 <= cents(previous.buy) * 60) {
      const decline = Math.round((1 - (current?.buy ?? 0) / previous.buy) * 100);
      const text = consecutive >= 2 ? `连续 ${consecutive} 个交易日净买入${name}，但今日买入金额比昨日减少 ${decline}%。`
        : (current?.buy ?? 0) === 0 ? `${name}今日没有买入成交，昨日曾买入。`
          : `${name}今日买入金额比昨日减少 ${decline}%。`;
      candidates.push({ stockId, kind: 'reduced', text, priority: 3, amount: previous.buy });
    } else if (consecutive >= 2) {
      candidates.push({ stockId, kind: 'continuation', text: `已连续 ${consecutive} 个交易日净买入${name}。`, priority: 2, amount: current!.buy });
    }
  }
  if (seat.buy > 0) {
    const mostBought = seat.stocks.reduce<SeatStockActivityView | null>((most, stock) => !most || stock.buy > most.buy ? stock : most, null);
    if (mostBought && mostBought.buy / seat.buy >= .5) {
      candidates.push({ stockId: mostBought.stockId, kind: 'concentration',
        text: `今日买入金额的 ${Math.round(mostBought.buy / seat.buy * 100)}% 集中在${mostBought.stockName}。`,
        priority: 1, amount: mostBought.buy });
    }
  }
  const seen = new Set<string>();
  return candidates.sort((a, b) => b.priority - a.priority || b.amount - a.amount || a.stockId.localeCompare(b.stockId))
    .filter(item => { if (seen.has(item.stockId)) return false; seen.add(item.stockId); return true; })
    .slice(0, 2).map(({ stockId, text, kind }) => ({ stockId, text, kind }));
}

/** Prices and all intermediate totals are integer cents; only the public report uses yuan. */
export function buildPostCloseReport(market: Market, date = market.calendarDate): PostCloseReport {
  const stocks = new Map(market.stocks.map(stock => [stock.id, stock]));
  const sectors = new Map<string, SectorFlowView>(market.stocks.map(stock => [stock.sector,
    { sector: stock.sector, inflow: 0, outflow: 0, neutral: 0, net: 0, turnover: 0 }]));
  const seats = new Map<string, SeatActivityView>(market.actors.filter(actor => namedSeat(actor.id)).map(actor => [actor.id,
    { seatId: actor.id, name: actor.name, buy: 0, sell: 0, net: 0, stocks: [] }]));
  const previous = new Map<string, { price: number; direction: -1 | 0 | 1 }>();

  // The engine appends fills in matching order. Sorting by string IDs would change the tick rule.
  for (const trade of market.trades) {
    if (trade.day !== market.day) continue;
    const stock = stocks.get(trade.stockId)!;
    const amount = trade.price * trade.quantity;
    const last = previous.get(stock.id);
    const auction = trade.time === '09:25' || trade.time === '15:00';
    const direction = auction || !last ? 0 : trade.price > last.price ? 1
      : trade.price < last.price ? -1 : last.direction;
    const sector = sectors.get(stock.sector)!;
    sector[direction > 0 ? 'inflow' : direction < 0 ? 'outflow' : 'neutral'] += amount;
    sector.turnover += amount;
    previous.set(stock.id, { price: trade.price, direction });

    for (const [actorId, side, quantityKey] of [[trade.buyerId, 'buy', 'buyQuantity'],
      [trade.sellerId, 'sell', 'sellQuantity']] as const) {
      const seat = seats.get(actorId);
      if (!seat) continue;
      let row = seat.stocks.find(item => item.stockId === stock.id);
      if (!row) {
        row = { stockId: stock.id, stockName: stock.name, sector: stock.sector,
          buy: 0, sell: 0, net: 0, buyQuantity: 0, sellQuantity: 0 };
        seat.stocks.push(row);
      }
      row[side] += amount; row[quantityKey] += trade.quantity;
      seat[side] += amount;
    }
  }
  const publicSeats = [...seats.values()].map(seat => ({ seatId: seat.seatId, name: seat.name,
    buy: yuan(seat.buy), sell: yuan(seat.sell), net: yuan(seat.buy - seat.sell),
    stocks: seat.stocks.map(row => ({ ...row, buy: yuan(row.buy), sell: yuan(row.sell), net: yuan(row.buy - row.sell) }))
      .sort((a, b) => b.buy + b.sell - a.buy - a.sell || a.stockId.localeCompare(b.stockId)),
  }));
  return {
    day: market.day, date,
    sectorFlows: [...sectors.values()].map(row => ({ sector: row.sector,
      inflow: yuan(row.inflow), outflow: yuan(row.outflow), neutral: yuan(row.neutral),
      net: yuan(row.inflow - row.outflow), turnover: yuan(row.turnover),
    })).sort((a, b) => b.net - a.net || a.sector.localeCompare(b.sector, 'zh-CN')),
    seats: publicSeats.map(seat => ({ ...seat, observations: observationsFor(market, seat),
    })).sort((a, b) => b.buy + b.sell - a.buy - a.sell || a.seatId.localeCompare(b.seatId)),
  };
}

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function monetary(value: unknown, signed = false): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (!signed && value < 0)) return false;
  const scaled = value * 100;
  return Number.isSafeInteger(Math.round(scaled)) && Math.abs(scaled - Math.round(scaled)) < .00001;
}
const cents = (value: number) => Math.round(value * 100);
const quantity = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) % 100 === 0;

/** A stored DTO must not be able to smuggle private actor/order state into the public view. */
export function validPostCloseReport(value: unknown, market: Market): value is PostCloseReport {
  if (!objectWithKeys(value, ['day', 'date', 'sectorFlows', 'seats'])) return false;
  const report = value as unknown as PostCloseReport;
  if (!Number.isSafeInteger(report.day) || report.day < 1 || report.day > market.day
    || (report.day === market.day && market.phase !== 'night' && market.phase !== 'ended')
    || typeof report.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(report.date)
    || !Number.isFinite(Date.parse(`${report.date}T00:00:00Z`))
    || new Date(`${report.date}T00:00:00Z`).toISOString().slice(0, 10) !== report.date
    || report.date < '2026-10-20' || report.date > market.calendarDate
    || (report.day < market.day && report.date >= market.calendarDate)
    || (report.day === market.day && market.phase === 'night' && report.date !== market.calendarDate)) return false;
  // Coverage grows only at an opening. Yesterday's report must retain the
  // sectors that existed then, including after a save migrates to more stocks.
  const coveredStocks = market.stocks.filter(stock => (stock.coverageStartDay ?? stock.listedDay ?? 1) <= report.day);
  const sectors = new Set(coveredStocks.map(stock => stock.sector));
  if (!Array.isArray(report.sectorFlows) || report.sectorFlows.length !== sectors.size) return false;
  for (const row of report.sectorFlows) {
    if (!objectWithKeys(row, ['sector', 'inflow', 'outflow', 'neutral', 'net', 'turnover'])
      || !sectors.delete(row.sector as string)
      || ![row.inflow, row.outflow, row.neutral, row.turnover].every(value => monetary(value))
      || !monetary(row.net, true)
      || cents(row.inflow as number) - cents(row.outflow as number) !== cents(row.net)
      || cents(row.inflow as number) + cents(row.outflow as number) + cents(row.neutral as number) !== cents(row.turnover as number)) return false;
  }
  const seats = new Map(market.actors.filter(actor => namedSeat(actor.id)).map(actor => [actor.id, actor.name]));
  if (!Array.isArray(report.seats) || report.seats.length !== seats.size) return false;
  for (const seat of report.seats) {
    if (!objectWithKeys(seat, ['seatId', 'name', 'buy', 'sell', 'net', 'stocks', ...(seat && Object.hasOwn(seat, 'observations') ? ['observations'] : [])])
      || (seats.get(seat.seatId as string) !== seat.name
        && !(report.day < market.day && seat.seatId === 'ai3' && seat.name === '南湾路 · 流动资金'
          && seats.get('ai3') === '南湾路 · 轮动资金')) || !seats.delete(seat.seatId as string)
      || !monetary(seat.buy) || !monetary(seat.sell) || !monetary(seat.net, true)
      || cents(seat.buy) - cents(seat.sell) !== cents(seat.net)
      || !Array.isArray(seat.stocks) || seat.stocks.length > coveredStocks.length) return false;
    const seen = new Set<string>();
    let buy = 0, sell = 0;
    for (const value of seat.stocks) {
      if (!objectWithKeys(value, ['stockId', 'stockName', 'sector', 'buy', 'sell', 'net', 'buyQuantity', 'sellQuantity'])) return false;
      const row = value as unknown as SeatStockActivityView;
      const stock = coveredStocks.find(stock => stock.id === row.stockId);
      if (!stock || seen.has(row.stockId) || row.stockName !== stock.name || row.sector !== stock.sector
        || !monetary(row.buy) || !monetary(row.sell) || !monetary(row.net, true)
        || cents(row.buy) - cents(row.sell) !== cents(row.net)
        || !quantity(row.buyQuantity) || !quantity(row.sellQuantity)
        || row.buyQuantity + row.sellQuantity <= 0
        || (row.buyQuantity === 0) !== (row.buy === 0) || (row.sellQuantity === 0) !== (row.sell === 0)) return false;
      seen.add(row.stockId); buy += cents(row.buy); sell += cents(row.sell);
    }
    if (buy !== cents(seat.buy) || sell !== cents(seat.sell)) return false;
    if (Object.hasOwn(seat, 'observations')) {
      if (!Array.isArray(seat.observations) || seat.observations.length > 2) return false;
      const observed = new Set<string>();
      for (const observation of seat.observations) {
        if (!objectWithKeys(observation, ['stockId', 'text', 'kind'])
          || typeof observation.stockId !== 'string' || !coveredStocks.some(stock => stock.id === observation.stockId)
          || observed.has(observation.stockId) || typeof observation.text !== 'string' || !observation.text.trim() || observation.text.length > 240
          || /[\u0000-\u001F\u007F]/.test(observation.text)
          || !['concentration', 'continuation', 'reduced', 'reversed'].includes(observation.kind as string)) return false;
        observed.add(observation.stockId);
      }
    }
  }
  return true;
}
