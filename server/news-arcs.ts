import type { NewsView, Phase } from '../shared/types.js';

export type StoryStage = 'proposal' | 'progress' | 'result' | 'delivery';
type Outcome = 'pending' | 'delayed' | 'modest' | 'strong';
type PublicationPhase = 'auction' | 'morning' | 'afternoon' | 'night';
type StoryStock = { id: string; name: string; sector: string; fair: number; newsBias: number };
export type StoryNews = Omit<NewsView, 'impacts'> & { impacts?: NewsView['impacts']; storyId?: string; stage?: StoryStage; stockIds?: string[] };
type StoryNode = { day: number; phase: PublicationPhase; at: number; premium: number; outcome: Outcome };
type Participant = { stockId: string; exposure: number };
export type NewsArc = {
  id: string; templateId: string; startedDay: number; primaryStockId: string;
  participants: Participant[]; nodes: StoryNode[]; publishedStage: number;
};
export type PublicExpectation = {
  // Only published facts contribute here. AI must never inspect the future nodes in arcs.
  premium: number; realizedPremium: number; conviction: number; updatedDay: number; activeStoryIds: string[];
};
export type StoryState = {
  version: 1; rngState: number; sequence: number; initializedDay: number; nextStartDay: number;
  arcs: NewsArc[]; expectations: Record<string, PublicExpectation>;
};
export type StoryMarket = {
  seed: number; day: number; phase: Phase; phaseElapsed: number; tickCount: number;
  stocks: StoryStock[]; news: StoryNews[]; storyState?: StoryState;
};
type StoryTemplate = {
  id: string; sector: string; project: string; primary: string;
  exposures: [string, number][]; proposal: string; progress: string;
  result: Record<Exclude<Outcome, 'pending'>, string>; delivery: Record<Exclude<Outcome, 'pending'>, string>;
  dependencies?: Record<StoryStage, string>;
  relatedNote?: string;
};

