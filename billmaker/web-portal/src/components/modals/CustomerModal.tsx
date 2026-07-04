import React, { useState } from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import { Customer, CustomerClass } from '../../types';
import { addCustomer, updateCustomer, archiveCustomer, store, classDisplayName, getActiveClassCodes } from '../../data/dummyData';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Button } from '../ui/button';

interface CustomerModalProps {
  mode: 'add' | 'edit';
  customer?: Customer;
  open: boolean;
  onClose: () => void;
}

const CustomerModal: React.FC<CustomerModalProps> = ({ mode, customer, open, onClose }) => {
  const [name, setName] = useState(customer?.name || '');
  const [phone, setPhone] = useState(customer?.phone || '');
  const [email, setEmail] = useState(customer?.email || '');
  const [gst, setGst] = useState(customer?.gstNumber || '');
  const [address, setAddress] = useState(customer?.address || '');
  const [cls, setCls] = useState<CustomerClass>(customer?.class || 'C');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');

  React.useEffect(() => {
    if (open) {
      setName(customer?.name || '');
      setPhone(customer?.phone || '');
      setEmail(customer?.email || '');
      setGst(customer?.gstNumber || '');
      setAddress(customer?.address || '');
      setCls(customer?.class || 'C');
      setConfirmingDelete(false);
      setDeleteReason('');
    }
  }, [open, customer]);

  const isEdit = mode === 'edit';
  const canSubmit = !!name.trim() && !!phone.trim();

  // Bill count for this customer (only relevant in edit mode)
  const billCount = isEdit && customer
    ? store.bills.filter(b => b.customerId === customer.id || b.customerName === customer.name).length
    : 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canSubmit) return;
    try {
      if (isEdit && customer) {
        updateCustomer(customer.id, {
          name: name.trim(),
          phone: phone.trim(),
          gstNumber: gst.trim() || undefined,
          address: address.trim() || undefined,
          email: email.trim(),
          class: cls,
        });
      } else {
        addCustomer({
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim(),
          gstNumber: gst.trim() || undefined,
          address: address.trim() || undefined,
          class: cls,
        });
      }
    } finally {
      // Always close, even if the mutation threw. Without this, an error in
      // notify() / pushPortalDoc could leave the modal stuck open.
      onClose();
    }
  };

  const handleDelete = () => {
    if (!isEdit || !customer) return;
    archiveCustomer(customer.id, deleteReason);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent>
        {confirmingDelete && customer ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-rose-700">
                <AlertTriangle className="h-5 w-5" /> Archive "{customer.name}"?
              </DialogTitle>
              <DialogDescription>
                The customer and their <strong>{billCount} bill{billCount === 1 ? '' : 's'}</strong> will be soft-deleted —
                hidden from active lists but preserved in the archive. You can restore them later from <strong>Manage Customers → Archive</strong>.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div>
                <Label htmlFor="del-reason" className="mb-1.5">Reason <span className="text-muted-foreground font-normal normal-case">(optional)</span></Label>
                <Input
                  id="del-reason"
                  value={deleteReason}
                  onChange={e => setDeleteReason(e.target.value)}
                  placeholder="e.g. duplicate, closed shop, requested removal"
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Saved with the archive entry — useful when you re-find it later.
                </p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-900">
                <p className="font-bold mb-1 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" /> What happens
                </p>
                <ul className="space-y-0.5 list-disc list-inside ml-1">
                  <li>Customer removed from <strong>Customers</strong> tab and all dropdowns</li>
                  <li>Their bills are moved to the archive — they won't appear in counts or outstanding totals</li>
                  <li>Bills tied to this customer in Firestore are <strong>not deleted</strong>; only hidden in the portal</li>
                </ul>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmingDelete(false)}>Back</Button>
              <Button type="button" variant="destructive" onClick={handleDelete}>
                <Trash2 className="h-4 w-4" /> Archive customer
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{isEdit ? 'Edit customer' : 'Add new customer'}</DialogTitle>
              <DialogDescription>
                {isEdit
                  ? 'All fields are editable. Changing the name automatically rewrites it across linked bills.'
                  : 'Name and phone are required. Other fields can be added later.'}
              </DialogDescription>
            </DialogHeader>

            <DialogBody>
              <div>
                <Label htmlFor="cust-name" className="mb-1.5">
                  Customer name <span className="text-rose-600">*</span>
                </Label>
                <Input
                  id="cust-name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Acme Store"
                  required
                />
                {isEdit && billCount > 0 && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Renaming will update <strong>{billCount} bill{billCount === 1 ? '' : 's'}</strong> to use the new name.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="cust-phone" className="mb-1.5">
                    Phone <span className="text-rose-600">*</span>
                  </Label>
                  <Input
                    id="cust-phone"
                    type="tel"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder="+91 98XXXXXXXX"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="cust-class" className="mb-1.5">Class</Label>
                  <select
                    id="cust-class"
                    value={cls}
                    onChange={e => setCls(e.target.value as CustomerClass)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                  >
                    {getActiveClassCodes().map(code => (
                      <option key={code} value={code}>
                        Class {code} — {classDisplayName(code)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <Label htmlFor="cust-email" className="mb-1.5">Email <span className="text-muted-foreground font-normal normal-case">(optional)</span></Label>
                <Input id="cust-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="customer@example.com" />
              </div>

              <div>
                <Label htmlFor="cust-gst" className="mb-1.5">GST Number <span className="text-muted-foreground font-normal normal-case">(optional)</span></Label>
                <Input id="cust-gst" value={gst} onChange={e => setGst(e.target.value)} placeholder="29ABCDE1234F1Z5" className="font-mono" />
              </div>

              <div>
                <Label htmlFor="cust-address" className="mb-1.5">Address <span className="text-muted-foreground font-normal normal-case">(optional)</span></Label>
                <Textarea id="cust-address" value={address} onChange={e => setAddress(e.target.value)} placeholder="Street, locality, city, pincode" rows={2} />
              </div>
            </DialogBody>

            <DialogFooter>
              {isEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirmingDelete(true)}
                  className="text-rose-600 hover:bg-rose-50 hover:text-rose-700 mr-auto"
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!canSubmit}>
                {isEdit ? 'Save changes' : 'Add customer'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default CustomerModal;
