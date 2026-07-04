import React, { useState, useEffect, useMemo } from 'react';
import { Plus, X, Tag, ChevronDown, ChevronUp, Sparkles, Search } from 'lucide-react';
import { Deal, DealItem, CustomerClass } from '../../types';
import {
  addDeal,
  updateDeal,
  store,
  getActiveClassCodes,
  classBadgeClasses,
  classDisplayName,
  fmtINR,
} from '../../data/dummyData';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Button } from '../ui/button';

interface DealModalProps {
  mode: 'add' | 'edit';
  deal?: Deal;
  open: boolean;
  onClose: () => void;
}

const COLORS: { value: NonNullable<Deal['bannerColor']>; label: string; cls: string }[] = [
  { value: 'sky', label: 'Sky', cls: 'bg-gradient-to-r from-sky-500 to-sky-700' },
  { value: 'amber', label: 'Amber', cls: 'bg-gradient-to-r from-amber-500 to-amber-700' },
  { value: 'rose', label: 'Rose', cls: 'bg-gradient-to-r from-rose-500 to-rose-700' },
  { value: 'indigo', label: 'Indigo', cls: 'bg-gradient-to-r from-indigo-500 to-violet-700' },
];

const todayPlus30 = () => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
};

/** Local editing state for one item's per-class prices: numbers as strings (so empty stays empty). */
type ItemDraft = { productId: string; prices: Partial<Record<CustomerClass, string>>; expanded?: boolean };

