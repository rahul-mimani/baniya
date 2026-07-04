// AdminQuotes — admin's inbox of client-submitted quote requests.
//
// Layout:
//   - Header with status filter chips (All / Pending / Accepted / Rejected / Fulfilled)
//   - Table of quotes (customer, product, qty, proposed price, status, note preview, date)
//   - Click a row → opens a response modal where admin can write a reply +
//     change status
//
// Data flow:
//   GET   /admin/quotes?status=...      — load list
//   PATCH /admin/quotes/:id             — submit response/status changes

import React, { useEffect, useState, useCallback } from 'react';
import {
  MessageSquare, Filter, RefreshCw, Loader2, Send, AlertCircle, CheckCircle2,
  Clock, ThumbsUp, ThumbsDown, Sparkles, Phone, Package, IndianRupee,
} from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { Textarea } from '../components/ui/textarea';
import { authedFetch } from '../lib/authClient';
import { fmtINR } from '../data/dummyData';
import { cn } from '../lib/utils';

type QuoteStatus = 'pending' | 'accepted' | 'rejected' | 'fulfilled';

interface Quote {
  id: string;
  shop_code: string;
  user_id: string;
  customer_id: string | null;
  customer_name: string | null;
  product_id: string;
  product_name: string | null;
  product_unit: string | null;
  quantity: number;
  proposed_price: number | null;
  note: string | null;
  status: QuoteStatus;
  admin_response: string | null;
  created_at: string;
  responded_at: string | null;
}

const STATUSES: { key: QuoteStatus | 'all'; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'all',       label: 'All',       icon: Filter },
  { key: 'pending',   label: 'Pending',   icon: Clock },
  { key: 'accepted',  label: 'Accepted',  icon: ThumbsUp },
  { key: 'rejected',  label: 'Rejected',  icon: ThumbsDown },
  { key: 'fulfilled', label: 'Fulfilled', icon: Sparkles },
];

const statusBadge = (s: QuoteStatus): { variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive'; label: string } => {
  switch (s) {
    case 'pending':   return { variant: 'warning', label: 'Pending' };
    case 'accepted':  return { variant: 'success', label: 'Accepted' };
    case 'rejected':  return { variant: 'destructive', label: 'Rejected' };
    case 'fulfilled': return { variant: 'secondary', label: 'Fulfilled' };
  }
};

