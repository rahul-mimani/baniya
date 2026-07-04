import React, { useState, useEffect, useRef } from 'react';
import { Image as ImageIcon, Plus, Trash2, FileText, Tag, Layers, AlertCircle, Link as LinkIcon, Loader2, CloudOff } from 'lucide-react';
import { Link as RouterLink } from 'react-router-dom';
import { Product, CustomerClass } from '../../types';
import { addProduct, updateProduct, store, canProductBeVisible, labelColorClasses, getActiveClassCodes, classDisplayName, classBadgeClasses } from '../../data/dummyData';
import { getPortalConfig, isImagesConfigured, onConfigChange } from '../../data/portalConfig';
import { uploadProductImage } from '../../lib/cloudinary';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';

interface ProductModalProps {
  mode: 'add' | 'edit';
  product?: Product;
  open: boolean;
  onClose: () => void;
}

const MAX_IMAGES = 5;
// Raw input cap before client-side resize+WebP encode. After encode we typically
// land in the 80–200 KB range, so this just keeps absurd inputs out.
const MAX_INPUT_BYTES = 12 * 1024 * 1024; // 12 MB

const ProductModal: React.FC<ProductModalProps> = ({ mode, product, open, onClose }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [prices, setPrices] = useState<Partial<Record<CustomerClass, string>>>({});
  const [enabledClasses, setEnabledClasses] = useState<Partial<Record<CustomerClass, boolean>>>({});
  const [inStock, setInStock] = useState(true);
  const [visibleToClient, setVisibleToClient] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [imageError, setImageError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [cfg, setCfg] = useState(getPortalConfig());
  useEffect(() => onConfigChange(setCfg), []);
  const imagesReady = isImagesConfigured(cfg);

  useEffect(() => {
    if (!open) return;
    const activeCodes = getActiveClassCodes();
    if (product) {
      setName(product.name);
      setDescription(product.description);
      setLabelIds(product.labelIds);
      const p: Partial<Record<CustomerClass, string>> = {};
      const e: Partial<Record<CustomerClass, boolean>> = {};
      for (const code of activeCodes) {
        p[code] = product.prices[code] ? String(product.prices[code]) : '';
        e[code] = !!product.enabledClasses[code];
      }
      setPrices(p);
      setEnabledClasses(e);
      setInStock(product.inStock);
      setVisibleToClient(product.visibleToClient);
      setImages(product.images || []);
    } else {
      setName(''); setDescription(''); setLabelIds([]);
      const p: Partial<Record<CustomerClass, string>> = {};
      const e: Partial<Record<CustomerClass, boolean>> = {};
      for (const code of activeCodes) {
        p[code] = '';
        e[code] = true;
      }
      setPrices(p);
      setEnabledClasses(e);
      setInStock(true); setVisibleToClient(false); setImages([]);
    }
    setUrlInput(''); setImageError(null);
  }, [open, product]);

  const toggleLabel = (id: string) => setLabelIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);

  const activeCodes = getActiveClassCodes();
  const candidatePrices: Partial<Record<CustomerClass, number>> = {};
  for (const code of activeCodes) candidatePrices[code] = parseFloat(prices[code] || '') || 0;
  const candidate: Product = {
    id: product?.id || 'tmp',
    name: name.trim(),
    description: description.trim(),
    labelIds,
    prices: candidatePrices,
    enabledClasses,
    visibleToClient,
    source: product?.source || 'manual',
    inStock,
    images,
  };
  const canBeVisible = canProductBeVisible(candidate);
  const canSubmit = !!name.trim();

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    setImageError(null);

    if (!imagesReady) {
      setImageError('Cloudinary is not configured. Add cloud name + upload preset in Settings.');
      return;
    }

    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      setImageError(`Maximum ${MAX_IMAGES} images per product.`);
      return;
    }
    const accepted = files.slice(0, remaining);

    // Use the product's existing id, or stage uploads under a placeholder folder
    // that we promote on save. Since the upload returns a URL (not a path), the
    // image stays accessible even if the placeholder id differs from the eventual one.
    const folderId = product?.id || `staging-${Date.now().toString(36)}`;

    setUploading(true);
    setUploadProgress({ done: 0, total: accepted.length });
    const newUrls: string[] = [];
    for (let i = 0; i < accepted.length; i++) {
      const f = accepted[i];
      try {
        if (!f.type.startsWith('image/')) throw new Error(`"${f.name}" isn't an image.`);
        if (f.size > MAX_INPUT_BYTES) throw new Error(`"${f.name}" is over 12 MB.`);
        const url = await uploadProductImage(cfg, folderId, f);
        newUrls.push(url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setImageError(msg);
      }
      setUploadProgress({ done: i + 1, total: accepted.length });
    }
    if (newUrls.length) setImages(prev => [...prev, ...newUrls].slice(0, MAX_IMAGES));
    if (files.length > remaining) {
      setImageError(`Only uploaded the first ${remaining} (limit is ${MAX_IMAGES} per product).`);
    }
    setUploading(false);
    setUploadProgress(null);
  };

  const handleAddUrl = () => {
    const u = urlInput.trim();
    if (!u) return;
    if (images.length >= MAX_IMAGES) {
      setImageError(`Maximum ${MAX_IMAGES} images per product.`);
      return;
    }
    if (!/^https?:\/\//i.test(u) && !u.startsWith('data:image/')) {
      setImageError('URL must start with http:// or https://');
      return;
    }
    setImages(prev => [...prev, u]);
    setUrlInput('');
    setImageError(null);
  };

  const removeImage = (idx: number) => setImages(prev => prev.filter((_, i) => i !== idx));

  const moveImage = (idx: number, dir: -1 | 1) => {
    setImages(prev => {
      const next = prev.slice();
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canSubmit) return;
    const finalVisible = visibleToClient && canBeVisible;
    const payload = {
      name: candidate.name,
      description: candidate.description,
      labelIds: candidate.labelIds,
      prices: candidate.prices,
      enabledClasses: candidate.enabledClasses,
      inStock: candidate.inStock,
      visibleToClient: finalVisible,
      images: candidate.images,
    };
    try {
      if (mode === 'edit' && product) updateProduct(product.id, payload);
      else await addProduct({ ...payload, source: 'manual' });
    } finally {
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{mode === 'edit' ? 'Edit product' : 'Add new product'}</DialogTitle>
            <DialogDescription>
              Fill in product details, set class-based pricing, and upload up to {MAX_IMAGES} images that clients will see.
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            {product?.source === 'billmaker' && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900">
                ⚡ This product was auto-imported from Baniya mobile. Fill in description, prices, class flags, and images to publish it.
              </div>
            )}

            <Tabs defaultValue="details">
              <TabsList className="w-full grid grid-cols-3">
                <TabsTrigger value="details"><FileText className="h-3.5 w-3.5" /> Details</TabsTrigger>
                <TabsTrigger value="pricing"><Layers className="h-3.5 w-3.5" /> Pricing</TabsTrigger>
                <TabsTrigger value="images"><ImageIcon className="h-3.5 w-3.5" /> Images <span className="ml-1 text-[10px] opacity-60">({images.length}/{MAX_IMAGES})</span></TabsTrigger>
              </TabsList>

              {/* DETAILS TAB */}
              <TabsContent value="details" className="space-y-4">
                <div>
                  <Label htmlFor="p-name" className="mb-1.5">Product name <span className="text-rose-600">*</span></Label>
                  <Input id="p-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Paracetamol 500mg" required />
                </div>
                <div>
                  <Label htmlFor="p-desc" className="mb-1.5">Description</Label>
                  <Textarea id="p-desc" value={description} onChange={e => setDescription(e.target.value)} placeholder="Pack size, composition, notes" rows={3} />
                </div>
                <div>
                  <Label className="mb-1.5 flex items-center gap-1.5"><Tag className="h-3.5 w-3.5" /> Labels</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {store.labels.map(l => {
                      const on = labelIds.includes(l.id);
                      return (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() => toggleLabel(l.id)}
                          className={`text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border transition ${
                            on ? labelColorClasses[l.color] : 'bg-background text-muted-foreground border-border hover:bg-muted'
                          }`}
                        >
                          {l.name}
                        </button>
                      );
                    })}
                    {store.labels.length === 0 && <p className="text-xs text-muted-foreground italic">No labels yet. Add some in the Labels tab.</p>}
                  </div>
                </div>
              </TabsContent>

              {/* PRICING TAB */}
              <TabsContent value="pricing" className="space-y-4">
                <div>
                  <Label className="mb-1.5">Class pricing & enablement</Label>
                  <div className="border rounded-lg overflow-hidden divide-y">
                    {activeCodes.map(cls => {
                      const enabled = !!enabledClasses[cls];
                      return (
                        <div
                          key={cls}
                          className={`flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 px-4 py-3.5 transition-colors ${
                            enabled ? 'bg-background' : 'bg-muted/30'
                          }`}
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <Switch
                              checked={enabled}
                              onCheckedChange={v => setEnabledClasses(p => ({ ...p, [cls]: !!v }))}
                            />
                            <span className={`text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border ${classBadgeClasses(cls)} flex-shrink-0`}>
                              Class {cls}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold truncate">{classDisplayName(cls)}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {enabled ? 'Visible & purchasable for this tier' : 'Hidden from this tier'}
                              </p>
                            </div>
                          </div>
                          <div className="relative w-full sm:w-40 flex-shrink-0 sm:ml-auto">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-base text-muted-foreground pointer-events-none">₹</span>
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={prices[cls] ?? ''}
                              onChange={e => { const v = e.target.value; if (/^\d*\.?\d*$/.test(v)) setPrices(p => ({ ...p, [cls]: v })); }}
                              disabled={!enabled}
                              placeholder="0.00"
                              className="pl-8 pr-3 text-right text-base font-semibold h-11"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">In stock</p>
                      <p className="text-[11px] text-muted-foreground">Toggle when out of stock</p>
                    </div>
                    <Switch checked={inStock} onCheckedChange={v => setInStock(!!v)} />
                  </div>
                  <div className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">Visible to clients</p>
                      <p className={`text-[11px] ${canBeVisible ? 'text-muted-foreground' : 'text-rose-600'}`}>
                        {canBeVisible ? 'Will appear in client portal for enabled classes' : 'Need name, description, ≥1 class with price'}
                      </p>
                    </div>
                    <Switch checked={visibleToClient && canBeVisible} disabled={!canBeVisible} onCheckedChange={v => setVisibleToClient(!!v)} />
                  </div>
                </div>
              </TabsContent>

              {/* IMAGES TAB */}
              <TabsContent value="images" className="space-y-4">
                <div className="flex items-start justify-between gap-3 bg-muted/40 rounded-lg p-3 text-xs">
                  <div className="flex-1">
                    <p className="font-bold text-foreground">Up to {MAX_IMAGES} images per product</p>
                    <p className="text-muted-foreground mt-0.5">
                      Resized to 1600 px / WebP in-browser, uploaded to Cloudinary, then served via CDN with auto format + quality. Only the URL lives in Firestore.
                    </p>
                  </div>
                  <span className="text-xs font-bold text-foreground bg-background px-2 py-1 rounded-md border flex-shrink-0">
                    {images.length} / {MAX_IMAGES}
                  </span>
                </div>

                {!imagesReady && (
                  <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2.5 text-xs text-amber-900 flex items-start gap-2">
                    <CloudOff className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-bold">Image upload disabled</p>
                      <p className="mt-0.5">
                        Cloudinary isn't configured. URL paste still works for external images.{' '}
                        <RouterLink to="/admin/settings" className="underline font-semibold" onClick={onClose}>
                          Open Settings →
                        </RouterLink>
                      </p>
                    </div>
                  </div>
                )}

                {imageError && (
                  <div className="bg-rose-50 border border-rose-200 rounded-md px-3 py-2 text-xs text-rose-800 flex items-center gap-2">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {imageError}
                  </div>
                )}

                {/* Existing images */}
                {images.length > 0 ? (
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                    {images.map((src, i) => (
                      <div key={i} className="relative group aspect-square rounded-lg overflow-hidden border bg-muted">
                        <img src={src} alt="" className="w-full h-full object-cover" />
                        {i === 0 && (
                          <span className="absolute top-1 left-1 text-[9px] font-bold uppercase tracking-wider bg-primary text-primary-foreground px-1.5 py-0.5 rounded">
                            Cover
                          </span>
                        )}
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex flex-col items-center justify-center gap-1">
                          <div className="flex gap-1">
                            {i > 0 && (
                              <button type="button" onClick={() => moveImage(i, -1)} className="text-white text-xs bg-white/20 hover:bg-white/30 rounded px-1.5 py-0.5">←</button>
                            )}
                            {i < images.length - 1 && (
                              <button type="button" onClick={() => moveImage(i, 1)} className="text-white text-xs bg-white/20 hover:bg-white/30 rounded px-1.5 py-0.5">→</button>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => removeImage(i)}
                            className="text-white text-xs bg-rose-500/90 hover:bg-rose-600 rounded px-2 py-0.5 flex items-center gap-1"
                          >
                            <Trash2 className="h-3 w-3" /> Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="border-2 border-dashed border-border rounded-lg p-8 text-center text-muted-foreground">
                    <ImageIcon className="h-10 w-10 mx-auto mb-2" />
                    <p className="text-sm">No images yet. Add up to {MAX_IMAGES} below.</p>
                  </div>
                )}

                {/* Add image controls */}
                {images.length < MAX_IMAGES && (
                  <div className="space-y-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={!imagesReady || uploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {uploading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Uploading {uploadProgress ? `${uploadProgress.done}/${uploadProgress.total}` : ''}…
                        </>
                      ) : imagesReady ? (
                        <>
                          <Plus className="h-4 w-4" /> Upload from device
                        </>
                      ) : (
                        <>
                          <CloudOff className="h-4 w-4" /> Upload disabled (configure Cloudinary)
                        </>
                      )}
                    </Button>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <LinkIcon className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                          value={urlInput}
                          onChange={e => setUrlInput(e.target.value)}
                          placeholder="Or paste image URL..."
                          className="pl-9"
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddUrl(); } }}
                        />
                      </div>
                      <Button type="button" variant="secondary" onClick={handleAddUrl} disabled={!urlInput.trim()}>
                        Add URL
                      </Button>
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={uploading}>Cancel</Button>
            <Button type="submit" disabled={!canSubmit || uploading}>
              {uploading ? <><Loader2 className="h-4 w-4 animate-spin" /> Uploading…</> : (mode === 'edit' ? 'Save changes' : 'Add product')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default ProductModal;
