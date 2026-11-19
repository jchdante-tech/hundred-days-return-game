import { useEffect, useRef, useState } from 'react';

type HowToPlayProps = {
  legacy?: boolean;
  onClose: () => void;
  onStart: () => void;
};

const steps = [
  { label: '身份与目标', title: '你的身份和目标' },
  { label: '每天怎么玩', title: '每天做这四件事' },
  { label: '第一笔交易', title: '从第一笔普通买入开始' },
] as const;

export default function HowToPlay({ onClose, onStart, legacy = false }: HowToPlayProps) {
  const [step, setStep] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(0);
  const isLast = step === steps.length - 1;

  useEffect(() => {
    if (previousStep.current !== step) {
      titleRef.current?.focus({ preventScroll: true });
      previousStep.current = step;
    }
  }, [step]);

  return (
    <div className="guide">
      <div className="guide-topline">
        <p className="guide-kicker">上手指南</p>
        <span className="guide-step-count" aria-label={`第 ${step + 1} 步，共 3 步`}>
          {String(step + 1).padStart(2, '0')} / 03
        </span>
      </div>

      <ol className="guide-progress" aria-label="玩法介绍进度">
        {steps.map((item, index) => (
          <li
            key={item.label}
            className={`guide-progress-step${index === step ? ' guide-progress-current' : ''}${index < step ? ' guide-progress-complete' : ''}`}
            aria-current={index === step ? 'step' : undefined}
          >
            <span className="guide-progress-number" aria-hidden="true">{index + 1}</span>
            <span>{item.label}</span>
          </li>
        ))}
      </ol>

      <section className="guide-step" key={step} aria-labelledby="guide-step-title" data-step={step + 1}>
        <h2 className="guide-title" id="guide-step-title" ref={titleRef} tabIndex={-1}>
          {steps[step].title}
        </h2>

        {step === 0 && (
          <>
            <p className="guide-lead">你是陈默，一位交易失手的游资。</p>
            <dl className="guide-balances">
              <div><dt>新局总资产</dt><dd>1,000<span>万</span></dd></div>
              <div><dt>目标欠款</dt><dd>1<span>亿</span></dd></div>
              <div><dt>目标资金倍数</dt><dd>10<span>倍</span></dd></div>
            </dl>
            <p className="guide-description">
              <strong>100 个自然日，偿还一亿旧账。</strong>
              新局有 1,000 万现金，从空仓开始。买入股票，等下一交易日再按买盘卖出。筹到现金后，结清交易信用债务，再支付目标欠款；可以提前还款。
            </p>
            <p className="guide-note">
              {legacy ? '你当前保留的是旧合同存档；重新开局后才采用上面的新挑战规则。' : '目标欠款是一笔独立的清算约定。“杠杆交易”第 20 个交易日开放，可选逐仓或全仓，用本金与倍数开仓，届时会有单独引导。'}
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <ol className="guide-flow">
              <li>
                <strong>看消息</strong>
                <p>先看新闻下方的利好、利空和涉及股票。</p>
              </li>
              <li>
                <strong>找能推动的盘口</strong>
                <p>先看可用现金，再看买卖盘口里的价格和数量。相同资金面对不同卖盘，推动价格的力度也不同。</p>
              </li>
              <li>
                <strong>试盘、扫货、看跟随</strong>
                <p>选择买入或卖出，填好价格与数量，再确认委托。需要快捷试单或扫档时，展开“盘口详情 / 更多操作”。成交后看回执，再观察有没有其他资金接力。</p>
              </li>
              <li>
                <strong>收盘复盘</strong>
                <p>看板块流向、游资连续买入与转卖的记录，再安排下一天。游资各有偏好，也可能等待机会。</p>
              </li>
            </ol>
            <p className="guide-note">
              一个项目会经历线索、进展、结果和兑现，持续几天。好消息也可能低于此前预期；留意具体公司和成交是否跟上。普通资金提供日常买卖，六个游资集中参与少量股票；盘后公布的是成交记录，不是明天的计划。
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <p className="guide-lead">
              <strong>第一天，就是正式存档中的固定开局关。</strong>
              18 只股票都保留，引导只标出一只目标股，并逐步框出要操作的位置。第一天买入，第二天解锁后再尝试卖出。第二天起行情随机，成交取决于当时的真实买盘。跳过只关闭提示，不会重置市场或账户。
            </p>
            <ol className="guide-start-steps">
              <li>
                <strong>跟着框选找到目标股</strong>
                <p>第一天的初始价格、盘口和筹码分布固定，其他 17 只股票也能自由交易。时间控制台可随时开始、暂停或快进。</p>
              </li>
              <li>
                <strong>填写价格、数量，再确认买入</strong>
                <p>首笔目标是 50 万股、10.30 元限价。按提示填写并提交，观察实际成交与价格变化；今天买入的股份暂时不能卖。</p>
              </li>
              <li>
                <strong>第二天看买盘，再提交卖出</strong>
                <p>现金和持仓会保留到次日。先检查可卖数量，再按买盘填写卖单；可能只成交一部分，也可能暂时无人接单，收益以实际成交为准。</p>
              </li>
            </ol>
            <ul className="guide-rule-list">
              <li><strong>T+1：</strong>今天买的，下一交易日才能卖。</li>
              <li><strong>筹码与承接：</strong>成交才改变筹码分布。拉高可能引来获利卖盘；浮盈要卖出后才变成现金。</li>
              <li>未成交部分可以撤单，竞价锁单阶段除外。</li>
              <li>休市不成交。第 20 个交易日开放杠杆交易；仍需实际成交，也仍遵守 T+1。</li>
            </ul>
          </>
        )}
      </section>

      <div className="guide-actions">
        <div className="guide-secondary-actions">
          {step > 0 && (
            <button type="button" className="guide-button guide-button-back" onClick={() => setStep((value) => value - 1)}>
              上一步
            </button>
          )}
          <button type="button" className="guide-button guide-button-dismiss" onClick={onClose}>
            关闭介绍
          </button>
        </div>
        <button
          type="button"
          className="guide-button guide-button-primary"
          onClick={isLast ? onStart : () => setStep((value) => Math.min(steps.length - 1, value + 1))}
        >
          {isLast ? '进入交易' : '下一步'}
          <span aria-hidden="true"> →</span>
        </button>
      </div>
    </div>
  );
}
