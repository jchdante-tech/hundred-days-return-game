import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import type { ChipView } from '../shared/types.js';
import ChipStructure from '../src/ChipStructure.js';

const chips: ChipView = {
  totalShares: 24000000, floatShares: 6000000, floatMarketCap: 72000000,
  inactiveShares: 18000000, playerRatio: .025, concentrationRatio: .45,
  concentration: 'concentrated', supply: 'tight', profitPressure: 'high', t1LockedRatio: .15,
};
const render = (value?: ChipView) => renderToStaticMarkup(createElement(ChipStructure, { chips: value, stockName: '江澜芯科' }));

test('chip observation is collapsed by default and absent in an older response without chip data', () => {
  assert.equal(render(), '');
  const html = render(chips);
  assert.match(html, /<details class="chip-structure" aria-label="江澜芯科筹码观察">/);
  assert.match(html, /<summary data-tour="chips">/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/);
  assert.match(html, /筹码集中/);
  assert.match(html, /卖盘偏紧/);
  assert.match(html, /游戏估算/);
});

test('chip metrics distinguish float value, ownership, approximate concentration and T+1 shares', () => {
  const html = render(chips);
  assert.match(html, /局内流通市值/);
  assert.match(html, /7,200.00 万/);
  assert.match(html, /你的筹码占流通盘<\/dt><dd>2.50%/);
  assert.match(html, /筹码集中度估计<\/dt><dd>约 45%/);
  assert.match(html, /获利抛压估计<\/dt><dd>较重/);
  assert.match(html, /长期未入场 1,800.00 万 股/);
  assert.match(html, /流通盘中约 15% 今日买入、待 T\+1 解锁/);
  assert.match(html, /T\+1 暂时不能卖，和持有人主动惜售是两回事/);
  assert.match(html, /普通、信用及杠杆多仓，不含融券义务/);
  assert.match(html, /浮盈不等于现金，卖出还需要买盘承接/);
});

test('all estimate labels remain qualitative and do not promise automatic price gains', () => {
  const dispersed = render({ ...chips, playerRatio: 0, concentration: 'dispersed', supply: 'ample', profitPressure: 'low' });
  assert.match(dispersed, /筹码分散/);
  assert.match(dispersed, /卖盘较松/);
  assert.match(dispersed, /获利抛压估计<\/dt><dd>较轻/);
  assert.match(dispersed, /0.00%/);
  const high = render({ ...chips, concentration: 'high', supply: 'balanced', profitPressure: 'medium' });
  assert.match(high, /高度集中/);
  assert.match(high, /卖盘适中/);
  assert.match(high, /获利抛压估计<\/dt><dd>适中/);
  assert.match(high, /买入成交才会改变筹码分布/);
  assert.match(high, /不展示其他席位的精确持仓/);
});
