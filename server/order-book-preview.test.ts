import test from 'node:test';
import assert from 'node:assert/strict';
import { crossesOwnOrder, previewBook, sweepTicket } from '../shared/order-book-preview.js';
import type { OrderView } from '../shared/types';
const asks = [{price:10.01,quantity:1000},{price:10.02,quantity:2000},{price:10.04,quantity:3000}];
test('size alone cannot sweep prices beyond the limit; depth is only visible coverage', () => {
  const a = previewBook(asks,'buy',10.01,10000)!;
  assert.equal(a.filled,1000); assert.equal(a.remaining,9000); assert.equal(a.lastPrice,10.01);
  const b = previewBook(asks,'buy',10.04,4000)!;
  assert.equal(b.filled,4000); assert.equal(b.amount,40090); assert.equal(b.fills.length,3);
  assert.equal(previewBook(asks,'buy',10,10000)!.filled,0);
  assert.equal(previewBook(asks,'buy',10,101),null);
});
test('sell preview consumes highest bids first without going below the limit', () => {
  const result = previewBook([...asks],'sell',10.02,6000)!;
  assert.equal(result.filled,5000); assert.equal(result.lastPrice,10.02); assert.equal(result.remaining,1000);
});
test('sweep presets reserve at limit, cap to sellable T+1 shares and never mutate depth', () => {
  const copy = structuredClone(asks);
  assert.deepEqual(sweepTicket(asks,'buy',5,10000,0),{price:10.04,quantity:900});
  assert.deepEqual(sweepTicket(asks,'sell',5,0,350),{price:10.01,quantity:300});
  assert.equal(sweepTicket(asks,'sell',5,0,99),null);
  assert.equal(sweepTicket([], 'buy',5,10000,0),null);
  assert.deepEqual(asks,copy);
});
test('own reverse ordinary and margin orders block a misleading sweep preview', () => {
  const order = { side:'marginSell', status:'partial', price:10.02 } as OrderView;
  assert.equal(crossesOwnOrder([order],'buy',10.03),true);
  assert.equal(crossesOwnOrder([order],'buy',10.01),false);
  assert.equal(crossesOwnOrder([{...order,status:'cancelled'}],'buy',10.03),false);
});