const DealModal: React.FC<DealModalProps> = ({ mode, deal, open, onClose }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [discountPct, setDiscountPct] = useState('');
  const [validUntil, setValidUntil] = useState(todayPlus30());
  const [visibleClasses, setVisibleClasses] = useState<CustomerClass[]>(getActiveClassCodes());
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [bannerColor, setBannerColor] = useState<NonNullable<Deal['bannerColor']>>('sky');
  const [picker, setPicker] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    if (deal) {
      setTitle(deal.title);
      setDescription(deal.description);
      setDiscountPct(String(deal.discountPct));
      setValidUntil(deal.validUntil);
      setVisibleClasses(deal.visibleClasses);
      setItems(deal.items.map(it => ({
        productId: it.productId,
        prices: Object.fromEntries(
          Object.entries(it.prices).map(([k, v]) => [k, v != null ? String(v) : '']),
        ) as Partial<Record<CustomerClass, string>>,
      })));
      setBannerColor(deal.bannerColor || 'sky');
    } else {
      setTitle(''); setDescription(''); setDiscountPct('');
      setValidUntil(todayPlus30());
      setVisibleClasses(getActiveClassCodes());
      setItems([]);
      setBannerColor('sky');
    }
    setPicker(false);
    setPickerSearch('');
  }, [open, deal]);

  const toggleClass = (cls: CustomerClass) => {
    setVisibleClasses(prev => prev.includes(cls) ? prev.filter(c => c !== cls) : [...prev, cls]);
  };

  const itemProductIds = useMemo(() => new Set(items.map(it => it.productId)), [items]);

  // Products available to add (manual + billmaker-imported, not already in the deal)
  const addableProducts = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    return store.products
      .filter(p => !itemProductIds.has(p.id))
      .filter(p => q ? `${p.name} ${p.description}`.toLowerCase().includes(q) : true)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [pickerSearch, itemProductIds, store.products.length]); // eslint-disable-line

  const addItem = (productId: string) => {
    setItems(prev => [...prev, { productId, prices: {}, expanded: true }]);
    setPickerSearch('');
  };
  const removeItem = (productId: string) => {
    setItems(prev => prev.filter(it => it.productId !== productId));
  };
  const setItemPrice = (productId: string, code: CustomerClass, value: string) => {
    setItems(prev => prev.map(it =>
      it.productId === productId
        ? { ...it, prices: { ...it.prices, [code]: value } }
        : it,
    ));
  };
  const toggleExpanded = (productId: string) => {
    setItems(prev => prev.map(it =>
      it.productId === productId ? { ...it, expanded: !it.expanded } : it,
    ));
  };

  const discountNum = parseFloat(discountPct) || 0;
  const canSubmit =
    !!title.trim() &&
    !!description.trim() &&
    !!validUntil &&
    visibleClasses.length > 0 &&
    // Either a whole-deal discount OR at least one product with prices is required
    (discountNum > 0 || items.length > 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canSubmit) return;

    // Convert ItemDraft → DealItem (drop empty/zero/NaN entries)
    const cleanItems: DealItem[] = items.map(it => {
      const prices: Partial<Record<CustomerClass, number>> = {};
      for (const [k, v] of Object.entries(it.prices)) {
        const n = parseFloat(v || '');
        if (!isNaN(n) && n >= 0 && v !== '') prices[k as CustomerClass] = n;
      }
      return { productId: it.productId, prices };
    });

    const payload: Omit<Deal, 'id'> = {
      title: title.trim(),
      description: description.trim(),
      discountPct: discountNum,
      validUntil,
      visibleClasses,
      items: cleanItems,
      bannerColor,
    };
    try {
      if (mode === 'edit' && deal) updateDeal(deal.id, payload);
      else addDeal(payload);
    } finally {
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{mode === 'edit' ? 'Edit deal' : 'Create new deal'}</DialogTitle>
            <DialogDescription>
              Pick which products this deal applies to and (optionally) set special prices per class.
              The whole-deal discount % below acts as a fallback for any class without an explicit price.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <div>
              <Label htmlFor="d-title" className="mb-1.5">Title <span className="text-rose-600">*</span></Label>
              <Input id="d-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Monsoon Antibiotic Combo" required />
            </div>

            <div>
              <Label htmlFor="d-desc" className="mb-1.5">Description <span className="text-rose-600">*</span></Label>
              <Textarea id="d-desc" value={description} onChange={e => setDescription(e.target.value)} placeholder="Short pitch the client sees on the deal banner" rows={2} required />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="d-disc" className="mb-1.5">Whole-deal discount % <span className="text-muted-foreground font-normal normal-case">(fallback)</span></Label>
                <Input
                  id="d-disc"
                  type="text"
                  inputMode="numeric"
                  value={discountPct}
                  onChange={e => { const v = e.target.value; if (/^\d*\.?\d*$/.test(v)) setDiscountPct(v); }}
                  placeholder="10"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Applied to products that don't have an explicit deal price below.</p>
              </div>
              <div>
                <Label htmlFor="d-date" className="mb-1.5">Valid until <span className="text-rose-600">*</span></Label>
                <Input id="d-date" type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} required />
              </div>
            </div>

            <div>
              <Label className="mb-1.5">Visible to classes <span className="text-rose-600">*</span></Label>
              <div className="grid grid-cols-3 sm:flex sm:flex-wrap gap-2">
                {getActiveClassCodes().map(cls => {
                  const on = visibleClasses.includes(cls);
                  return (
                    <button
                      key={cls}
                      type="button"
                      onClick={() => toggleClass(cls)}
                      className={`flex-1 min-w-[80px] py-2 px-2 rounded-md text-xs font-bold border-2 transition ${
                        on ? classBadgeClasses(cls) : 'bg-background text-muted-foreground border-border opacity-60'
                      }`}
                      title={classDisplayName(cls)}
                    >
                      Class {cls}
                      <span className="block text-[9px] font-medium opacity-80 mt-0.5 normal-case">{classDisplayName(cls)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Products + per-product prices */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="mb-0">
                  Products in this deal
                  {items.length > 0 && <span className="ml-1.5 text-muted-foreground font-normal normal-case text-xs">({items.length})</span>}
                </Label>
                <Button type="button" variant="outline" size="sm" onClick={() => setPicker(p => !p)}>
                  <Plus className="h-3.5 w-3.5" /> {picker ? 'Done' : 'Add products'}
                </Button>
              </div>

              {picker && (
                <div className="border rounded-lg overflow-hidden mb-2">
                  <div className="relative border-b">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <input
                      autoFocus
                      value={pickerSearch}
                      onChange={e => setPickerSearch(e.target.value)}
                      placeholder="Search products to add…"
                      className="w-full pl-9 pr-3 py-2 text-sm bg-background focus:outline-none"
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto divide-y">
                    {addableProducts.length === 0 ? (
                      <p className="text-xs text-muted-foreground px-3 py-4 italic text-center">
                        {pickerSearch ? 'No matching products.' : 'No more products to add — all of them are already in this deal.'}
                      </p>
                    ) : addableProducts.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => addItem(p.id)}
                        className="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/40 text-left transition"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate">{p.name}</p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {getActiveClassCodes().map(c => `${c}:${fmtINR(p.prices[c] || 0)}`).join(' · ')}
                          </p>
                        </div>
                        <Plus className="h-4 w-4 text-primary flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {items.length === 0 ? (
                <div className="border-2 border-dashed border-border rounded-lg p-6 text-center text-muted-foreground">
                  <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No products yet. The deal banner will still show with the whole-deal discount.</p>
                </div>
              ) : (
                <div className="border rounded-lg divide-y">
                  {items.map(it => {
                    const product = store.products.find(p => p.id === it.productId);
                    if (!product) {
                      return (
                        <div key={it.productId} className="px-3 py-2 text-xs text-rose-700 flex items-center justify-between">
                          <span>⚠ Missing product {it.productId}</span>
                          <Button type="button" variant="ghost" size="sm" onClick={() => removeItem(it.productId)}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      );
                    }
                    const expanded = it.expanded !== false;
                    return (
                      <div key={it.productId}>
                        <div className="flex items-center gap-2 px-3 py-2 hover:bg-muted/30">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(it.productId)}
                            className="flex items-center gap-2 flex-1 min-w-0 text-left"
                          >
                            <Tag className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="font-semibold text-sm truncate">{product.name}</span>
                            {expanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeItem(it.productId)}
                            className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {expanded && (
                          <div className="px-3 pb-3 pt-1 bg-muted/20">
                            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mb-1.5">
                              Deal price per class
                              {discountNum > 0 && <span className="ml-1 normal-case font-medium opacity-70">(leave blank to use {discountNum}% off)</span>}
                            </p>
                            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                              {getActiveClassCodes().map(code => {
                                const enabledOnProduct = !!product.enabledClasses[code];
                                const normalPrice = product.prices[code] || 0;
                                const fallbackDeal = discountNum > 0 && normalPrice > 0
                                  ? normalPrice * (1 - discountNum / 100)
                                  : null;
                                return (
                                  <div key={code} className={enabledOnProduct ? '' : 'opacity-40'}>
                                    <div className="flex items-baseline justify-between mb-1">
                                      <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${classBadgeClasses(code)}`}>
                                        {code}
                                      </span>
                                      {normalPrice > 0 && (
                                        <span className="text-[9px] text-muted-foreground line-through">
                                          {fmtINR(normalPrice)}
                                        </span>
                                      )}
                                    </div>
                                    <div className="relative">
                                      <span className="absolute left-2 top-1.5 text-xs text-muted-foreground">₹</span>
                                      <input
                                        type="text"
                                        inputMode="decimal"
                                        value={it.prices[code] ?? ''}
                                        onChange={e => {
                                          const v = e.target.value;
                                          if (/^\d*\.?\d*$/.test(v)) setItemPrice(it.productId, code, v);
                                        }}
                                        disabled={!enabledOnProduct}
                                        placeholder={fallbackDeal !== null ? fallbackDeal.toFixed(2) : '—'}
                                        className="w-full pl-5 pr-1 py-1 text-xs text-right border border-input rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed"
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {!getActiveClassCodes().some(c => !!product.enabledClasses[c]) && (
                              <p className="text-[10px] text-amber-700 mt-1.5">
                                ⚠ This product has no active classes enabled — clients won't see it even with the deal.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <Label className="mb-1.5">Banner color</Label>
              <div className="grid grid-cols-4 gap-2">
                {COLORS.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setBannerColor(c.value)}
                    className={`h-12 rounded-lg ${c.cls} ring-2 transition ${
                      bannerColor === c.value ? 'ring-foreground ring-offset-2' : 'ring-transparent hover:ring-foreground/30'
                    }`}
                    title={c.label}
                  />
                ))}
              </div>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="gradient" disabled={!canSubmit}>
              {mode === 'edit' ? 'Save changes' : 'Create deal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default DealModal;
