import { useEffect, useRef, useState, type CSSProperties } from 'react';
import './story.css';
import type { MarketView } from '../shared/types';
import { compact } from './format';
import BrandLogo from './BrandLogo';

type StoryProps = {
  account?: MarketView;
  onStart: () => void;
  onResume: () => void;
  hasSave: boolean;
  onHelp: () => void;
};

const scenes = [
  {
    name: '曾经',
    number: '一',
    place: '旧日 · 酒店包厢',
    title: '那时候，\n桌上总有人。',
    quote: '“陈先生，这一轮，还跟你。”',
    paragraphs: [
      '人声、碰杯声，行情屏上的红光。',
      '你曾以为，坐在这张桌上，\n明天就总会更好。',
    ],
    alt: '昔日的陈默在暖黄灯光下与几位客人围坐酒店圆桌，手边放着旧账本。',
    crop: { x: 0, y: 0, width: 763, height: 460 },
  },
  {
    name: '失手',
    number: '二',
    place: '后来 · 交易室',
    title: '行情没有\n给你第二次机会。',
    quote: '一笔重仓，一次判断失误。',
    paragraphs: [
      '下跌接着下跌。\n追保通知之后，是部分强制减仓。',
      '大半身家留在了那一轮行情里。\n屏幕还亮着，屋子已经空了。',
    ],
    alt: '陈默独坐昏暗交易室，一手扶额，红绿行情光映在脸上，面前是摊开的账本。',
    crop: { x: 775, y: 0, width: 761, height: 460 },
  },
  {
    name: '来电',
    number: '三',
    place: '深夜 · 一通电话',
    title: '“合约还剩\n一百天。”',
    quote: '“追加授信先停了。\n这一笔到期，不再展期。”',
    paragraphs: [
      '电话那头的语气很平静。',
      '你没有接话。\n窗外，雨还没有停。',
    ],
    alt: '雨夜窗前，陈默接听老式有线电话，窗外霓虹与路灯映在湿玻璃上。',
    crop: { x: 0, y: 473, width: 763, height: 551 },
  },
  {
    name: '开市',
    number: '四',
    place: '清晨 · 重新入局',
    title: '账，还在。\n人，也还在。',
    quote: '你叫陈默。',
    paragraphs: [
      '一千万，回到你的游资席位。\n你的每一笔成交，都可能改变盘口。',
      '余下的一百个自然日，先把债还清，\n再决定要走多远。',
    ],
    alt: '晨光照进交易室，陈默卷起衬衫袖子，在旧账本前重新整理自己的账户。',
    crop: { x: 775, y: 473, width: 761, height: 551 },
  },
] as const;

