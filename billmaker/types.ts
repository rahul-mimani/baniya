
export interface Product {
  id: string;
  prefix: 'Box' | 'Pieces';
  quantity: string; // Stored as string for input control, converted to number for saving
  name: string;
  price: string;
}

export interface Bill {
  id: string;
  /** Empty string while isDraft=true — a real LE-XXXXXXX is assigned only
   *  when the user taps Sync to cloud (or saves directly with internet). */
  billNumber: string;
  customerName: string;
  products: Product[];
  createdAt: Date;
  updatedAt: Date;
  createdByProfileId?: string;
  createdByProfileName?: string;
  /** True if released to the client. Set by either portal admin or by mobile
   *  user via the Release button on BillDetailView. */
  acknowledged?: boolean;
  /** ISO timestamp (Date here, ISO string when serialized). */
  acknowledgedAt?: Date;
  /** Saved locally but NOT yet pushed to Firestore — no bill number assigned.
   *  Set by handleSaveDraft, cleared by handleSyncDraft after a successful push. */
  isDraft?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  createdAt: Date;
}

export interface BusinessInfo {
  name: string;
  phone: string;
  address: string;
  gst: string;
  /** Optional sync key — devices that share this code see the same data via Firestore. */
  shopCode?: string;
}

export type PaymentMethod = 'cash' | 'upi' | 'card' | 'bank' | 'other';

export interface Payment {
  id: string;
  billId: string;
  amount: number;
  receivedAt: Date;
  method?: PaymentMethod;
  note?: string;
  createdByProfileId?: string;
  createdByProfileName?: string;
}
