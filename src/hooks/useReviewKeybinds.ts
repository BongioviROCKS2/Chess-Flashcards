import { useEffect } from 'react';
import { useKeybinds, KeyAction } from '../context/KeybindsProvider';

type FrontHandlers = {
  showAnswer?: () => void;
};

type BackHandlers = {
  again?: () => void;
  hard?: () => void;
  good?: () => void;
  easy?: () => void;
};

export function useReviewKeybinds(opts: {
  isFront: boolean;          // true on front side, false on back side
  front?: FrontHandlers;
  back?: BackHandlers;
  onUndo?: () => void;       // NEW: undo handler, fires on Ctrl+Z by default
  enabled?: boolean;         // default true
}) {
  const { getActionsForEvent } = useKeybinds();
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;

    const isTypingTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return true;
      return false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      const actions = getActionsForEvent(e);
      if (actions.length === 0) return;

      // Undo has top priority and is context-agnostic
      if (actions.includes('review.undo') && opts.onUndo) {
        opts.onUndo();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      let handled = false;

      if (opts.isFront) {
        if (actions.includes('review.showAnswer') && opts.front?.showAnswer) {
          opts.front.showAnswer();
          handled = true;
        }
      } else {
        const order: KeyAction[] = ['review.again', 'review.hard', 'review.good', 'review.easy'];
        for (const act of order) {
          if (actions.includes(act)) {
            switch (act) {
              case 'review.again':
                if (opts.back?.again) { opts.back.again(); handled = true; }
                break;
              case 'review.hard':
                if (opts.back?.hard)  { opts.back.hard();  handled = true; }
                break;
              case 'review.good':
                if (opts.back?.good)  { opts.back.good();  handled = true; }
                break;
              case 'review.easy':
                if (opts.back?.easy)  { opts.back.easy();  handled = true; }
                break;
            }
            if (handled) break;
          }
        }
      }

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [enabled, getActionsForEvent, opts.isFront, opts.front?.showAnswer, opts.back?.again, opts.back?.hard, opts.back?.good, opts.back?.easy, opts.onUndo]);
}
