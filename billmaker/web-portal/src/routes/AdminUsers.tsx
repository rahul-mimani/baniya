import React, { useEffect, useState } from 'react';
import { Users, Plus, Pencil, Trash2, Mail, Loader2, AlertCircle, ShieldCheck, Power } from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
} from '../components/ui/dialog';
import { authedFetch } from '../lib/authClient';
import { store, classBadgeClasses } from '../data/dummyData';
import { CustomerClass } from '../types';

interface AuthUser {
  id: string;
  identifier: string;
  identifier_type: string;
  name: string;
  role: 'client' | 'admin';
  customer_id: string | null;
  class: string | null;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
}

const friendlyAdminError = (code: string): string => {
  switch (code) {
    case 'email_already_used': return 'This email is already registered.';
    case 'invalid_email': return 'Please enter a valid email address.';
    case 'name_required': return 'Display name is required.';
    case 'forbidden': return 'You do not have permission for this.';
    case 'not_found': return 'User not found.';
    case 'self_delete_forbidden': return "You can't delete your own admin account.";
    case 'self_deactivate_forbidden': return "You can't deactivate your own admin account.";
    case 'cannot_delete_admin': return "Admin accounts can't be deleted from here.";
    default: return 'Something went wrong. Please try again.';
  }
};

const AdminUsers: React.FC = () => {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: 'add' | 'edit'; user?: AuthUser } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const loadUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authedFetch('/admin/users');
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'load_failed');
      setUsers(body.users || []);
    } catch (e) {
      setError(friendlyAdminError((e as Error).message));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadUsers(); }, []);

  const handleDelete = async (u: AuthUser) => {
    if (!window.confirm(`Remove portal access for ${u.identifier}?\n\nThe customer's bills + history are NOT affected — they just lose login access until you add their email back.`)) return;
    try {
      const r = await authedFetch(`/admin/users/${u.id}`, { method: 'DELETE' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error);
      }
      showToast(`Removed login for ${u.identifier}.`);
      await loadUsers();
    } catch (e) {
      window.alert(friendlyAdminError((e as Error).message));
    }
  };

  const handleToggleActive = async (u: AuthUser) => {
    try {
      const r = await authedFetch(`/admin/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !u.active }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error);
      }
      showToast(u.active ? `Suspended ${u.identifier}.` : `Reactivated ${u.identifier}.`);
      await loadUsers();
    } catch (e) {
      window.alert(friendlyAdminError((e as Error).message));
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
            <Users className="h-7 w-7 text-secondary" /> Client logins
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Email-OTP portal access for your customers. Add a customer's email and link it to one of your portal customers — they'll sign in with a one-time code.
          </p>
        </div>
        <Button onClick={() => setModal({ mode: 'add' })}>
          <Plus className="h-4 w-4" /> Add login
        </Button>
      </header>

      {loading ? (
        <Card className="p-12 text-center">
          <Loader2 className="h-8 w-8 mx-auto animate-spin text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Card>
      ) : error ? (
        <Card className="border-rose-200 bg-rose-50">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-rose-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-rose-900">Couldn't load logins</p>
              <p className="text-xs text-rose-800 mt-0.5">{error}</p>
              <Button variant="outline" size="sm" onClick={loadUsers} className="mt-2">Retry</Button>
            </div>
          </CardContent>
        </Card>
      ) : users.length === 0 ? (
        <Card className="p-12 text-center">
          <Mail className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
          <p className="font-semibold mb-1">No client logins yet</p>
          <p className="text-sm text-muted-foreground mb-4">Add the first customer's email to grant them portal access.</p>
          <Button onClick={() => setModal({ mode: 'add' })}>
            <Plus className="h-4 w-4" /> Add first login
          </Button>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 border-b">
                <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  <th className="px-4 py-3 font-bold">Name / Email</th>
                  <th className="px-3 py-3 font-bold">Role</th>
                  <th className="px-3 py-3 font-bold">Linked customer</th>
                  <th className="px-3 py-3 font-bold">Class</th>
                  <th className="px-3 py-3 font-bold">Last login</th>
                  <th className="px-3 py-3 font-bold text-center">Status</th>
                  <th className="px-4 py-3 font-bold w-24"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map(u => {
                  const linkedCustomer = u.customer_id
                    ? store.customers.find(c => c.id === u.customer_id)
                    : null;
                  return (
                    <tr key={u.id} className={u.active ? '' : 'opacity-50'}>
                      <td className="px-4 py-3">
                        <p className="font-semibold">{u.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{u.identifier}</p>
                      </td>
                      <td className="px-3 py-3">
                        {u.role === 'admin' ? (
                          <Badge variant="default" className="gap-1">
                            <ShieldCheck className="h-3 w-3" /> Admin
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Client</Badge>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        {linkedCustomer ? (
                          linkedCustomer.name
                        ) : u.role === 'admin' ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="text-amber-700 italic">unlinked</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {/* Class is derived from the linked customer (single source of truth). */}
                        {linkedCustomer?.class ? (
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${classBadgeClasses(linkedCustomer.class as CustomerClass)}`}>
                            {linkedCustomer.class}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs text-muted-foreground">
                        {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : 'never'}
                      </td>
                      <td className="px-3 py-3 text-center">
                        {u.active ? (
                          <Badge variant="success">Active</Badge>
                        ) : (
                          <Badge variant="warning">Suspended</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <Button variant="ghost" size="sm" onClick={() => setModal({ mode: 'edit', user: u })}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {u.role !== 'admin' && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleToggleActive(u)}
                              title={u.active ? 'Suspend access' : 'Re-enable access'}
                              className={u.active ? 'text-amber-600 hover:bg-amber-50' : 'text-emerald-600 hover:bg-emerald-50'}
                            >
                              <Power className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(u)}
                              className="text-rose-600 hover:bg-rose-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {modal && <UserModal mode={modal.mode} user={modal.user} onClose={() => setModal(null)} onSaved={() => { loadUsers(); showToast(modal.mode === 'add' ? 'Login added.' : 'Login updated.'); }} />}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white text-sm font-semibold px-4 py-3 rounded-lg shadow-xl">
          ✓ {toast}
        </div>
      )}
    </div>
  );
};

