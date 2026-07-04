// Product detail modal — opened when a client taps a product card.
//
// Two views inside the modal:
//   1. Details view (default): gallery + product info + "Request a quote" CTA
//   2. Quote form: quantity + proposed price + note + submit
//
// The user can flip between them with a slide animation. Submitting the form
// posts to /client/quotes and lands in the admin's Quotes inbox.

import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, ChevronRight, MessageSquare, Package as PackageIcon,
  CheckCircle2, XCircle, AlertCircle, Loader2, Send, ArrowLeft,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { authedFetch } from '../../lib/authClient';
import { labelColorClasses, fmtINR } from '../../data/dummyData';
import type { Product, Label as LabelType, CustomerClass } from '../../types';

interface ProductDetailModalProps {
  product: Product | null;
  labels: LabelType[];
  classKey: CustomerClass | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

type View = 'details' | 'quote' | 'success';

export const ProductDetailModal: React.FC<ProductDetailModalProps> = ({
  product, labels, classKey, open, onOpenChange,
}) => {
  const [idx, setIdx] = useState(0);
  const [view, setView] = useState<View>('details');

  // Reset everything when the product changes or modal closes.
  useEffect(() => {
    setIdx(0);
    setView('details');
  }, [product?.id]);
  useEffect(() => {
    if (!open) setView('details');
  }, [open]);

  const images = product?.images?.filter(Boolean) || [];
  const total = images.length;

  const prev = useCallback(() => setIdx(i => (i - 1 + total) % total), [total]);
  const next = useCallback(() => setIdx(i => (i + 1) % total), [total]);

  useEffect(() => {
    if (!open || view !== 'details') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, view, prev, next]);

  if (!product) return null;

  const productLabels = labels.filter(l => product.labelIds.includes(l.id));
  const price = classKey ? (product.prices?.[classKey] || 0) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* IMPORTANT: do NOT add overflow-hidden here — it overrides the
          dialog primitive's overflow-y-auto and breaks scrolling on mobile
          when the form is taller than the viewport. */}
      <DialogContent className="max-w-3xl p-0 bg-white border border-blue-100 shadow-2xl shadow-blue-500/15">
        <DialogTitle className="sr-only">{product.name}</DialogTitle>

