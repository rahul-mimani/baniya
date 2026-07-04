import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import IconButton from './IconButton';
import { cls } from './tokens';

interface FullScreenModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  /** Optional action buttons to render on the right side of the header. */
  headerActions?: React.ReactNode;
  /** Optional sticky footer (e.g., grand total + Save bar). */
  footer?: React.ReactNode;
  /** Body padding. Default true. */
  padded?: boolean;
  children: React.ReactNode;
}

/**
 * Edge-to-edge mobile modal used for bill view / edit / preview screens.
 * Header is sticky (always visible at top). Footer is sticky too if
 * provided. Body scrolls between them.
 *
 * Pressing the Android back button calls `onClose` — caller is
 * responsible for setting that up via the global back handler.
 */
const FullScreenModal: React.FC<FullScreenModalProps> = ({
  isOpen,
  onClose,
  title,
  headerActions,
  footer,
  padded = true,
  children,
}) => {
  // Lock body scroll while open so background doesn't bounce.
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-3 py-2.5 flex items-center gap-2 shadow-sm">
        <IconButton label="Close" variant="ghost" onClick={onClose}>
          <X />
        </IconButton>
        {title && (
          <h2 className="flex-1 text-base font-semibold text-slate-900 truncate">
            {title}
          </h2>
        )}
        {!title && <div className="flex-1" />}
        {headerActions && (
          <div className="flex items-center gap-1.5">
            {headerActions}
          </div>
        )}
      </header>

      {/* Scrollable body */}
      <div className={cls('flex-1 overflow-y-auto', padded && 'px-4 py-3')}>
        {children}
      </div>

      {/* Sticky footer (optional) */}
      {footer && (
        <footer className="sticky bottom-0 z-10 bg-white border-t border-slate-200 px-3 py-2.5">
          {footer}
        </footer>
      )}
    </div>
  );
};

export default FullScreenModal;