interface ModalProps {
  mode: 'add' | 'edit';
  user?: AuthUser;
  onClose: () => void;
  onSaved: () => void;
}

const UserModal: React.FC<ModalProps> = ({ mode, user, onClose, onSaved }) => {
  const [email, setEmail] = useState(user?.identifier || '');
  const [name, setName] = useState(user?.name || '');
  const [customerId, setCustomerId] = useState(user?.customer_id || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The class is owned by the linked customer record (see Admin → Customers).
  // We display it here as read-only confirmation; the server-side resolver in
  // /client/products + /client/deals reads it from portal_customer.data.class.
  const linkedCustomer = customerId
    ? store.customers.find(x => x.id === customerId)
    : null;

  const handleCustomerChange = (id: string) => {
    setCustomerId(id);
    if (id) {
      const c = store.customers.find(x => x.id === id);
      if (c && !name) setName(c.name);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      // Don't send `class` — server resolves it from the linked customer.
      const body: Record<string, unknown> = {
        name: name.trim(),
        customer_id: customerId || null,
      };
      if (mode === 'add') body.email = email.trim().toLowerCase();

      const path = mode === 'add' ? '/admin/users' : `/admin/users/${user!.id}`;
      const method = mode === 'add' ? 'POST' : 'PATCH';
      const r = await authedFetch(path, { method, body: JSON.stringify(body) });
      const resBody = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(resBody.error);
      onSaved();
      onClose();
    } catch (e) {
      setError(friendlyAdminError((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{mode === 'add' ? 'Add client login' : 'Edit login'}</DialogTitle>
            <DialogDescription>
              {mode === 'add'
                ? 'Customer signs in with email + one-time code — no password to manage.'
                : 'Update display name, linked customer, or class. Email is fixed once created.'}
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <div>
              <Label htmlFor="user-email" className="mb-1.5">
                Email <span className="text-rose-600">*</span>
              </Label>
              <Input
                id="user-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="customer@example.com"
                required
                disabled={mode === 'edit' || saving}
                className="font-mono text-xs"
              />
              {mode === 'edit' && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Email can't be changed. Delete + recreate if needed.
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="user-customer" className="mb-1.5">Linked customer</Label>
              <select
                id="user-customer"
                value={customerId}
                onChange={e => handleCustomerChange(e.target.value)}
                disabled={saving}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
              >
                <option value="">— Not linked (will see no bills) —</option>
                {store.customers.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Drives which bills this client sees. Pick the portal customer record that represents them.
              </p>
            </div>

            <div>
              <Label htmlFor="user-name" className="mb-1.5">
                Display name <span className="text-rose-600">*</span>
              </Label>
              <Input
                id="user-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Ramesh"
                required
                disabled={saving}
              />
            </div>

            {/* Read-only class display. Set from Admin → Customers → edit
                customer; this avoids two divergent class values for the same
                person. */}
            <div className="bg-muted/40 border border-border rounded-md px-3 py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Pricing class (from linked customer)
                </p>
                {linkedCustomer?.class ? (
                  <p className="text-sm mt-0.5">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${classBadgeClasses(linkedCustomer.class as CustomerClass)}`}>
                      Class {linkedCustomer.class}
                    </span>
                    <span className="text-xs text-muted-foreground ml-2">
                      Edit in <strong>Customers → {linkedCustomer.name}</strong>
                    </span>
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-0.5 italic">
                    Link a customer above to inherit their class.
                  </p>
                )}
              </div>
            </div>

            {error && (
              <div className="bg-rose-50 border border-rose-200 rounded-md px-3 py-2 text-xs text-rose-800 flex items-start gap-2">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving || !email || !name}>
              {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : (mode === 'add' ? 'Add login' : 'Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default AdminUsers;
