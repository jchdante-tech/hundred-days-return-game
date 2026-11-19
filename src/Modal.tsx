import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import './motion.css';

type ModalPhase = 'entering' | 'open' | 'exiting';

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

export function Modal({ title, children, close }: {
  title: string;
  children: ReactNode | ((dismiss: () => void) => ReactNode);
  close: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const [phase, setPhase] = useState<ModalPhase>('entering');
  const phaseRef = useRef<ModalPhase>('entering');
  const finished = useRef(false);
  const frame = useRef(0);
  const secondFrame = useRef(0);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerStartedOutside = useRef(false);

  function cancelScheduledWork() {
    cancelAnimationFrame(frame.current);
    cancelAnimationFrame(secondFrame.current);
    clearTimeout(exitTimer.current);
  }

  function finishClose() {
    if (finished.current) return;
    finished.current = true;
    cancelScheduledWork();
    dialog.current?.close();
    closeRef.current();
  }

  function dismiss(immediate = false) {
    if (immediate || keyboardInput()) {
      finishClose();
      return;
    }
    if (phaseRef.current === 'exiting' || finished.current) return;
    cancelScheduledWork();
    phaseRef.current = 'exiting';
    setPhase('exiting');
    const duration = dialog.current ? transitionTime(dialog.current) : 0;
    if (duration === 0) finishClose();
    else exitTimer.current = setTimeout(finishClose, duration + 50);
  }

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    finished.current = false;
    if (!element.open) element.showModal();
    if (keyboardInput()) {
      phaseRef.current = 'open';
      setPhase('open');
    } else {
      phaseRef.current = 'entering';
      setPhase('entering');
      frame.current = requestAnimationFrame(() => {
        secondFrame.current = requestAnimationFrame(() => {
          if (finished.current || phaseRef.current === 'exiting') return;
          phaseRef.current = 'open';
          setPhase('open');
        });
      });
    }
    return () => {
      finished.current = true;
      cancelScheduledWork();
      if (element.open) element.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="motion-dialog"
      data-state={phase}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); dismiss(true); }}
      onClose={() => { if (!dialog.current?.open) finishClose(); }}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        pointerStartedOutside.current = event.target === event.currentTarget
          && (event.clientX < bounds.left || event.clientX > bounds.right
            || event.clientY < bounds.top || event.clientY > bounds.bottom);
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || !pointerStartedOutside.current) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss();
      }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'opacity'
          && phaseRef.current === 'exiting') finishClose();
      }}
    >
      <header className="motion-dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="motion-dialog-close" aria-label="关闭" onClick={() => dismiss()}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="motion-dialog-content">
        {typeof children === 'function' ? children(() => dismiss()) : children}
      </div>
    </dialog>
  );
}

export default Modal;
