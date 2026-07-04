// Pure aggregation over bills.json — surfaces the unique rates a given
// product has been billed at, sorted by recency. Used by BillViewer's
// PriceHistoryStrip to show tap-to-fill chips under the rate field.
//
// Drafts are intentionally INCLUDED. If the user typed a rate while
// making a draft, that's still a useful reference even though the draft
// hasn't been finalised yet.

import { Bill } from '../types';

export interface PriceHistoryEntry {
  rate: number;
  /** Most-recent bill where this rate appeared for this product. */
  lastUsedAt: Date;
  /** How many times this exact rate (rounded to 2dp) shows up across bills. */
  count: number;
}

/** Normalise a product name for fuzzy-ish matching across bills. */
const normName = (s: string): string => s.trim().toLowerCase();

/** Round a parsed rate to 2 decimals so 230 / 230.0 / 230.00 collapse to one chip. */
const roundRate = (n: number): number => Math.round(n * 100) / 100;

/**
 * Return at most `max` unique rates that the given product name has been
 * billed at, sorted by recency desc (most recent first). Frequency is
 * captured but only used as a tiebreak.
 *
 * Returns [] when:
 *   - productName is empty/whitespace
 *   - no bills contain a product with this name
 *   - all matching rows have rate == 0 (work-in-progress with no price)
 */
export const getPriceHistory = (
  bills: Bill[],
  productName: string,
  max = 5,
): PriceHistoryEntry[] => {
  const target = normName(productName);
  if (!target) return [];

  // rate(rounded) → aggregate
  const byRate = new Map<number, PriceHistoryEntry>();

  for (const bill of bills) {
    if (!bill?.products?.length) continue;
    for (const p of bill.products) {
      if (!p?.name || normName(p.name) !== target) continue;
      const parsed = parseFloat(String(p.price));
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      const rate = roundRate(parsed);

      const existing = byRate.get(rate);
      if (existing) {
        existing.count += 1;
        if (bill.createdAt && bill.createdAt.getTime() > existing.lastUsedAt.getTime()) {
          existing.lastUsedAt = bill.createdAt;
        }
      } else {
        byRate.set(rate, {
          rate,
          lastUsedAt: bill.createdAt ?? new Date(0),
          count: 1,
        });
      }
    }
  }

  return [...byRate.values()]
    .sort((a, b) => {
      const dt = b.lastUsedAt.getTime() - a.lastUsedAt.getTime();
      return dt !== 0 ? dt : b.count - a.count;
    })
    .slice(0, max);
};
