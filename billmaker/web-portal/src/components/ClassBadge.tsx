import React, { useEffect, useState } from 'react';
import { CustomerClass } from '../types';
import { classBadgeClasses, classDisplayName, onStoreChange } from '../data/dummyData';
import { cn } from '../lib/utils';

interface ClassBadgeProps {
  code: CustomerClass;
  /** Show only the letter (e.g. "A") instead of "Class A · Top Partner". */
  compact?: boolean;
  /** Show only the human-readable name (e.g. "Top Partner") — preferred on
   *  client-facing UI where the "Class A" prefix is internal terminology. */
  nameOnly?: boolean;
  className?: string;
}

/**
 * Renders a class chip whose color + display name are pulled live from
 * `store.classDefs`. Subscribes to store changes so admin edits (or initial
 * load on the client side via /client/me) immediately reflect.
 *
 * Variants:
 *   - default:  "Class A · Top Partner"     (admin / detailed)
 *   - compact:  "A"                          (header chips, mobile)
 *   - nameOnly: "Top Partner"                (client-facing UI)
 */
export const ClassBadge: React.FC<ClassBadgeProps> = ({ code, compact = false, nameOnly = false, className }) => {
  // Re-render whenever store.classDefs changes. Empty body — the component
  // reads classDisplayName/classBadgeClasses on each render.
  const [, force] = useState(0);
  useEffect(() => onStoreChange(() => force(n => n + 1)), []);

  const label =
    compact  ? code :
    nameOnly ? classDisplayName(code) :
               `Class ${code} · ${classDisplayName(code)}`;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border',
        classBadgeClasses(code),
        className,
      )}
    >
      {label}
    </span>
  );
};
