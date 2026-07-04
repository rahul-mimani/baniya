// AdminReprints — queue of client-submitted bill-reprint requests.
//
// Workflow: clients tap "Request reprint" on a bill in their portal → a row
// lands here with status=pending. Admin handles the physical reprint
// outside the system, then clicks "Mark released" (or "Reject") here.
// Releasing the request unblocks the client's button so they can request
// again for that same bill if needed.

import React, { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw, Loader2, Clock, ThumbsUp, ThumbsDown, Filter, AlertCircle,
  CheckCircle2, Receipt, Inbox, MessageSquare,
} from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { Textarea } from '../components/ui/textarea';
import { authedFetch } from '../lib/authClient';
import { cn } from '../lib/utils';

type ReprintStatus = 'pending' | 'released' | 'rejected';

interface Reprint {
  id: string;
  bill_id: string;
  bill_number: string | null;
  customer_name: string | null;
  customer_id: string | null;
  user_id: string;
  status: ReprintStatus;
  note: string | null;
  admin_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

const FILTERS: { key: ReprintStatus | 'all'; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'all',      label: 'All',       icon: Filter },
  { key: 'pending',  label: 'Pending',   icon: Clock },
  { key: 'released', label: 'Released',  icon: ThumbsUp },
  { key: 'rejected', label: 'Rejected',  icon: ThumbsDown },
];

const statusBadge = (s: ReprintStatus) => {
  switch (s) {
    case 'pending':  return { variant: 'warning' as const, label: 'Pending' };
    case 'released': return { variant: 'success' as const, label: 'Released' };
    case 'rejected': return { variant: 'destructive' as const, label: 'Rejected' };
  }
};

