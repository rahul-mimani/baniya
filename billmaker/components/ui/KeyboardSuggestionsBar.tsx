import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  suggestions: string[];
  onSelect: (s: string) => void;
  /** Optional className for the chip color scheme — defaults to sky-blue. */
  chipClassName?: string;
}

/**
 * A horizontal chip strip pinned just above the on-screen keyboard.
 *
 * Solves the classic mobile bill-builder problem: when the user focuses a
 * suggestion-backed input, the soft keyboard covers the dropdown that
 * naturally falls underneath. Native iOS/Android pickers handle this by
 * floating their suggestions above the keyboard — we mimic that by:
 *
 *   1. Using `window.visualViewport` to compute the keyboard's top edge
 *      (= layout-viewport height − visual-viewport bottom).
 *   2. Rendering ourselves at `position: fixed; bottom: <that gap>` so we
 *      sit flush against the keyboard regardless of scroll.
 *   3. Portaling to document.body so no parent's overflow:hidden /
 *      transform / sticky container clips us off.
 *
 * Tapping a chip uses `onMouseDown` + `preventDefault` so the focus stays
 * on the input — the keyboard doesn't bounce and the user can keep typing
 * after a selection if they want to.
 */
const KeyboardSuggestionsBar: React.FC<Props> = ({
  suggestions,
  onSelect,
  chipClassName,
}) => {
  const [bottomOffset, setBottomOffset] = useState(0);

  useEffect(() => {
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    if (!vv) return;
    const update = () => {
      // Gap between the layout viewport's bottom and the visual viewport's
      // bottom. With the keyboard open, this equals the keyboard height.
      const offset = window.innerHeight - (vv.offsetTop + vv.height);
      setBottomOffset(Math.max(0, offset));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  if (typeof document === 'undefined' || suggestions.length === 0) return null;

  return createPortal(
    <div
      className="fixed left-0 right-0 z-[80] bg-white border-t border-slate-200 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]"
      style={{
        bottom: `${bottomOffset}px`,
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      <div
        className="flex gap-2 overflow-x-auto px-3 py-2"
        style={{ scrollbarWidth: 'none' }}
      >
        {suggestions.map((s, i) => (
          <button
            key={`${s}-${i}`}
            type="button"
            onMouseDown={e => { e.preventDefault(); onSelect(s); }}
            // touchstart on iOS fires before mousedown — also intercept it
            // so the chip selection feels instant on mobile.
            onTouchStart={e => { e.preventDefault(); onSelect(s); }}
            className={
              chipClassName ??
              'shrink-0 px-3 py-1.5 bg-sky-50 text-sky-900 rounded-full text-xs font-semibold border border-sky-200 active:bg-sky-100 max-w-[60vw] truncate'
            }
            title={s}
          >
            {s}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
};

export default KeyboardSuggestionsBar;
