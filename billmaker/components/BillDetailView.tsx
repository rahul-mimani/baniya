import React, { useEffect, useState } from 'react';
import { Bill, Product } from '../types';
import { PlusIcon, TrashIcon } from './Icons';
import { toggleBillAcknowledged } from '../storage/storage';

interface BillDetailViewProps {
  bill: Bill;
  onSave: (bill: Partial<Bill>) => Promise<Bill>;
  onBack: () => void;
}

const BillDetailView: React.FC<BillDetailViewProps> = ({ bill, onSave, onBack }) => {
  const [editedBill, setEditedBill] = useState<Bill>(bill);
  const [isSaving, setIsSaving] = useState(false);
  const [isReleasing, setIsReleasing] = useState(false);

  // Sync edited state from the parent's bill prop. Without this, after a
  // release/un-release the parent reloads bills (fresh state) but the
  // edited state inside this component would stay stuck on the old value
  // if useState only honored the initial mount.
  useEffect(() => {
    setEditedBill(bill);
  }, [bill.id, bill.acknowledged, bill.acknowledgedAt]);

  const handleToggleRelease = async () => {
    if (isReleasing) return;
    setIsReleasing(true);
    try {
      const next = await toggleBillAcknowledged(editedBill.id);
      if (next !== null) {
        setEditedBill(prev => ({
          ...prev,
          acknowledged: next,
          acknowledgedAt: next ? new Date() : undefined,
        }));
      }
    } finally {
      setIsReleasing(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    await onSave(editedBill);
    setIsSaving(false);
    onBack();
  };

  const updateCustomerName = (name: string) => {
    setEditedBill(prev => ({ ...prev, customerName: name }));
  };

  const updateProduct = (index: number, field: keyof Product, value: string) => {
    const newProducts = [...editedBill.products];
    if (field === 'quantity' || field === 'price') {
        if (/^\d*\.?\d*$/.test(value)) {
           newProducts[index] = { ...newProducts[index], [field]: value };
        }
    } else {
       newProducts[index] = { ...newProducts[index], [field]: value };
    }
    setEditedBill(prev => ({ ...prev, products: newProducts }));
  };

  const addProduct = () => {
    const newProduct: Product = { id: Date.now().toString(), name: '', prefix: 'Box', quantity: '', price: '' };
    setEditedBill(prev => ({ ...prev, products: [...prev.products, newProduct] }));
  };

  const removeProduct = (index: number) => {
    setEditedBill(prev => ({ ...prev, products: prev.products.filter((_, i) => i !== index) }));
  };

  const isFormValid = editedBill.customerName.trim() !== '' &&
                      editedBill.products.length > 0 &&
                      editedBill.products.every(p => p.name.trim() !== '' && parseFloat(p.quantity) > 0 && !isNaN(parseFloat(p.price)) && parseFloat(p.price) >= 0);

  return (
    <div className="bg-white p-6 rounded-xl shadow-lg space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-slate-700">
          Edit Bill - <span className="font-mono text-xl text-sky-600">{bill.billNumber}</span>
        </h2>
        <button onClick={onBack} className="text-sky-600 hover:underline">&larr; Back to list</button>
      </div>

      {/* Release / Acknowledge — mirrors the portal's Release toggle so mobile
          users can mark a bill released without going to the admin dashboard. */}
      <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-md px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-700">
            {editedBill.acknowledged ? 'Released to client' : 'Not released yet'}
          </p>
          {editedBill.acknowledged && editedBill.acknowledgedAt && (
            <p className="text-xs text-slate-500">
              {editedBill.acknowledgedAt instanceof Date
                ? editedBill.acknowledgedAt.toLocaleString()
                : new Date(editedBill.acknowledgedAt).toLocaleString()}
            </p>
          )}
        </div>
        <button
          onClick={handleToggleRelease}
          disabled={isReleasing}
          className={`font-semibold py-2 px-4 rounded-md transition disabled:opacity-50 ${
            editedBill.acknowledged
              ? 'bg-slate-200 text-slate-700 hover:bg-slate-300'
              : 'bg-emerald-500 text-white hover:bg-emerald-600'
          }`}
        >
          {isReleasing
            ? 'Saving…'
            : editedBill.acknowledged
              ? 'Mark as not released'
              : 'Release to client'}
        </button>
      </div>

      <div>
        <label htmlFor="customerName" className="block text-sm font-medium text-slate-600 mb-1">
          Customer Name
        </label>
        <input
          type="text"
          id="customerName"
          value={editedBill.customerName}
          onChange={(e) => updateCustomerName(e.target.value)}
          className="w-full px-4 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 transition bg-white text-slate-900"
        />
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-slate-700">Products</h3>
        {editedBill.products.map((product, index) => (
           <div key={product.id} className="p-4 bg-slate-50 rounded-md border relative space-y-3">
             <div className="absolute top-2 right-2">
                <button
                    onClick={() => removeProduct(index)}
                    className="text-slate-400 hover:text-red-500 transition"
                    aria-label="Remove Product"
                >
                    <TrashIcon />
                </button>
            </div>
            <div>
                <label htmlFor={`name-${product.id}`} className="block text-sm font-medium text-slate-600 mb-1">Product Name</label>
                <input
                    id={`name-${product.id}`}
                    type="text"
                    value={product.name}
                    onChange={(e) => updateProduct(index, 'name', e.target.value)}
                    placeholder="Product Name"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 transition bg-white text-slate-900"
                />
            </div>
             <div className="grid grid-cols-2 gap-4">
                <div>
                    <label htmlFor={`quantity-${product.id}`} className="block text-sm font-medium text-slate-600 mb-1">Quantity</label>
                    <input
                        id={`quantity-${product.id}`}
                        type="text"
                        inputMode="decimal"
                        value={product.quantity}
                        onChange={(e) => updateProduct(index, 'quantity', e.target.value)}
                        onFocus={e => e.target.select()}
                        placeholder="Qty"
                        className="w-full px-3 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 transition bg-white text-slate-900"
                    />
                </div>
                <div>
                    <label htmlFor={`prefix-${product.id}`} className="block text-sm font-medium text-slate-600 mb-1">Unit</label>
                    <select
                        id={`prefix-${product.id}`}
                        value={product.prefix}
                        onChange={(e) => updateProduct(index, 'prefix', e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 transition bg-white text-slate-900"
                    >
                        <option>Box</option>
                        <option>Pieces</option>
                    </select>
                </div>
             </div>
             <div>
                 <label htmlFor={`price-${product.id}`} className="block text-sm font-medium text-slate-600 mb-1">Price</label>
                 <div className="relative">
                    <input
                        id={`price-${product.id}`}
                        type="text"
                        inputMode="decimal"
                        value={product.price}
                        onChange={(e) => updateProduct(index, 'price', e.target.value)}
                        onFocus={e => e.target.select()}
                        placeholder="0.00"
                        className="w-full pl-3 pr-12 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 transition bg-white text-slate-900 text-right"
                    />
                     <span className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">
                        INR
                    </span>
                </div>
            </div>
          </div>
        ))}
      </div>
      
      <div className="flex justify-between items-center pt-4 border-t">
        <button
          onClick={addProduct}
          className="flex items-center gap-2 bg-slate-200 text-slate-700 font-semibold py-2 px-4 rounded-md hover:bg-slate-300 transition"
        >
          <PlusIcon />
          Add Product
        </button>
        <button
          onClick={handleSave}
          disabled={!isFormValid || isSaving}
          className="bg-sky-500 text-white font-bold py-2 px-6 rounded-lg shadow-md hover:bg-sky-600 transition disabled:bg-slate-300 disabled:cursor-not-allowed"
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
};

export default BillDetailView;
