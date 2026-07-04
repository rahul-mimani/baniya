import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Edit3, Save, Eye, EyeOff, Share2, Plus, Trash2,
  Calendar, Hash, UploadCloud, FileText,
} from 'lucide-react';
import { Bill, Product, Profile } from '../types';
import { calcBillTotal, formatINR } from '../utils/billTotal';
import { getPriceHistory } from '../utils/priceHistory';
import { toggleBillAcknowledged } from '../storage/storage';
import { setBackHandler } from '../utils/backHandler';
import { Button, IconButton, Pill, cls } from './ui';
import CustomerInput from './CustomerInput';
import ProductInput from './ProductInput';

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export type BillViewerMode = 'view' | 'edit' | 'create';

interface BillViewerProps {
  isOpen: boolean;
  /**
   * 'view'   — show an existing bill, read-only. Edit button switches into 'edit'.
   * 'edit'   — open an existing bill in edit mode directly. Save → 'view'.
   * 'create' — blank new bill. Save → closes via onClose.
   */
  initialMode: BillViewerMode;
  /** Required for 'view' and 'edit'. Ignored for 'create'. */
  bill?: Bill;
  activeProfile: Profile | null;
  onClose: () => void;
  onSave: (bill: Partial<Bill>) => Promise<Bill>;
  /** Called when user taps Share in view mode. Optional. */
  onShare?: (bill: Bill) => void;
  /** Save the in-progress bill LOCALLY without a bill number and without
   *  pushing to Firestore. Used when sync is unavailable or the user
   *  isn't ready to commit a final number. Optional — when omitted the
   *  Save Draft button hides. */
  onSaveDraft?: (bill: Partial<Bill>) => Promise<Bill>;
  /** Finalise a previously-saved draft: assigns the next bill number and
   *  pushes to Firestore. Called when the user taps Sync-to-cloud on a
   *  draft bill. */
  onSyncDraft?: (draftId: string) => Promise<Bill>;
  /** Full bills list used to surface previously-used rates per product as
   *  tappable chips under each row's rate field. Optional — when omitted
   *  the history strip simply doesn't render. */
  allBills?: Bill[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const blankProduct = (): Product => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  name: '',
  prefix: 'Box',
  quantity: '',
  price: '',
});

/** A product row is "completely blank" if the user hasn't filled anything yet —
 *  treat it as a placeholder for adding, not as a validation failure. */
const isBlankProduct = (p: Product) =>
  !p.name.trim() && !String(p.quantity).trim() && !String(p.price).trim();

const isValidProduct = (p: Product) =>
  p.name.trim().length > 0 &&
  parseFloat(p.quantity) > 0 &&
  !isNaN(parseFloat(p.price)) &&
  parseFloat(p.price) >= 0;

const validateForSave = (customerName: string, products: Product[]): boolean => {
  if (!customerName.trim()) return false;
  const real = products.filter(p => !isBlankProduct(p));
  if (real.length === 0) return false;
  return real.every(isValidProduct);
};

/** Relaxed validation for "Save Draft" — the whole point of the draft
 *  flow is to preserve work-in-progress. We only require a customer name
 *  and at least one product row that has SOMETHING in it. Qty/price can
 *  still be blank; the user fixes them later before syncing. */
const validateForDraft = (customerName: string, products: Product[]): boolean => {
  if (!customerName.trim()) return false;
  return products.some(p => !isBlankProduct(p));
};