const STAGES: StoryStage[] = ['proposal', 'progress', 'result', 'delivery'];
const PHASE_ORDER: Phase[] = ['auction', 'morning', 'lunch', 'afternoon', 'closing', 'night', 'ended'];
const TEMPLATES: StoryTemplate[] = [
  {
    id: 'chip-equipment', sector: '半导体', project: '晶圆产线设备采购', primary: 's2',
    exposures: [['s2', 1], ['s3', .4], ['s1', .15]],
    proposal: '晶圆厂启动设备采购，砺川设备进入候选名单',
    progress: '砺川设备进入产线验证，配套材料需求开始明朗',
    result: { delayed: '设备采购推迟，砺川本轮尚未取得正式订单', modest: '砺川设备取得首批订单，规模低于前期设想', strong: '砺川设备中标主要批次，采购规模超过初期方案' },
    delivery: { delayed: '设备验收延后，砺川回款周期拉长', modest: '首批设备完成验收，后续扩单仍待确认', strong: '设备验收顺利，砺川确认追加采购' },
  },
  {
    id: 'auto-chip', sector: '半导体', project: '车规器件定点', primary: 's4',
    exposures: [['s4', 1], ['s1', .3], ['s3', .1]],
    proposal: '新车型开始选择功率器件供应商，远辰微电送样',
    progress: '远辰微电进入可靠性测试，定点份额仍有分歧',
    result: { delayed: '车规测试未达要求，远辰定点延后', modest: '远辰取得部分车型定点，首批份额有限', strong: '远辰取得主力车型定点，预计供货份额提高' },
    delivery: { delayed: '新车型排产回落，器件交付低于原计划', modest: '远辰开始小批交付，利润贡献逐步兑现', strong: '车型排产上修，远辰器件交付放量' },
  },
  {
    id: 'optical-bid', sector: '光通信', project: '算力园区光互联招标', primary: 's5',
    exposures: [['s5', 1], ['s8', .55], ['s7', .3], ['s6', .1]],
    proposal: '算力园区启动光互联招标，星瀚光联准备投标',
    progress: '光模块投标进入报价阶段，交付与成本成为分歧',
    result: { delayed: '园区缩减首批采购，星瀚暂未取得预期份额', modest: '星瀚光联中标，报价让利压缩利润空间', strong: '星瀚光联取得主要订单，交付规模超出预案' },
    delivery: { delayed: '光模块验收延后，部分收入确认顺延', modest: '星瀚完成首批交付，订单利润开始兑现', strong: '光模块交付顺利，客户追加下一批采购' },
  },
  {
    id: 'silicon-validation', sector: '光通信', project: '硅光产品客户验证', primary: 's7',
    exposures: [['s7', 1], ['s5', .35], ['s8', .2]],
    proposal: '长曜光电送样新一代硅光器件，客户启动验证',
    progress: '硅光样品测试进入后段，量产良率尚待核实',
    result: { delayed: '硅光验证出现返工，长曜量产排期延后', modest: '长曜通过客户验证，初期量产规模较小', strong: '长曜通过关键验证，客户提高量产需求' },
    delivery: { delayed: '量产良率爬坡缓慢，硅光成本高于计划', modest: '长曜小批量交付，良率仍在改善', strong: '硅光良率改善，长曜交付与利润同步提升' },
  },
  {
    id: 'grid-project', sector: '电力', project: '输配电更新项目', primary: 's11',
    exposures: [['s11', 1], ['s12', .35], ['s9', .1]],
    proposal: '输配电更新项目启动，恒原电网进入投标准备',
    progress: '电网更新公布技术要求，设备与储能配套分批评审',
    result: { delayed: '电网项目重新评审，恒原订单确认推迟', modest: '恒原中标部分标段，首批订单贡献有限', strong: '恒原取得核心标段，设备采购规模上修' },
    delivery: { delayed: '电网项目施工延迟，设备验收与回款后移', modest: '恒原首批设备完成验收，收入按进度确认', strong: '电网项目推进顺利，配套采购追加' },
  },
  {
    id: 'storage-contract', sector: '电力', project: '储能系统示范项目', primary: 's12',
    exposures: [['s12', 1], ['s11', .3], ['s10', .15]],
    proposal: '储能示范项目征集方案，沧岳储能提交报价',
    progress: '储能方案进入评审，电池成本和调度收益待核实',
    result: { delayed: '储能项目暂缓，沧岳预期订单未能落地', modest: '沧岳取得示范项目，竞争让利影响盈利', strong: '沧岳方案获选，项目规模较征集阶段扩大' },
    delivery: { delayed: '储能项目验收推迟，成本控制弱于预期', modest: '储能项目完成首期验收，盈利逐步兑现', strong: '储能项目运行达标，后续扩建采购启动' },
  },
  {
    id: 'robot-production-line', sector: '机器人', project: '柔性产线改造', primary: 's17',
    exposures: [['s17', 1], ['s18', .3]],
    proposal: '制造厂启动柔性产线改造，衡川智造提交机器人方案',
    progress: '衡川产线方案进入试运行，节拍与故障率仍待核实',
    result: { delayed: '产线改造预算收紧，衡川尚未取得正式订单', modest: '衡川获得试点产线订单，规模小于前期方案', strong: '衡川方案通过评审，多条产线同步采购' },
    delivery: { delayed: '机器人产线调试反复，衡川验收回款延后', modest: '衡川完成首条产线验收，后续采购仍待确认', strong: '柔性产线运行达标，衡川取得追加订单' },
  },
  {
    id: 'robot-joint-validation', sector: '机器人', project: '机器人关节供应商验证', primary: 's18',
    exposures: [['s18', 1], ['s17', .15]],
    proposal: '机器人厂商启动关节选型，灵枢驱动进入样品验证',
    progress: '灵枢关节进入耐久测试，量产成本尚待确认',
    result: { delayed: '耐久指标未达预期，灵枢定点验证推后', modest: '灵枢取得小批定点，首批供货份额有限', strong: '灵枢通过关键测试，客户提高关节采购份额' },
    delivery: { delayed: '关节良率爬坡缓慢，灵枢交付成本高于计划', modest: '灵枢完成首批交付，产能利用率逐步改善', strong: '关节交付与良率同步改善，灵枢获追加采购' },
    relatedNote: '衡川智造只有行业需求的间接关联，尚未确认采用本轮关节产品。',
  },
  {
    id: 'drug-license', sector: '创新药', project: '创新药海外授权谈判', primary: 's19',
    exposures: [['s19', 1], ['s20', .1]],
    proposal: '海外药企接触知微生物，创新药授权进入初步谈判',
    progress: '知微授权谈判进入数据核验，首付款与后续分成仍有分歧',
    result: { delayed: '授权条款暂未谈拢，知微合作签约延后', modest: '知微签署区域授权，首付款低于此前设想', strong: '知微取得多区域授权，首付款超过初步方案' },
    delivery: { delayed: '授权首付款到账延后，知微合作推进慢于计划', modest: '知微收到首笔授权款，后续里程碑仍需条件达成', strong: '授权首付款到账，知微合作方确认扩大开发投入' },
    dependencies: {
      proposal: '后续看数据核验与授权条款；接触不等于签约，也不代表药品获批。',
      progress: '核验通过仍需正式签约，意向总额中的后续里程碑并非确定收入。',
      result: '授权范围和首付款已经公布，后续关注实际到账；里程碑仍取决于研发进展。',
      delivery: '本轮款项与合作进度已有结果，未来开发、获批与商业化仍有不确定性。',
    },
    relatedNote: '澄和医药仅有同板块估值的间接关联，不分享知微的授权款。',
  },
  {
    id: 'drug-hospital-access', sector: '创新药', project: '已上市新药院端准入', primary: 's20',
    exposures: [['s20', 1], ['s19', .08]],
    proposal: '澄和医药启动新一轮医院准入，终端覆盖有望扩大',
    progress: '澄和新药进入院端评审，进院数量与推广费用尚待确认',
    result: { delayed: '部分医院评审延期，澄和本轮准入慢于计划', modest: '澄和进入部分目标医院，首批覆盖小于预案', strong: '澄和通过多数目标医院评审，准入范围扩大' },
    delivery: { delayed: '新药终端用量偏低，澄和推广费用挤压利润', modest: '澄和新增医院开始采购，终端用量逐步增长', strong: '新药终端用量超出预案，澄和新增医院持续补货' },
    dependencies: {
      proposal: '这轮讨论的是已上市新药的销售准入，后续看医院评审与患者实际用量。',
      progress: '进入评审不等于完成准入，完成准入也不等于立刻形成大量销售。',
      result: '准入结果已经公布，后续关注实际采购、终端用量和推广成本。',
      delivery: '本轮终端需求已有反馈，后续销量仍取决于使用情况与竞争格局。',
    },
    relatedNote: '知微生物仅受新药商业化预期的间接影响，不分享澄和的销售收入。',
  },
  {
    id: 'consumer-channel-order', sector: '大消费', project: '食品渠道补货', primary: 's21',
    exposures: [['s21', 1], ['s22', .2]],
    proposal: '商超启动新品采购，瑞禾食品进入渠道选品名单',
    progress: '瑞禾新品试销启动，终端动销与促销费用受到关注',
    result: { delayed: '试销动销偏弱，渠道推迟瑞禾大批采购', modest: '瑞禾取得首批补货单，促销让利压缩毛利', strong: '瑞禾新品动销较好，渠道提高首批补货规模' },
    delivery: { delayed: '渠道库存上升，瑞禾退货与折扣压力加大', modest: '瑞禾完成补货，终端销量平稳消化库存', strong: '终端动销持续改善，瑞禾渠道再次补货' },
    dependencies: {
      proposal: '先看试销动销与渠道反馈，进入选品名单不等于确定采购。',
      progress: '关注终端实际卖出多少，而非只看向渠道发了多少货。',
      result: '补货规模已经公布，后续看动销、退货和促销后的实际毛利。',
      delivery: '本轮动销与库存已有反馈，下一轮补货仍需真实消费需求支撑。',
    },
    relatedNote: '锦里商贸有渠道销售的间接关联，但采购成本与零售毛利可能不同步。',
  },
  {
    id: 'retail-store-renovation', sector: '大消费', project: '连锁商超门店调改', primary: 's22',
    exposures: [['s22', 1], ['s21', .12]],
    proposal: '锦里商贸公布门店调改计划，试点客流成为观察重点',
    progress: '锦里首批门店重新开业，客流增长能否覆盖促销成本待核实',
    result: { delayed: '门店改造超支，锦里推迟后续调改计划', modest: '锦里试点客流改善，客单价与毛利提升有限', strong: '锦里试点销售超出预案，门店经营效率改善' },
    delivery: { delayed: '促销退坡后客流回落，锦里门店利润低于计划', modest: '锦里门店销售趋稳，调改投入逐步回收', strong: '锦里客流和复购保持增长，单店利润持续改善' },
    dependencies: {
      proposal: '后续看调改成本与试点客流，门店翻新本身不会直接形成利润。',
      progress: '重新开业的短期热度仍需复购验证，促销带来的客流也可能牺牲毛利。',
      result: '试点经营数据已经公布，后续看促销退坡后的复购和费用控制。',
      delivery: '试点经营已有持续反馈，后续扩店效果仍取决于选址与投入成本。',
    },
    relatedNote: '瑞禾食品有零售渠道需求的间接关联，门店客流改善不等于瑞禾独享新增采购。',
  },
];

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
function random(state: StoryState) {
  state.rngState = (Math.imul(state.rngState, 1664525) + 1013904223) >>> 0;
  return state.rngState / 0x1_0000_0000;
}
function emptyExpectation(day: number): PublicExpectation {
  return { premium: 0, realizedPremium: 0, conviction: 0, updatedDay: day, activeStoryIds: [] };
}

