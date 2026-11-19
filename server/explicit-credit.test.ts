import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, ensureCreditAccount, getView, transferCreditCollateral, submitOrder, cancelOrder,
  repay, validateMarket, nextDay, type Market } from './engine.js';

function market() {
  const m = createMarket(42, { legacySimulation: true });
  m.day = 20; m.calendarDate = '2026-11-16'; m.elapsedDays = 27; m.paused = false;
  return m;
}
function stock(m: Market, id = 's1', quantity = 1000) {
  const s = m.stocks.find(s => s.id === id)!;
  m.actors[1].positions[id].quantity -= quantity;
  m.actors[1].positions[id].cost -= s.price * quantity;
  m.actors[0].positions[id] = { quantity, today: 0, financed: 0, cost: s.price * quantity };
}
const cashSupply = (m: Market) => m.brokerCash + m.actors.reduce((sum, a) => sum + a.cash, 0)
  + Object.values(m.shorts).reduce((sum, p) => sum + p.proceeds, 0) + (m.challenge?.paid ?? 0);
const deposit = (m: Market, cash: number) => assert.equal(transferCreditCollateral(m, {direction: 'in', cash}).ok, true);

test('cash and shares must be explicitly selected; transfers change neither assets nor debt', () => {
  const m = market(); stock(m);
  const supply = cashSupply(m), initial = getView(m);
  assert.equal(initial.credit.financeAvailable, 0); assert.equal(initial.credit.collateralTotal, 0);
  assert.equal(submitOrder(m, {stockId:'s1', side:'finance', quantity:100, price:12}).ok, false);
  deposit(m, 5000);
  assert.equal(transferCreditCollateral(m, {direction:'in', stockId:'s1', quantity:400}).ok, true);
  const view = getView(m);
  assert.equal(view.credit.cashBalance, 5000); assert.equal(view.credit.collateralStockValue, 2880);
  assert.equal(view.availableCash, 9_995_000); assert.equal(view.positions[0].available, 600);
  assert.equal(view.credit.positions[0].available, 400); assert.equal(view.credit.financeAvailable, 7880);
  assert.equal(view.assets, initial.assets); assert.equal(view.debt, 0); assert.equal(cashSupply(m), supply);
  assert.equal(transferCreditCollateral(m, {direction:'out', cash:5000}).ok, true);
  assert.equal(transferCreditCollateral(m, {direction:'out', stockId:'s1', quantity:400}).ok, true);
  assert.equal(getView(m).availableCash, initial.availableCash); assert.equal(getView(m).positions[0].available,1000);
});

test('normal buy and sell cannot consume credit cash or pledged shares; credit sales retain proceeds', () => {
  const m = market(); stock(m); deposit(m, 10_000_000);
  assert.equal(transferCreditCollateral(m, {direction:'in',stockId:'s1',quantity:1000}).ok,true);
  m.phase='morning'; const supply=cashSupply(m);
  assert.equal(submitOrder(m,{stockId:'s1',side:'buy',quantity:100,price:12.01}).ok,false);
  assert.equal(submitOrder(m,{stockId:'s1',side:'sell',quantity:100,price:11.99}).ok,false);
  assert.equal(submitOrder(m,{stockId:'s1',side:'creditSell',quantity:100,price:11.99}).ok,true);
  assert.equal(getView(m).credit.cashBalance,10_001_199); assert.equal(getView(m).availableCash,0);
  assert.equal(getView(m).credit.positions[0].quantity,900); assert.equal(cashSupply(m),supply);
  assert.equal(validateMarket(m),true);
});

