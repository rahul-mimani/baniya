import { Filesystem, Encoding } from '@capacitor/filesystem';
import { Payment } from '../types';
import { APP_DIR, initFile } from './paths';
import {
  appendPaymentToBill,
  removePaymentFromBill,
  triggerWorkerSync,
} from './sync';
import { log } from '../utils/diagnostics';

const FILE_NAME = 'payments.json';

const serializePayment = (p: Payment): any => ({
  id: p.id,
  billId: p.billId,
  amount: p.amount,
  receivedAt: p.receivedAt.toISOString(),
  method: p.method ?? null,
  note: p.note ?? null,
  createdByProfileId: p.createdByProfileId ?? null,
  createdByProfileName: p.createdByProfileName ?? null,
});

export const initPaymentStorage = async () => {
  await initFile(FILE_NAME, '[]');
};

export const getPayments = async (): Promise<Payment[]> => {
  try {
    const result = await Filesystem.readFile({
      path: FILE_NAME,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
    });
    const dataStr = typeof result.data === 'string' ? result.data : await result.data.text();
    const raw = JSON.parse(dataStr);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((p: any) => {
        if (!p || typeof p !== 'object') return null;
        const amount = typeof p.amount === 'number' ? p.amount : parseFloat(p.amount) || 0;
        const receivedAt = p.receivedAt ? new Date(p.receivedAt) : new Date();
        if (isNaN(receivedAt.getTime())) return null;
        return {
          id: String(p.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
          billId: String(p.billId || ''),
          amount,
          receivedAt,
          method: p.method,
          note: typeof p.note === 'string' ? p.note : undefined,
          createdByProfileId: typeof p.createdByProfileId === 'string' ? p.createdByProfileId : undefined,
          createdByProfileName: typeof p.createdByProfileName === 'string' ? p.createdByProfileName : undefined,
        } as Payment;
      })
      .filter((p): p is Payment => p !== null && !!p.billId);
  } catch (e) {
    console.error('Error reading payments:', e);
    return [];
  }
};

export const savePayments = async (payments: Payment[]) => {
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: JSON.stringify(payments, null, 2),
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

/** Shape stored inside `bills/<id>.payments[]`. Mirrors the separate
 *  payments collection but without billId (the parent doc IS the bill). */
const toEmbeddedPayment = (p: Payment): Record<string, any> => ({
  id: p.id,
  amount: p.amount,
  receivedAt: p.receivedAt.toISOString(),
  method: p.method ?? null,
  note: p.note ?? null,
  createdByProfileId: p.createdByProfileId ?? null,
  createdByProfileName: p.createdByProfileName ?? null,
});

/** Phase B: ONE Firestore write per payment action — an arrayUnion against
 *  bills/<billId>.payments[]. The worker derives admin_aggregates.totalRevenue
 *  and portal_customer.paid from the updated bill on next sync. */
export const addPayment = async (payment: Payment): Promise<void> => {
  log('info', 'payments', `addPayment id=${payment.id} billId=${payment.billId} amount=${payment.amount} method=${payment.method || 'n/a'}`);
  const list = await getPayments();
  list.push(payment);
  await savePayments(list);
  // ONE Firestore write — arrayUnion into the embedded payments[] on the bill.
  await appendPaymentToBill(payment.billId, toEmbeddedPayment(payment));
  void triggerWorkerSync('bills');
};

export const deletePayment = async (id: string): Promise<void> => {
  log('info', 'payments', `deletePayment id=${id}`);
  const list = await getPayments();
  const toDelete = list.find(p => p.id === id);
  await savePayments(list.filter(p => p.id !== id));
  if (toDelete) {
    // ONE Firestore write — arrayRemove from bill.payments[].
    await removePaymentFromBill(toDelete.billId, toEmbeddedPayment(toDelete));
    void triggerWorkerSync('bills');
  } else {
    log('warn', 'payments', `deletePayment id=${id} not found locally`);
  }
};

export const updatePayment = async (payment: Payment): Promise<void> => {
  log('info', 'payments', `updatePayment id=${payment.id} billId=${payment.billId} amount=${payment.amount}`);
  const list = await getPayments();
  const idx = list.findIndex(p => p.id === payment.id);
  if (idx >= 0) {
    const oldPayment = list[idx];
    list[idx] = payment;
    await savePayments(list);
    // TWO Firestore writes (remove + add) — unavoidable because arrayUnion
    // doesn't support in-place replacement. Wrapped in a single trigger.
    await removePaymentFromBill(oldPayment.billId, toEmbeddedPayment(oldPayment));
    await appendPaymentToBill(payment.billId, toEmbeddedPayment(payment));
    void triggerWorkerSync('bills');
  }
};