const AdminQuotes: React.FC = () => {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<QuoteStatus | 'all'>('all');
  const [active, setActive] = useState<Quote | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = filter === 'all' ? '' : `?status=${filter}`;
      const r = await authedFetch(`/admin/quotes${qs}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'load_failed');
      setQuotes(body.quotes || []);
    } catch (e: any) {
      setError(e?.message || 'load_failed');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const counts = quotes.reduce<Record<string, number>>((acc, q) => {
    acc[q.status] = (acc[q.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
            <MessageSquare className="h-7 w-7 text-blue-600" /> Quote requests
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Client-submitted price requests from your product catalog. Respond directly here.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </header>

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2 mb-4">
        {STATUSES.map(s => {
          const isActive = filter === s.key;
          const total = s.key === 'all' ? quotes.length : (counts[s.key] || 0);
          return (
            <button
              key={s.key}
              onClick={() => setFilter(s.key)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition border',
                isActive
                  ? 'bg-blue-600 text-white border-blue-700 shadow-md shadow-blue-200'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-blue-50 hover:border-blue-300',
              )}
            >
              <s.icon className="h-3 w-3" />
              {s.label}
              {filter === 'all' && (
                <span className={cn(
                  'ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold',
                  isActive ? 'bg-white/20' : 'bg-slate-100 text-slate-500',
                )}>
                  {total}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <Card className="mb-4 border-rose-200 bg-rose-50">
          <CardContent className="p-3 text-xs text-rose-800 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>Couldn't load quotes — {error}</span>
          </CardContent>
        </Card>
      )}

      {/* Quotes table — switches to card-list on mobile */}
      <Card className="overflow-hidden">
        {loading && quotes.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Loading…
          </div>
        ) : quotes.length === 0 ? (
          <div className="p-12 text-center">
            <MessageSquare className="h-10 w-10 mx-auto text-blue-200 mb-2" />
            <p className="text-sm font-semibold text-slate-700">No quotes yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Client requests will appear here once submitted.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-gradient-to-r from-sky-50 to-blue-50 border-b border-blue-100">
                  <tr className="text-[10px] uppercase tracking-wider text-blue-700/80">
                    <th className="text-left px-4 py-3 font-bold">Customer</th>
                    <th className="text-left px-4 py-3 font-bold">Product</th>
                    <th className="text-right px-4 py-3 font-bold">Qty</th>
                    <th className="text-right px-4 py-3 font-bold">Proposed</th>
                    <th className="text-left px-4 py-3 font-bold">Note</th>
                    <th className="text-left px-4 py-3 font-bold">Status</th>
                    <th className="text-left px-4 py-3 font-bold">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {quotes.map(q => {
                    const b = statusBadge(q.status);
                    return (
                      <tr
                        key={q.id}
                        onClick={() => setActive(q)}
                        className="border-b border-blue-50 hover:bg-blue-50/40 cursor-pointer transition"
                      >
                        <td className="px-4 py-3 font-semibold text-slate-800">{q.customer_name || '—'}</td>
                        <td className="px-4 py-3 text-slate-700">{q.product_name || q.product_id}</td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700">{q.quantity}</td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700">
                          {q.proposed_price !== null ? fmtINR(q.proposed_price) : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500 max-w-[220px] truncate">
                          {q.note || <span className="italic text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-3"><Badge variant={b.variant}>{b.label}</Badge></td>
                        <td className="px-4 py-3 text-xs text-slate-500">
                          {new Date(q.created_at).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile card list */}
            <div className="md:hidden divide-y divide-blue-50">
              {quotes.map(q => {
                const b = statusBadge(q.status);
                return (
                  <button
                    key={q.id}
                    onClick={() => setActive(q)}
                    className="w-full text-left p-4 hover:bg-blue-50/40 transition"
                  >
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <p className="font-semibold text-slate-800 text-sm">{q.customer_name || '—'}</p>
                      <Badge variant={b.variant}>{b.label}</Badge>
                    </div>
                    <p className="text-xs text-slate-600 mb-1.5">{q.product_name || q.product_id}</p>
                    <div className="flex items-center gap-3 text-[11px] text-slate-500">
                      <span className="font-mono"><strong className="text-slate-700">{q.quantity}</strong> units</span>
                      {q.proposed_price !== null && (
                        <span className="font-mono"><strong className="text-slate-700">{fmtINR(q.proposed_price)}</strong></span>
                      )}
                      <span className="ml-auto">{new Date(q.created_at).toLocaleDateString()}</span>
                    </div>
                    {q.note && (
                      <p className="text-[11px] text-slate-500 mt-2 italic line-clamp-1">"{q.note}"</p>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </Card>

      <ResponseModal
        quote={active}
        onClose={() => setActive(null)}
        onUpdated={(updated) => {
          setQuotes(qs => qs.map(q => q.id === updated.id ? updated : q));
          setActive(null);
        }}
      />
    </div>
  );
};


// ===========================================================================
// Response modal
// ===========================================================================
interface ResponseModalProps {
  quote: Quote | null;
  onClose: () => void;
  onUpdated: (q: Quote) => void;
}

const ResponseModal: React.FC<ResponseModalProps> = ({ quote, onClose, onUpdated }) => {
  const [response, setResponse] = useState('');
  const [status, setStatus] = useState<QuoteStatus>('pending');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (quote) {
      setResponse(quote.admin_response || '');
      setStatus(quote.status);
      setError(null);
    }
  }, [quote?.id]);

  if (!quote) return null;

  const submit = async (newStatus?: QuoteStatus) => {
    setSubmitting(true);
    setError(null);
    const targetStatus = newStatus || status;
    try {
      const r = await authedFetch(`/admin/quotes/${quote.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: targetStatus,
          admin_response: response,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'update_failed');
      onUpdated(body.quote);
    } catch (e: any) {
      setError(e?.message || 'update_failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!quote} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden bg-white border border-blue-100 shadow-2xl shadow-blue-500/15">
        <DialogTitle className="sr-only">Respond to quote from {quote.customer_name}</DialogTitle>

        <div className="h-[2px] bg-gradient-to-r from-sky-400 via-blue-600 to-indigo-600" />

        <div className="p-5 sm:p-6">
          {/* Quote summary */}
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold text-slate-900">{quote.customer_name || 'Customer'}</h2>
                <p className="text-xs text-slate-500">
                  Submitted {new Date(quote.created_at).toLocaleString()}
                </p>
              </div>
              <Badge variant={statusBadge(quote.status).variant}>{statusBadge(quote.status).label}</Badge>
            </div>

            <div className="bg-gradient-to-br from-sky-50 to-blue-50 border border-blue-100 rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Package className="h-4 w-4 text-blue-600" />
                <span className="font-semibold text-slate-800">{quote.product_name || quote.product_id}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-blue-700/80 font-bold mb-0.5">Quantity</p>
                  <p className="font-mono font-bold text-slate-900">{quote.quantity}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-blue-700/80 font-bold mb-0.5">Proposed price</p>
                  <p className="font-mono font-bold text-slate-900">
                    {quote.proposed_price !== null
                      ? <><IndianRupee className="h-3 w-3 inline" /> {fmtINR(quote.proposed_price).replace('₹', '').trim()}</>
                      : <span className="text-slate-400 italic">— not specified —</span>}
                  </p>
                </div>
              </div>
              {quote.note && (
                <div className="border-t border-blue-200 pt-2">
                  <p className="text-[10px] uppercase tracking-wider text-blue-700/80 font-bold mb-1">Client note</p>
                  <p className="text-sm text-slate-700 italic">"{quote.note}"</p>
                </div>
              )}
            </div>
          </div>

          {/* Response form */}
          <div className="mt-5 space-y-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-blue-700/80 font-bold mb-1.5 block">
                Your response (optional)
              </label>
              <Textarea
                value={response}
                onChange={e => setResponse(e.target.value)}
                placeholder={`Confirm the price, propose alternatives, or share availability…`}
                className="bg-white border-blue-200/70 focus-visible:ring-blue-400/40 focus:border-blue-400 resize-none"
                rows={4}
                maxLength={4000}
                disabled={submitting}
              />
              <p className="text-[10px] text-slate-400 mt-1">
                The client will see this when they next open their portal.
              </p>
            </div>

            <div>
              <label className="text-[10px] uppercase tracking-wider text-blue-700/80 font-bold mb-1.5 block">
                Set status
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(['pending', 'accepted', 'rejected', 'fulfilled'] as QuoteStatus[]).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s)}
                    disabled={submitting}
                    className={cn(
                      'px-3 py-2 rounded-md text-xs font-semibold capitalize border transition',
                      status === s
                        ? 'bg-blue-600 text-white border-blue-700 shadow-md shadow-blue-200'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-blue-50',
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-xs text-rose-700 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5 text-rose-500" />
                <span>Couldn't save — {error}</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={() => submit()} disabled={submitting}>
                {submitting
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
                  : <><Send className="h-4 w-4" /> Save response</>}
              </Button>
            </div>
          </div>

          {quote.responded_at && (
            <p className="text-[10px] text-slate-400 mt-4 text-center">
              <CheckCircle2 className="h-3 w-3 inline" /> Last updated {new Date(quote.responded_at).toLocaleString()}
            </p>
          )}
          {quote.customer_id && (
            <p className="text-[10px] text-slate-400 mt-1 text-center inline-flex items-center gap-1 justify-center w-full">
              <Phone className="h-3 w-3" /> Customer ID: <span className="font-mono">{quote.customer_id}</span>
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AdminQuotes;