/** Migration is deliberately silent: existing articles are never replayed as new information. */
export function initNewsArcs(m: StoryMarket): StoryState {
  if (m.storyState) return m.storyState;
  const freshOpening = m.phase === 'auction' && m.phaseElapsed === 0 && m.news.length === 0;
  m.storyState = {
    version: 1, rngState: (m.seed ^ 0x6e657773) >>> 0, sequence: 0, initializedDay: m.day,
    nextStartDay: freshOpening ? m.day : m.day + 1,
    arcs: [], expectations: Object.fromEntries(m.stocks.map(s => [s.id, emptyExpectation(m.day)])),
  };
  return m.storyState;
}

function makeArc(m: StoryMarket, state: StoryState): NewsArc | null {
  const recent = new Set(state.arcs.slice(-2).map(arc => arc.templateId));
  const stockIds = new Set(m.stocks.map(s => s.id));
  let options = TEMPLATES.filter(t => stockIds.has(t.primary) && !recent.has(t.id));
  if (!options.length) options = TEMPLATES.filter(t => stockIds.has(t.primary));
  if (!options.length) return null;
  const template = options[Math.floor(random(state) * options.length)];
  const proposal = .04 + random(state) * .12;
  const progress = clamp(proposal + (random(state) - .5) * .12, -.03, .22);
  const resultRoll = random(state);
  const resultOutcome: Exclude<Outcome, 'pending'> = resultRoll < .23 ? 'delayed' : resultRoll < .65 ? 'modest' : 'strong';
  const result = resultOutcome === 'delayed' ? -.025 - random(state) * .08
    : resultOutcome === 'modest' ? .015 + random(state) * .05 : .11 + random(state) * .13;
  const delivery = clamp(result + (random(state) - .5) * .14, -.16, .3);
  const deliveryOutcome: Exclude<Outcome, 'pending'> = delivery < .005 ? 'delayed' : delivery < .105 ? 'modest' : 'strong';
  const progressRoll = random(state);
  const progressPhase: PublicationPhase = progressRoll < .25 ? 'morning' : progressRoll < .65 ? 'night' : 'auction';
  const progressDay = m.day + (progressPhase === 'auction' ? 1 : 0);
  const resultDay = progressDay + 1 + Math.floor(random(state) * 3);
  const deliveryDay = resultDay + 1 + Math.floor(random(state) * 2);
  const resultRollTime = random(state), deliveryRollTime = random(state);
  const resultPhase: PublicationPhase = resultRollTime < .45 ? 'night' : resultRollTime < .9 ? 'auction' : 'afternoon';
  const deliveryPhase: PublicationPhase = deliveryRollTime < .55 ? 'night' : deliveryRollTime < .92 ? 'auction' : 'afternoon';
  const nodes: StoryNode[] = [
    { day: m.day, phase: 'auction', at: 0, premium: proposal, outcome: 'pending' },
    { day: progressDay, phase: progressPhase, at: progressPhase === 'morning' ? 45 + Math.floor(random(state) * 85) : 0, premium: progress, outcome: 'pending' },
    { day: resultDay, phase: resultPhase, at: resultPhase === 'afternoon' ? 35 + Math.floor(random(state) * 100) : 0, premium: result, outcome: resultOutcome },
    { day: deliveryDay, phase: deliveryPhase, at: deliveryPhase === 'afternoon' ? 35 + Math.floor(random(state) * 100) : 0, premium: delivery, outcome: deliveryOutcome },
  ];
  return { id: `story-${++state.sequence}`, templateId: template.id, startedDay: m.day,
    primaryStockId: template.primary, participants: template.exposures.filter(([id]) => stockIds.has(id)).map(([stockId, exposure]) => ({ stockId, exposure })),
    nodes, publishedStage: -1 };
}

