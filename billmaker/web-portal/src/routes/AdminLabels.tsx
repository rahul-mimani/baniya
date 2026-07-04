import React, { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Tag, Check, Users } from 'lucide-react';
import {
  store,
  addLabel,
  updateLabel,
  deleteLabel,
  onStoreChange,
  labelColorClasses,
  updateClassDef,
  classDisplayName,
  classBadgeClasses,
  addNextClassDef,
  removeClassDef,
  MAX_CLASSES,
} from '../data/dummyData';
import { Label as LabelEntity, LabelColor, ClassDef, CustomerClass } from '../types';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
} from '../components/ui/dialog';

const ALL_COLORS: LabelColor[] = ['sky', 'indigo', 'emerald', 'amber', 'rose', 'violet', 'slate', 'cyan'];

type LabelModalState = { kind: 'label'; mode: 'add' | 'edit'; label?: LabelEntity };
type ClassModalState = { kind: 'class'; classDef: ClassDef };
type ModalState = LabelModalState | ClassModalState | null;

const AdminLabels: React.FC = () => {
  const [, force] = useState(0);
  useEffect(() => onStoreChange(() => force(n => n + 1)), []);

  const [modal, setModal] = useState<ModalState>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<LabelColor>('sky');

  useEffect(() => {
    if (!modal) return;
    if (modal.kind === 'label') {
      if (modal.mode === 'edit' && modal.label) {
        setName(modal.label.name);
        setColor(modal.label.color);
      } else {
        setName('');
        setColor('sky');
      }
    } else if (modal.kind === 'class') {
      setName(modal.classDef.name);
      setColor(modal.classDef.color);
    }
  }, [modal]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (modal?.kind === 'label') {
      if (modal.mode === 'edit' && modal.label) {
        updateLabel(modal.label.id, { name, color });
      } else {
        addLabel(name, color);
      }
    } else if (modal?.kind === 'class') {
      updateClassDef(modal.classDef.code, { name: name.trim(), color });
    }
    setModal(null);
  };

  const handleAddClass = () => {
    const added = addNextClassDef();
    if (!added) return;
    // Open the edit modal for the new class so admin can pick name + color immediately.
    const def = store.classDefs.find(d => d.code === added);
    if (def) setModal({ kind: 'class', classDef: def });
  };

  const handleRemoveClass = (code: CustomerClass) => {
    const def = store.classDefs.find(d => d.code === code);
    if (!def) return;
    if (!window.confirm(`Remove Class ${code} (${def.name})? Won't be allowed if any customer, product, or deal still uses it.`)) return;
    const res = removeClassDef(code);
    if (!res.ok) window.alert(res.reason || 'Could not remove class.');
  };

  const handleDelete = (l: LabelEntity) => {
    const productCount = store.products.filter(p => p.labelIds.includes(l.id)).length;
    const ok = window.confirm(
      productCount > 0
        ? `Delete label "${l.name}"? It's currently applied to ${productCount} product${productCount === 1 ? '' : 's'}. The label will be removed from those products.`
        : `Delete label "${l.name}"?`,
    );
    if (!ok) return;
    deleteLabel(l.id);
  };

  const modalTitle =
    modal?.kind === 'class'
      ? `Edit class ${modal.classDef.code}`
      : modal?.kind === 'label' && modal.mode === 'edit'
        ? 'Edit label'
        : 'Add label';

  const modalDescription =
    modal?.kind === 'class'
      ? `Customise how Class ${modal.classDef.code} is displayed everywhere — name and accent color.`
      : 'Pick a short, recognizable name and color.';

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
            <Tag className="h-7 w-7 text-secondary" /> Labels & Classes
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Two kinds of categorisation. <strong>Labels</strong> tag products (OTC, Antibiotic, …) so clients
            can filter them. <strong>Customer classes</strong> (A / B / C) set the pricing tier and visibility
            — you can rename and recolour them here.
          </p>
        </div>
        <Button onClick={() => setModal({ kind: 'label', mode: 'add' })}>
          <Plus className="h-4 w-4" /> Add label
        </Button>
      </header>

      {/* Customer Classes */}
      <Card className="mb-6">
        <div className="px-5 py-4 border-b bg-slate-50 rounded-t-xl flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-sky-500 flex items-center justify-center text-white">
            <Users className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="font-bold">Customer classes <span className="text-xs font-medium text-muted-foreground">· {store.classDefs.length}/{MAX_CLASSES}</span></p>
            <p className="text-xs text-muted-foreground">
              Up to {MAX_CLASSES} pricing tiers. A/B/C are core (can't be removed); D and E are optional. Colors here drive
              the badge color everywhere a class is shown.
            </p>
          </div>
          {store.classDefs.length < MAX_CLASSES && (
            <Button variant="outline" size="sm" onClick={handleAddClass}>
              <Plus className="h-3.5 w-3.5" /> Add class
            </Button>
          )}
        </div>
        <CardContent className="p-0">
          <div className="divide-y">
            {store.classDefs.map(def => {
              const customerCount = store.customers.filter(c => c.class === def.code).length;
              const productUse = store.products.filter(p => p.enabledClasses[def.code]).length;
              const dealUse = store.deals.filter(d => d.visibleClasses.includes(def.code)).length;
              const isCore = def.code === 'A' || def.code === 'B' || def.code === 'C';
              return (
                <div key={def.code} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition">
                  <span className={`text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full border ${classBadgeClasses(def.code)}`}>
                    Class {def.code} · {def.name}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground">
                      Used by {customerCount} customer{customerCount === 1 ? '' : 's'}
                      {productUse > 0 && ` · ${productUse} product${productUse === 1 ? '' : 's'}`}
                      {dealUse > 0 && ` · ${dealUse} deal${dealUse === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setModal({ kind: 'class', classDef: def })}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  {!isCore && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveClass(def.code)}
                      className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                      title={`Remove Class ${def.code}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Product Labels */}
      <Card>
        <div className="px-5 py-4 border-b bg-slate-50 rounded-t-xl flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-rose-500 flex items-center justify-center text-white">
            <Tag className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="font-bold">Product labels</p>
            <p className="text-xs text-muted-foreground">
              Reusable tags applied to products. Clients see these on the product card and can filter by them.
            </p>
          </div>
        </div>
        <CardContent className="p-0">
          {store.labels.length === 0 ? (
            <div className="p-12 text-center">
              <Tag className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
              <p className="text-lg font-semibold mb-1">No labels yet</p>
              <p className="text-sm text-muted-foreground mb-4">Labels help organize and filter your product catalog.</p>
              <Button onClick={() => setModal({ kind: 'label', mode: 'add' })}>
                <Plus className="h-4 w-4" /> Add first label
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {store.labels.map(l => {
                const productCount = store.products.filter(p => p.labelIds.includes(l.id)).length;
                return (
                  <div key={l.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition">
                    <span className={`text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full border ${labelColorClasses[l.color]}`}>
                      {l.name}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-muted-foreground">
                        Used on {productCount} product{productCount === 1 ? '' : 's'}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setModal({ kind: 'label', mode: 'edit', label: l })}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(l)} className="text-rose-600 hover:bg-rose-50 hover:text-rose-700">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!modal} onOpenChange={o => { if (!o) setModal(null); }}>
        <DialogContent>
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{modalTitle}</DialogTitle>
              <DialogDescription>{modalDescription}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider mb-1.5 block">
                  {modal?.kind === 'class' ? 'Display name' : 'Name'}
                </label>
                <Input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={modal?.kind === 'class' ? 'e.g. Top Partner, Regular' : 'e.g. OTC, Antibiotic'}
                  required
                  autoFocus
                />
                {modal?.kind === 'class' && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Shown as "Class {modal.classDef.code} — {name || '…'}" wherever a customer's class appears.
                  </p>
                )}
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider mb-1.5 block">Color</label>
                <div className="grid grid-cols-4 gap-2">
                  {ALL_COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      className={`relative h-10 rounded-md border-2 transition ${labelColorClasses[c]} ${
                        color === c ? 'ring-2 ring-foreground ring-offset-2' : ''
                      }`}
                    >
                      {color === c && <Check className="h-4 w-4 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />}
                    </button>
                  ))}
                </div>
              </div>
              <div className="bg-muted/40 rounded-lg p-3">
                <p className="text-xs text-muted-foreground mb-2">Preview</p>
                <span className={`inline-block text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full border ${labelColorClasses[color]}`}>
                  {modal?.kind === 'class'
                    ? `Class ${modal.classDef.code} · ${name || classDisplayName(modal.classDef.code as CustomerClass)}`
                    : name || 'Label name'}
                </span>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setModal(null)}>Cancel</Button>
              <Button type="submit" disabled={!name.trim()}>
                {modal?.kind === 'class' ? 'Save class' : modal?.mode === 'edit' ? 'Save' : 'Add label'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminLabels;
