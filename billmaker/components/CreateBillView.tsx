import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Bill, Product, Profile } from '../types';
import { PlusIcon, TrashIcon, CloseIcon, UserIcon, PackageIcon } from './Icons';
import BillSummaryModal from './BillSummaryModal';
import CustomerInput from './CustomerInput';
import ProductInput from './ProductInput';
import { setBackHandler } from '../utils/backHandler';
import { calcBillTotal, formatINR } from '../utils/billTotal';

interface CreateBillViewProps {
  isOpen: boolean;
  onClose: () => void;
  activeProfile: Profile | null;
  onSaveBill: (bill: Partial<Bill>) => Promise<Bill>;
}

const blankBill = (): Partial<Bill> => ({ customerName: '', products: [] });

const blankProduct = (): Product => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  name: '',
  prefix: 'Box',
  quantity: '',
  price: '',
});

const validateBill = (bill: Partial<Bill> | null, custName: string): boolean => {
  if (!bill || !custName?.trim()) return false;
  if (!bill.products || bill.products.length === 0) return false;
  return bill.products.every(
    p =>
      p.name.trim() &&
      parseFloat(p.quantity) > 0 &&
      !isNaN(parseFloat(p.price)) &&
      parseFloat(p.price) >= 0,
  );
};

const CreateBillView: React.FC<CreateBillViewProps> = ({ isOpen, onClose, activeProfile, onSaveBill }) => {
  const [currentBill, setCurrentBill] = useState<Partial<Bill>>(blankBill);
  const [customerName, setCustomerName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showSummary, setShowSummary] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCurrentBill(blankBill());
      setCustomerName('');
      setShowSummary(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setBackHandler(() => {
      if (showSummary) { setShowSummary(false); return true; }
      onClose();
      return true;
    });
    return () => setBackHandler(null);
  }, [isOpen, showSummary, onClose]);

  const isValid = validateBill(currentBill, customerName);
  const grandTotal = useMemo(() => calcBillTotal(currentBill.products), [currentBill.products]);
  const validProductCount = (currentBill.products || []).filter(
    p => p.name.trim() && parseFloat(p.quantity) > 0,
  ).length;

  const handleSave = useCallback(async () => {
    if (!isValid) return;
    setIsSaving(true);
    try {
      await onSaveBill({
        ...currentBill,
        customerName,
        createdByProfileId: activeProfile?.id,
        createdByProfileName: activeProfile?.name,
      });
      onClose();
    } catch (error) {
      console.error('Failed to save bill:', error);
    } finally {
      setIsSaving(false);
    }
  }, [onSaveBill, currentBill, customerName, activeProfile, onClose, isValid]);

  const updateProduct = (index: number, field: keyof Product, value: string) => {
    setCurrentBill(prev => {
      const products = prev.products || [];
      const next = [...products];
      if (field === 'quantity' || field === 'price') {
        if (/^\d*\.?\d*$/.test(value)) {
          next[index] = { ...next[index], [field]: value };
        }
      } else {
        next[index] = { ...next[index], [field]: value };
      }
      return { ...prev, products: next };
    });
  };

  const addProduct = () => {
    setCurrentBill(prev => ({
      ...prev,
      products: [...(prev.products || []), blankProduct()],
    }));
  };

  const removeProduct = (index: number) => {
    setCurrentBill(prev => ({ ...prev, products: (prev.products || []).filter((_, i) => i !== index) }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 bg-sky-50 overflow-y-auto no-print">
      <div className="sticky top-0 z-40 bg-white border-b shadow-sm app-header">
        <div className="px-3 py-3 flex items-center gap-2">
          <button
            onClick={onClose}
            className="p-2 rounded-full active:bg-slate-100 text-slate-700 flex-shrink-0"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-slate-800 leading-tight">New Bill</h2>
            <p className="text-[11px] text-slate-500 truncate leading-tight mt-0.5">
              {customerName.trim() || <span className="italic">Enter customer details below</span>}
              {validProductCount > 0 && (
                <>
                  <span className="mx-1">·</span>
                  <span className="text-indigo-600 font-semibold">
                    {validProductCount} item{validProductCount === 1 ? '' : 's'}
                  </span>
                </>
              )}
              {grandTotal > 0 && (
                <>
                  <span className="mx-1">·</span>
                  <span className="text-sky-700 font-bold">{formatINR(grandTotal)}</span>
                </>
              )}
            </p>
          </div>
          <button
            onClick={() => setShowSummary(true)}
            disabled={!isValid}
            className="px-3 py-1.5 text-sky-600 font-semibold rounded-md text-sm border border-sky-200 active:bg-sky-50 disabled:text-slate-400 disabled:border-slate-200 disabled:cursor-not-allowed transition"
          >
            Preview
          </button>
          <button
            onClick={handleSave}
            disabled={!isValid || isSaving}
            className="px-4 py-1.5 bg-sky-600 text-white font-bold rounded-md text-sm shadow active:bg-sky-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition"
          >
            {isSaving ? '…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="container mx-auto px-4 pt-6 pb-32 max-w-3xl space-y-5">
        <section className="bg-white rounded-xl shadow-sm relative z-20">
          <header className="px-5 py-3 bg-sky-50 border-b rounded-t-xl flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center flex-shrink-0">
              <UserIcon />
            </div>
            <div>
              <h3 className="font-bold text-slate-800 leading-tight">Customer</h3>
              <p className="text-[11px] text-slate-500 leading-tight">Who this bill is for</p>
            </div>
          </header>
          <div className="p-5">
            <CustomerInput value={customerName} onChange={setCustomerName} />
            {activeProfile && (
              <p className="text-xs text-slate-500 mt-3">
                Tagged as created by{' '}
                <span className="font-semibold text-slate-700">{activeProfile.name}</span>
              </p>
            )}
          </div>
        </section>

        <section className="bg-white rounded-xl shadow-sm">
          <header className="px-5 py-3 bg-indigo-50 border-b rounded-t-xl flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center flex-shrink-0">
              <PackageIcon />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-slate-800 leading-tight">Products</h3>
              <p className="text-[11px] text-slate-500 leading-tight">
                {(currentBill.products?.length ?? 0) === 0
                  ? 'Add items to this bill'
                  : `${currentBill.products?.length} item${currentBill.products?.length === 1 ? '' : 's'} on bill`}
              </p>
            </div>
          </header>
          <div className="p-5 space-y-3">
            {(currentBill.products?.length ?? 0) === 0 && (
              <div className="text-center py-8 text-sm text-slate-400">
                <PackageIcon />
                <p className="mt-2">No products yet</p>
              </div>
            )}
            {currentBill.products?.map((product, index) => (
              <ProductRow
                key={product.id}
                index={index}
                product={product}
                onUpdate={(field, value) => updateProduct(index, field, value)}
                onRemove={() => removeProduct(index)}
              />
            ))}
            <button
              onClick={addProduct}
              className="w-full flex items-center justify-center gap-2 bg-indigo-50 text-indigo-700 font-semibold py-3 px-4 rounded-md active:bg-indigo-100 transition border border-dashed border-indigo-300"
            >
              <PlusIcon />
              Add product
            </button>
          </div>
        </section>

        {grandTotal > 0 && (
          <section className="bg-sky-600 text-white rounded-xl shadow-lg p-5">
            <div className="flex justify-between items-end">
              <div>
                <p className="text-[11px] uppercase tracking-wider opacity-80 font-semibold">Grand total</p>
                <p className="text-3xl font-bold mt-1 leading-none">{formatINR(grandTotal)}</p>
              </div>
              <div className="text-right text-sm opacity-90">
                <p>
                  {validProductCount} item{validProductCount === 1 ? '' : 's'}
                </p>
                {customerName.trim() && (
                  <p className="font-semibold text-white truncate max-w-[160px]">{customerName}</p>
                )}
              </div>
            </div>
          </section>
        )}
      </div>

      {showSummary && (
        <BillSummaryModal
          bill={{ ...currentBill, customerName } as Bill}
          onClose={() => setShowSummary(false)}
        />
      )}
    </div>
  );
};

interface ProductRowProps {
  index: number;
  product: Product;
  onUpdate: (field: keyof Product, value: string) => void;
  onRemove: () => void;
}

const ProductRow: React.FC<ProductRowProps> = ({ index, product, onUpdate, onRemove }) => {
  const qty = parseFloat(product.quantity);
  const price = parseFloat(product.price);
  const subtotal = !isNaN(qty) && !isNaN(price) && qty > 0 && price >= 0 ? qty * price : null;

  return (
    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 relative space-y-3">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[11px] font-bold uppercase tracking-wide">
          Item {index + 1}
        </span>
        <button
          onClick={onRemove}
          className="text-slate-400 active:text-rose-500 transition p-1"
          aria-label="Remove product"
        >
          <TrashIcon />
        </button>
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Item name</label>
        <ProductInput value={product.name} onChange={val => onUpdate('name', val)} />
      </div>
      <div className="grid grid-cols-5 gap-3">
        <div className="col-span-3">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Quantity</label>
          <input
            type="text"
            inputMode="decimal"
            value={product.quantity}
            onChange={e => onUpdate('quantity', e.target.value)}
            onFocus={e => e.target.select()}
            placeholder="0"
            className="w-full px-3 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white text-slate-900"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Unit</label>
          <select
            value={product.prefix}
            onChange={e => onUpdate('prefix', e.target.value)}
            className="w-full px-2 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white text-slate-900"
          >
            <option>Box</option>
            <option>Pieces</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Price per unit</label>
        <div className="relative">
          <input
            type="text"
            inputMode="decimal"
            value={product.price}
            onChange={e => onUpdate('price', e.target.value)}
            onFocus={e => e.target.select()}
            placeholder="0.00"
            className="w-full pl-3 pr-12 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white text-slate-900 text-right"
          />
          <span className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500 text-sm font-semibold">INR</span>
        </div>
      </div>
      {subtotal !== null && (
        <div className="text-right text-sm text-slate-600 pt-2 border-t border-slate-200">
          Subtotal: <span className="font-bold text-sky-700">{formatINR(subtotal)}</span>
        </div>
      )}
    </div>
  );
};

export default CreateBillView;
