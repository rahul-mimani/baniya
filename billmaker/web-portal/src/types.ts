export type CustomerClass = 'A' | 'B' | 'C' | 'D' | 'E';
/** All possible class codes in canonical order. Whether each one is "active" is
 *  determined by `store.classDefs` — admin can configure 3–5 of these. */
export const ALL_CLASS_CODES: CustomerClass[] = ['A', 'B', 'C', 'D', 'E'];
export type LabelColor = 'sky' | 'indigo' | 'emerald' | 'amber' | 'rose' | 'violet' | 'slate' | 'cyan';

export interface Label {
  id: string;
  name: string;
  color: LabelColor;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  gstNumber?: string;
  address?: string;
  class: CustomerClass;
  createdAt: string;
  /** Raw name aliases that have been merged into this customer (for billmaker name deduplication). */
  aliases?: string[];
  /**
   * Current outstanding balance, kept up-to-date by the worker's aggregate
   * recompute (single writer, no concurrency). The portal reads this for
   * cleaner Customer page UX without needing to look up the aggregate doc.
   */
  outstanding?: number;
  /** ISO timestamp of the last `outstanding` field write. */
  lastOutstandingUpdate?: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  labelIds: string[];
  /** Per-class price. Only keys for active classes are stored; missing keys default to 0. */
  prices: Partial<Record<CustomerClass, number>>;
  /** Which classes this product is offered to (independent of pricing). Missing key = false. */
  enabledClasses: Partial<Record<CustomerClass, boolean>>;
  /** Master switch — must be true for clients to see this product at all. */
  visibleToClient: boolean;
  /** Where this product entry came from. 'billmaker' = auto-imported from mobile, needs admin enrichment. */
  source: 'manual' | 'billmaker';
  inStock: boolean;
  /** Image URLs or data URIs. Up to 5 per product. */
  images: string[];
}

/** One product inside a deal, with optional per-class override prices. */
export interface DealItem {
  productId: string;
  /**
   * Special prices set just for this deal. Per class; missing keys fall back to:
   *   1. the product's normal price × (1 − deal.discountPct), if discountPct > 0
   *   2. otherwise the product's normal price for that class
   */
  prices: Partial<Record<CustomerClass, number>>;
}

export interface Deal {
  id: string;
  title: string;
  description: string;
  /** New schema — per-product items with custom prices. */
  items: DealItem[];
  /** Whole-deal fallback discount, applied to any product/class without an explicit price in `items`. */
  discountPct: number;
  validUntil: string;
  visibleClasses: CustomerClass[];
  bannerColor?: 'sky' | 'amber' | 'rose' | 'indigo';
}

export interface BillItem {
  productName: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
}

export interface Bill {
  id: string;
  billNumber: string;
  customerId: string;
  customerName: string;
  items: BillItem[];
  total: number;
  paid: number;
  createdAt: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
  /** Set when this bill was rewritten by a customer link (linkRawCustomers).
   *  Records the original `customerName` before the rewrite so unlink can
   *  cleanly revert the bill. Cleared on unlink. Bills that have never been
   *  linked don't carry this field. */
  linkedFromName?: string;
}

/**
 * Mirrors mobile's payment shape. Mobile is the source of truth — it never
 * stores `paid` on a bill, it derives it from sum of payments where
 * `payment.billId === bill.id`.
 */
export interface Payment {
  id: string;
  billId: string;
  amount: number;
  receivedAt: string;
  method?: string | null;
  note?: string | null;
  createdByProfileId?: string | null;
  createdByProfileName?: string | null;
}

/** Represents a raw customer name that appeared in Baniya — pending dedup-and-link. */
export interface RawCustomer {
  rawName: string;
  billCount: number;
  /** If set, this raw name has been merged into a canonical customer. */
  linkedCustomerId?: string;
  /** True when admin explicitly unlinked this raw via the Manage Customers
   *  Unlink button. Prevents rebuildRawCustomers's auto-link fallback from
   *  re-linking immediately (which it would otherwise do if a customer's
   *  name still matches the raw name). Cleared on re-link. */
  manuallyUnlinked?: boolean;
}

export type View = 'client' | 'admin';

/** Editable metadata for each customer pricing class. Display name + color can be customised by admin. */
export interface ClassDef {
  code: CustomerClass;
  name: string;
  color: LabelColor;
}

/** Snapshot of everything tied to a customer being soft-deleted, kept for restore. */
export interface CustomerArchive {
  archivedAt: string;
  reason?: string;
  customer: Customer;
  bills: Bill[];
  /** Payments tied to the archived bills — restored together with them. Optional
   *  for backwards compatibility with archive entries written before this field
   *  existed. */
  payments?: Payment[];
}