test('pending ordinary orders block deposits and credit orders block withdrawals atomically', () => {
  const m = market(); stock(m);
  assert.equal(submitOrder(m,{stockId:'s1',side:'buy',quantity:100,price:10.8}).ok,true);
  assert.equal(transferCreditCollateral(m,{direction:'in',cash:10_000_000}).ok,false);
  assert.equal(submitOrder(m,{stockId:'s1',side:'sell',quantity:200,price:13.2}).ok,true);
  assert.equal(transferCreditCollateral(m,{direction:'in',stockId:'s1',quantity:1000}).ok,false);
  deposit(m,5000);
  assert.equal(transferCreditCollateral(m,{direction:'in',stockId:'s1',quantity:800}).ok,true);
  assert.equal(submitOrder(m,{stockId:'s3',side:'finance',quantity:500,price:16.2}).ok,true);
  const before=structuredClone(m.creditAccount);
  assert.equal(transferCreditCollateral(m,{direction:'out',cash:5000}).ok,false);
  assert.deepEqual(m.creditAccount,before);
  assert.equal(submitOrder(m,{stockId:'s1',side:'creditSell',quantity:800,price:13.2}).ok,true);
  assert.equal(transferCreditCollateral(m,{direction:'out',stockId:'s1',quantity:100}).ok,false);
  for(const order of [...getView(m).orders]) assert.equal(cancelOrder(m,order.id).ok,true);
  assert.equal(transferCreditCollateral(m,{direction:'out',cash:5000}).ok,true);
  assert.equal(validateMarket(m),true);
});

test('mixed same-stock ownership and T+1 remain isolated through finance repayment and manual withdrawal', () => {
  const m=market(); stock(m,'s1',1000); deposit(m,5000); m.phase='morning';
  assert.equal(submitOrder(m,{stockId:'s1',side:'finance',quantity:100,price:12.01}).ok,true);
  const supply=cashSupply(m);
  assert.equal(getView(m).positions[0].available,1000);
  assert.equal(getView(m).credit.positions[0].available,0);
  assert.equal(submitOrder(m,{stockId:'s1',side:'sell',quantity:100,price:11.99}).ok,true);
  assert.equal(m.actors[0].positions.s1.financed,100); assert.equal(m.principal,120100);
  assert.equal(repay(m,1201).ok,true);
  assert.equal(m.actors[0].positions.s1.financed,0);
  assert.equal(getView(m).credit.positions[0].quantity,100);
  assert.equal(transferCreditCollateral(m,{direction:'out',stockId:'s1',quantity:100}).ok,false);
  m.phase='night'; nextDay(m);
  assert.equal(transferCreditCollateral(m,{direction:'out',stockId:'s1',quantity:100}).ok,true);
  assert.equal(getView(m).credit.positions.length,0); assert.equal(cashSupply(m),supply);
  assert.equal(validateMarket(m),true);
});

test('unpledged wealth cannot improve maintenance or be silently spent for repayment', () => {
  const m=market(); deposit(m,1201); m.phase='morning';
  assert.equal(submitOrder(m,{stockId:'s1',side:'finance',quantity:100,price:12.01}).ok,true);
  m.stocks[0].price=400;
  const view=getView(m);
  assert.ok(view.assets>9_000_000); assert.equal(view.credit.accountAssets,1601);
  assert.ok(view.maintenance<145); assert.equal(view.riskLevel,'margin-call');
  assert.equal(view.credit.risk.topUpAmount,380.65);
  const normal=view.availableCash;
  assert.equal(transferCreditCollateral(m,{direction:'out',cash:1}).ok,false);
  assert.equal(repay(m,1201).ok,true);
  assert.equal(getView(m).availableCash,normal);
  assert.equal(m.principal,0); assert.equal(getView(m).credit.positions[0].quantity,100);
});

test('legacy active credit adopts prior collateral once, debt-free legacy saves do not auto-pledge', () => {
  const old=market(); delete old.creditAccount; old.principal=100_000; stock(old);
  const supply=cashSupply(old), cash=old.actors[0].cash, shares=old.actors[0].positions.s1.quantity;
  assert.equal(validateMarket(old),true); ensureCreditAccount(old);
  assert.equal(old.creditAccount!.cash,cash); assert.equal(old.creditAccount!.positions.s1.quantity,shares);
  assert.match(getView(old).credit.migrationNotice!,/旧存档/); assert.equal(cashSupply(old),supply);
  const snapshot=JSON.stringify(old); ensureCreditAccount(old); assert.equal(JSON.stringify(old),snapshot);
  const clean=market(); delete clean.creditAccount; stock(clean); ensureCreditAccount(clean);
  assert.equal(clean.creditAccount!.cash,0); assert.deepEqual(clean.creditAccount!.positions,{});
  assert.equal(getView(clean).credit.financeAvailable,0);
});