export default function Story({ onStart, onResume, hasSave, onHelp, account }: StoryProps) {
  const [sceneIndex, setSceneIndex] = useState(-1);
  const [entering, setEntering] = useState(false);
  const [entryError, setEntryError] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const enterLock = useRef(false);
  const scene = scenes[sceneIndex];
  const isLast = sceneIndex === scenes.length - 1;
  const legacy = !!account && !account.challenge;

  useEffect(() => {
    if (sceneIndex >= 0) headingRef.current?.focus({ preventScroll: true });
  }, [sceneIndex]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        entering || document.querySelector('dialog[open]') ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName)))
      ) return;

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setSceneIndex((index) => Math.min(scenes.length - 1, index + 1));
      } else if (event.key === 'ArrowLeft' && sceneIndex >= 0) {
        event.preventDefault();
        setSceneIndex((index) => Math.max(-1, index - 1));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [entering, sceneIndex]);

  const enterMarket = async () => {
    if (enterLock.current) return;
    enterLock.current = true;
    setEntering(true);
    setEntryError('');
    try {
      await onStart();
    } catch {
      setEntryError('暂时没能进入交易室，请重试。');
    } finally {
      enterLock.current = false;
      setEntering(false);
    }
  };

  if (sceneIndex < 0) {
    return (
      <main className="story story--cover" aria-label="百日回归游戏封面">
        <img
          className="story-cover-art"
          src="/art/cover.png"
          alt="沪上雨夜，一个身着深色西装的男人背对窗前，望着暖金灯光中的老金融街。"
          fetchPriority="high"
        />
        <div className="story-cover-shade" aria-hidden="true" />
        <header className="story-topline">
          <BrandLogo className="story-brand-logo" />
          
        </header>

        <section className="story-cover-copy">
          <p className="story-eyebrow">沪上 · 一个漫长的雨夜</p>
          <h1 className="story-cover-title" aria-label="百日回归"><BrandLogo className="brand-logo--hero" decorative /></h1>
          <p className="story-cover-subtitle">这次，由你坐上游资席位。</p>
          <p className="story-cover-intro">一千万起步，用成交改变盘口。<br />留给你偿还旧账的，还有一百天。</p>
          <div className="story-cover-actions">

            <button className="story-button story-button--primary" onClick={() => setSceneIndex(0)}>
              翻开序章 <span aria-hidden="true">→</span>
            </button>
            {hasSave && (
              <button className="story-button story-button--quiet" onClick={onResume}>
                继续交易 <span aria-hidden="true">→</span>
              </button>
            )}
          </div>
          <button className="story-help" onClick={onHelp}>玩法介绍</button>
          <p className="story-cover-caption">四幕序章 · 独立市场 · 百日生涯</p>
        </section>

        <footer className="story-cover-footer">
          <span>灯还亮着，故事就没有结束。</span>
          
        </footer>
      </main>
    );
  }

  const cropStyle: CSSProperties = {
    width: `${(1536 / scene.crop.width) * 100}%`,
    left: `${(-scene.crop.x / scene.crop.width) * 100}%`,
    top: `${(-scene.crop.y / scene.crop.height) * 100}%`,
  };

  return (
    <main className="story story--prologue" aria-label="百日回归序章">
      <header className="story-topline">
        <button className="story-wordmark-button" onClick={() => setSceneIndex(-1)} disabled={entering} aria-label="返回百日回归封面">
          <BrandLogo className="story-brand-logo" decorative />
        </button>
        <button className="story-skip" onClick={() => void enterMarket()} disabled={entering}>
          {entering ? '正在入局' : '跳过序章'} <span aria-hidden="true">→</span>
        </button>
      </header>

      <div className="story-page" key={sceneIndex}>
        <figure className="story-frame">
          <div className="story-frame-window" style={{ aspectRatio: `${scene.crop.width} / ${scene.crop.height}` }}>
            <img
              className="story-comic-image"
              src="/art/comic.png"
              alt={scene.alt}
              style={cropStyle}
              fetchPriority="high"
            />
          </div>
          <figcaption className="story-frame-caption">
            <span>{scene.place}</span>
            <span aria-hidden="true">0{sceneIndex + 1} / 04</span>
          </figcaption>
        </figure>

        <section className="story-dialogue" aria-labelledby="story-scene-title">
          <p className="story-eyebrow">第{scene.number}幕 · {scene.name}</p>
          <h1 id="story-scene-title" className="story-scene-title" tabIndex={-1} ref={headingRef}>{scene.title}</h1>
          <p className="story-quote">{sceneIndex === 2 && !legacy ? '“清算留下的一个亿，\n到期必须结清。”' : scene.quote}</p>
          <div className="story-narration">
            {(sceneIndex === 3 && !legacy ? ['旧友替你争来一百天。\n你手里，还有一千万现金。', '从空仓开始，把这张旧账，\n一笔一笔还清。'] : scene.paragraphs).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </div>

          {isLast && (
            <>
              <dl className="story-ledger" aria-label="开局账户">
                {legacy ? <><div><dt>当前可用现金</dt><dd>{compact(account.availableCash)}</dd></div><div><dt>原合同融资</dt><dd className="story-debt">{compact(account.debt)}</dd></div><div><dt>当前净资产</dt><dd>{compact(account.equity)}</dd></div><div><dt>距离到期</dt><dd>{account.daysLeft}<span>自然日</span></dd></div></> : <><div><dt>开局现金</dt><dd>1,000<span>万</span></dd></div><div><dt>清偿目标</dt><dd className="story-debt">1<span>亿</span></dd></div><div><dt>目标倍数</dt><dd>10<span>倍</span></dd></div><div><dt>距离到期</dt><dd>100<span>自然日</span></dd></div></>}
              </dl>
              <p className="story-contract-note">{legacy ? '当前继续旧合同存档。重新开局后可体验一亿挑战。' : '目标欠款独立于证券融资。第 20 个交易日，新的信用交易权限将开放。'}</p>
            </>
          )}

          <div className="story-scene-actions">
            <button
              className="story-button story-button--primary"
              onClick={isLast ? () => void enterMarket() : () => setSceneIndex((index) => index + 1)}
              disabled={entering}
            >
              {entering ? '正在进入交易室' : isLast ? '推开交易室的门' : '下一幕'}
              <span aria-hidden="true">→</span>
            </button>
            <button
              className="story-back"
              onClick={() => setSceneIndex((index) => index - 1)}
              disabled={entering}
            >
              <span aria-hidden="true">←</span> {sceneIndex === 0 ? '封面' : '上一步'}
            </button>
          </div>
          {entryError && <p className="story-error" role="alert">{entryError}</p>}
        </section>
      </div>

      <footer className="story-bottom">
        <nav aria-label="序章进度" className="story-progress">
          {scenes.map((item, index) => (
            <button
              key={item.name}
              className={`story-progress-step${index === sceneIndex ? ' is-current' : ''}${index < sceneIndex ? ' is-complete' : ''}`}
              aria-current={index === sceneIndex ? 'step' : undefined}
              aria-label={`第${item.number}幕：${item.name}`}
              onClick={() => setSceneIndex(index)}
              disabled={entering}
            >
              <span className="story-progress-line" aria-hidden="true" />
              <span className="story-progress-label"><span>0{index + 1}</span>{item.name}</span>
            </button>
          ))}
        </nav>
        <span className="story-keyboard-hint">← → 翻页</span>
      </footer>
    </main>
  );
}
