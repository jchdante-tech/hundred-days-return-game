/** Fictional companies. Prices here use yuan; the engine converts them to cents. */
export type BaseStockDefinition = {
  id: string; code: string; name: string; sector: string; price: number;
  concepts: string[]; description: string; shares: number; pe: number;
  financeEligible: boolean; lendTotal: number;
};

export const LEGACY_BASE_STOCK_COUNT = 12;
export const STOCK_UNIVERSE_VERSION = 1;

export const BASE_STOCKS: readonly BaseStockDefinition[] = [
  { id: 's1', code: '虚001', name: '江澜芯科', sector: '半导体', price: 12,
    concepts: ['先进封装', '国产替代'], description: '研发工业控制芯片，订单受设备更新与国产替代需求影响。',
    shares: 24_000_000, pe: 16, financeEligible: true, lendTotal: 0 },
  { id: 's2', code: '虚002', name: '砺川设备', sector: '半导体', price: 28,
    concepts: ['晶圆设备', '国产替代'], description: '提供晶圆清洗与检测设备，客户扩产是主要订单来源。',
    shares: 75_000_000, pe: 19, financeEligible: false, lendTotal: 0 },
  { id: 's3', code: '虚003', name: '云岫材料', sector: '半导体', price: 18,
    concepts: ['电子材料', '先进封装'], description: '主营封装基板与电子材料，原料价格影响利润。',
    shares: 40_000_000, pe: 22, financeEligible: true, lendTotal: 0 },
  { id: 's4', code: '虚004', name: '远辰微电', sector: '半导体', price: 35,
    concepts: ['功率器件', '汽车电子'], description: '供应车规功率器件，研发验证周期较长。',
    shares: 120_000_000, pe: 25, financeEligible: false, lendTotal: 0 },
  { id: 's5', code: '虚005', name: '星瀚光联', sector: '光通信', price: 22,
    concepts: ['光模块', '算力'], description: '供应数据中心光模块，资本开支决定订单弹性。',
    shares: 30_000_000, pe: 28, financeEligible: true, lendTotal: 10_000 },
  { id: 's6', code: '虚006', name: '海序通信', sector: '光通信', price: 16,
    concepts: ['光纤光缆', '算力'], description: '主营光纤与通信网络建设，业务受招标节奏影响。',
    shares: 180_000_000, pe: 31, financeEligible: false, lendTotal: 0 },
  { id: 's7', code: '虚007', name: '长曜光电', sector: '光通信', price: 31,
    concepts: ['硅光', '光模块'], description: '研发硅光器件，产品验证和良率影响交付。',
    shares: 20_000_000, pe: 34, financeEligible: true, lendTotal: 0 },
  { id: 's8', code: '虚008', name: '青屿连接', sector: '光通信', price: 9,
    concepts: ['连接器', '数据中心'], description: '生产高速连接器，客户集中度较高。',
    shares: 60_000_000, pe: 37, financeEligible: false, lendTotal: 0 },
  { id: 's9', code: '虚009', name: '丰泽电力', sector: '电力', price: 8,
    concepts: ['火电', '容量电价'], description: '区域发电企业，燃料价格与用电负荷影响盈利。',
    shares: 240_000_000, pe: 40, financeEligible: true, lendTotal: 10_000 },
  { id: 's10', code: '虚010', name: '川岚水电', sector: '电力', price: 14,
    concepts: ['水电', '绿电'], description: '经营水电站，来水量决定可发电量。',
    shares: 160_000_000, pe: 43, financeEligible: false, lendTotal: 0 },
  { id: 's11', code: '虚011', name: '恒原电网', sector: '电力', price: 19,
    concepts: ['特高压', '电网投资'], description: '主营输配电设备，订单跟随电网投资进度。',
    shares: 100_000_000, pe: 46, financeEligible: true, lendTotal: 0 },
  { id: 's12', code: '虚012', name: '沧岳储能', sector: '电力', price: 26,
    concepts: ['储能', '绿电'], description: '提供储能系统，项目验收与电池成本影响利润。',
    shares: 45_000_000, pe: 49, financeEligible: false, lendTotal: 0 },
  // s13–s16 remain reserved for the existing IPO schedule and saved IPO holdings.
  { id: 's17', code: '虚017', name: '衡川智造', sector: '机器人', price: 24,
    concepts: ['工业机器人', '柔性产线'], description: '提供工业机器人与柔性产线，整线订单规模较大，验收进度影响回款。',
    shares: 48_000_000, pe: 38, financeEligible: true, lendTotal: 0 },
  { id: 's18', code: '虚018', name: '灵枢驱动', sector: '机器人', price: 15,
    concepts: ['减速器', '机器人关节'], description: '研发精密减速器和机器人关节，客户验证、量产良率与零件成本决定盈利弹性。',
    shares: 32_000_000, pe: 44, financeEligible: false, lendTotal: 0 },
  { id: 's19', code: '虚019', name: '知微生物', sector: '创新药', price: 32,
    concepts: ['创新药授权', '研发管线'], description: '研发创新药并寻求海外授权，验证结果与授权首付款影响价值，后续里程碑收入不确定。',
    shares: 55_000_000, pe: 52, financeEligible: false, lendTotal: 0 },
  { id: 's20', code: '虚020', name: '澄和医药', sector: '创新药', price: 20,
    concepts: ['新药商业化', '院端准入'], description: '经营已上市新药的商业化业务，医院准入、终端用量与推广费用共同影响利润。',
    shares: 100_000_000, pe: 26, financeEligible: true, lendTotal: 0 },
  { id: 's21', code: '虚021', name: '瑞禾食品', sector: '大消费', price: 11,
    concepts: ['食品饮料', '渠道补货'], description: '生产大众食品饮料，商超补货、终端动销与原料成本决定利润，渠道压货不等于真实需求。',
    shares: 180_000_000, pe: 18, financeEligible: true, lendTotal: 10_000 },
  { id: 's22', code: '虚022', name: '锦里商贸', sector: '大消费', price: 7,
    concepts: ['连锁零售', '门店经营'], description: '经营区域连锁商超，客流、客单价与门店租金影响经营，促销放量也可能牺牲毛利。',
    shares: 90_000_000, pe: 22, financeEligible: false, lendTotal: 0 },
];

const STOCKS_BY_ID = new Map(BASE_STOCKS.map(stock => [stock.id, stock]));
export function baseStockById(id: string): BaseStockDefinition | undefined {
  return STOCKS_BY_ID.get(id);
}
