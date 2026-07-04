/**
 * Cloudinary unsigned-upload helper for product images.
 *
 * Why Cloudinary:
 *  - Free tier: 25 credits/month (≈ 25 GB storage + 25 GB bandwidth combined). No card required.
 *  - Built-in CDN + on-the-fly format/quality optimization via URL transforms.
 *  - Unsigned upload preset = upload directly from the browser without a backend.
 *
 * What we do:
 *  - Resize + WebP-encode client-side BEFORE upload (saves credits, faster delivery).
 *  - POST as multipart/form-data to https://api.cloudinary.com/v1_1/<cloud>/image/upload.
 *  - Rewrite the returned URL to include `f_auto,q_auto` so clients get the smallest
 *    format their browser supports (AVIF → WebP → JPG) with auto-chosen quality.
 *  - Only the final string URL lands in Firestore.
 */
import { PortalConfig, isImagesConfigured } from '../data/portalConfig';

const MAX_DIM = 1600;
const QUALITY = 0.85;

const resizeAndEncode = async (file: File): Promise<Blob> => {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Safari fallback via <img>
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      const c = document.createElement('canvas');
      const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      return await new Promise<Blob>((resolve, reject) => {
        c.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/webp', QUALITY);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  if ('OffscreenCanvas' in window) {
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    return await c.convertToBlob({ type: 'image/webp', quality: QUALITY });
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) => {
    c.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/webp', QUALITY);
  });
};

/**
 * Inserts `f_auto,q_auto` after `/upload/` so Cloudinary serves the optimal
 * format & quality per request. Idempotent — running twice doesn't double-apply.
 */
const withAutoTransform = (url: string): string => {
  if (!url.includes('/upload/')) return url;
  if (/\/upload\/[^/]*(f_auto|q_auto)/.test(url)) return url;
  return url.replace('/upload/', '/upload/f_auto,q_auto/');
};

interface CloudinaryUploadResponse {
  secure_url?: string;
  public_id?: string;
  error?: { message?: string };
}

/** Upload a single image to Cloudinary; returns the optimized secure URL. */
export const uploadProductImage = async (
  cfg: PortalConfig,
  productId: string,
  file: File,
): Promise<string> => {
  if (!isImagesConfigured(cfg)) {
    throw new Error('Cloudinary is not configured. Set cloud name + upload preset in Settings.');
  }
  const blob = await resizeAndEncode(file);
  const form = new FormData();
  form.append('file', blob, `${file.name.replace(/\.[^.]+$/, '')}.webp`);
  form.append('upload_preset', cfg.cloudinaryUploadPreset!.trim());
  // Folder keeps assets organized in the Cloudinary media library — admin can browse there.
  const folder = `shops/${cfg.shopCode || 'default'}/products/${productId}`;
  form.append('folder', folder);

  const endpoint = `https://api.cloudinary.com/v1_1/${cfg.cloudinaryCloudName!.trim()}/image/upload`;
  const res = await fetch(endpoint, { method: 'POST', body: form });
  let data: CloudinaryUploadResponse;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Cloudinary returned ${res.status} (not JSON)`);
  }
  if (!res.ok || !data.secure_url) {
    const msg = data.error?.message || `Upload failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return withAutoTransform(data.secure_url);
};
