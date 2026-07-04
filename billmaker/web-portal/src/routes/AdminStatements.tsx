// /admin/statements — bulk-send customer statement emails with PDF attachments.
//
// Flow:
//   1. Admin picks a date range (quick presets + custom from/to).
//   2. UI lists every customer who has an email address, with per-customer
//      bill count and outstanding for the selected period.
//   3. Admin checks the customers they want to send to.
//   4. Optional: click "Preview PDF" on any row to see exactly what that
//      customer will receive.
//   5. Click "Send statements" — UI generates PDFs locally (pdf-lib in the
//      browser) and POSTs them in batches of 20 to /admin/statements/send.
//      Worker forwards each to Brevo as a transactional email + attachment.

import React, { useEffect, useMemo, useState } from 'react';
import {
  Mail, FileText, Loader2, AlertCircle, CheckCircle2, Calendar, Eye, Send, Search, X, Users,
} from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';
import { store, fmtINR, onStoreChange } from '../data/dummyData';
import { authedFetch } from '../lib/authClient';
import {
  generateStatementPdf,
  previewStatementPdf,
  computeTotals,
  buildFileName,
  type StatementData,
} from '../lib/statementPdf';
import {
  buildHtmlBody,
  buildTextBody,
  buildEmailSubject,
} from '../lib/statementEmail';

// ────────────────────────────────────────────────────────────
// Date range model
// ────────────────────────────────────────────────────────────
type RangePreset = 'this_month' | 'last_month' | 'this_quarter' | 'custom';

const todayLocalIso = () => new Date().toISOString().slice(0, 10);
const firstOfMonth = (year: number, monthIdx: number) => {
  const d = new Date(year, monthIdx, 1);
  return d.toISOString().slice(0, 10);
};
const lastOfMonth = (year: number, monthIdx: number) => {
  const d = new Date(year, monthIdx + 1, 0);
  return d.toISOString().slice(0, 10);
};

const computeRange = (preset: RangePreset, custom: { from: string; to: string }) => {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  if (preset === 'this_month') return { from: firstOfMonth(y, m), to: todayLocalIso() };
  if (preset === 'last_month') {
    const prevMonth = m === 0 ? 11 : m - 1;
    const prevYear = m === 0 ? y - 1 : y;
    return { from: firstOfMonth(prevYear, prevMonth), to: lastOfMonth(prevYear, prevMonth) };
  }
  if (preset === 'this_quarter') {
    const qStart = Math.floor(m / 3) * 3;
    return { from: firstOfMonth(y, qStart), to: todayLocalIso() };
  }
  return custom;
};

const formatPeriodLabel = (fromIso: string, toIso: string): string => {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  };
  return `${fmt(fromIso)} – ${fmt(toIso)}`;
};

// ────────────────────────────────────────────────────────────
// Per-customer status during a send batch
// ────────────────────────────────────────────────────────────
type SendStatus = 'idle' | 'preparing' | 'sending' | 'sent' | 'failed';

interface PerCustomer {
  status: SendStatus;
  error?: string;
}