const formatDateShort = (d: Date) =>
  d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' });

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const BillViewer: React.FC<BillViewerProps> = ({
  isOpen,
  initialMode,
  bill,
  activeProfile,
  onClose,
  onSave,
  onShare,
  onSaveDraft,
  onSyncDraft,
  allBills,
}) => {
  const [mode, setMode] = useState<BillViewerMode>(initialMode);
  const [customerName, setCustomerName] = useState(bill?.customerName || '');
  const [products, setProducts] = useState<Product[]>(
    bill?.products && bill.products.length > 0 ? bill.products : [blankProduct()],
  );
  const [acknowledged, setAcknowledged] = useState(bill?.acknowledged === true);
  const [acknowledgedAt, setAcknowledgedAt] = useState<Date | undefined>(bill?.acknowledgedAt);
  const [isSaving, setIsSaving] = useState(false);
  const [isReleasing, setIsReleasing] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isSyncingDraft, setIsSyncingDraft] = useState(false);
  // Preview-before-save confirmation step for create mode. Editor → tap Save →
  // shows the bill read-only with Edit + Confirm Save buttons.
  const [isConfirmingNew, setIsConfirmingNew] = useState(false);
  // Save-intent modal for create mode. When the user taps Save while still
  // editing a brand-new bill, we ask whether they'd like to Preview first
  // (recommended) or save directly. Avoids accidental commits and nudges
  // toward a quick visual check.
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);

  // Reset internal state whenever the viewer opens / bill changes.
  useEffect(() => {
    if (!isOpen) return;
    setMode(initialMode);
    setCustomerName(bill?.customerName || '');
    setProducts(
      bill?.products && bill.products.length > 0 ? bill.products : [blankProduct()],
    );
    setAcknowledged(bill?.acknowledged === true);
    setAcknowledgedAt(bill?.acknowledgedAt);
    setIsConfirmingNew(false);
    setShowSaveConfirm(false);
  }, [isOpen, initialMode, bill?.id]);

  // Wire Android hardware back button to close the viewer.
  useEffect(() => {
    if (!isOpen) return;
    setBackHandler(() => { onClose(); return true; });
    return () => setBackHandler(null);
  }, [isOpen, onClose]);

  // Derived
  // View mode is always read-only. Create mode flips to read-only while the
  // user is confirming the preview before final save.
  const isReadOnly = mode === 'view' || (mode === 'create' && isConfirmingNew);
  const grandTotal = useMemo(() => calcBillTotal(products), [products]);
  const realProductCount = useMemo(
    () => products.filter(p => !isBlankProduct(p)).length,
    [products],
  );
  const isValidForSave = validateForSave(customerName, products);
  const isValidForDraft = validateForDraft(customerName, products);
  // True only when the user is currently looking at / editing a draft.
  // Drives the DRAFT pill, the Sync-to-cloud button, and the footer-button
  // permutation.
  const isDraft = bill?.isDraft === true;

  // ---- handlers ----------------------------------------------------------

  const handleProductChange = useCallback((index: number, field: keyof Product, value: string) => {
    setProducts(prev => {
      const next = [...prev];
      if (field === 'quantity' || field === 'price') {
        if (/^\d*\.?\d*$/.test(value)) {
          next[index] = { ...next[index], [field]: value };
        }
      } else {
        next[index] = { ...next[index], [field]: value };
      }
      return next;
    });
  }, []);

  // Track the id of the just-added product so the post-render effect can
  // scroll/focus it. Refs (not state) — we don't want a re-render here.
  const lastAddedIdRef = useRef<string | null>(null);

  const handleAddProduct = useCallback(() => {
    // Append so chronological order is preserved at the bottom of the
    // list. The follow-up effect handles scrolling the new row UP to just
    // below the sticky "Items" header so it isn't hidden by the keyboard.
    const fresh = blankProduct();
    lastAddedIdRef.current = fresh.id;
    setProducts(prev => [...prev, fresh]);
  }, []);

  // When products grow and lastAddedIdRef is set, scroll the brand-new
  // row to the top of the scrollable viewport AND focus its name input.
  // Focusing the input fires ProductInput's own scroll-into-view (which
  // honours scrollMarginTop) and pops the keyboard — net effect: the new
  // empty row sits right below the sticky Items bar with the keyboard
  // ready underneath.
  useEffect(() => {
    const id = lastAddedIdRef.current;
    if (!id) return;
    const t = window.setTimeout(() => {
      const card = document.querySelector<HTMLElement>(`[data-product-card-id="${id}"]`);
      if (card) {
        card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        const input = card.querySelector<HTMLInputElement>('input[type="text"]');
        input?.focus();
      }
      lastAddedIdRef.current = null;
    }, 60);
    return () => window.clearTimeout(t);
  }, [products.length]);

  const handleRemoveProduct = useCallback((index: number) => {
    setProducts(prev => {
      const next = prev.filter((_, i) => i !== index);
      // Always keep at least one (blank) row for the editor to feel alive.
      return next.length > 0 ? next : [blankProduct()];
    });
  }, []);

  const handleToggleRelease = useCallback(async () => {
    if (!bill || isReleasing) return;
    setIsReleasing(true);
    try {
      const next = await toggleBillAcknowledged(bill.id);
      if (next !== null) {
        setAcknowledged(next);
        setAcknowledgedAt(next ? new Date() : undefined);
      }
    } finally {
      setIsReleasing(false);
    }
  }, [bill, isReleasing]);

  const handleSave = useCallback(async () => {
    if (!isValidForSave || isSaving) return;
    // Strip completely-blank rows before saving — they're placeholders.
    const cleanedProducts = products.filter(p => !isBlankProduct(p));
    setIsSaving(true);
    try {
      const payload: Partial<Bill> = bill
        ? { ...bill, customerName: customerName.trim(), products: cleanedProducts, updatedAt: new Date() }
        : {
            customerName: customerName.trim(),
            products: cleanedProducts,
            createdByProfileId: activeProfile?.id,
            createdByProfileName: activeProfile?.name,
          };
      await onSave(payload);
      if (mode === 'create') {
        onClose();
      } else {
        setMode('view');
      }
    } catch (e) {
      console.error('Save bill failed:', e);
    } finally {
      setIsSaving(false);
    }
  }, [isValidForSave, isSaving, bill, customerName, products, mode, activeProfile, onSave, onClose]);

  const handleShare = useCallback(() => {
    if (bill && onShare) onShare(bill);
  }, [bill, onShare]);

  // Save the in-progress bill as a draft — no bill number, no Firestore.
  // Works in create mode (new draft) and edit mode (update existing draft).
  // Relaxed validation: just customer name + one non-empty product row.
  const handleSaveDraftTap = useCallback(async () => {
    if (!onSaveDraft || !isValidForDraft || isSavingDraft) return;
    const cleaned = products.filter(p => !isBlankProduct(p));
    setIsSavingDraft(true);
    try {
      const payload: Partial<Bill> = bill
        ? {
            ...bill,
            customerName: customerName.trim(),
            products: cleaned,
            updatedAt: new Date(),
            isDraft: true,
            billNumber: '',
          }
        : {
            customerName: customerName.trim(),
            products: cleaned,
            createdByProfileId: activeProfile?.id,
            createdByProfileName: activeProfile?.name,
          };
      await onSaveDraft(payload);
      onClose();
    } catch (e) {
      console.error('Save draft failed:', e);
    } finally {
      setIsSavingDraft(false);
    }
  }, [onSaveDraft, isValidForDraft, isSavingDraft, products, bill, customerName, activeProfile, onClose]);

  // Finalise a draft → assign a bill number + push to Firestore. If we're
  // in edit mode of a draft (the user just made changes), save the edits
  // as a draft FIRST so the sync has the latest content, then finalise.
  const handleSyncDraftTap = useCallback(async () => {
    if (!onSyncDraft || !bill || isSyncingDraft) return;
    setIsSyncingDraft(true);
    try {
      if (mode === 'edit' && onSaveDraft) {
        if (!isValidForSave) {
          // Sync (= final save) needs the strict validation: qty > 0 and a
          // numeric price on every product row. If not met, fall back to
          // saving the draft and stay in edit mode so the user can fix it.
          await handleSaveDraftTap();
          return;
        }
        const cleaned = products.filter(p => !isBlankProduct(p));
        await onSaveDraft({
          ...bill,
          customerName: customerName.trim(),
          products: cleaned,
          updatedAt: new Date(),
          isDraft: true,
          billNumber: '',
        });
      }
      await onSyncDraft(bill.id);
      onClose();
    } catch (e) {
      console.error('Sync draft failed:', e);
    } finally {
      setIsSyncingDraft(false);
    }
  }, [onSyncDraft, bill, isSyncingDraft, mode, onSaveDraft, isValidForSave, products, customerName, handleSaveDraftTap, onClose]);

  // Intercept the Save tap in create-editing phase to pop a "Preview or save?"
  // modal. Any other mode goes straight to handleSave.
  const handleSaveTap = useCallback(() => {
    if (!isValidForSave || isSaving) return;
    if (mode === 'create' && !isConfirmingNew) {
      setShowSaveConfirm(true);
      return;
    }
    handleSave();
  }, [mode, isConfirmingNew, isValidForSave, isSaving, handleSave]);

  // ---- rendering ---------------------------------------------------------

  if (!isOpen) return null;

  // Portal to document.body so the fixed-position modal escapes any parent
  // container constraints (mx-auto containers, transformed ancestors,
  // overflow-hidden parents) and reliably covers the full viewport.
  if (typeof document === 'undefined') return null;

  const headerTitle =
    mode === 'create'
      ? 'New Bill'
      : isDraft
        ? 'DRAFT'
        : bill
          ? bill.billNumber
          : 'Bill';

  // Customer name shown on the right side of the sticky header (small,
  // ALL CAPS). Empty when there's nothing to show — better than shouting
  // a placeholder sentence in uppercase.
  const headerSubtitle =
    mode === 'create'
      ? customerName.trim()
      : bill?.customerName ?? '';

  const dateLabel = bill
    ? formatDateShort(bill.createdAt)
    : formatDateShort(new Date());

  return createPortal(
    <div
      className="fixed inset-0 z-[60] bg-amber-50 flex flex-col"
      // Respect bottom + side safe areas only — the TOP safe-area inset
      // moves INSIDE the navy header below, so the padded strip above the
      // close pill stays sky-900 (not cream). Otherwise the cream wrapper
      // shows through and the header looks broken at the very top.
      style={{
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      {/* ============================== STICKY HEADER ==============================
          Dark navy — matches the app's top header + bottom nav. White icons
          on navy ensure every action stays visible regardless of theme. */}
      <header
        className="sticky top-0 z-10 bg-sky-900 shadow-md text-white"
        // Safe-area top padding sits INSIDE the navy header so the padded
        // strip above the close pill stays sky-900 — clears the status bar
        // / front camera without exposing the cream wrapper above it.
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 6px)' }}
      >
        {/* Row 1: close (small pill), title (bill# + date), CUSTOMER CAPS (right),
            then action buttons. */}
        <div className="px-3 pt-2 pb-2.5 flex items-center gap-2">
          {/* Close — small RED-on-WHITE oval pill. Smaller footprint so it
              doesn't dominate the header. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center bg-white text-rose-600 active:bg-rose-50 shadow-sm rounded-full h-7 w-10 flex-shrink-0"
          >
            <X className="w-4 h-4" strokeWidth={3} />
          </button>

          {/* Title block: bill# + date. Customer name lives on the pill
              row below — keeps this row uncluttered for the actions. */}
          <div className="flex-1 min-w-0 leading-tight">
            <div className="flex items-center gap-1">
              <Hash className="w-3 h-3 text-sky-300 flex-shrink-0" />
              <span className="font-mono text-[13px] font-semibold text-white truncate">
                {headerTitle}
              </span>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-sky-200 mt-0.5 whitespace-nowrap">
              <Calendar className="w-3 h-3" />
              {dateLabel}
            </div>
          </div>

          {/* Release toggle — white bg always.
              NOT released:  closed-eye + RED  (visible-to-client = off / blocked)
              RELEASED:      open-eye   + GREEN (visible-to-client = on / done) */}
          {/* Release toggle hidden for drafts — there's nothing on Firestore
              to release until the user syncs. */}
          {bill && !isDraft && (
            <IconButton
              label={acknowledged ? 'Mark as not released' : 'Release to client'}
              variant="ghost"
              onClick={handleToggleRelease}
              disabled={isReleasing}
              className={
                acknowledged
                  ? '!bg-white !text-emerald-600 active:!bg-emerald-50 shadow-sm'
                  : '!bg-white !text-rose-600 active:!bg-rose-50 shadow-sm'
              }
            >
              {acknowledged ? <Eye strokeWidth={2.75} /> : <EyeOff strokeWidth={2.75} />}
            </IconButton>
          )}

          {/* Save Draft — create mode + edit-of-draft. AMBER icon on white,
              sits LEFT of Save so the primary commit action stays nearest
              the user's thumb. Moved up here from the footer because users
              were tapping the bottom buttons by accident. */}
          {mode !== 'view' && onSaveDraft && (mode === 'create' || isDraft) && (
            <IconButton
              label="Save as draft"
              variant="ghost"
              onClick={handleSaveDraftTap}
              disabled={!isValidForDraft || isSavingDraft}
              className="!bg-white !text-amber-600 active:!bg-amber-50 disabled:!bg-white/40 disabled:!text-amber-300 shadow-sm"
            >
              <FileText strokeWidth={2.75} />
            </IconButton>
          )}

          {/* Save (DARK YELLOW on white) / Edit (BLUE on white). */}
          {mode === 'view' ? (
            <IconButton
              label="Edit"
              variant="ghost"
              onClick={() => setMode('edit')}
              className="!bg-white !text-sky-600 active:!bg-sky-50 shadow-sm"
            >
              <Edit3 strokeWidth={2.75} />
            </IconButton>
          ) : (
            <IconButton
              label={mode === 'create' ? 'Save' : 'Save changes'}
              variant="ghost"
              onClick={handleSaveTap}
              disabled={!isValidForSave || isSaving}
              className="!bg-white !text-amber-700 active:!bg-amber-50 disabled:!bg-white/40 disabled:!text-amber-300 shadow-sm"
            >
              <Save strokeWidth={2.75} />
            </IconButton>
          )}

          {/* Sync-to-cloud — only when viewing a DRAFT. Replaces the Share
              button position since drafts aren't shareable until they have
              a bill number. SKY-BLUE icon on white. */}
          {mode === 'view' && bill && isDraft && onSyncDraft && (
            <IconButton
              label="Sync this draft to cloud"
              variant="ghost"
              onClick={handleSyncDraftTap}
              disabled={isSyncingDraft}
              className="!bg-white !text-sky-600 active:!bg-sky-50 disabled:!bg-white/40 disabled:!text-sky-300 shadow-sm"
            >
              <UploadCloud strokeWidth={2.75} />
            </IconButton>
          )}

          {/* Share — GREEN icon on white. Hidden for drafts. */}
          {mode === 'view' && bill && !isDraft && onShare && (
            <IconButton
              label="Share"
              variant="ghost"
              onClick={handleShare}
              className="!bg-white !text-emerald-600 active:!bg-emerald-50 shadow-sm"
            >
              <Share2 strokeWidth={2.75} />
            </IconButton>
          )}
        </div>

        {/* Row 2: release/edit pills on the LEFT, CUSTOMER NAME (caps) on
            the RIGHT — sits right beside the Pending/Released pill so the
            client this bill belongs to is always visible at a glance. */}
        {(bill || headerSubtitle) && (
          <div className="px-3 pb-2 flex items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-1.5 min-w-0">
              {bill && isDraft && (
                <Pill
                  tone="brand"
                  icon={<FileText />}
                  className="!bg-amber-100 !text-amber-800 border border-amber-300"
                >
                  Draft — not synced
                </Pill>
              )}
              {bill && !isDraft && (
                acknowledged ? (
                  <Pill
                    tone="info"
                    icon={<EyeOff />}
                    className="!bg-sky-700 !text-white border border-sky-500"
                  >
                    Released{acknowledgedAt ? ` • ${formatDateShort(acknowledgedAt)}` : ''}
                  </Pill>
                ) : (
                  <Pill tone="info" icon={<Eye />} className="!bg-white !text-sky-900">
                    Pending release
                  </Pill>
                )
              )}
              {mode === 'edit' && !isDraft && (
                <Pill tone="brand" className="!bg-amber-100 !text-amber-800">
                  Editing
                </Pill>
              )}
            </div>
            {headerSubtitle && (
              <span className="text-[10px] font-bold tracking-widest text-sky-100 uppercase truncate">
                {headerSubtitle}
              </span>
            )}
          </div>
        )}
      </header>

      {/* ============================== SCROLLABLE BODY ============================
          No top padding on the scroll container so the sticky Items bar can
          flush against the navy header when scrolled. The customer card has
          its own top margin to keep visual breathing room when AT TOP. */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {/* Customer field — only shown while editing. In view/preview the
            customer is already displayed beside the Pending/Released pill
            in the header, so this section would be redundant. */}
        {!isReadOnly && (
          <section className="bg-white rounded-xl border border-slate-200 p-3 mt-2">
            <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Customer
            </label>
            <CustomerInput value={customerName} onChange={setCustomerName} />
          </section>
        )}

        {/* Products list — section header is STICKY at top:0 of the scroll body
            so it flushes against the navy header when the user scrolls. The
            customer card above scrolls under it. mt-2 gives a small gap from
            the customer card when at the top of scroll. */}
        <section className="space-y-2 mt-2 mb-3">
          <div className="sticky top-0 z-[1] -mx-3 px-3 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-between shadow-sm">
            <h3 className="text-[11px] font-semibold text-slate-700 uppercase tracking-wide">
              Items {realProductCount > 0 && <span className="text-slate-500">({realProductCount})</span>}
            </h3>
            {!isReadOnly && (
              <button
                onClick={handleAddProduct}
                className="text-white bg-sky-600 active:bg-sky-700 font-semibold text-xs inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" /> Add item
              </button>
            )}
          </div>

          {isReadOnly ? (
            <ReadOnlyProductsList products={products} />
          ) : (
            <EditableProductsList
              products={products}
              onChange={handleProductChange}
              onRemove={handleRemoveProduct}
              onAdd={handleAddProduct}
              canRemove={products.length > 1}
              allBills={allBills}
            />
          )}
        </section>

        {/* Created-by footer */}
        {bill?.createdByProfileName && (
          <p className="text-[11px] text-slate-400 px-1 mb-2">
            Created by {bill.createdByProfileName}
          </p>
        )}
      </div>

      {/* ============================== STICKY FOOTER ==============================
          Layout:  [ left action button(s) ] ←—— space ——→ [ Grand Total ] */}
      <footer className="sticky bottom-0 z-10 bg-white border-t border-slate-200 px-3 py-2 flex items-center justify-between gap-2 shadow-[0_-2px_8px_rgba(0,0,0,0.04)]">
        {/* Left action(s) — depends on mode + create-confirm sub-state */}
        <div className="flex items-center gap-1.5">
          {mode === 'view' && (
            <>
              {/* Red text + red border on white — matches the header close
                  pill and makes the destructive intent obvious. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={onClose}
                leftIcon={<X className="w-4 h-4" />}
                className="!text-rose-600 !border-rose-500 active:!bg-rose-50"
              >
                Close
              </Button>
              {/* On a DRAFT, surface the Sync-to-cloud action directly in
                  the footer too — the most likely next user action. */}
              {bill && isDraft && onSyncDraft && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSyncDraftTap}
                  disabled={isSyncingDraft}
                  loading={isSyncingDraft}
                  leftIcon={<UploadCloud className="w-4 h-4" />}
                >
                  Sync to cloud
                </Button>
              )}
            </>
          )}

          {mode === 'edit' && (
            <>
              {/* Editing an existing DRAFT → user can save edits as draft OR
                  finalise + sync. Editing a synced bill → just Save. */}
              {isDraft && onSaveDraft && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSaveDraftTap}
                  disabled={!isValidForDraft || isSavingDraft}
                  loading={isSavingDraft}
                  leftIcon={<FileText className="w-4 h-4" />}
                >
                  Save draft
                </Button>
              )}
              {isDraft && onSyncDraft ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSyncDraftTap}
                  disabled={!isValidForSave || isSyncingDraft}
                  loading={isSyncingDraft}
                  leftIcon={<UploadCloud className="w-4 h-4" />}
                >
                  Save & sync
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSave}
                  disabled={!isValidForSave || isSaving}
                  loading={isSaving}
                  leftIcon={<Save className="w-4 h-4" />}
                >
                  Save
                </Button>
              )}
            </>
          )}

          {/* Create-mode editing phase: footer is intentionally EMPTY (no
              Save / Save draft buttons). Users were tapping these by
              accident; both actions moved into the header where they
              require a deliberate reach. Confirm phase (isConfirmingNew)
              still keeps its buttons below — by then the user has chosen
              to commit. */}

          {mode === 'create' && isConfirmingNew && (
            <>
              {/* Confirm phase: tapping back to edit (left) or commit (right) */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsConfirmingNew(false)}
                leftIcon={<Edit3 className="w-4 h-4" />}
              >
                Edit
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={isSaving}
                loading={isSaving}
                leftIcon={<Save className="w-4 h-4" />}
              >
                Confirm
              </Button>
            </>
          )}
        </div>

        {/* Right: grand total */}
        <div className="leading-tight text-right">
          <p className="text-[9px] font-semibold text-slate-500 uppercase tracking-wide">
            Grand Total
          </p>
          <p className="text-base font-bold text-sky-900">
            {formatINR(grandTotal)}
          </p>
        </div>
      </footer>

      {/* ===== SAVE-INTENT MODAL (create mode only) ===========================
          Asks the user whether they want to preview the bill first
          (recommended) or save it right away. Backdrop tap = cancel. */}
      {showSaveConfirm && (
        <div
          className="absolute inset-0 z-[70] bg-black/40 flex items-center justify-center px-4"
          onClick={() => setShowSaveConfirm(false)}
        >
          <div
            className="bg-white rounded-2xl p-5 max-w-sm w-full shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-slate-900 mb-1">
              Save this bill?
            </h3>
            <p className="text-[13px] text-slate-600 mb-4">
              Preview it first to double-check the details, or save it right away.
            </p>
            <div className="flex flex-col gap-2">
              <Button
                variant="primary"
                size="md"
                fullWidth
                onClick={() => {
                  setShowSaveConfirm(false);
                  setIsConfirmingNew(true);
                }}
                leftIcon={<Eye className="w-4 h-4" />}
              >
                Preview (Recommended)
              </Button>
              <Button
                variant="secondary"
                size="md"
                fullWidth
                onClick={() => {
                  setShowSaveConfirm(false);
                  handleSave();
                }}
                leftIcon={<Save className="w-4 h-4" />}
              >
                Save now
              </Button>
              <button
                type="button"
                onClick={() => setShowSaveConfirm(false)}
                className="text-[12px] text-slate-500 font-semibold uppercase tracking-wide py-2 active:text-slate-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};

export default BillViewer;

// ===========================================================================
// Internal: editable products list (edit / create modes)
// ===========================================================================

interface EditableProductsListProps {
  products: Product[];
  onChange: (index: number, field: keyof Product, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  canRemove: boolean;
  /** Bills used to compute the past-rates strip under each row. When
   *  undefined or empty the strip simply never renders. */
  allBills?: Bill[];
}

/** Shared scroll-on-focus behaviour for every input inside a product row.
 *  When the soft keyboard appears it pushes the field down — scrollIntoView
 *  with block:'start' and the scroll-margin-top set on the input element
 *  drops it just BELOW the sticky "Items" bar, where the user can read
 *  what they're typing. */
const scrollFieldIntoView = (el: HTMLElement | null) => {
  if (!el) return;
  window.setTimeout(() => {
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, 250);
};

const INPUT_SCROLL_STYLE: React.CSSProperties = {
  scrollMarginTop: 60,
  scrollMarginBottom: 80,
};

const EditableProductsList: React.FC<EditableProductsListProps> = ({
  products, onChange, onRemove, onAdd, canRemove, allBills,
}) => (
  <>
    {products.map((p, index) => (
      <div
        key={p.id}
        data-product-card-id={p.id}
        // scroll-margin-top so the BillViewer's post-add scrollIntoView
        // lands the row JUST BELOW the sticky Items bar (~52pt) — not
        // tucked underneath it.
        style={{ scrollMarginTop: 60 }}
        className={cls(
          'bg-white border rounded-xl p-3 space-y-2',
          isBlankProduct(p) ? 'border-dashed border-slate-300' : 'border-slate-200',
        )}
      >
        {/* Name + remove */}
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <label className="block text-[10px] font-semibold text-slate-500 uppercase mb-0.5">
              Item
            </label>
            <ProductInput
              value={p.name}
              onChange={v => onChange(index, 'name', v)}
            />
          </div>
          {canRemove && (
            <IconButton
              label="Remove item"
              variant="ghost"
              size="sm"
              onClick={() => onRemove(index)}
              className="mt-4 text-slate-400 active:text-rose-600"
            >
              <Trash2 />
            </IconButton>
          )}
        </div>

        {/* Quantity + Unit + Price */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase mb-0.5">
              Qty
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={p.quantity}
              onChange={e => onChange(index, 'quantity', e.target.value)}
              onFocus={e => { e.target.select(); scrollFieldIntoView(e.currentTarget); }}
              placeholder="0"
              style={INPUT_SCROLL_STYLE}
              className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-sm bg-white text-slate-900 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase mb-0.5">
              Unit
            </label>
            <select
              value={p.prefix}
              onChange={e => onChange(index, 'prefix', e.target.value)}
              onFocus={e => scrollFieldIntoView(e.currentTarget)}
              style={INPUT_SCROLL_STYLE}
              className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm bg-white text-slate-900 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 focus:outline-none"
            >
              <option>Box</option>
              <option>Pieces</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 uppercase mb-0.5">
              Price (₹)
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={p.price}
              onChange={e => onChange(index, 'price', e.target.value)}
              onFocus={e => { e.target.select(); scrollFieldIntoView(e.currentTarget); }}
              placeholder="0.00"
              style={INPUT_SCROLL_STYLE}
              className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-sm bg-white text-slate-900 text-right focus:ring-2 focus:ring-sky-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Past-rates strip — only renders when this product name has been
            billed before. Tap-to-fill the Rate field; no auto-fill. */}
        <PriceHistoryStrip
          allBills={allBills}
          productName={p.name}
          onPick={(rate) => onChange(index, 'price', String(rate))}
        />

        {/* Per-line subtotal */}
        {!isBlankProduct(p) && parseFloat(p.quantity) > 0 && !isNaN(parseFloat(p.price)) && (
          <div className="text-right text-[11px] text-slate-500">
            Subtotal: <span className="font-semibold text-slate-700">
              {formatINR(parseFloat(p.quantity) * parseFloat(p.price))}
            </span>
          </div>
        )}
      </div>
    ))}

    {/* Inline + Add another item — saves the scroll-up to the sticky
        Items bar when entering a long bill. Mirrors that bar's styling
        in dashed/outline form so it reads as a "next item slot". */}
    <button
      type="button"
      onClick={onAdd}
      className="w-full flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-sky-700 bg-white border border-dashed border-sky-300 rounded-xl active:bg-sky-50"
    >
      <Plus className="w-3.5 h-3.5" />
      Add another item
    </button>
  </>
);

// ===========================================================================
// Internal: past-rates strip
// ===========================================================================

interface PriceHistoryStripProps {
  allBills?: Bill[];
  productName: string;
  onPick: (rate: number) => void;
}

/**
 * Thin row of tappable rate chips for the product on this line. Renders
 * nothing when there's no history (new product, no bills yet, etc.) so
 * the strip has zero footprint for new items.
 *
 * Tap behaviour uses onMouseDown + preventDefault so focus on the rate
 * field isn't stolen when the user is already typing there.
 */
const PriceHistoryStrip: React.FC<PriceHistoryStripProps> = ({
  allBills, productName, onPick,
}) => {
  const history = useMemo(
    () => getPriceHistory(allBills || [], productName, 5),
    [allBills, productName],
  );
  if (history.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 py-0.5"
         style={{ scrollbarWidth: 'none' }}>
      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide flex-shrink-0">
        Past:
      </span>
      {history.map(h => (
        <button
          key={h.rate}
          type="button"
          onMouseDown={e => { e.preventDefault(); onPick(h.rate); }}
          onTouchStart={e => { e.preventDefault(); onPick(h.rate); }}
          title={`Used ${h.count} time${h.count === 1 ? '' : 's'} · last ${h.lastUsedAt.toLocaleDateString()}`}
          className="shrink-0 px-2 py-0.5 bg-sky-50 text-sky-900 border border-sky-200 rounded-full text-[11px] font-semibold active:bg-sky-100"
        >
          {`Rs ${h.rate.toLocaleString('en-IN', { minimumFractionDigits: h.rate % 1 ? 2 : 0, maximumFractionDigits: 2 })}`}
        </button>
      ))}
    </div>
  );
};

// ===========================================================================
// Internal: read-only product list (view mode)
// ===========================================================================

interface ReadOnlyProductsListProps {
  products: Product[];
}

const ReadOnlyProductsList: React.FC<ReadOnlyProductsListProps> = ({ products }) => {
  const visible = products.filter(p => !isBlankProduct(p));
  if (visible.length === 0) {
    return (
      <div className="text-center text-sm text-slate-400 py-6">
        No items
      </div>
    );
  }
  // Numbered list on the transparent cream background — no card wrappers, just
  // tight rows separated by hair-thin amber dividers so the bill reads as one
  // continuous receipt instead of a deck of cards.
  return (
    <div className="divide-y divide-amber-200/70">
      {visible.map((p, i) => {
        const qty = parseFloat(p.quantity) || 0;
        const price = parseFloat(p.price) || 0;
        const subtotal = qty * price;
        return (
          <div key={p.id} className="flex items-start gap-3 px-1 py-2.5">
            <span className="font-mono text-[11px] font-semibold text-slate-500 mt-0.5 w-5 text-right">
              {i + 1}.
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-slate-900 text-sm truncate">{p.name}</p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {qty} {p.prefix} × {formatINR(price)}
              </p>
            </div>
            <p className="font-bold text-slate-900 text-sm whitespace-nowrap">
              {formatINR(subtotal)}
            </p>
          </div>
        );
      })}
    </div>
  );
};