const AdminReprints: React.FC = () => {
  const [reprints, setReprints] = useState<Reprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReprintStatus | 'all'>('pending');
  const [active, setActive] = useState<Reprint | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = filter === 'all' ? '' : `?status=${filter}`;
      const r = await authedFetch(`/admin/reprints${qs}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'load_failed');
      setReprints(body.reprints || []);
    } catch (e: any) {
      setError(e?.message || 'load_failed');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const counts = reprints.reduce<Record<string, number>>((acc, q) => {
    acc[q.status] = (acc[q.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
            <RefreshCw className="h-7 w-7 text-blue-600" /> Reprint requests
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            When a customer taps <strong>Request reprint</strong> on a bill, it lands here. Handle the
            physical reprint and mark it released — the customer can then request again if needed.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </header>

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map(s => {
          const isActive = filter === s.key;
          const count = s.key === 'all' ? reprints.length : (counts[s.key] || 0);
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
              <span className={cn(
                'ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold',
                isActive ? 'bg-white/20' : 'bg-slate-100 text-slate-500',
              )}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <Card className="mb-4 border-rose-200 bg-rose-50">
          <CardContent className="p-3 text-xs text-rose-800 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>Couldn't load — {error}</span>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden">
        {loading && reprints.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Loading…
          </div>
        ) : reprints.length === 0 ? (
          <div className="p-12 text-center">
            <Inbox className="h-12 w-12 mx-auto text-blue-200 mb-3" />
            <p className="text-lg font-semibold text-slate-800">No reprint requests</p>
            <p className="text-sm text-muted-foreground mt-1">
              When customers ask for a reprint, you'll see them here.
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
                    <th className="text-left px-4 py-3 font-bold">Bill</th>
                    <th className="text-left px-4 py-3 font-bold">Note</th>
                    <th className="text-left px-4 py-3 font-bold">Status</th>
                    <th className="text-left px-4 py-3 font-bold">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {reprints.map(r => {
                    const b = statusBadge(r.status);
                    return (
                      <tr
                        key={r.id}
                        onClick={() => setActive(r)}
                        className="border-b border-blue-50 hover:bg-blue-50/40 cursor-pointer transition"
                      >
                        <td className="px-4 py-3 font-semibold text-slate-800">{r.customer_name || '—'}</td>
                        <td className="px-4 py-3 font-mono text-blue-700">{r.bill_number || r.bill_id}</td>
                        <td className="px-4 py-3 text-xs text-slate-500 max-w-[260px] truncate">
                          {r.note || <span className="italic text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-3"><Badge variant={b.variant}>{b.label}</Badge></td>
                        <td className="px-4 py-3 text-xs text-slate-500">
                          {new Date(r.created_at).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile card list */}
            <div className="md:hidden divide-y divide-blue-50">
              {reprints.map(r => {
                const b = statusBadge(r.status);
                return (
                  <button
                    key={r.id}
                    onClick={() => setActive(r)}
                    className="w-full text-left p-4 hover:bg-blue-50/40 transition"
                  >
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <p className="font-semibold text-slate-800 text-sm">{r.customer_name || '—'}</p>
                      <Badge variant={b.variant}>{b.label}</Badge>
                    </div>
                    <p className="text-xs text-blue-700 font-mono mb-1">{r.bill_number || r.bill_id}</p>
                    <p className="text-[11px] text-slate-500">{new Date(r.created_at).toLocaleString()}</p>
                    {r.note && (
                      <p className="text-[11px] text-slate-500 mt-2 italic line-clamp-1">"{r.note}"</p>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </Card>

      <ResolveModal
        reprint={active}
        onClose={() => setActive(null)}
        onUpdated={(updated) => {
          setReprints(rs => rs.map(r => r.id === updated.id ? updated : r));
          setActive(null);
        }}
      />
    </div>
  );
};


// ===========================================================================
// Resolve modal
// ===========================================================================
interface ResolveModalProps {
  reprint: Reprint | null;
  onClose: () => void;
  onUpdated: (r: Reprint) => void;
}

const ResolveModal: React.FC<ResolveModalProps> = ({ reprint, onClose, onUpdated }) => {
  const [adminNote, setAdminNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (reprint) {
      setAdminNote(reprint.admin_note || '');
      setError(null);
    }
  }, [reprint?.id]);

  if (!reprint) return null;

  const submit = async (status: ReprintStatus) => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await authedFetch(`/admin/reprints/${reprint.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, admin_note: adminNote }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'update_failed');
      onUpdated(body.reprint);
    } catch (e: any) {
      setError(e?.message || 'update_failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!reprint} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-xl p-0 bg-white border border-blue-100 shadow-2xl shadow-blue-500/15">
        <DialogTitle className="sr-only">Resolve reprint request</DialogTitle>
        <div className="h-[2px] bg-gradient-to-r from-sky-400 via-blue-600 to-indigo-600" />

        <div className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">{reprint.customer_name || 'Customer'}</h2>
              <p className="text-xs text-slate-500">
                Submitted {new Date(reprint.created_at).toLocaleString()}
              </p>
            </div>
            <Badge variant={statusBadge(reprint.status).variant}>
              {statusBadge(reprint.status).label}
            </Badge>
          </div>

          <div className="bg-gradient-to-br from-sky-50 to-blue-50 border border-blue-100 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <Receipt className="h-4 w-4 text-blue-600" />
              <span className="font-semibold text-slate-800">
                Bill <span className="font-mono">{reprint.bill_number || reprint.bill_id}</span>
              </span>
            </div>
            {reprint.note && (
              <div className="border-t border-blue-200 pt-2">
                <p className="text-[10px] uppercase tracking-wider text-blue-700/80 font-bold mb-1">Customer note</p>
                <p className="text-sm text-slate-700 italic">"{reprint.note}"</p>
              </div>
            )}
          </div>

          {/* Admin response */}
          <div className="mt-5 space-y-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-blue-700/80 font-bold mb-1.5 block">
                Internal note (optional, visible to customer)
              </label>
              <Textarea
                value={adminNote}
                onChange={e => setAdminNote(e.target.value)}
                placeholder="e.g. Picked up by Ramesh 5 Apr"
                className="bg-white border-blue-200/70 focus-visible:ring-blue-400/40 focus:border-blue-400 resize-none"
                rows={3}
                maxLength={2000}
                disabled={submitting}
              />
            </div>

            {error && (
              <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-xs text-rose-700 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5 text-rose-500" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              {reprint.status === 'pending' ? (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => submit('rejected')}
                    disabled={submitting}
                    className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                  >
                    {submitting
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <ThumbsDown className="h-4 w-4" />}
                    Reject
                  </Button>
                  <Button
                    onClick={() => submit('released')}
                    disabled={submitting}
                    className="bg-emerald-600 hover:bg-emerald-700"
                  >
                    {submitting
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <CheckCircle2 className="h-4 w-4" />}
                    Mark released
                  </Button>
                </>
              ) : (
                <Button onClick={() => submit('pending')} disabled={submitting}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
                  Re-open as pending
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AdminReprints;
