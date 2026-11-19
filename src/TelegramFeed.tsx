import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp } from '@phosphor-icons/react';
import type { NewsView } from '../shared/types';
import './telegram-feed.css';
import GameIcon from './GameIcon';

export function NewsStage({ news }: { news: NewsView }) {
  if (!news.stage) return null;
  return <span className="news-stage">{({ proposal: '项目线索', progress: '进展跟踪', result: '结果公布', delivery: '交付兑现' })[news.stage]}</span>;
}

export function NewsImpacts({ news, onSector }: { news: NewsView; onSector: (sector: string) => void }) {
  if (!news.impacts?.length) return null;
  return <div className="news-impacts">
    {news.impacts.map((impact, i) => <div key={`${impact.sector}-${i}`} className={`impact ${impact.direction}`}>
      <span className="impact-direction">{impact.direction === 'positive' ? '预期利好' : '预期利空'}</span>
      <button className="impact-sector" onClick={() => onSector(impact.sector)}>{impact.sector}<ArrowRight size={12} /></button>
      <span className="impact-reason">{impact.reason}</span>
    </div>)}
  </div>;
}

type ReadingAnchor = { id: string; offset: number; scrollTop: number };

export default function TelegramFeed({ news, onSector, onOpen }: {
  news: NewsView[];
  onSector: (sector: string) => void;
  onOpen: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const readingAnchor = useRef<ReadingAnchor | null>(null);
  const previousIds = useRef<string[]>([]);
  const [unread, setUnread] = useState(0);
  const [canScroll, setCanScroll] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const hintId = useId();
  const ids = news.map(item => item.id);
  const listKey = JSON.stringify(ids);

  const rememberPosition = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    const firstVisible = Array.from(list.querySelectorAll<HTMLElement>('[data-news-id]'))
      .find(item => item.getBoundingClientRect().bottom > top + 1);
    readingAnchor.current = firstVisible ? {
      id: firstVisible.dataset.newsId!,
      offset: firstVisible.getBoundingClientRect().top - top,
      scrollTop: list.scrollTop,
    } : null;
    setCanScroll(list.scrollHeight > list.clientHeight + 2);
    setAtEnd(list.scrollHeight - list.clientHeight - list.scrollTop < 4);
    if (list.scrollTop < 12) setUnread(0);
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const previous = previousIds.current;
    const oldFirstIndex = previous.length ? ids.indexOf(previous[0]) : -1;
    const anchor = readingAnchor.current;

    if (oldFirstIndex > 0 && anchor && anchor.scrollTop >= 12) {
      // Preserve the visible article, even when older entries are trimmed from the feed.
      const visibleArticle = Array.from(list.querySelectorAll<HTMLElement>('[data-news-id]'))
        .find(item => item.dataset.newsId === anchor.id);
      if (visibleArticle) {
        list.scrollTop += visibleArticle.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset;
      }
      setUnread(count => count + oldFirstIndex);
    } else if (oldFirstIndex < 0 || !anchor || anchor.scrollTop < 12) {
      list.scrollTop = 0;
      setUnread(0);
    }
    previousIds.current = ids;
    rememberPosition();
  }, [listKey, rememberPosition]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(rememberPosition);
    observer.observe(list);
    return () => observer.disconnect();
  }, [rememberPosition]);

  const goToLatest = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = 0;
    setUnread(0);
    rememberPosition();
    list.focus({ preventScroll: true });
  };

  return <aside className="news-note telegram-feed" aria-label="沪上电讯" data-tour="news">
    <div className="telegram-masthead"><GameIcon name="news" /><span>沪上电讯</span><small>{news.length} 封</small></div>
    <div className="telegram-feed-status" id={hintId}>
      {unread > 0
        ? <button onClick={goToLatest}><ArrowUp size={12} />{unread} 封新电讯 · 回到最新</button>
        : <span>{canScroll ? atEnd ? '已翻至最早电讯' : '最新在前 · 向下翻阅' : '最新在前'}{canScroll && !atEnd && <ArrowDown size={12} />}</span>}
    </div>
    <div className="telegram-feed-list" ref={listRef} tabIndex={0} role="region" aria-label="滚动电讯列表" aria-describedby={hintId} onScroll={rememberPosition}>
      {news.length ? news.map(item => <article className="telegram-item" key={item.id} data-news-id={item.id}>
        <div className="telegram-item-dateline"><span>{item.day ? `第 ${item.day} 日` : '往期来信'}</span><time>{item.time}</time></div>
        <NewsStage news={item} />
        <h3>{item.headline}</h3>
        {(item.storyId || !item.impacts?.length) && <p className="telegram-item-body">{item.body}</p>}
        <NewsImpacts news={item} onSector={onSector} />
      </article>) : <p className="telegram-feed-empty">暂未收到电讯，留意接下来的市场消息。</p>}
    </div>
    <button className="telegram-link" onClick={onOpen}>拆开全部电讯 <ArrowRight size={15} /></button>
  </aside>;
}
