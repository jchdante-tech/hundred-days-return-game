import type { OpeningScenarioView } from './opening-scenario.js';
export type Phase = 'auction' | 'morning' | 'lunch' | 'afternoon' | 'closing' | 'night' | 'ended';
export type OrderSide = 'buy' | 'sell' | 'finance' | 'short' | 'cover' | 'creditSell' | 'marginBuy' | 'marginShort' | 'marginSell' | 'marginCover';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'partial';
export type OrderCancelReason = 'user' | 'day-expired' | 'game-ended';
export interface OrderInput { stockId: string; side: OrderSide; quantity: number; price: number }
export interface MarginOpenInput { stockId: string; direction: 'long' | 'short'; mode: 'isolated' | 'cross'; leverage: 1 | 2 | 3; principal: number; price: number }
export interface MarginCloseInput { positionId: string; quantity: number; price: number }
export interface MarginAddInput { accountId: string; amount: number }
export interface MarginAccountView { id: string; mode: 'isolated' | 'cross'; cash: number; assets: number; equity: number; debt: number; grossExposure: number; pendingExposure: number; marginRatio: number; riskLevel: 'normal' | 'warning' | 'liquidating'; interest: number; contributedPrincipal: number }
export interface MarginPositionView { id: string; accountId: string; stockId: string; direction: 'long' | 'short'; leverage: 1 | 2 | 3; quantity: number; availableQuantity: number; todayQuantity: number; entryPrice: number; currentPrice: number; principal: number; loan: number; lockedProceeds: number; unrealizedPnl: number; marketValue: number; liquidationPrice: number | null }
export interface MarginView { accounts: MarginAccountView[]; positions: MarginPositionView[]; financeLimit: number; financeUsed: number; financeAvailable: number; shortLimit: number; shortUsed: number; shortAvailable: number; warningRatio: number; liquidationRatio: number; totalDebt: number; financingDebt: number; interest: number; dailyInterest: number }
export interface CollateralTransferInput { direction: 'in' | 'out'; cash?: number; stockId?: string; quantity?: number }
export interface ActionResult { ok: boolean; message: string }
export interface PriceLevel { price: number; quantity: number }
export interface PricePoint { time: string; price: number; volume: number }
export interface DailyBar {
  day: number; date: string; open: number; high: number; low: number; close: number;
  volume: number; turnover: number; complete: boolean;
  origin?: 'background' | 'session';
}
export interface LimitBoardView {
  status: 'none' | 'touched' | 'sealed' | 'opened' | 'closed-limit';
  // Completed sessions only; candidateStreak is the potential result while trading.
  upStreak: number; candidateStreak: number; touched: boolean; breakCount: number | null;
  queuedBuyQuantity: number; queuedBuyAmount: number;
}
export interface IpoFactors {
  demand: 'weak' | 'steady' | 'strong'; issuePe: number; peerPe: number; offeredShares: number; floatRatio: number;
}
export interface IpoOfferView {
  id: string; stockId: string; name: string; sector: string; description: string; concepts: string[];
  announcementDay: number; listingDay: number; status: 'subscribing' | 'awaiting-listing' | 'listed' | 'cancelled';
  cancelReason?: 'game-ended' | 'no-demand';
  issuePrice: number; totalShares: number; offeredShares: number; demand: 'weak' | 'steady' | 'strong';
  issuePe: number; peerPe: number; floatRatio: number; quotaQuantity: number; quotaAmount: number;
  subscribedQuantity: number; reservedAmount: number; allocatedQuantity: number | null;
  allocatedAmount: number | null; refundAmount: number | null; subscriptionRate: number | null; issuedQuantity: number | null;
}
export interface ChipView {
  totalShares: number; floatShares: number; floatMarketCap: number; inactiveShares: number;
  playerRatio: number;
  // Aggregate game estimates, rounded to five percentage points. No individual NPC positions or plans.
  concentrationRatio: number; concentration: 'dispersed' | 'concentrated' | 'high';
  supply: 'ample' | 'balanced' | 'tight'; profitPressure: 'low' | 'medium' | 'high';
  t1LockedRatio: number;
}
export interface StockView {
  id: string; code: string; name: string; sector: string; concepts: string[]; description: string;
  price: number; previousClose: number; change: number; changePercent: number; open: number;
  high: number; low: number; volume: number; turnover: number; limitUp: number; limitDown: number;
  marketCap: number; pe: number; financeEligible: boolean; shortEligible: boolean; shortAvailable: number;
  bids: PriceLevel[]; asks: PriceLevel[]; history: PricePoint[];
  dailyBars: DailyBar[]; dailyHistoryStartDay: number;
  limitBoard?: LimitBoardView;
  listedDay?: number; issuePrice?: number; ipoFactors?: IpoFactors;
  chips?: ChipView;
}
export interface PositionView {
  stockId: string; quantity: number; available: number; frozen: number; todayBought: number;
  financedQuantity: number; averageCost: number; marketValue: number; profit: number;
  shortQuantity: number; shortToday: number; shortProceeds: number;
}
/** Actual fills during this order's submission, not later resting-order fills. */
export interface OrderExecutionView {
  filled: number; amount: number; averagePrice: number | null; priceLevels: number;
  // Absent without immediate fills, or if other orders traded between this
  // order's fills. These prices never attribute unrelated market movement.
  beforePrice?: number; afterPrice?: number;
}
export interface OrderView {
  marginAccountId?: string; marginPositionId?: string;
  // Optional for historical saves that did not record this metadata.
  day?: number; cancelReason?: OrderCancelReason;
  execution?: OrderExecutionView;
  id: string; stockId: string; side: OrderSide; quantity: number; remaining: number; filled: number;
  price: number; status: OrderStatus; time: string; frozenCash: number; frozenQuantity: number;
}
export interface TradeView {
  id: string; stockId: string; price: number; quantity: number; time: string;
  day?: number;
  side: OrderSide | 'market'; buyer?: string; seller?: string;
}
export interface NewsImpact {
  sector: string; direction: 'positive' | 'negative'; reason: string;
}
export interface NewsView {
  id: string; time: string; headline: string; body: string; sector?: string; day?: number;
  sentiment: 'positive' | 'negative' | 'neutral';
  impacts: NewsImpact[];
  storyId?: string; stage?: 'proposal' | 'progress' | 'result' | 'delivery'; stockIds?: string[];
}
export interface SeatView { name: string; buy: number; sell: number; net: number }
export interface SectorFlowView {
  sector: string; inflow: number; outflow: number; neutral: number; net: number; turnover: number;
}
export interface SeatStockActivityView {
  stockId: string; stockName: string; sector: string;
  buy: number; sell: number; net: number; buyQuantity: number; sellQuantity: number;
}
export interface SeatActivityView {
  seatId: string; name: string; buy: number; sell: number; net: number; stocks: SeatStockActivityView[];
  observations?: { stockId: string; text: string; kind: 'concentration' | 'continuation' | 'reduced' | 'reversed' }[];
}
export interface PostCloseReport {
  day: number; date: string; sectorFlows: SectorFlowView[]; seats: SeatActivityView[];
}
export interface LeaderboardView {
  stockId: string; stockName: string; reason: string; day: number;
  buyers: SeatView[]; sellers: SeatView[]; totalBuy: number; totalSell: number;
}
export interface LedgerView {
  id: string; day: number; time: string; kind: string; description: string; amount: number;
}
export interface CreditView {
  debt: number; financingDebt: number; interest: number; dailyInterest: number;
  ordinaryCash: number; cashBalance: number; cashAvailable: number; withdrawableCash: number;
  accountAssets: number; maintenance: number; migrationNotice: string | null;
  transferablePositions: { stockId: string; quantity: number; ratio: number; marketValue: number }[];
  positions: { stockId: string; quantity: number; available: number; todayBought: number; financedQuantity: number;
    pledgedQuantity: number; withdrawableQuantity: number; marketValue: number }[];
  risk: { level: 'normal' | 'warning' | 'margin-call'; warningLine: number; callLine: number;
    restoreLine: number; targetLine: number; topUpAmount: number; repayAmount: number; marginCallDay: number | null };
  // Public amounts use yuan; ratios use fractions. These are game contract terms.
  financeLimit: number; financeUsed: number; financePending: number; financeAvailable: number;
  shortLimit: number; shortUsed: number; shortPending: number; shortAvailableAmount: number;
  collateralCash: number; collateralStockValue: number; collateralTotal: number;
  collateralOccupied: number; collateralPending: number; collateralAvailable: number;
  financeMarginRatio: number; shortMarginRatio: number; borrowAnnualRate: number;
  repayAvailable: number;
  collateralPositions: { stockId: string; quantity: number; marketValue: number; ratio: number; collateralValue: number }[];
  pools: { stockId: string; total: number; borrowed: number; reserved: number; available: number; playerMaxQuantity: number }[];
}
export interface MarketView {
  openingScenario?: OpeningScenarioView;
  revision: number; phase: Phase; phaseLabel: string; time: string;
  day: number; daysLeft: number; calendarDate: string; deadlineDate: string;
  paused: boolean; speed: 1 | 4 | 12; phaseProgress: number;
  challenge: { target: number; paid: number; remaining: number; startingCapital: number } | null;
  creditUnlocked: boolean; creditUnlockDay: number;
  credit: CreditView;
  margin: MarginView;
  assets: number; equity: number; debt: number; financingDebt: number; shortLiability: number;
  interest: number; cash: number; availableCash: number; frozenCash: number; restrictedCash: number;
  maintenance: number; financeAvailable: number; annualInterestRate: number; dailyInterest: number;
  riskLevel: 'normal' | 'warning' | 'margin-call' | 'default' | 'repaid';
  riskMessage: string; result: null | 'won' | 'default';
  stocks: StockView[]; positions: PositionView[]; orders: OrderView[];
  trades: TradeView[]; news: NewsView[]; leaderboard: LeaderboardView[]; ledger: LedgerView[];
  seatFlows: SeatView[]; postClose: PostCloseReport | null;
  ipos?: IpoOfferView[];
}
