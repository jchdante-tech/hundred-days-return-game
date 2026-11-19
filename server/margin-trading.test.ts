import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarket,submitMarginOrder,closeMarginPosition,addMargin,getView,cancelOrder,submitOrder,validateMarket,nextDay,repayChallenge,type Market} from './engine.js';
function market(){const m=createMarket(42,{legacySimulation:true});m.day=20;m.calendarDate='2026-11-16';m.elapsedDays=27;m.paused=false;m.phase='morning';return m;}
function supply(m:Market){return m.actors.reduce((n,a)=>n+a.cash,0)+m.brokerCash+Object.values(m.shorts).reduce((n,p)=>n+p.proceeds,0)+(m.challenge?.paid??0)+(m.marginState?.accounts??[]).flatMap(a=>a.positions).reduce((n,p)=>n+p.proceeds,0);}
function open(m:Market,extra:Partial<Parameters<typeof submitMarginOrder>[1]>={}){return submitMarginOrder(m,{stockId:'s1',direction:'long',mode:'isolated',leverage:2,principal:1201,price:12.01,...extra});}
function npc(m:Market,side:'buy'|'sell',stockId:string,price:number,quantity:number){m.orders.push({id:`npc${++m.sequence}`,actorId:'ai1',stockId,side,quantity,remaining:quantity,price,status:'open',time:'09:30',sequence:m.sequence,createdTick:0,frozenCash:side==='buy'?price*quantity:0,restrictedClaim:0});}

