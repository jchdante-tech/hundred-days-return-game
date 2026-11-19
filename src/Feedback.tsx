import { useLayoutEffect, useRef, useState } from 'react';
import { Check, WarningCircle, X } from '@phosphor-icons/react';
import './motion.css';

export interface FeedbackMessage { text: string; error: boolean }
type FeedbackPhase = 'entering' | 'open' | 'exiting';

function keyboardInput() {
  return document.documentElement.dataset.input === 'keyboard';
}

function transitionTime(element: HTMLElement) {
  const style = getComputedStyle(element);
  const milliseconds = (value: string) => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000);
  const durations = style.transitionDuration.split(',').map(milliseconds);
  const delays = style.transitionDelay.split(',').map(milliseconds);
  return Math.max(0, ...durations.map((duration, index) => duration + (delays[index % delays.length] ?? 0)));
}

export function Feedback({ toast, onClose }: {
  toast: FeedbackMessage | null;
  onClose: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [displayed, setDisplayed] = useState<FeedbackMessage | null>(toast);
  const displayedRef = useRef<FeedbackMessage | null>(toast);
  const latestToast = useRef(toast);
  latestToast.current = toast;
  const [phase, setPhase] = useState<FeedbackPhase>('entering');
  const phaseRef = useRef<FeedbackPhase>('entering');
  const frame = useRef(0);
  const secondFrame = useRef(0);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function cancelScheduledWork() {
    cancelAnimationFrame(frame.current);
    cancelAnimationFrame(secondFrame.current);
    clearTimeout(exitTimer.current);
  }

  function removeDisplayed() {
    if (latestToast.current !== null) return;
    cancelScheduledWork();
    displayedRef.current = null;
    setDisplayed(null);
  }

  useLayoutEffect(() => {
    cancelScheduledWork();
    if (toast) {
      const hadContent = displayedRef.current !== null;
      displayedRef.current = toast;
      setDisplayed(toast);
      if (keyboardInput() || (hadContent && phaseRef.current !== 'entering')) {
        // Retarget an interrupted exit from its current CSS value; never remount the toast.
        phaseRef.current = 'open';
        setPhase('open');
      } else {
        phaseRef.current = 'entering';
        setPhase('entering');
        frame.current = requestAnimationFrame(() => {
          secondFrame.current = requestAnimationFrame(() => {
            if (!latestToast.current) return;
            phaseRef.current = 'open';
            setPhase('open');
          });
        });
      }
    } else if (displayedRef.current) {
      if (keyboardInput()) removeDisplayed();
      else {
        phaseRef.current = 'exiting';
        setPhase('exiting');
        const duration = element.current ? transitionTime(element.current) : 0;
        if (duration === 0) removeDisplayed();
        else exitTimer.current = setTimeout(removeDisplayed, duration + 50);
      }
    }
    return cancelScheduledWork;
  }, [toast]);

  function dismiss() {
    if (keyboardInput()) {
      cancelScheduledWork();
      displayedRef.current = null;
      setDisplayed(null);
    }
    onClose();
  }

  if (!displayed) return null;
  return (
    <div
      ref={element}
      className={`feedback${displayed.error ? ' feedback-error' : ''}`}
      data-state={phase}
      role={displayed.error ? 'alert' : 'status'}
      aria-atomic="true"
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'opacity'
          && phaseRef.current === 'exiting') removeDisplayed();
      }}
    >
      {displayed.error ? <WarningCircle size={20} aria-hidden="true" /> : <Check size={20} aria-hidden="true" />}
      <span className="feedback-message">{displayed.text}</span>
      <button
        type="button"
        className="feedback-close"
        aria-label="关闭提示"
        disabled={phase === 'exiting'}
        onClick={dismiss}
      >
        <X size={19} aria-hidden="true" />
      </button>
    </div>
  );
}

export default Feedback;
