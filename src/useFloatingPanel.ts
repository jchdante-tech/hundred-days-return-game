import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clampPanelPoint, restorePanelPoint, savePanelPoint, type PanelPoint, type PanelViewport } from './floating-panel-position';

const STORAGE_KEY = 'bairi-clock-position-v1';
export const FLOATING_PANEL_MOVE = 'bairi-floating-panel-move';

function viewport(): PanelViewport {
  const view = window.visualViewport;
  return { left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0,
    width: view?.width ?? document.documentElement.clientWidth, height: view?.height ?? window.innerHeight };
}

/** Local UI preference only: moving the clock never calls a game action. */
export function useFloatingPanel() {
  const panelRef = useRef<HTMLElement>(null);
  const [point, setPoint] = useState<PanelPoint | null>(null);
  const pointRef = useRef<PanelPoint | null>(null);
  const saved = useRef<unknown>(null);
  const drag = useRef<{ pointerId: number; clientX: number; clientY: number; origin: PanelPoint } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);

  const move = (next: PanelPoint) => {
    pointRef.current = next;
    setPoint(previous => previous?.x === next.x && previous.y === next.y ? previous : next);
  };
  const remember = () => {
    if (!panelRef.current || !pointRef.current) return;
    saved.current = savePanelPoint(pointRef.current, panelRef.current.getBoundingClientRect(), viewport());
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved.current)); } catch { /* optional UI preference */ }
  };
  const reset = () => {
    saved.current = null; pointRef.current = null; drag.current = null;
    setDragging(false); setPoint(null);
    setResetVersion(value => value + 1);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* optional UI preference */ }
  };

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    try { saved.current = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); } catch { saved.current = null; }
    let frame = 0;
    const fit = () => {
      const rect = panel.getBoundingClientRect(), bounds = viewport();
      const restored = !drag.current && restorePanelPoint(saved.current, rect, bounds);
      if (restored) move(restored);
      else {
        const current = pointRef.current ?? { x: rect.left, y: rect.top };
        const safe = clampPanelPoint(current, rect, bounds);
        if (pointRef.current || safe.x !== current.x || safe.y !== current.y) move(safe);
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    fit();
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, []);

  // CSS defaults use the layout viewport. After reset, keep them visible even
  // when zooming or the software keyboard has reduced the visual viewport.
  useLayoutEffect(() => {
    if (!resetVersion || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    const safe = clampPanelPoint({ x: rect.left, y: rect.top }, rect, viewport());
    if (safe.x !== rect.left || safe.y !== rect.top) move(safe);
  }, [resetVersion]);

  // Tutorial spotlights need fresh coordinates when a fixed target moves.
  useLayoutEffect(() => { window.dispatchEvent(new Event(FLOATING_PANEL_MOVE)); }, [point]);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      origin: { x: rect.left, y: rect.top } };
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId || !panelRef.current) return;
    event.preventDefault();
    move(clampPanelPoint({ x: active.origin.x + event.clientX - active.clientX,
      y: active.origin.y + event.clientY - active.clientY }, panelRef.current.getBoundingClientRect(), viewport()));
  };
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null; setDragging(false); remember();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Home') { event.preventDefault(); reset(); return; }
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction || !panelRef.current) return;
    event.preventDefault();
    const rect = panelRef.current.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
    move(clampPanelPoint({ x: rect.left + direction[0] * step, y: rect.top + direction[1] * step }, rect, viewport()));
    remember();
  };

  return { panelRef, dragging, reset, moved: point !== null,
    style: point ? { left: point.x, top: point.y, right: 'auto', bottom: 'auto' } : undefined,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish, onKeyDown } };
}