test('2x real stock purchase spends own cash and borrows only the difference',()=>{
 const m=market(),before=supply(m),cash=m.actors[0].cash,broker=m.brokerCash;
 assert.equal(open(m).ok,true);
 const v=getView(m),p=v.margin.positions[0];
 assert.equal(p.quantity,200);assert.equal(p.loan,1201);assert.equal(p.principal,1201);assert.equal(p.marketValue,2402);
 assert.equal(m.actors[0].cash,cash-120100);assert.equal(m.brokerCash,broker-120100);assert.equal(m.principal,0);
 assert.equal(v.margin.accounts[0].marginRatio,50);assert.equal(v.debt,1201);assert.equal(v.credit.debt,0);
 assert.equal(v.positions[0].available,0);assert.equal(submitOrder(m,{stockId:'s1',side:'sell',quantity:100,price:11.99}).ok,false);
 assert.equal(closeMarginPosition(m,{positionId:p.id,quantity:100,price:11.99}).ok,false);
 assert.equal(supply(m),before);assert.equal(validateMarket(m),true);
});
test('1x uses no broker credit and round-lot remainder stays ordinary',()=>{
 const m=market(),broker=m.brokerCash,before=supply(m);assert.equal(open(m,{stockId:'s2',leverage:1,principal:3000,price:28.01}).ok,true);
 const v=getView(m);assert.equal(v.margin.positions[0].quantity,100);assert.equal(v.margin.positions[0].loan,0);assert.equal(v.margin.positions[0].principal,2801);
 assert.equal(v.availableCash,10_000_000-2801);assert.equal(m.brokerCash,broker);assert.equal(supply(m),before);assert.equal(validateMarket(m),true);
});
test('partial fills borrow actual amounts, cancelling unfilled lots refunds only unused principal',()=>{
 const m=market();m.orders=[];npc(m,'sell','s1',1200,100);const before=supply(m);
 assert.equal(open(m,{principal:2000,price:12.01}).ok,true);
 let v=getView(m);assert.equal(v.margin.positions[0].quantity,100);assert.equal(v.margin.positions[0].loan,600);
 const order=v.orders.find(o=>o.side==='marginBuy')!;assert.equal(order.remaining,200);assert.equal(cancelOrder(m,order.id).ok,true);
 v=getView(m);assert.equal(v.margin.positions[0].principal,600);assert.equal(v.availableCash,9_999_400);assert.equal(v.margin.accounts[0].cash,0);
 assert.equal(supply(m),before);assert.equal(validateMarket(m),true);
});
test('short borrowing uses finite shares and restricted proceeds; cover stays in its bucket',()=>{
 const m=market();m.orders=[];npc(m,'buy','s5',2200,1000);const before=supply(m);
 assert.equal(open(m,{stockId:'s5',direction:'short',principal:1210,price:22}).ok,true);
 let v=getView(m),p=v.margin.positions[0];assert.equal(p.quantity,100);assert.equal(p.lockedProceeds,2200);assert.equal(m.stocks[4].lendAvailable,9900);
 assert.equal(v.availableCash,10_000_000-1210);assert.equal(v.restrictedCash,2200);assert.equal(supply(m),before);
 m.marginState!.accounts[0].positions[0].today=0;npc(m,'sell','s5',2100,100);
 assert.equal(closeMarginPosition(m,{positionId:p.id,quantity:100,price:21}).ok,true);
 v=getView(m);assert.equal(v.margin.positions.length,0);assert.equal(v.margin.accounts.length,0);assert.equal(v.availableCash,10_000_100);
 assert.equal(m.stocks[4].lendAvailable,10000);assert.equal(supply(m),before);assert.equal(validateMarket(m),true);
});
test('cross shares risk while isolated positions keep independent equity and margin',()=>{
 const m=market();assert.equal(open(m,{mode:'cross'}).ok,true);assert.equal(open(m,{mode:'cross',stockId:'s3',price:18.01,principal:1801}).ok,true);
 assert.equal(open(m,{mode:'isolated',stockId:'s5',price:22.01,principal:2201}).ok,true);
 let v=getView(m);assert.equal(v.margin.accounts.length,2);assert.equal(v.margin.positions[0].accountId,v.margin.positions[1].accountId);
 const cross=v.margin.accounts.find(a=>a.mode==='cross')!,isolated=v.margin.accounts.find(a=>a.mode==='isolated')!;
 assert.equal(addMargin(m,{accountId:cross.id,amount:1000}).ok,true);
 v=getView(m);assert.equal(v.margin.accounts.find(a=>a.id===cross.id)!.cash,1000);assert.equal(v.margin.accounts.find(a=>a.id===isolated.id)!.cash,0);
 assert.equal(repayChallenge(m,1000).ok,false);assert.equal(validateMarket(m),true);
});
test('closing a real long returns surplus only after its own loan and fees are paid',()=>{
 const m=market();m.orders=[];npc(m,'sell','s1',1200,200);const before=supply(m);assert.equal(open(m,{price:12,principal:1200}).ok,true);
 const p=m.marginState!.accounts[0].positions[0];p.today=0;m.actors[0].positions.s1.today=0;
 npc(m,'buy','s1',1300,200);assert.equal(closeMarginPosition(m,{positionId:p.id,quantity:200,price:13}).ok,true);
 const v=getView(m);assert.equal(v.margin.accounts.length,0);assert.equal(v.debt,0);assert.equal(v.availableCash,10_000_200);assert.equal(supply(m),before);assert.equal(validateMarket(m),true);
});
test('margin snapshots reject unknown versions and preserve independent natural-day fees',()=>{
 const m=market();assert.equal(open(m).ok,true);m.phase='night';nextDay(m);
 const v=getView(m);assert.ok(v.margin.interest>0);assert.equal(m.interest,0);assert.equal(v.margin.positions[0].todayQuantity,0);
 assert.equal(validateMarket(JSON.parse(JSON.stringify(m))),true);
 assert.equal(validateMarket({...m,marginState:{version:2,accounts:[]}}),false);
 const restored=JSON.parse(JSON.stringify(m));assert.deepEqual(getView(restored).margin,v.margin);
});
test('3x cent allocation remains exact across three separate partial fills',()=>{
 const m=market();m.orders=[];const before=supply(m);
 for(let i=0;i<3;i++)npc(m,'sell','s1',1201,100);
 assert.equal(open(m,{leverage:3,principal:1201,price:12.01}).ok,true);
 const v=getView(m);assert.equal(v.margin.positions[0].quantity,300);assert.equal(v.margin.positions[0].loan,2402);assert.equal(v.margin.positions[0].principal,1201);
 assert.equal(v.availableCash,9_998_799);assert.equal(supply(m),before);assert.equal(validateMarket(m),true);
});
test('margin position cost cannot be mixed into the remaining ordinary holding',()=>{
 const m=market();m.orders=[];m.actors[1].positions.s1.quantity-=100;m.actors[0].positions.s1={quantity:100,today:0,financed:0,cost:100_000};
 npc(m,'sell','s1',1201,200);assert.equal(open(m).ok,true);
 const p=m.marginState!.accounts[0].positions[0];p.today=0;m.actors[0].positions.s1.today=0;
 npc(m,'buy','s1',1300,200);assert.equal(closeMarginPosition(m,{positionId:p.id,quantity:200,price:13}).ok,true);
 assert.equal(m.actors[0].positions.s1.quantity,100);assert.equal(m.actors[0].positions.s1.cost,100_000);
 assert.equal(validateMarket(m),true);
});
test('cash-only 1x holdings do not prevent cash target repayment or winning at maturity',()=>{
 const m=market();m.actors[0].cash+=10_000_000_000;m.brokerCash-=10_000_000_000;
 assert.equal(open(m,{leverage:1,principal:1201}).ok,true);
 assert.equal(repayChallenge(m,100_000_000).ok,true);
 m.elapsedDays=99;m.calendarDate='2027-01-27';m.phase='night';nextDay(m);
 assert.equal(m.result,'won');assert.equal(m.marginState!.accounts[0].positions[0].quantity,100);
 const pending=market();pending.phase='auction';
 assert.equal(open(pending,{leverage:1,price:10.8,principal:1080}).ok,true);
 assert.equal(repayChallenge(pending,1000).ok,true);
 const borrowed=market();borrowed.phase='auction';assert.equal(open(borrowed,{leverage:2,price:10.8,principal:1080}).ok,true);
 assert.equal(repayChallenge(borrowed,1000).ok,false);
});
