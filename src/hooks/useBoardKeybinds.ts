import { useEffect } from 'react';
import { useKeybinds, KeyAction } from '../context/KeybindsProvider';

export type BoardKeyHandlers = {
  first?: () => void;
  prev?: () => void;
  next?: () => void;
  last?: () => void;
  flip?: () => void;
};

/**
 * Attaches window-level keydown handlers for board navigation.
 * Skips when user is typing in inputs/textareas/contentEditable.
 * Supports two bindings per action and modifiers (Ctrl/Alt/Shift/Meta).
 */
export function useBoardKeybinds(handlers: BoardKeyHandlers, enabled = true) {
  const { getActionForEvent } = useKeybinds();

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

      const action = getActionForEvent(e);
      if (!action) return;

      let handled = false;

      switch (action as KeyAction) {
        case 'board.first':
          if (handlers.first) { handlers.first(); handled = true; }
          break;
        case 'board.prev':
          if (handlers.prev) { handlers.prev(); handled = true; }
          break;
        case 'board.next':
          if (handlers.next) { handlers.next(); handled = true; }
          break;
        case 'board.last':
          if (handlers.last) { handlers.last(); handled = true; }
          break;
        case 'board.flip':
          if (handlers.flip) { handlers.flip(); handled = true; }
          break;
      }

      if (handled) {
        // Prevent the page from scrolling with arrow keys while navigating
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [getActionForEvent, handlers.first, handlers.prev, handlers.next, handlers.last, enabled]);
}