        <div className="grid grid-cols-1 md:grid-cols-2">
          {/* Gallery side */}
          <div className="relative bg-gradient-to-br from-sky-50 via-white to-blue-50 p-4 sm:p-6 flex flex-col">
            <div className="relative flex-1 min-h-[260px] sm:min-h-[360px] rounded-xl overflow-hidden bg-white border border-blue-100">
              <AnimatePresence mode="wait">
                {images.length > 0 ? (
                  <motion.img
                    key={idx}
                    src={images[idx]}
                    alt={product.name}
                    className="absolute inset-0 w-full h-full object-contain"
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.03 }}
                    transition={{ duration: 0.22, ease: 'easeOut' }}
                    draggable={false}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-blue-200">
                    <PackageIcon className="h-16 w-16" />
                  </div>
                )}
              </AnimatePresence>

              {total > 1 && (
                <>
                  <button
                    type="button"
                    onClick={prev}
                    aria-label="Previous image"
                    className="absolute left-2 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full bg-white/95 backdrop-blur border border-blue-100 shadow-md flex items-center justify-center text-blue-700 hover:bg-blue-50 transition"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={next}
                    aria-label="Next image"
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full bg-white/95 backdrop-blur border border-blue-100 shadow-md flex items-center justify-center text-blue-700 hover:bg-blue-50 transition"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1 bg-white/80 backdrop-blur px-2 py-1 rounded-full border border-blue-100">
                    {images.map((_, i) => (
                      <span
                        key={i}
                        className={`block w-1.5 h-1.5 rounded-full transition ${i === idx ? 'bg-blue-600 w-3' : 'bg-blue-300'}`}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>

            {total > 1 && (
              <div className="mt-3 grid grid-cols-5 gap-2">
                {images.slice(0, 5).map((src, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setIdx(i)}
                    aria-label={`Show image ${i + 1}`}
                    className={`aspect-square rounded-md overflow-hidden border-2 bg-white transition ${
                      i === idx ? 'border-blue-500 shadow-md shadow-blue-200' : 'border-blue-100 hover:border-blue-300'
                    }`}
                  >
                    <img src={src} alt="" className="w-full h-full object-contain" draggable={false} />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Details / Quote side. Generous bottom-padding on mobile so the
              CTA stays reachable above the system gesture bar / soft keyboard. */}
          <div className="p-5 pb-12 sm:p-6 sm:pb-6 flex flex-col bg-white relative min-h-[300px]">
            <AnimatePresence mode="wait">
              {view === 'details' && (
                <motion.div
                  key="details"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.2 }}
                  className="flex flex-col flex-1"
                >
                  <DetailsView
                    product={product}
                    productLabels={productLabels}
                    price={price}
                    onRequestQuote={() => setView('quote')}
                  />
                </motion.div>
              )}

              {view === 'quote' && (
                <motion.div
                  key="quote"
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  transition={{ duration: 0.2 }}
                  className="flex flex-col flex-1"
                >
                  <QuoteForm
                    product={product}
                    price={price}
                    onBack={() => setView('details')}
                    onSuccess={() => setView('success')}
                  />
                </motion.div>
              )}

              {view === 'success' && (
                <motion.div
                  key="success"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 280, damping: 26 }}
                  className="flex-1 flex flex-col items-center justify-center text-center"
                >
                  <motion.div
                    className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-emerald-100 to-emerald-50 border border-emerald-300 mb-4"
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{ duration: 0.6, ease: 'easeInOut' }}
                  >
                    <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                  </motion.div>
                  <h3 className="text-lg font-bold text-slate-900">Quote request sent</h3>
                  <p className="text-sm text-slate-500 mt-2 max-w-xs">
                    Admin will review your request and get back to you. The reply will
                    appear here.
                  </p>
                  <Button
                    className="mt-6"
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                  >
                    Close
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};


// ===========================================================================
// Details (read-only) view
// ===========================================================================
interface DetailsViewProps {
  product: Product;
  productLabels: LabelType[];
  price: number;
  onRequestQuote: () => void;
}

const DetailsView: React.FC<DetailsViewProps> = ({ product, productLabels, price, onRequestQuote }) => (
  <>
    {productLabels.length > 0 && (
      <div className="flex flex-wrap gap-1 mb-2">
        {productLabels.map(l => (
          <span
            key={l.id}
            className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${labelColorClasses[l.color]}`}
          >
            {l.name}
          </span>
        ))}
      </div>
    )}

    <h2 className="text-2xl font-bold text-slate-900 tracking-tight pr-8">{product.name}</h2>

    <div className="mt-2 flex flex-wrap items-center gap-2">
      {product.inStock !== false ? (
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
          <CheckCircle2 className="h-3 w-3" /> In stock
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full border border-rose-200">
          <XCircle className="h-3 w-3" /> Out of stock
        </span>
      )}
    </div>

    {product.description && (
      <p className="text-sm text-slate-600 mt-4 leading-relaxed whitespace-pre-line">
        {product.description}
      </p>
    )}

    {/* Use mt-auto so the price block pins to the bottom on desktop (where
        the form has free vertical space) but stays right under the description
        on mobile (where content flows naturally and the modal scrolls). */}
    <div className="mt-6 sm:mt-auto pt-4 border-t border-blue-100">
      <p className="text-xs text-blue-700/70 uppercase tracking-widest font-bold mb-1">Your price</p>
      <p className="text-3xl font-bold bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 bg-clip-text text-transparent">
        {price > 0 ? fmtINR(price) : 'Quote on request'}
      </p>
      <Button
        variant="gradient"
        size="lg"
        className="w-full mt-4"
        disabled={product.inStock === false}
        onClick={onRequestQuote}
      >
        <MessageSquare className="h-4 w-4" /> Request a quote
      </Button>
      <p className="text-[10px] text-slate-400 mt-2 text-center">
        Admin will get back to you with pricing confirmation.
      </p>
    </div>
  </>
);


// ===========================================================================
// Quote-request form
// ===========================================================================
interface QuoteFormProps {
  product: Product;
  /** Class-aware list price; shown as a soft default for the proposed-price field. */
  price: number;
  onBack: () => void;
  onSuccess: () => void;
}

const friendlyError = (code: string): string => {
  switch (code) {
    case 'product_required': return 'Could not identify the product. Try again from the catalog.';
    case 'invalid_quantity': return 'Please enter a valid quantity.';
    case 'invalid_price':    return 'Please enter a valid proposed price (or leave blank).';
    case 'note_too_long':    return 'Your note is too long. Please trim it under 2000 characters.';
    case 'too_many_pending': return 'You already have a lot of pending quotes. Wait for a response before adding more.';
    default:                 return 'Could not submit your request. Please try again.';
  }
};

const QuoteForm: React.FC<QuoteFormProps> = ({ product, price, onBack, onSuccess }) => {
  const [quantity, setQuantity] = useState<string>('');
  const [proposedPrice, setProposedPrice] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const qNum = Number(quantity);
    if (!Number.isFinite(qNum) || qNum <= 0) {
      setError(friendlyError('invalid_quantity'));
      return;
    }
    const ppNum = proposedPrice.trim() === '' ? null : Number(proposedPrice);
    if (ppNum !== null && (!Number.isFinite(ppNum) || ppNum < 0)) {
      setError(friendlyError('invalid_price'));
      return;
    }
    setSubmitting(true);
    try {
      const r = await authedFetch('/client/quotes', {
        method: 'POST',
        body: JSON.stringify({
          productId: product.id,
          productName: product.name,
          quantity: qNum,
          proposedPrice: ppNum,
          note: note.trim() || undefined,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(friendlyError(body.error || ''));
        return;
      }
      onSuccess();
    } catch {
      setError(friendlyError(''));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col flex-1">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-slate-500 hover:text-blue-700 inline-flex items-center gap-1 self-start transition mb-3"
      >
        <ArrowLeft className="h-3 w-3" /> Back to product
      </button>

      <h3 className="text-lg font-bold text-slate-900">Request a quote</h3>
      <p className="text-xs text-slate-500 mt-1">
        For <strong className="text-slate-700">{product.name}</strong>
      </p>

      <div className="mt-5 space-y-4">
        <div>
          <Label htmlFor="quote-qty" className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-blue-700/80">
            Quantity <span className="text-rose-600">*</span>
          </Label>
          <Input
            id="quote-qty"
            type="number"
            min="0.01"
            step="any"
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            placeholder="e.g. 10"
            className="h-11 bg-white border-blue-200/70 focus-visible:ring-blue-400/40 focus:border-blue-400"
            required
            autoFocus
            disabled={submitting}
            inputMode="decimal"
          />
        </div>

        <div>
          <Label htmlFor="quote-price" className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-blue-700/80">
            Proposed price <span className="text-slate-400 normal-case">(per unit, optional)</span>
          </Label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">₹</span>
            <Input
              id="quote-price"
              type="number"
              min="0"
              step="any"
              value={proposedPrice}
              onChange={e => setProposedPrice(e.target.value)}
              placeholder={price > 0 ? `e.g. ${price}` : 'e.g. 250'}
              className="pl-7 h-11 bg-white border-blue-200/70 focus-visible:ring-blue-400/40 focus:border-blue-400"
              disabled={submitting}
              inputMode="decimal"
            />
          </div>
          <p className="text-[10px] text-slate-400 mt-1">
            Leave blank to ask for their price.
          </p>
        </div>

        <div>
          <Label htmlFor="quote-note" className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-blue-700/80">
            Note <span className="text-slate-400 normal-case">(optional)</span>
          </Label>
          <Textarea
            id="quote-note"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Anything we should know? e.g. delivery preference, urgency, packaging…"
            className="bg-white border-blue-200/70 focus-visible:ring-blue-400/40 focus:border-blue-400 resize-none"
            rows={3}
            maxLength={2000}
            disabled={submitting}
          />
        </div>
      </div>

      {error && (
        <div className="mt-4 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-xs text-rose-700 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5 text-rose-500" />
          <span>{error}</span>
        </div>
      )}

      <Button
        type="submit"
        variant="gradient"
        size="lg"
        className="w-full mt-5 sm:mt-auto"
        disabled={submitting || !quantity}
      >
        {submitting
          ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</>
          : <><Send className="h-4 w-4" /> Send to shop</>}
      </Button>
    </form>
  );
};
