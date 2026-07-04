import React from 'react';
import { Bill, Product } from '../types';

interface BillSummaryModalProps {
  bill: Partial<Bill>;
  onClose: () => void;
  onEdit?: () => void;
}

const BillSummaryModal: React.FC<BillSummaryModalProps> = ({ bill, onClose, onEdit }) => {
    const calculateTotal = (products: Product[] | undefined) => {
        if (!products) return 0;
        return products.reduce((acc, product) => {
            const quantity = parseFloat(product.quantity) || 0;
            const price = parseFloat(product.price) || 0;
            return acc + (quantity * price);
        }, 0);
    };
    
    const grandTotal = calculateTotal(bill.products);

  return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 no-print">
        <div className="bg-white rounded-lg shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col">
          <div className="p-6 border-b">
            <div className="flex justify-between items-start">
              <h2 className="text-2xl font-bold text-slate-800">Bill Summary</h2>
              {bill.billNumber && <span className="font-mono text-base text-slate-500 pt-1">{bill.billNumber}</span>}
              <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-2xl leading-none">&times;</button>
            </div>
            <div className="mt-4">
              <p className="text-lg">
                <span className="font-semibold text-slate-600">Customer:</span>
                <span className="ml-2 text-slate-800">{bill.customerName}</span>
              </p>
            </div>
          </div>
          <div className="p-6 flex-grow overflow-y-auto">
              <h3 className="text-lg font-semibold text-slate-600 mb-2">Products</h3>
              <div className="space-y-3">
                {bill.products?.map((product, index) => {
                    const quantity = parseFloat(product.quantity) || 0;
                    const price = parseFloat(product.price) || 0;
                    const total = quantity * price;

                    return (
                      <div key={index} className="p-3 bg-slate-50 rounded-md">
                        <div className="flex justify-between items-center">
                            <span className="font-semibold text-slate-800">{product.name}</span>
                            <span className="font-mono text-slate-700 font-semibold">₹{total.toFixed(2)}</span>
                        </div>
                        <div className="text-sm text-slate-500 mt-1">
                            {product.quantity} {product.prefix} &times; ₹{price.toFixed(2)}
                        </div>
                      </div>
                    );
                })}
              </div>
          </div>
           <div className="p-6 bg-slate-100 border-t">
                <div className="flex justify-between items-center text-xl font-bold">
                    <span className="text-slate-700">Grand Total</span>
                    <span className="text-sky-600">₹{grandTotal.toFixed(2)}</span>
                </div>
           </div>
          <div className="p-4 bg-slate-50 border-t flex justify-end gap-3">
            {onEdit && (
              <button
                  onClick={onEdit}
                  className="bg-white text-sky-600 border border-sky-500 font-semibold py-2 px-4 rounded-md hover:bg-sky-50 transition"
              >
                  Edit Bill
              </button>
            )}
            <button
              onClick={onClose}
              className="bg-sky-500 text-white font-semibold py-2 px-4 rounded-md hover:bg-sky-600 transition"
            >
              Close
            </button>
          </div>
        </div>
      </div>
  );
};

export default BillSummaryModal;