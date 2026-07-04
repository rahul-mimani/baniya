// ClientQuotes — read-only view of the client's submitted quote requests.
//
// Shows status, admin response, and metadata. Auto-refreshes when the user
// returns from idle (via the shared cache).

import React, { useState, useMemo } from 'react';
import {
  MessageSquare, Loader2, Clock, ThumbsUp, ThumbsDown, Sparkles, RefreshCw,
  Filter, IndianRupee, Package, AlertCircle, Inbox,
} from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { InlineSkeleton } from '../components/client/Skeletons';
import { fmtINR } from '../data/dummyData';
import { useClientQuotes, type ClientQuote } from '../lib/clientData';
import { useT } from '../lib/i18n';
import { cn } from '../lib/utils';

type StatusFilter = ClientQuote['status'] | 'all';

const STATUSES: { key: StatusFilter; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'all',       label: 'All',       icon: Filter },
  { key: 'pending',   label: 'Pending',   icon: Clock },
  { key: 'accepted',  label: 'Accepted',  icon: ThumbsUp },
  { key: 'rejected',  label: 'Rejected',  icon: ThumbsDown },
  { key: 'fulfilled', label: 'Fulfilled', icon: Sparkles },
];

const statusBadge = (s: ClientQuote['status']) => {
  switch (s) {
    case 'pending':   return { variant: 'warning' as const, label: 'Pending', tone: 'amber' };
    case 'accepted':  return { variant: 'success' as const, label: 'Accepted', tone: 'emerald' };
    case 'rejected':  return { variant: 'destructive' as const, label: 'Declined', tone: 'rose' };
    case 'fulfilled': return { variant: 'secondary' as const, label: 'Fulfilled', tone: 'blue' };
  }
};

const ClientQuotes: React.FC = () => {
  const { quotes, loading, error, refetch } = useClientQuotes();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const { t } = useT();

  const filtered = useMemo(() => {
    if (filter === 'all') return quotes;
    return quotes.filter(q => q.status === filter);
  }, [quotes, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const q of quotes) c[q.status] = (c[q.status] || 0) + 1;
    return c;
  }, [quotes]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
            <MessageSquare className="h-7 w-7 text-blue-600" /> {t('quotes.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track the quote requests you've sent and their responses.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </header>

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2 mb-4">
        {STATUSES.map(s => {
          const isActive = filter === s.key;
          const count = s.key === 'all' ? quotes.length : (counts[s.key] || 0);
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
                  'ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold inline-flex items-center',
                  isActive ? 'bg-white/20' : 'bg-slate-100 text-slate-500',
                )}>
                  {loading && quotes.length === 0
                    ? <InlineSkeleton width="1.2em" />
                    : count}
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
            <span>Couldn't load — {error}</span>
          </CardContent>
        </Card>
      )}

      {/* List */}
      {loading && quotes.length === 0 ? (
        <Card className="p-12 text-center text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Loading…
        </Card>
      ) : quotes.length === 0 ? (
        <Card className="p-12 text-center">
          <Inbox className="h-12 w-12 mx-auto text-blue-200 mb-3" />
          <p className="text-lg font-semibold text-slate-800">No quotes yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
            Open a product and tap <strong>"Request a quote"</strong> to ask for a price.
          </p>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No {filter} quotes.
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map(q => <QuoteCard key={q.id} q={q} />)}
        </div>
      )}
    </div>
  );
};


// ---------------------------------------------------------------------------
// One quote card
// ---------------------------------------------------------------------------
const QuoteCard: React.FC<{ q: ClientQuote }> = ({ q }) => {
  const b = statusBadge(q.status);
  return (
    <Card className="overflow-hidden">
      <div className={cn('h-1 bg-gradient-to-r',
        b.tone === 'amber'   ? 'from-amber-300 to-amber-500' :
        b.tone === 'emerald' ? 'from-emerald-300 to-emerald-500' :
        b.tone === 'rose'    ? 'from-rose-300 to-rose-500' :
                               'from-sky-300 to-blue-500',
      )} />
      <CardContent className="p-4 sm:p-5">
        {/* Header row */}
        <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Package className="h-4 w-4 text-blue-600 flex-shrink-0" />
              <p className="font-semibold text-slate-900 truncate">{q.product_name || q.product_id}</p>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Sent {new Date(q.created_at).toLocaleString()}
            </p>
          </div>
          <Badge variant={b.variant}>{b.label}</Badge>
        </div>

        {/* Request details */}
        <div className="bg-gradient-to-br from-sky-50 to-blue-50 border border-blue-100 rounded-lg p-3 grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-blue-700/80 font-bold mb-0.5">Quantity</p>
            <p className="font-mono font-bold text-slate-900">{q.quantity}{q.product_unit ? ` ${q.product_unit}` : ''}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-blue-700/80 font-bold mb-0.5">Your offer</p>
            <p className="font-mono font-bold text-slate-900">
              {q.proposed_price !== null
                ? <span className="inline-flex items-center"><IndianRupee className="h-3 w-3" />{fmtINR(q.proposed_price).replace('₹', '').trim()}</span>
                : <span className="text-slate-400 italic">No offer</span>}
            </p>
          </div>
          {q.note && (
            <div className="col-span-2 border-t border-blue-200 pt-2">
              <p className="text-[10px] uppercase tracking-wider text-blue-700/80 font-bold mb-1">Your note</p>
              <p className="text-xs text-slate-700 italic">"{q.note}"</p>
            </div>
          )}
        </div>

        {/* Admin response */}
        {q.admin_response ? (
          <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <MessageSquare className="h-3.5 w-3.5 text-emerald-700" />
              <p className="text-[10px] uppercase tracking-wider text-emerald-700 font-bold">Shop's reply</p>
              {q.responded_at && (
                <span className="text-[10px] text-emerald-700/70">
                  {new Date(q.responded_at).toLocaleDateString()}
                </span>
              )}
            </div>
            <p className="text-sm text-emerald-900 whitespace-pre-line leading-relaxed">{q.admin_response}</p>
          </div>
        ) : q.status === 'pending' ? (
          <p className="text-[11px] text-muted-foreground italic mt-3 flex items-center gap-1.5">
            <Clock className="h-3 w-3" /> Waiting for your shop to respond…
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
};

export default ClientQuotes;
