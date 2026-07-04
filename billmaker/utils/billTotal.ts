import { Product } from '../types';

export const calcBillTotal = (products: Product[] | undefined): number => {
  if (!products) return 0;
  return products.reduce((acc, p) => {
    const q = parseFloat(p.quantity) || 0;
    const pr = parseFloat(p.price) || 0;
    return acc + q * pr;
  }, 0);
};

export const formatINR = (amount: number): string =>
  `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
