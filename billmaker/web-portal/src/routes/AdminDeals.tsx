import React, { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Clock, Sparkles, Package } from 'lucide-react';
import { store, deleteDeal, onStoreChange, getActiveClassCodes, classBadgeClasses } from '../data/dummyData';
import { Deal } from '../types';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import DealModal from '../components/modals/DealModal';

const gradients: Record<string, string> = {
  sky: 'from-sky-500 via-sky-600 to-sky-700',
  amber: 'from-amber-500 via-orange-500 to-amber-700',
  rose: 'from-rose-500 via-pink-600 to-rose-700',
  indigo: 'from-indigo-500 via-violet-500 to-purple-700',
};

const AdminDeals: React.FC = () => {
  const [, force] = useState(0);
  useEffect(() => onStoreChange(() => force(n => n + 1)), []);
  const [modal, setModal] = useState<{ mode: 'add' | 'edit'; deal?: Deal } | null>(null);

  const handleDelete = (dealId: string, title: string) => {
    if (!window.confirm(`Delete deal "${title}"?`)) return;
    deleteDeal(dealId);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
            <Sparkles className="h-7 w-7 text-accent" /> Deals
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Promotions you want to publish to clients. Choose which classes can see each deal.
          </p>
        </div>
        <Button variant="gradient" onClick={() => setModal({ mode: 'add' })}>
          <Plus className="h-4 w-4" /> Create deal
        </Button>
      </header>

      {store.deals.length === 0 ? (
        <Card className="p-12 text-center">
          <Sparkles className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold mb-1">No deals yet</p>
          <p className="text-sm text-muted-foreground mb-4">Create your first promotion to attract clients.</p>
          <Button variant="gradient" onClick={() => setModal({ mode: 'add' })}>
            <Plus className="h-4 w-4" /> Create first deal
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
          {store.deals.map(d => {
            const gradient = gradients[d.bannerColor || 'sky'];
            const validUntil = new Date(d.validUntil);
            const daysLeft = Math.ceil((validUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            return (
              <Card key={d.id} className="overflow-hidden hover:shadow-xl transition group">
                <div className={`relative bg-gradient-to-br ${gradient} text-white px-5 sm:px-6 py-5 overflow-hidden`}>
                  <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -translate-y-16 translate-x-16 blur-2xl" />
                  <div className="relative flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Badge className="bg-white/25 text-white border-white/40 backdrop-blur mb-2">
                        {d.discountPct}% OFF
                      </Badge>
                      <p className="text-lg sm:text-xl font-bold truncate">{d.title}</p>
                    </div>
                    <div className="text-right text-xs flex-shrink-0">
                      <p className="opacity-80 flex items-center gap-1 justify-end">
                        <Clock className="h-3 w-3" /> {daysLeft > 0 ? `${daysLeft}d left` : 'Expired'}
                      </p>
                      <p className="font-bold mt-0.5">{validUntil.toLocaleDateString()}</p>
                    </div>
                  </div>
                </div>
                <div className="px-5 sm:px-6 py-4">
                  <p className="text-sm">{d.description}</p>

                  {d.items.length > 0 && (
                    <div className="mt-3 pt-3 border-t">
                      <p className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground mb-1.5 flex items-center gap-1">
                        <Package className="h-3 w-3" /> {d.items.length} product{d.items.length === 1 ? '' : 's'}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {d.items.slice(0, 5).map(it => {
                          const p = store.products.find(p => p.id === it.productId);
                          if (!p) return null;
                          const overrides = Object.keys(it.prices).length;
                          return (
                            <span
                              key={it.productId}
                              title={overrides > 0 ? `${overrides} custom price${overrides === 1 ? '' : 's'}` : 'Uses whole-deal discount'}
                              className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-muted text-foreground border"
                            >
                              {p.name}
                              {overrides > 0 && <span className="ml-1 text-primary">·{overrides}</span>}
                            </span>
                          );
                        })}
                        {d.items.length > 5 && (
                          <span className="text-[10px] text-muted-foreground px-2 py-0.5">
                            +{d.items.length - 5} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-3 pt-3 border-t gap-2 flex-wrap">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs text-muted-foreground">For:</span>
                      {getActiveClassCodes().map(cls => {
                        const on = d.visibleClasses.includes(cls);
                        return (
                          <span
                            key={cls}
                            className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                              on
                                ? classBadgeClasses(cls)
                                : 'bg-background text-muted-foreground/40 border-border line-through'
                            }`}
                          >
                            {cls}
                          </span>
                        );
                      })}
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setModal({ mode: 'edit', deal: d })}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(d.id, d.title)} className="text-rose-600 hover:bg-rose-50 hover:text-rose-700">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <DealModal mode={modal?.mode || 'add'} deal={modal?.deal} open={!!modal} onClose={() => setModal(null)} />
    </div>
  );
};

export default AdminDeals;
