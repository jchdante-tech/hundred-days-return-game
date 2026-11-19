import { useId, useLayoutEffect, useRef } from 'react';
import { ArrowRight, X } from '@phosphor-icons/react';
import type { MarketView } from '../shared/types';
import { compact } from './format';
import './EndingScreen.css';
import BrandLogo from './BrandLogo';

export interface EndingScreenProps {
  market: MarketView;
  onClose: () => void;
  /** Parent dismisses this screen and opens the existing new-game confirmation. */
  onRestart: () => void;
}

export default function EndingScreen({ market, onClose, onRestart }: EndingScreenProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const won = market.result === 'won';
  const matured = market.daysLeft <= 0;
  const challenge = market.challenge;

  useLayoutEffect(() => {
    if (!market.result) return;
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    if (!element.open) element.showModal();
    document.body.style.overflow = 'hidden';
    heading.current?.focus({ preventScroll: true });
    return () => {
      if (element.open) element.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [market.result]);

  if (!market.result) return null;

  return (
    <dialog
      ref={dialog}
      className={`ending-screen ending-screen--${won ? 'victory' : 'default'}`}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <div className="ending-screen__scene">
        <img
          className="ending-screen__art"
          src={`/art/ending-${won ? 'victory' : 'default'}-v14.png`}
          alt={won ? '沪上夜宴中，你从容地向来宾举起酒杯，窗外灯火通明。' : '雨夜的黄浦江边，交易室里只剩一把空椅子和无人接听的电话。'}
        />
        <header className="ending-screen__topline">
          <div className="ending-screen__wordmark"><BrandLogo className="ending-screen__brand-logo" /><span>· 终章</span></div>
          <button type="button" className="ending-screen__close" onClick={onClose} aria-label="关闭结局，查看本局复盘">
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <article className="ending-screen__copy">
          <p className="ending-screen__chapter">{won ? '结局 · 名利双收' : '结局 · 江湖无名'}</p>
          <h1 id={titleId} ref={heading} tabIndex={-1}>
            {won ? <><span>旧账已清，</span><span>牌局未散。</span></> : <><span>你离席了，</span><span>传闻还在。</span></>}
          </h1>
          <div className="ending-screen__story" aria-label="结局故事">
            {won ? <>
              <p>最后一笔款到账，借据上落下了两个字：<strong>结清。</strong></p>
              <p>黄浦江边又摆了一桌酒。当年劝你离席的人，如今抢着替你斟满。你举起杯，敬的却是那些独自等到收盘的夜晚。</p>
              <p>此后，龙虎榜上仍常见你的席位。有人追随，有人忌惮。旧债归零，名声和信用回到了你手里——这一次，没人能逼你离场。</p>
            </> : <>
              <p>{matured ? '约定的日子到了，账上的钱终究没能填平那个窟窿。' : '催缴的电话响过最后一遍，你再也拿不出足够的担保。'}交易室的灯，从那夜起就没有再亮。</p>
              <p>起初，茶桌上还聊起你的那几笔大单。后来，新的名字上了龙虎榜，旧故事便无人再提。</p>
              <p>有人说，你死在了一个无人知晓的夜里；有人说，你远走南洋，成了电诈集团背后的头目。传闻越讲越真，却始终没人拿得出证据。</p>
            </>}
          </div>
          <p className="ending-screen__last-line">{won ? '明早开盘，江湖还有你的名字。' : '但谁知道呢。江面起了雾，故事也就断在这里。'}</p>

          <dl className="ending-screen__record" aria-label="本局结算">
            <div>
              <dt>{challenge ? (won ? '累计偿还' : '未清旧账') : '未清信用债务'}</dt>
              <dd>{compact(challenge ? (won ? challenge.paid : challenge.remaining) : market.debt)}</dd>
            </div>
            {challenge && market.debt > 0 && <div><dt>未清信用债务</dt><dd>{compact(market.debt)}</dd></div>}
            <div><dt>结算净资产</dt><dd>{compact(market.equity)}</dd></div>
            <div><dt>经历交易日</dt><dd>{market.day}<small> 日</small></dd></div>
          </dl>

          <div className="ending-screen__actions">
            <button type="button" className="ending-screen__primary" onClick={onClose}>查看本局复盘 <ArrowRight size={18} aria-hidden="true" /></button>
            <button type="button" className="ending-screen__restart" onClick={onRestart}>再赴牌局</button>
          </div>
          <p className="ending-screen__footnote">本局记录已保存</p>
        </article>
        <div className="ending-screen__seal" aria-hidden="true">{won ? '归' : '隐'}</div>
      </div>
    </dialog>
  );
}