test('malformed credit ledgers and unknown versions are rejected instead of silently remigrated', () => {
  const m=market(); stock(m); deposit(m,1000);
  for(const account of [null,{}, {version:2,cash:0,positions:{}}, {version:1,cash:-1,positions:{}},
    {version:1,cash:m.actors[0].cash+1,positions:{}}, {version:1,cash:0,positions:{unknown:{quantity:100,today:0}}},
    {version:1,cash:0,positions:{s1:{quantity:1100,today:0}}},
    {version:1,cash:0,positions:{s1:{quantity:100,today:100}}}]) {
    assert.equal(validateMarket({...m,creditAccount:account}),false);
  }
  assert.equal(validateMarket(JSON.parse(JSON.stringify(m))),true);
});

test('cover releases only restricted proceeds into credit cash and never draws ordinary cash', () => {
  const m=market(); deposit(m,5000); m.phase='morning'; m.orders=[];
  const addNpc=(side:'buy'|'sell',price:number) => m.orders.push({id:`npc${++m.sequence}`,actorId:'ai1',stockId:'s5',side,
    quantity:100,remaining:100,price,status:'open',time:'09:30',sequence:m.sequence,createdTick:0,
    frozenCash:side==='buy'?price*100:0,restrictedClaim:0});
  addNpc('buy',2200); const supply=cashSupply(m), normal=getView(m).availableCash;
  assert.equal(submitOrder(m,{stockId:'s5',side:'short',quantity:100,price:22}).ok,true);
  assert.equal(getView(m).credit.cashBalance,5000); assert.equal(getView(m).restrictedCash,2200);
  m.shorts.s5.today=0; addNpc('sell',2000);
  assert.equal(submitOrder(m,{stockId:'s5',side:'cover',quantity:100,price:20}).ok,true);
  assert.equal(getView(m).credit.cashBalance,5200); assert.equal(getView(m).availableCash,normal);
  assert.equal(m.stocks[4].lendAvailable,10000); assert.equal(cashSupply(m),supply);
  assert.equal(validateMarket(m),true);
});

test('credit cash resolving a call stops forced sales; ordinary wealth is never swept by a call', () => {
  const recovered=market(); deposit(recovered,1202); recovered.phase='morning';
  assert.equal(submitOrder(recovered,{stockId:'s1',side:'finance',quantity:100,price:12.01}).ok,true);
  recovered.stocks[0].price=400;
  assert.equal(submitOrder(recovered,{stockId:'s2',side:'buy',quantity:100,price:1}).ok,false);
  assert.equal(recovered.marginCallDay,20);
  const normal=getView(recovered).availableCash;
  recovered.phase='night'; nextDay(recovered);
  assert.equal(recovered.principal,0); assert.equal(recovered.interest,0);
  assert.equal(recovered.orders.some(o=>o.forced && o.remaining && ['open','partial'].includes(o.status)),false);
  assert.equal(getView(recovered).availableCash,normal);
  assert.equal(recovered.actors[0].positions.s1.quantity,100);

  const stressed=market(); stock(stressed,'s1'); stock(stressed,'s2'); deposit(stressed,100);
  assert.equal(transferCreditCollateral(stressed,{direction:'in',stockId:'s1',quantity:1000}).ok,true);
  stressed.phase='morning';
  assert.equal(submitOrder(stressed,{stockId:'s3',side:'finance',quantity:300,price:18.01}).ok,true);
  stressed.stocks[0].price=100; stressed.stocks[2].price=100; stressed.stocks[2].low=100;
  submitOrder(stressed,{stockId:'s2',side:'buy',quantity:100,price:1});
  const ordinaryCash=getView(stressed).availableCash;
  stressed.phase='night'; nextDay(stressed);
  assert.equal(getView(stressed).availableCash,ordinaryCash);
  assert.equal(stressed.actors[0].positions.s2.quantity,1000);
  assert.ok(stressed.orders.some(o=>o.forced && o.side==='creditSell'));
  assert.equal(stressed.orders.some(o=>o.forced && o.stockId==='s2'),false);
  assert.equal(validateMarket(stressed),true);
});

test('risk guidance does not promise unreachable safety from repaying only financing debt', () => {
  const m=market(); deposit(m,5000);
  m.principal=100_000;
  m.shorts.s5={quantity:100,today:0,proceeds:100_000,margin:100_000}; m.stocks[4].lendAvailable-=100;
  m.stocks[4].price=10000;
  const credit=getView(m).credit;
  assert.ok(credit.risk.topUpAmount>0); assert.equal(credit.risk.repayAmount,0);
});
