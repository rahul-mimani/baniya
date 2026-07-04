import React, { useRef, useEffect } from 'react';
import { cn } from '../lib/utils';

interface OtpInputProps {
  /** Number of cells (default 4). */
  length?: number;
  /** Current value (always upper-case). Parent owns this. */
  value: string;
  /** Called with the new value any time it changes. */
  onChange: (v: string) => void;
  /** Called when the value reaches `length` (auto-submit hook). */
  onComplete?: (v: string) => void;
  /** Render the input cells in disabled state. */
  disabled?: boolean;
  /** Optional auto-focus on first cell. */
  autoFocus?: boolean;
  /** Optional className wrapper. */
  className?: string;
  /** Optional prefix shown as a non-interactive cell group before the input. */
  prefix?: string;
}

/**
 * OTP / verification-code input.
 *
 * Behaviour:
 *   - One cell per character, length set by `length` prop (default 4).
 *   - Typing into any cell auto-advances focus.
 *   - Backspace clears the current cell or jumps to the previous one if empty.
 *   - Arrow keys navigate between cells.
 *   - **Paste fix**: pasting fills ALL cells starting from cell 0, regardless
 *     of which cell received the paste event. (Old implementation took only
 *     the first char and wiped subsequent cells.)
 *   - Accepts alphanumeric (uppercase) only — matches the OTP alphabet on the
 *     server (excludes 0, O, 1, I, L for legibility).
 *
 * The `prefix` prop renders a non-editable group of cells before the input —
 * used to display the 3-char OTP prefix returned by /auth/request-otp.
 */
export const OtpInput: React.FC<OtpInputProps> = ({
  length = 4,
  value,
  onChange,
  onComplete,
  disabled = false,
  autoFocus = false,
  className,
  prefix,
}) => {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  const sanitize = (s: string): string =>
    s.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const setAt = (i: number, ch: string) => {
    const arr = value.padEnd(length, ' ').split('');
    arr[i] = ch;
    const next = arr.join('').replace(/\s+$/, '').slice(0, length);
    onChange(next);
    if (next.length === length) onComplete?.(next);
  };

  const handleChange = (i: number, raw: string) => {
    const clean = sanitize(raw);
    if (clean.length <= 1) {
      setAt(i, clean);
      if (clean.length === 1 && i < length - 1) refs.current[i + 1]?.focus();
    } else {
      // Multi-char drop into a single cell — treat as paste starting at i.
      handlePasteAt(i, clean);
    }
  };

  /**
   * Paste handler. Spreads pasted characters across ALL cells starting at
   * `startIndex` (clamped). Crucially, it does NOT clear cells before
   * `startIndex` — so pasting the 4 OTP characters while the 3-char prefix
   * is shown elsewhere doesn't touch the prefix. The bug previously was: a
   * paste of "ABCD" into a single cell set only "A" and cleared the rest.
   */
  const handlePasteAt = (startIndex: number, raw: string) => {
    const chars = sanitize(raw).slice(0, length - startIndex);
    if (!chars.length) return;
    const arr = value.padEnd(length, ' ').split('');
    for (let k = 0; k < chars.length; k++) arr[startIndex + k] = chars[k];
    const next = arr.join('').replace(/\s+$/, '').slice(0, length);
    onChange(next);
    // Focus the cell after the last pasted char (or last cell)
    const focusIdx = Math.min(startIndex + chars.length, length - 1);
    refs.current[focusIdx]?.focus();
    if (next.length === length) onComplete?.(next);
  };

  const handlePaste = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    handlePasteAt(i, e.clipboardData.getData('text'));
  };

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (value[i]) {
        // Clear current cell
        setAt(i, '');
      } else if (i > 0) {
        // Cell already empty — jump back and clear that one
        setAt(i - 1, '');
        refs.current[i - 1]?.focus();
      }
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus();
      e.preventDefault();
    } else if (e.key === 'ArrowRight' && i < length - 1) {
      refs.current[i + 1]?.focus();
      e.preventDefault();
    }
  };

  const cells = Array.from({ length }, (_, i) => value[i] || '');

  return (
    <div className={cn('flex items-center justify-center gap-2 sm:gap-3', className)}>
      {prefix && (
        <>
          <div className="flex items-center gap-1">
            {prefix.split('').map((ch, i) => (
              <div
                key={`prefix-${i}`}
                className="w-10 h-12 sm:w-12 sm:h-14 rounded-lg border-2 border-dashed border-primary/40 bg-primary/5 flex items-center justify-center font-mono font-bold text-xl text-primary/70 select-none"
                aria-hidden
              >
                {ch}
              </div>
            ))}
          </div>
          <span className="text-xl font-bold text-muted-foreground select-none" aria-hidden>—</span>
        </>
      )}
      <div className="flex items-center gap-1.5 sm:gap-2">
        {cells.map((ch, i) => (
          <input
            key={i}
            ref={el => { refs.current[i] = el; }}
            inputMode="text"
            autoComplete="one-time-code"
            // Use a single fixed maxLength=1 so the browser doesn't cap our paste handler.
            // Larger paste events come through onPaste which calls preventDefault and
            // distributes characters manually.
            maxLength={1}
            value={ch}
            disabled={disabled}
            onChange={e => handleChange(i, e.target.value)}
            onPaste={e => handlePaste(i, e)}
            onKeyDown={e => handleKeyDown(i, e)}
            onFocus={e => e.target.select()}
            className="w-10 h-12 sm:w-12 sm:h-14 text-center font-mono font-bold text-xl rounded-lg border-2 border-input bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition disabled:opacity-50"
            aria-label={`Code character ${i + 1} of ${length}`}
          />
        ))}
      </div>
    </div>
  );
};