function due(m: StoryMarket, node: StoryNode) {
  if (m.day !== node.day) return m.day > node.day;
  const current = PHASE_ORDER.indexOf(m.phase), scheduled = PHASE_ORDER.indexOf(node.phase);
  return current > scheduled || (current === scheduled && m.phaseElapsed >= node.at);
}
function clock(m: StoryMarket) {
  const minutes = m.phase === 'auction' ? 555 + 10 * m.phaseElapsed / 45
    : m.phase === 'morning' ? 570 + 120 * m.phaseElapsed / 180
      : m.phase === 'lunch' ? 690 + 90 * m.phaseElapsed / 30
        : m.phase === 'afternoon' ? 780 + 117 * m.phaseElapsed / 180
          : m.phase === 'closing' ? 897 + 3 * m.phaseElapsed / 15 : 1080;
  const value = Math.floor(minutes);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function publish(m: StoryMarket, state: StoryState, arc: NewsArc, index: number) {
  const template = TEMPLATES.find(t => t.id === arc.templateId)!;
  const stage = STAGES[index], node = arc.nodes[index], previous = index ? arc.nodes[index - 1].premium : 0;
  const delta = node.premium - previous;
  arc.publishedStage = index;
  for (const participant of arc.participants) {
    const stock = m.stocks.find(s => s.id === participant.stockId)!;
    const expectation = state.expectations[stock.id] ??= emptyExpectation(m.day);
    if (stage === 'delivery') expectation.realizedPremium = clamp(expectation.realizedPremium + node.premium * participant.exposure, -.4, 2);
    const activeArcs = state.arcs.filter(other => other.publishedStage >= 0 && other.publishedStage < 3 && other.participants.some(p => p.stockId === stock.id));
    const activePremium = activeArcs.reduce((sum, other) => sum + other.nodes[other.publishedStage].premium * other.participants.find(p => p.stockId === stock.id)!.exposure, 0);
    expectation.premium = clamp(expectation.realizedPremium + activePremium, -.45, 2.5);
    expectation.conviction = stage === 'proposal' ? .35 : stage === 'progress' ? .5 : stage === 'result' ? .75 : .9;
    expectation.updatedDay = m.day;
    expectation.activeStoryIds = activeArcs.map(other => other.id);
    stock.newsBias = clamp(stock.newsBias * .5 + delta * participant.exposure * .5, -.08, .08);
  }
  const primary = m.stocks.find(s => s.id === arc.primaryStockId)!;
  const otherNames = arc.participants.filter(p => p.stockId !== primary.id).map(p => m.stocks.find(s => s.id === p.stockId)!.name);
  const direction = delta >= 0 ? 'positive' : 'negative';
  const revision = index === 0 ? '这只是项目线索，尚未形成确定利润。'
    : delta > .012 ? '本次信息好于此前预期，盈利预期上修。'
      : delta < -.012 ? '本次信息弱于此前预期，盈利预期下修。' : '本次信息与此前预期接近，新增信息有限。';
  const dependency = template.dependencies?.[stage] ?? (stage === 'proposal' ? '后续看验证、报价及订单份额。'
    : stage === 'progress' ? '还要等待正式结果，进入评审不等于拿到订单。'
      : stage === 'result' ? '订单结果已经公布，后续关注交付、成本与回款。' : '本轮项目已有兑现结果，后续采购属于新的不确定机会。');
  const related = template.relatedNote ?? (otherNames.length ? `${otherNames.join('、')}有配套关联，但业务暴露较小，不能按同等幅度推断。` : '');
  const headline = stage === 'proposal' ? template.proposal : stage === 'progress' ? template.progress
    : stage === 'result' ? template.result[node.outcome as Exclude<Outcome, 'pending'>] : template.delivery[node.outcome as Exclude<Outcome, 'pending'>];
  m.news.unshift({
    id: `${arc.id}-${stage}`, storyId: arc.id, stage, stockIds: arc.participants.map(p => p.stockId),
    day: m.day, time: clock(m), headline,
    body: `第 ${arc.id.slice(6)} 批${template.project}：${primary.name}是本轮信息的主要关联公司。${revision}${dependency}${related}价格仍取决于买卖成交和市场承接。`,
    sector: template.sector, sentiment: Math.abs(delta) < .012 ? 'neutral' : direction,
    impacts: [{ sector: template.sector, direction, reason: `${primary.name}关联最直接；${revision}${template.relatedNote ?? (otherNames.length ? `配套公司 ${otherNames.join('、')} 的影响较弱。` : '')}` }],
  });
  m.news = m.news.slice(0, 40);
}

/** Call at each simulation step and the opening of a trading day; never uses wall-clock time. */
export function advanceNewsArcs(m: StoryMarket): number {
  const state = initNewsArcs(m);
  if (m.phase === 'ended') return 0;
  if (m.phase === 'auction' && m.day >= state.nextStartDay) {
    const activeCount = state.arcs.filter(arc => arc.publishedStage < 3).length;
    if (activeCount < 2) {
      const arc = makeArc(m, state);
      if (arc) state.arcs.push(arc);
      state.nextStartDay = m.day + 2 + Math.floor(random(state) * 2);
    } else state.nextStartDay = m.day + 1;
  }
  let published = 0;
  for (const arc of state.arcs) {
    while (arc.publishedStage < 3 && due(m, arc.nodes[arc.publishedStage + 1])) {
      publish(m, state, arc, arc.publishedStage + 1);
      published++;
    }
  }
  // Completed contributions already live in realizedPremium. Keep a few stories for no-repeat selection.
  const completed = state.arcs.filter(arc => arc.publishedStage === 3).slice(-4);
  state.arcs = state.arcs.filter(arc => arc.publishedStage < 3 || completed.includes(arc));
  return published;
}

/** Cents. The AI's valuation has access only to information already published to the player. */
export function expectedValue(m: Pick<StoryMarket, 'storyState'>, stock: Pick<StoryStock, 'id' | 'fair'>): number {
  const premium = m.storyState?.expectations[stock.id]?.premium ?? 0;
  return Math.max(1, Math.round(stock.fair * (1 + premium)));
}

/** Save-file shape validation. Private future outcomes remain server-side and bounded. */
export function validateStoryState(value: unknown, m: Pick<StoryMarket, 'day' | 'stocks'>): value is StoryState {
  if (!value || typeof value !== 'object') return false;
  const v = value as StoryState;
  const integer = (n: unknown, min: number, max: number) => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
  const finite = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  const ids = new Set(m.stocks.map(s => s.id));
  if (v.version !== 1 || !integer(v.rngState, 0, 0xffff_ffff) || !integer(v.sequence, 0, 1_000_000)
    || !integer(v.initializedDay, 1, m.day) || !integer(v.nextStartDay, 1, m.day + 10)
    || !Array.isArray(v.arcs) || v.arcs.length > 8 || !v.expectations || typeof v.expectations !== 'object' || Array.isArray(v.expectations)) return false;
  const arcIds = new Set<string>();
  for (const arc of v.arcs) {
    if (!arc || typeof arc !== 'object' || typeof arc.id !== 'string' || !/^story-[1-9]\d*$/.test(arc.id) || Number(arc.id.slice(6)) > v.sequence || arcIds.has(arc.id)
      || !TEMPLATES.some(t => t.id === arc.templateId) || !integer(arc.startedDay, v.initializedDay, m.day)
      || !ids.has(arc.primaryStockId) || !integer(arc.publishedStage, -1, 3)
      || !Array.isArray(arc.participants) || arc.participants.length < 1 || arc.participants.length > ids.size
      || !Array.isArray(arc.nodes) || arc.nodes.length !== 4) return false;
    arcIds.add(arc.id);
    const participants = new Set<string>();
    for (const p of arc.participants) {
      if (!p || !ids.has(p.stockId) || participants.has(p.stockId) || !finite(p.exposure, .01, 1)) return false;
      participants.add(p.stockId);
    }
    if (!participants.has(arc.primaryStockId)) return false;
    let previousTime = -1;
    for (const [index, node] of arc.nodes.entries()) {
      if (!node || !integer(node.day, arc.startedDay, arc.startedDay + 6)
        || !['auction', 'morning', 'afternoon', 'night'].includes(node.phase) || !integer(node.at, 0, node.phase === 'night' ? 0 : node.phase === 'auction' ? 44 : 179)
        || !finite(node.premium, -.2, .35) || !['pending', 'delayed', 'modest', 'strong'].includes(node.outcome)
        || (index < 2 ? node.outcome !== 'pending' : node.outcome === 'pending')) return false;
      const time = node.day * 2000 + PHASE_ORDER.indexOf(node.phase) * 200 + node.at;
      if (time <= previousTime || (index <= arc.publishedStage && node.day > m.day)
        || (index === 0 && (node.day !== arc.startedDay || node.phase !== 'auction' || node.at !== 0))) return false;
      previousTime = time;
    }
  }
  if (Object.keys(v.expectations).length !== ids.size) return false;
  for (const [id, expectation] of Object.entries(v.expectations)) {
    if (!ids.has(id) || !expectation || !finite(expectation.premium, -.45, 2.5) || !finite(expectation.realizedPremium, -.4, 2)
      || !finite(expectation.conviction, 0, 1) || !integer(expectation.updatedDay, v.initializedDay, m.day)
      || !Array.isArray(expectation.activeStoryIds) || expectation.activeStoryIds.length > 2
      || new Set(expectation.activeStoryIds).size !== expectation.activeStoryIds.length
      || expectation.activeStoryIds.some(id => !v.arcs.some(arc => arc.id === id && arc.publishedStage >= 0 && arc.publishedStage < 3))) return false;
  }
  return true;
}
