import { Bill, Payment } from '../types';
import { calcBillTotal } from './billTotal';

export type PaymentStatus = 'paid' | 'partial' | 'unpaid';

export const billTotal = (bill: Bill): number => calcBillTotal(bill.products);

export const paymentsForBill = (billId: string, payments: Payment[]): Payment[] =>
  payments.filter(p => p.billId === billId);

export const billPaidAmount = (billId: string, payments: Payment[]): number =>
  paymentsForBill(billId, payments).reduce((s, p) => s + (p.amount || 0), 0);

export const billBalance = (bill: Bill, payments: Payment[]): number => {
  const balance = billTotal(bill) - billPaidAmount(bill.id, payments);
  return Math.round(balance * 100) / 100; // avoid floating-point dust
};

export const billStatus = (bill: Bill, payments: Payment[]): PaymentStatus => {
  const total = billTotal(bill);
  const paid = billPaidAmount(bill.id, payments);
  if (total === 0) return 'paid';
  if (paid >= total - 0.005) return 'paid';
  if (paid > 0) return 'partial';
  return 'unpaid';
};

export const customerOutstanding = (
  customerName: string,
  bills: Bill[],
  payments: Payment[],
): number =>
  bills
    .filter(b => b.customerName === customerName)
    .reduce((s, b) => s + Math.max(0, billBalance(b, payments)), 0);

export const totalOutstanding = (bills: Bill[], payments: Payment[]): number =>
  bills.reduce((s, b) => s + Math.max(0, billBalance(b, payments)), 0);

export const paidThisMonth = (payments: Payment[]): number => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return payments
    .filter(p => p.receivedAt.getTime() >= start)
    .reduce((s, p) => s + (p.amount || 0), 0);
};

/** Most recent payment date for a given bill, or null if none recorded. */
export const lastPaymentDate = (billId: string, payments: Payment[]): Date | null => {
  let latest: Date | null = null;
  for (const p of payments) {
    if (p.billId !== billId) continue;
    if (latest === null || p.receivedAt.getTime() > latest.getTime()) latest = p.receivedAt;
  }
  return latest;
};

/** Aggregate payments by calendar day (local time) for the last `days` days. Most-recent day last. */
export const dailyPaymentTotals = (
  payments: Payment[],
  days: number,
): { date: Date; total: number }[] => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets: { date: Date; total: number }[] = [];
  const indexByKey = new Map<number, number>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    indexByKey.set(d.getTime(), buckets.length);
    buckets.push({ date: d, total: 0 });
  }
  for (const p of payments) {
    const d = new Date(p.receivedAt);
    d.setHours(0, 0, 0, 0);
    const idx = indexByKey.get(d.getTime());
    if (idx !== undefined) buckets[idx].total += p.amount || 0;
  }
  return buckets;
};

/** Top N customers by outstanding balance (descending). Customers with 0 balance are excluded. */
export const topOutstandingCustomers = (
  bills: Bill[],
  payments: Payment[],
  limit: number,
): { customerName: string; outstanding: number; billCount: number }[] => {
  const map = new Map<string, { outstanding: number; billCount: number }>();
  for (const b of bills) {
    const bal = billBalance(b, payments);
    if (bal <= 0.005) continue;
    const cur = map.get(b.customerName) || { outstanding: 0, billCount: 0 };
    cur.outstanding += bal;
    cur.billCount += 1;
    map.set(b.customerName, cur);
  }
  return Array.from(map.entries())
    .map(([customerName, v]) => ({ customerName, ...v }))
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, limit);
};
