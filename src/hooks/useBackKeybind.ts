import { useEffect } from 'react';
import { useKeybinds } from '../context/KeybindsProvider';

export function useBackKeybind(onBack: () => void, enabled: boolean = true) {
  const { getActionsForEvent } = useKeybinds();

  useEffect(() => {
    if (!enabled) return;

    const isTypingTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || el.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      const actions = getActionsForEvent(e);
      if (actions.includes('app.back')) {
        e.preventDefault();
        e.stopPropagation();
        onBack();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [enabled, getActionsForEvent, onBack]);
}
