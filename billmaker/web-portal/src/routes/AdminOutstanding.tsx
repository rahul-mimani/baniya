import React, { useState, useEffect, useMemo } from 'react';
import {
  IndianRupee,
  Search,
  ChevronDown,
  Check,
  AlertTriangle,
  CheckCircle2,
  X,
} from 'lucide-react';
import { store, onStoreChange, fmtINR, settleBills, classBadgeClasses } from '../data/dummyData';
import { Bill, Customer } from '../types';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
} from '../components/ui/dialog';
import { cn } from '../lib/utils';

interface CustomerOutstandingRow {
  customer: Customer;
  bills: Bill[];        // bills with outstanding > 0
  total: number;        // sum of outstanding
}

const AdminOutstanding: React.FC = () => {
  const [, force] = useState(0);
  useEffect(() => onStoreChange(() => force(n => n + 1)), []);

  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedBills, setSelectedBills] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Group bills by customer where outstanding > 0
  const rows: CustomerOutstandingRow[] = useMemo(() => {
    const byCustomer = new Map<string, { customer: Customer; bills: Bill[]; total: number }>();
    for (const b of store.bills) {
      const outstanding = b.total - b.paid;
      if (outstanding <= 0) continue;
      // Try to resolve customer by id, then by name (since some bills only have name)
      const customer =
        store.customers.find(c => c.id === b.customerId) ||
        store.customers.find(c => c.name === b.customerName);
      if (!customer) continue;
      const slot = byCustomer.get(customer.id) || { customer, bills: [], total: 0 };
      slot.bills.push(b);
      slot.total += outstanding;
      byCustomer.set(customer.id, slot);
    }
    let list = Array.from(byCustomer.values());
    // Filter by search
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(r => r.customer.name.toLowerCase().includes(q));
    }
    // Sort by total descending — largest debts at top
    list.sort((a, b) => b.total - a.total);
    // Each row's bills sorted by date desc
    for (const r of list) {
      r.bills.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return list;
  }, [search, store.bills.length, store.bills.map(b => `${b.id}:${b.paid}`).join('|'), store.customers.length]); // eslint-disable-line

  // Global stats — unfiltered
  const globalStats = useMemo(() => {
    let total = 0;
    let billCount = 0;
    const customerIds = new Set<string>();
    for (const b of store.bills) {
      const due = b.total - b.paid;
      if (due <= 0) continue;
      const customer =
        store.customers.find(c => c.id === b.customerId) ||
        store.customers.find(c => c.name === b.customerName);
      if (customer) {
        total += due;
        billCount++;
        customerIds.add(customer.id);
      }
    }
    return { total, billCount, customerCount: customerIds.size };
  }, [store.bills.length, store.bills.map(b => `${b.id}:${b.paid}`).join('|'), store.customers.length]); // eslint-disable-line

  // Selected total (computed from selectedBills set)
  const selectedTotal = useMemo(() => {
    let sum = 0;
    for (const bid of selectedBills) {
      const b = store.bills.find(b => b.id === bid);
      if (b) sum += b.total - b.paid;
    }
    return sum;
  }, [selectedBills, store.bills]); // eslint-disable-line

  // Helpers for tri-state customer checkboxes
  const customerState = (row: CustomerOutstandingRow): 'none' | 'some' | 'all' => {
    const billIds = row.bills.map(b => b.id);
    const selectedCount = billIds.filter(id => selectedBills.has(id)).length;
    if (selectedCount === 0) return 'none';
    if (selectedCount === billIds.length) return 'all';
    return 'some';
  };

  const toggleCustomer = (row: CustomerOutstandingRow) => {
    const state = customerState(row);
    setSelectedBills(prev => {
      const next = new Set(prev);
      if (state === 'all') {
        for (const b of row.bills) next.delete(b.id);
      } else {
        for (const b of row.bills) next.add(b.id);
      }
      return next;
    });
  };

  const toggleBill = (billId: string) => {
    setSelectedBills(prev => {
      const next = new Set(prev);
      next.has(billId) ? next.delete(billId) : next.add(billId);
      return next;
    });
  };

  const toggleExpanded = (customerId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(customerId) ? next.delete(customerId) : next.add(customerId);
      return next;
    });
  };

  // Select all customers (every bill with outstanding > 0)
  const allBillIds = useMemo(() => rows.flatMap(r => r.bills.map(b => b.id)), [rows]);
  const allSelectedState: 'none' | 'some' | 'all' = useMemo(() => {
    if (allBillIds.length === 0) return 'none';
    const count = allBillIds.filter(id => selectedBills.has(id)).length;
    if (count === 0) return 'none';
    if (count === allBillIds.length) return 'all';
    return 'some';
  }, [allBillIds, selectedBills]);

  const toggleAll = () => {
    setSelectedBills(prev => {
      if (allSelectedState === 'all') {
        const next = new Set(prev);
        for (const id of allBillIds) next.delete(id);
        return next;
      }
      const next = new Set(prev);
      for (const id of allBillIds) next.add(id);
      return next;
    });
  };

  const handleConfirmSettle = () => {
    const count = settleBills(Array.from(selectedBills));
    setSelectedBills(new Set());
    setExpanded(new Set());
    setConfirming(false);
    setToast(`Marked ${count} bill${count === 1 ? '' : 's'} as paid.`);
    setTimeout(() => setToast(null), 4000);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
          <IndianRupee className="h-7 w-7 text-emerald-600" /> Settle Outstanding
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Clear outstanding balances in bulk. Select one customer or many, then optionally drill down to
          settle specific bills — or mark every overdue bill paid in one click.
        </p>
      </header>

      {/* Stats hero */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4">
        <Card className="bg-gradient-to-br from-rose-100 to-rose-50 border-rose-200">
          <CardContent className="p-3 sm:p-4">
            <p className="text-[10px] uppercase tracking-widest font-bold opacity-70">Total Outstanding</p>
            <p className="text-xl sm:text-2xl font-bold mt-1 text-rose-700 truncate" title={fmtINR(globalStats.total)}>
              {fmtINR(globalStats.total)}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-amber-100 to-amber-50 border-amber-200">
          <CardContent className="p-3 sm:p-4">
            <p className="text-[10px] uppercase tracking-widest font-bold opacity-70">Unpaid Bills</p>
            <p className="text-xl sm:text-2xl font-bold mt-1 text-amber-700">{globalStats.billCount}</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-sky-100 to-sky-50 border-sky-200">
          <CardContent className="p-3 sm:p-4">
            <p className="text-[10px] uppercase tracking-widest font-bold opacity-70">Customers Owing</p>
            <p className="text-xl sm:text-2xl font-bold mt-1 text-sky-700">{globalStats.customerCount}</p>
          </CardContent>
        </Card>
      </div>

      {globalStats.billCount === 0 ? (
        <Card className="p-12 text-center">
          <CheckCircle2 className="h-12 w-12 mx-auto text-emerald-500 mb-3" />
          <p className="text-lg font-semibold mb-1">All settled</p>
          <p className="text-sm text-muted-foreground">
            No customer has any outstanding balance right now. 🎉
          </p>
        </Card>
      ) : (
        <>
          {/* Search */}
          <div className="relative mb-3">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search customers…"
              className="pl-9 pr-9"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Customer list with bills */}
          <Card className="overflow-hidden">
            {/* Select-all header */}
            <div
              onClick={toggleAll}
              className="flex items-center gap-3 px-4 py-3 border-b bg-muted/30 cursor-pointer hover:bg-muted/50 transition select-none"
            >
              <TriCheckbox state={allSelectedState} />
              <div className="flex-1">
                <p className="font-semibold text-sm">
                  Select all {rows.length} customer{rows.length === 1 ? '' : 's'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Marks every overdue bill as fully paid
                </p>
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No customers match your search.
              </div>
            ) : (
              <div className="divide-y">
                {rows.map(row => {
                  const state = customerState(row);
                  const isExpanded = expanded.has(row.customer.id);
                  return (
                    <div key={row.customer.id}>
                      <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition">
                        <div onClick={() => toggleCustomer(row)} className="cursor-pointer">
                          <TriCheckbox state={state} />
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleExpanded(row.customer.id)}
                          className="flex-1 flex items-center gap-3 text-left min-w-0"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold truncate">{row.customer.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {row.bills.length} bill{row.bills.length === 1 ? '' : 's'} owed
                            </p>
                          </div>
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${classBadgeClasses(row.customer.class)}`}>
                            {row.customer.class}
                          </span>
                          <div className="text-right flex-shrink-0">
                            <p className="font-bold text-rose-600">{fmtINR(row.total)}</p>
                          </div>
                          <ChevronDown
                            className={cn(
                              'h-4 w-4 text-muted-foreground transition flex-shrink-0',
                              isExpanded && 'rotate-180',
                            )}
                          />
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="bg-muted/20 border-t divide-y">
                          {row.bills.map(b => {
                            const due = b.total - b.paid;
                            const checked = selectedBills.has(b.id);
                            return (
                              <div
                                key={b.id}
                                onClick={() => toggleBill(b.id)}
                                className={cn(
                                  'flex items-center gap-3 pl-12 pr-4 py-2.5 cursor-pointer transition',
                                  checked ? 'bg-sky-50' : 'hover:bg-muted/40',
                                )}
                              >
                                <div className={cn(
                                  'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0',
                                  checked
                                    ? 'bg-primary border-primary text-primary-foreground'
                                    : 'bg-background border-input',
                                )}>
                                  {checked && <Check className="h-3 w-3" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="font-mono text-sm font-bold text-primary">{b.billNumber}</p>
                                  <p className="text-[11px] text-muted-foreground">
                                    {new Date(b.createdAt).toLocaleDateString()} · {b.items.length} item{b.items.length === 1 ? '' : 's'}
                                    {b.paid > 0 && (
                                      <span className="ml-2">
                                        · Paid {fmtINR(b.paid)} of {fmtINR(b.total)}
                                      </span>
                                    )}
                                  </p>
                                </div>
                                <div className="text-right flex-shrink-0">
                                  <p className="font-bold text-rose-600 text-sm">{fmtINR(due)}</p>
                                  <p className="text-[10px] text-muted-foreground">due</p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}

      {/* Floating action bar */}
      {selectedBills.size > 0 && (
        <div className="fixed bottom-0 inset-x-0 lg:left-72 z-30 bg-background/95 backdrop-blur border-t shadow-2xl">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {selectedBills.size} bill{selectedBills.size === 1 ? '' : 's'} selected
              </p>
              <p className="text-lg sm:text-xl font-bold text-emerald-700">
                {fmtINR(selectedTotal)}
                <span className="text-xs font-normal text-muted-foreground ml-2">will be cleared</span>
              </p>
            </div>
            <Button variant="outline" onClick={() => setSelectedBills(new Set())}>
              Clear
            </Button>
            <Button onClick={() => setConfirming(true)}>
              <CheckCircle2 className="h-4 w-4" /> Mark Paid
            </Button>
          </div>
        </div>
      )}

      {/* Confirmation dialog */}
      <Dialog open={confirming} onOpenChange={o => { if (!o) setConfirming(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-5 w-5" /> Confirm bulk settlement
            </DialogTitle>
            <DialogDescription>
              You're about to mark <strong>{selectedBills.size} bill{selectedBills.size === 1 ? '' : 's'}</strong> totaling{' '}
              <strong>{fmtINR(selectedTotal)}</strong> as fully paid. This action will push the change to your Firestore
              <code className="font-mono mx-1 text-xs bg-muted px-1.5 py-0.5 rounded">bills</code> collection so Baniya mobile sees them as settled too.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2.5 text-xs text-amber-900">
              <p className="font-bold mb-1">⚠ Heads up</p>
              <ul className="space-y-0.5 list-disc list-inside ml-1">
                <li>This is not reversible from this screen — manually edit each bill on mobile to revert.</li>
                <li>Each affected bill gets <code>paid = total</code> and a <code>settledFromPortal: true</code> marker.</li>
                <li>No payment records are created in the <code>payments</code> collection (this is a quick-clear, not an audit-grade entry).</li>
              </ul>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button type="button" onClick={handleConfirmSettle}>
              <CheckCircle2 className="h-4 w-4" /> Yes, mark {selectedBills.size} paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white text-sm font-semibold px-4 py-3 rounded-lg shadow-xl">
          ✓ {toast}
        </div>
      )}
    </div>
  );
};

interface TriCheckboxProps {
  state: 'none' | 'some' | 'all';
}
const TriCheckbox: React.FC<TriCheckboxProps> = ({ state }) => (
  <div className={cn(
    'w-5 h-5 rounded-md border flex items-center justify-center flex-shrink-0 transition',
    state === 'none' && 'bg-background border-input',
    state === 'some' && 'bg-primary/30 border-primary',
    state === 'all' && 'bg-primary border-primary text-primary-foreground',
  )}>
    {state === 'all' && <Check className="h-3.5 w-3.5" />}
    {state === 'some' && <div className="w-2 h-0.5 bg-primary rounded" />}
  </div>
);

export default AdminOutstanding;