const AdminStatements: React.FC = () => {
  const [, force] = useState(0);
  useEffect(() => onStoreChange(() => force(n => n + 1)), []);

  const [preset, setPreset] = useState<RangePreset>('this_month');
  const [customFrom, setCustomFrom] = useState<string>(() => {
    const d = new Date(); d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState<string>(todayLocalIso());

  const range = useMemo(
    () => computeRange(preset, { from: customFrom, to: customTo }),
    [preset, customFrom, customTo],
  );
  const periodLabel = useMemo(
    () => formatPeriodLabel(range.from, range.to),
    [range.from, range.to],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [perCustomer, setPerCustomer] = useState<Record<string, PerCustomer>>({});
  const [sending, setSending] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [summaryToast, setSummaryToast] = useState<string | null>(null);

  // Inclusive date range comparison — bills are ISO timestamps, range bounds
  // are YYYY-MM-DD (local). We compare just the date portion to be timezone-safe.
  const billsInRange = useMemo(() => {
    const fromKey = range.from;
    const toKey = range.to;
    return store.bills.filter(b => {
      const day = (b.createdAt || '').slice(0, 10);
      return day >= fromKey && day <= toKey;
    });
  }, [range.from, range.to, store.bills.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Customers with an email AND at least one bill (overall, not just in range —
  // those without any bill ever won't have a useful statement). Include those
  // with zero bills in range too so admin can still send them a "nil" summary
  // if they want.
  const eligible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byCustomerInRange = new Map<string, number>();
    const outstandingByCustomer = new Map<string, number>();
    for (const b of billsInRange) {
      if (!b.customerId) continue;
      byCustomerInRange.set(b.customerId, (byCustomerInRange.get(b.customerId) || 0) + 1);
      const due = Math.max(0, (Number(b.total) || 0) - (Number(b.paid) || 0));
      outstandingByCustomer.set(b.customerId, (outstandingByCustomer.get(b.customerId) || 0) + due);
    }
    const list = store.customers
      .filter(c => c.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email))
      .map(c => ({
        customer: c,
        billCount: byCustomerInRange.get(c.id) || 0,
        outstanding: outstandingByCustomer.get(c.id) || 0,
      }))
      .sort((a, b) => {
        // Sort: customers WITH bills in period first, then by outstanding desc, then by name
        if ((b.billCount > 0 ? 1 : 0) !== (a.billCount > 0 ? 1 : 0)) {
          return (b.billCount > 0 ? 1 : 0) - (a.billCount > 0 ? 1 : 0);
        }
        if (b.outstanding !== a.outstanding) return b.outstanding - a.outstanding;
        return a.customer.name.localeCompare(b.customer.name);
      });
    if (!q) return list;
    return list.filter(row =>
      row.customer.name.toLowerCase().includes(q) ||
      (row.customer.email || '').toLowerCase().includes(q),
    );
  }, [store.customers, billsInRange, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const allSelected = eligible.length > 0 && eligible.every(r => selected.has(r.customer.id));
  const toggleAll = () => {
    setSelected(prev => {
      if (allSelected) return new Set();
      return new Set(eligible.map(r => r.customer.id));
    });
  };
  const toggleOne = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Build the StatementData for one customer (used by both preview and send).
  const buildStatementData = (customerId: string): StatementData | null => {
    const customer = store.customers.find(c => c.id === customerId);
    if (!customer) return null;
    const bills = billsInRange.filter(b => b.customerId === customerId);
    return {
      customer,
      bills,
      periodLabel,
      periodFromIso: range.from,
      periodToIso: range.to,
      shopName: store.business.name || 'Baniya',
      shopAddress: store.business.address,
      shopPhone: store.business.phone,
      shopEmail: undefined, // contact email lives in shop record, not in store yet
      generatedAt: new Date(),
    };
  };

  const handlePreview = async (customerId: string) => {
    const data = buildStatementData(customerId);
    if (!data) return;
    try {
      await previewStatementPdf(data);
    } catch (err) {
      setGlobalError(`Preview failed: ${String((err as Error)?.message || err)}`);
    }
  };

  const handleSend = async () => {
    if (selected.size === 0) return;
    const confirmMsg = `Send statement emails to ${selected.size} customer${selected.size === 1 ? '' : 's'}? PDFs will be generated locally and sent via Brevo from your configured sender address.`;
    if (!window.confirm(confirmMsg)) return;

    setSending(true);
    setGlobalError(null);
    setSummaryToast(null);
    const ids = Array.from(selected);

    // Initialize per-customer status
    const init: Record<string, PerCustomer> = {};
    ids.forEach(id => { init[id] = { status: 'preparing' }; });
    setPerCustomer(init);

    const BATCH = 20; // matches the worker's MAX_BATCH
    let sentTotal = 0;
    let failedTotal = 0;

    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);

        // Build payloads (PDF generation per customer)
        const items: Array<{
          customerId: string;
          to: string;
          name: string;
          subject: string;
          html: string;
          text: string;
          pdfBase64: string;
          fileName: string;
        }> = [];
        for (const id of chunk) {
          setPerCustomer(prev => ({ ...prev, [id]: { status: 'preparing' } }));
          const data = buildStatementData(id);
          if (!data || !data.customer.email) {
            setPerCustomer(prev => ({
              ...prev,
              [id]: { status: 'failed', error: 'No email address on file' },
            }));
            failedTotal++;
            continue;
          }
          const totals = computeTotals(data.bills);
          const fileName = buildFileName(data.customer.name, periodLabel);
          const emailInput = {
            customerName: data.customer.name,
            shopName: data.shopName,
            shopPhone: data.shopPhone,
            shopEmail: data.shopEmail,
            portalUrl: window.location.origin,
            periodLabel: data.periodLabel,
            billCount: totals.billCount,
            totalBilled: totals.billed,
            totalPaid: totals.paid,
            outstanding: totals.outstanding,
            attachmentName: fileName,
          };
          try {
            const pdfBase64 = await generateStatementPdf(data);
            items.push({
              customerId: id,
              to: data.customer.email,
              name: data.customer.name,
              subject: buildEmailSubject(emailInput),
              html: buildHtmlBody(emailInput),
              text: buildTextBody(emailInput),
              pdfBase64,
              fileName,
            });
            setPerCustomer(prev => ({ ...prev, [id]: { status: 'sending' } }));
          } catch (err) {
            setPerCustomer(prev => ({
              ...prev,
              [id]: { status: 'failed', error: `PDF generation: ${String((err as Error)?.message || err)}` },
            }));
            failedTotal++;
          }
        }

        if (items.length === 0) continue;

        const r = await authedFetch('/admin/statements/send', {
          method: 'POST',
          body: JSON.stringify({
            items: items.map(it => ({
              to: it.to,
              name: it.name,
              subject: it.subject,
              html: it.html,
              text: it.text,
              pdfBase64: it.pdfBase64,
              fileName: it.fileName,
            })),
          }),
        });

        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          // Mark every item in this batch as failed
          items.forEach(it => {
            setPerCustomer(prev => ({
              ...prev,
              [it.customerId]: { status: 'failed', error: body.error || `HTTP ${r.status}` },
            }));
            failedTotal++;
          });
          continue;
        }

        const data = await r.json();
        // Map worker results back to customerIds
        const byTo = new Map<string, { ok: boolean; error?: string }>();
        for (const result of data.results || []) byTo.set(result.to, result);
        for (const it of items) {
          const result = byTo.get(it.to);
          if (result?.ok) {
            setPerCustomer(prev => ({ ...prev, [it.customerId]: { status: 'sent' } }));
            sentTotal++;
          } else {
            setPerCustomer(prev => ({
              ...prev,
              [it.customerId]: { status: 'failed', error: result?.error || 'Unknown error' },
            }));
            failedTotal++;
          }
        }
      }

      setSummaryToast(`Sent ${sentTotal} · Failed ${failedTotal}.`);
    } catch (err) {
      setGlobalError(`Send batch failed: ${String((err as Error)?.message || err)}`);
    } finally {
      setSending(false);
    }
  };

  const totalsInRange = useMemo(() => computeTotals(billsInRange), [billsInRange]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
          <Mail className="h-7 w-7 text-secondary" /> Customer Statements
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Send each customer a branded email with a detailed PDF of their bills in a chosen date range.
          PDFs are generated locally in your browser; emails go out via Brevo from{' '}
          your configured sender address.
        </p>
      </header>

      {/* Date range */}
      <Card className="mb-4">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-primary" />
            <p className="font-semibold text-sm">Statement period</p>
          </div>

          <div className="flex flex-wrap gap-2">
            {(
              [
                ['this_month', 'This month'],
                ['last_month', 'Last month'],
                ['this_quarter', 'This quarter'],
                ['custom', 'Custom range'],
              ] as Array<[RangePreset, string]>
            ).map(([p, label]) => (
              <button
                key={p}
                onClick={() => setPreset(p)}
                className={cn(
                  'text-xs font-semibold px-3 py-1.5 rounded-full border transition',
                  preset === p
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5 block">From</label>
                <Input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5 block">To</label>
                <Input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} />
              </div>
            </div>
          )}

          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 border-t">
            <span><strong className="text-foreground">{periodLabel}</strong></span>
            <span>{billsInRange.length} bill{billsInRange.length === 1 ? '' : 's'} in period</span>
            <span>Total billed: <strong className="text-foreground">{fmtINR(totalsInRange.billed)}</strong></span>
            <span>Outstanding: <strong className="text-rose-700">{fmtINR(totalsInRange.outstanding)}</strong></span>
          </div>
        </CardContent>
      </Card>

      {/* Customer list */}
      <Card className="mb-4">
        <CardContent className="p-5">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              <p className="font-semibold text-sm">
                Customers with email address
                <span className="text-muted-foreground font-normal ml-1.5">
                  ({eligible.length})
                </span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleAll}
                className="text-xs font-semibold text-primary hover:underline"
              >
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="text-xs font-semibold">
                {selected.size} selected
              </span>
            </div>
          </div>

          <div className="relative mb-3">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name or email…"
              className="pl-9 pr-9"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {eligible.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {store.customers.length === 0
                ? 'No customers yet.'
                : 'No customers with a valid email address. Add emails in Manage Customers.'}
            </div>
          ) : (
            <div className="border rounded-lg divide-y max-h-[55vh] overflow-y-auto">
              {eligible.map(({ customer, billCount, outstanding }) => {
                const isSelected = selected.has(customer.id);
                const status = perCustomer[customer.id]?.status;
                const statusError = perCustomer[customer.id]?.error;
                return (
                  <label
                    key={customer.id}
                    className={cn(
                      'flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/40 transition',
                      isSelected && 'bg-sky-50/60',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(customer.id)}
                      className="h-4 w-4 rounded border-input accent-primary"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold truncate">{customer.name}</p>
                        {billCount === 0 && (
                          <Badge variant="secondary" className="text-[10px]">No bills in period</Badge>
                        )}
                        {customer.class && (
                          <Badge variant="default" className="text-[10px]">{customer.class}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{customer.email}</p>
                      <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-3">
                        <span>{billCount} bill{billCount === 1 ? '' : 's'} in period</span>
                        {outstanding > 0 && (
                          <span className="text-rose-700 font-semibold">
                            {fmtINR(outstanding)} outstanding
                          </span>
                        )}
                      </div>
                      {statusError && (
                        <p className="text-[11px] text-rose-700 font-medium mt-0.5">
                          ✗ {statusError}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {status === 'preparing' && <Badge variant="secondary"><Loader2 className="h-3 w-3 animate-spin" /> Preparing</Badge>}
                      {status === 'sending' && <Badge variant="secondary"><Loader2 className="h-3 w-3 animate-spin" /> Sending</Badge>}
                      {status === 'sent' && <Badge variant="success"><CheckCircle2 className="h-3 w-3" /> Sent</Badge>}
                      {status === 'failed' && <Badge variant="destructive"><AlertCircle className="h-3 w-3" /> Failed</Badge>}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={e => { e.preventDefault(); void handlePreview(customer.id); }}
                        className="text-xs"
                      >
                        <Eye className="h-3.5 w-3.5" /> Preview
                      </Button>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action bar */}
      <div className="sticky bottom-4 bg-background border rounded-lg shadow-elevated p-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <FileText className="h-5 w-5 text-primary flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {selected.size === 0 ? 'No recipients selected' : `${selected.size} recipient${selected.size === 1 ? '' : 's'}`}
            </p>
            <p className="text-[11px] text-muted-foreground truncate">
              Period: {periodLabel} · PDFs generated in browser · Sent in batches of 20
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {summaryToast && (
            <span className="text-xs text-emerald-700 font-semibold inline-flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> {summaryToast}
            </span>
          )}
          {globalError && (
            <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
              <AlertCircle className="h-3.5 w-3.5" /> {globalError}
            </span>
          )}
          <Button
            onClick={handleSend}
            disabled={selected.size === 0 || sending}
          >
            {sending
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</>
              : <><Send className="h-4 w-4" /> Send statements</>}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default AdminStatements;
