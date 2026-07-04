// Single-bill PDF generator for the client portal.
//
// Mirrors the A4 layout produced by BillMaker mobile's
// `utils/generateBillsPDF.ts → drawA4Bill`, so a client downloading a PDF
// from the web portal gets an identical-looking document. We port only the
// pieces needed for one bill (no quarter-paper layout, no batch).
//
// pdf-lib's StandardFonts use WinAnsi encoding (no ₹, no Devanagari, no
// emoji). We sanitize all user-provided text + use "Rs." instead of ₹ —
// same rule as mobile.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { Bill } from '../types';
import type { ClientBusinessInfo } from './clientData';

// Mobile palette — keep the visual identity consistent.
const PRIMARY = rgb(0.0117, 0.5176, 0.7803); // sky-700 #0284c7
const TEXT = rgb(0.118, 0.161, 0.231);       // slate-800
const MUTED = rgb(0.392, 0.455, 0.545);      // slate-500
const HAIRLINE = rgb(0.835, 0.871, 0.898);   // slate-300


// ---------------------------------------------------------------------------
// Indian-style number-to-words (rupees + paise). Identical output to mobile's
// `utils/numberToWords.ts`. Inlined so this file has no cross-bundle deps.
// ---------------------------------------------------------------------------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const TEENS = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const twoDigit = (n: number): string => {
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ` ${ONES[o]}` : '');
};

const threeDigit = (n: number): string => {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigit(rest));
  return parts.join(' ');
};

const numberToIndianWords = (amount: number): string => {
  if (!isFinite(amount) || amount < 0) return '';
  if (amount === 0) return 'Zero Rupees Only';
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  const rupeeParts: string[] = [];
  if (rupees > 0) {
    const crore = Math.floor(rupees / 10000000);
    const lakh = Math.floor((rupees % 10000000) / 100000);
    const thousand = Math.floor((rupees % 100000) / 1000);
    const hundred = rupees % 1000;
    if (crore) rupeeParts.push(`${twoDigit(crore)} Crore`);
    if (lakh) rupeeParts.push(`${twoDigit(lakh)} Lakh`);
    if (thousand) rupeeParts.push(`${twoDigit(thousand)} Thousand`);
    if (hundred) rupeeParts.push(threeDigit(hundred));
  }
  let out = rupeeParts.length ? `${rupeeParts.join(' ')} Rupees` : '';
  if (paise > 0) out += (out ? ' and ' : '') + `${twoDigit(paise)} Paise`;
  return `${out} Only`;
};


// ---------------------------------------------------------------------------
// Small helpers (drawRight, truncate, safe text, money formatter) — same
// behavior as mobile so output matches byte-for-byte where possible.
// ---------------------------------------------------------------------------
const safeMoney = (n: number) =>
  `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d: Date) => {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
};

const safe = (s: any): string => {
  if (s == null) return '';
  return String(s)
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');
};

const drawRight = (
  page: PDFPage, text: string, rightX: number, y: number,
  size: number, font: PDFFont, color: any,
): void => {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rightX - w, y, size, font, color });
};

const truncate = (text: string, font: PDFFont, size: number, maxWidth: number): string => {
  if (!text) return '';
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(0, mid) + '…';
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  return text.slice(0, Math.max(1, lo - 1)) + '…';
};

const pad2 = (n: number) => String(n).padStart(2, '0');


// ---------------------------------------------------------------------------
// Bill renderer — one A4 page, matches mobile's drawA4Bill layout.
// ---------------------------------------------------------------------------
const drawA4Bill = (
  page: PDFPage,
  bill: Bill,
  business: ClientBusinessInfo | null,
  font: PDFFont,
  bold: PDFFont,
) => {
  const W = page.getWidth();
  const H = page.getHeight();
  const M = 40;

  // Shop identity for the client-facing PDF — pulled from the business record
  // (_meta/business / /admin/shop), so the receipt always carries whatever the
  // shop has configured. Falls back to a generic name only if none is set.
  const businessName = business?.name || 'BillMaker';
  const phone = business?.phone || '';
  const address = business?.address || '';
  const createdAt = bill.createdAt ? new Date(bill.createdAt) : new Date();

  // ---------- Header band ----------
  // Slightly taller (96px) to fit shop name + contact + address on three lines
  // with breathing room. Soft inner band of slightly-lighter blue gives the
  // header a subtle 2-tone depth without overwhelming the receipt.
  const HEADER_H = 96;
  page.drawRectangle({ x: 0, y: H - HEADER_H, width: W, height: HEADER_H, color: PRIMARY });
  // Subtle accent band along the bottom of the header
  page.drawRectangle({
    x: 0, y: H - HEADER_H - 2, width: W, height: 2,
    color: rgb(0.04, 0.42, 0.66),
  });

  // Shop name — ALL CAPS, bold, large
  page.drawText(safe(businessName.toUpperCase()), {
    x: M, y: H - 36, size: 20, font: bold, color: rgb(1, 1, 1),
  });

  // Right side: "Bill summary" in sentence case
  const headerLabel = 'Bill summary';
  const headerLabelWidth = bold.widthOfTextAtSize(headerLabel, 13);
  page.drawText(headerLabel, {
    x: W - M - headerLabelWidth,
    y: H - 36, size: 13, font: bold, color: rgb(1, 1, 1),
  });
  // Tiny pill under "Bill summary" with the bill number — gives the eye an
  // anchor and feels more like a designed badge than plain text.
  if (bill.billNumber) {
    const billNoText = safe(bill.billNumber);
    const billNoW = font.widthOfTextAtSize(billNoText, 9);
    const pillW = billNoW + 14;
    page.drawRectangle({
      x: W - M - pillW,
      y: H - 56,
      width: pillW,
      height: 14,
      color: rgb(0.04, 0.42, 0.66),
    });
    page.drawText(billNoText, {
      x: W - M - pillW + 7,
      y: H - 52,
      size: 9, font, color: rgb(1, 1, 1),
    });
  }

  // Contact line — "Contact:" prefix in sentence case
  if (phone) {
    page.drawText(safe(`Contact:  ${phone}`), {
      x: M, y: H - 58, size: 10, font, color: rgb(0.88, 0.95, 1),
    });
  }

  // Address line
  if (address) {
    page.drawText(safe(address), {
      x: M, y: H - 75, size: 10, font, color: rgb(0.88, 0.95, 1),
    });
  }

  // Meta row — sit below the slightly-taller header
  let y = H - 128;
  page.drawText('Bill No.', { x: M, y, size: 9, font: bold, color: MUTED });
  page.drawText('Date', { x: M + 200, y, size: 9, font: bold, color: MUTED });
  page.drawText('Customer', { x: M + 320, y, size: 9, font: bold, color: MUTED });

  y -= 14;
  page.drawText(safe(bill.billNumber || '—'), { x: M, y, size: 12, font: bold, color: TEXT });
  page.drawText(fmtDate(createdAt), { x: M + 200, y, size: 12, font, color: TEXT });
  page.drawText(safe(bill.customerName || '—'), { x: M + 320, y, size: 12, font: bold, color: TEXT });

  // Divider
  y -= 20;
  page.drawLine({
    start: { x: M, y }, end: { x: W - M, y },
    thickness: 1, color: HAIRLINE,
  });

  // Table columns
  const COL_SR_X = M + 4;
  const COL_NAME_X = M + 22;
  const COL_QTY_END = M + 280;
  const COL_UNIT_X = M + 295;
  const COL_RATE_END = M + 425;
  const COL_AMT_END = W - M - 4;
  const NAME_MAX_W = COL_QTY_END - COL_NAME_X - 35;

  y -= 18;
  page.drawRectangle({
    x: M, y: y - 6, width: W - 2 * M, height: 22,
    color: rgb(0.94, 0.97, 1),
  });
  page.drawText('#', { x: COL_SR_X, y, size: 9, font: bold, color: TEXT });
  page.drawText('Item', { x: COL_NAME_X, y, size: 9, font: bold, color: TEXT });
  drawRight(page, 'Qty', COL_QTY_END, y, 9, bold, TEXT);
  page.drawText('Unit', { x: COL_UNIT_X, y, size: 9, font: bold, color: TEXT });
  drawRight(page, 'Rate', COL_RATE_END, y, 9, bold, TEXT);
  drawRight(page, 'Amount', COL_AMT_END, y, 9, bold, TEXT);

  y -= 22;
  (bill.items || []).forEach((it, idx) => {
    const qty = Number(it.quantity || 0);
    const rate = Number(it.rate || 0);
    const amount = Number(it.amount || qty * rate || 0);
    page.drawText(String(idx + 1), { x: COL_SR_X, y, size: 10, font, color: TEXT });
    page.drawText(truncate(safe(it.productName), font, 10, NAME_MAX_W), {
      x: COL_NAME_X, y, size: 10, font, color: TEXT,
    });
    drawRight(page, String(qty), COL_QTY_END, y, 10, font, TEXT);
    page.drawText(safe(it.unit || ''), { x: COL_UNIT_X, y, size: 10, font, color: TEXT });
    drawRight(page, safeMoney(rate), COL_RATE_END, y, 10, font, TEXT);
    drawRight(page, safeMoney(amount), COL_AMT_END, y, 10, font, TEXT);
    y -= 18;
  });

  page.drawLine({
    start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 },
    thickness: 0.6, color: HAIRLINE,
  });

  const grandTotal = Number(bill.total ?? (bill.items || []).reduce((s, i) => s + Number(i.amount || 0), 0));

  // Totals block
  y -= 14;
  const totalsLeft = W - M - 200;
  page.drawText('Subtotal', { x: totalsLeft, y, size: 10, font, color: MUTED });
  drawRight(page, safeMoney(grandTotal), COL_AMT_END, y, 10, font, TEXT);

  // Paid + balance lines (web portal carries this; mobile didn't have it in PDF)
  if (bill.paid !== undefined && bill.paid !== null) {
    const paid = Number(bill.paid || 0);
    const balance = grandTotal - paid;
    y -= 16;
    page.drawText('Paid', { x: totalsLeft, y, size: 10, font, color: MUTED });
    drawRight(page, safeMoney(paid), COL_AMT_END, y, 10, font, TEXT);
    y -= 16;
    page.drawText('Balance', { x: totalsLeft, y, size: 10, font: bold, color: balance > 0 ? rgb(0.7, 0.13, 0.18) : rgb(0.05, 0.46, 0.18) });
    drawRight(page, safeMoney(balance), COL_AMT_END, y, 10, bold, balance > 0 ? rgb(0.7, 0.13, 0.18) : rgb(0.05, 0.46, 0.18));
  }

  y -= 22;
  page.drawRectangle({
    x: totalsLeft - 8, y: y - 8,
    width: W - M - totalsLeft + 12, height: 28,
    color: PRIMARY,
  });
  page.drawText('Grand Total', { x: totalsLeft, y, size: 12, font: bold, color: rgb(1, 1, 1) });
  drawRight(page, safeMoney(grandTotal), COL_AMT_END - 4, y, 12, bold, rgb(1, 1, 1));

  // Amount in words
  y -= 36;
  page.drawText('Amount in words:', { x: M, y, size: 9, font: bold, color: MUTED });
  y -= 14;
  page.drawText(numberToIndianWords(grandTotal), { x: M, y, size: 10, font, color: TEXT });

  // ---------- Footer ----------
  // Calm + catchy. Three layers:
  //   1. A whisper-thin row of three dots as a decorative divider
  //   2. A warm centered "thank-you" tagline in primary blue
  //   3. A soft sub-line with the shop's name in subtle muted text
  //   4. Issue timestamp anchored bottom-left as the practical footer info
  const footerCenter = 78;

  // Decorative dot divider — three small dots, centered. Feels light and
  // intentional, much warmer than a flat hairline.
  const cx = W / 2;
  for (let i = -1; i <= 1; i++) {
    page.drawCircle({
      x: cx + i * 14,
      y: footerCenter + 36,
      size: 1,
      color: PRIMARY,
      opacity: i === 0 ? 0.85 : 0.55,
    });
  }

  // Hairlines flanking the dots — gives an elegant "·   ·  ·  ·   ·" feel
  page.drawLine({
    start: { x: M, y: footerCenter + 36 },
    end: { x: cx - 24, y: footerCenter + 36 },
    thickness: 0.3, color: HAIRLINE,
  });
  page.drawLine({
    start: { x: cx + 24, y: footerCenter + 36 },
    end: { x: W - M, y: footerCenter + 36 },
    thickness: 0.3, color: HAIRLINE,
  });

  // Warm main tagline — centered, soft blue
  const taglineMain = 'We are grateful for you.';
  const taglineMainW = bold.widthOfTextAtSize(taglineMain, 13);
  page.drawText(taglineMain, {
    x: cx - taglineMainW / 2,
    y: footerCenter + 14,
    size: 13, font: bold, color: PRIMARY,
  });

  // Sub-line — shop signature, smaller, muted
  const taglineSub = safe(`See you soon  ·  ${businessName}`);
  const taglineSubW = font.widthOfTextAtSize(taglineSub, 9);
  page.drawText(taglineSub, {
    x: cx - taglineSubW / 2,
    y: footerCenter,
    size: 9, font, color: MUTED,
  });

  // Practical timestamp anchored bottom-left
  page.drawText(
    `Issued ${fmtDate(createdAt)} at ${pad2(createdAt.getHours())}:${pad2(createdAt.getMinutes())}`,
    { x: M, y: 30, size: 8, font, color: MUTED },
  );
  // Bill number repeated bottom-right — makes filing/cross-referencing easier
  if (bill.billNumber) {
    const ref = safe(`Ref: ${bill.billNumber}`);
    const refW = font.widthOfTextAtSize(ref, 8);
    page.drawText(ref, {
      x: W - M - refW, y: 30, size: 8, font, color: MUTED,
    });
  }
};


// ---------------------------------------------------------------------------
// Public API — build + trigger browser download for one bill.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Builds the PDF as a Blob — used by both download + share.
// ---------------------------------------------------------------------------
const buildBillPdf = async (
  bill: Bill,
  business: ClientBusinessInfo | null,
): Promise<{ blob: Blob; filename: string }> => {
  const A4_WIDTH = 595.28;
  const A4_HEIGHT = 841.89;
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  drawA4Bill(page, bill, business, font, bold);
  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const safeBillNo = (bill.billNumber || bill.id).replace(/[^A-Za-z0-9_-]/g, '_');
  return { blob, filename: `Bill_${safeBillNo}.pdf` };
};


export const downloadBillPdf = async (
  bill: Bill,
  business: ClientBusinessInfo | null,
): Promise<void> => {
  const { blob, filename } = await buildBillPdf(bill, business);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};


/**
 * Share a bill via WhatsApp.
 *
 * Two paths, picked at runtime based on browser capability:
 *
 *   1. Web Share API + file (mobile Safari / Android Chrome): opens the
 *      native share sheet with the PDF attached. User picks WhatsApp.
 *   2. Fallback (desktop / browsers without file-share support): downloads
 *      the PDF + opens WhatsApp Web in a new tab with a preset message.
 *      User attaches the just-downloaded file manually.
 *
 * IMPORTANT: the fallback's `window.open` must happen INSIDE the same JS
 * tick as the user's click — i.e. BEFORE the `await` for PDF generation.
 * If we open after the await, the user-gesture context is gone and every
 * mainstream browser blocks it as a popup. We pre-open `about:blank`
 * synchronously, then navigate that window to WhatsApp once the PDF is
 * ready. If native share ends up being available, we just close the window.
 *
 * MUST be called directly from a user gesture (e.g. button onClick) for the
 * popup pre-open to work.
 */
export const shareBillOnWhatsApp = async (
  bill: Bill,
  business: ClientBusinessInfo | null,
): Promise<{ method: 'native-share' | 'fallback-download' }> => {
  const pretext = `Bill ${bill.billNumber || bill.id} for ${bill.customerName || 'you'}`;
  const waUrl = `https://wa.me/?text=${encodeURIComponent(pretext)}`;

  // Pre-open the WhatsApp tab in the user-gesture context. Important: do
  // NOT pass 'noopener' — that would strip our reference and we couldn't
  // navigate it later.
  //
  // If the browser pop-up policy still blocks this (some strict
  // configurations), `fallbackWindow` ends up null and we fall back to a
  // synthesized anchor click after the PDF is ready.
  let fallbackWindow: Window | null = null;
  try {
    fallbackWindow = window.open('about:blank', '_blank');
  } catch { /* blocked — handled below */ }

  let blob: Blob;
  let filename: string;
  try {
    const built = await buildBillPdf(bill, business);
    blob = built.blob;
    filename = built.filename;
  } catch (err) {
    fallbackWindow?.close();
    throw err;
  }

  // ----- Native share path -----
  if (typeof navigator !== 'undefined' && 'share' in navigator) {
    try {
      const file = new File([blob], filename, { type: 'application/pdf' });
      const shareData: ShareData = { title: pretext, text: pretext, files: [file] };
      const canShareFiles = !('canShare' in navigator) || (navigator as any).canShare(shareData);

      if (canShareFiles) {
        // Native sheet will handle everything — close the placeholder tab.
        try { fallbackWindow?.close(); } catch {}
        await (navigator as any).share(shareData);
        return { method: 'native-share' };
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // User dismissed the share sheet. Treat as success — no fallback needed.
        try { fallbackWindow?.close(); } catch {}
        return { method: 'native-share' };
      }
      // Any other error → fall through to the download/redirect path.
    }
  }

  // ----- Fallback path: download + open WhatsApp -----
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  if (fallbackWindow && !fallbackWindow.closed) {
    // Best case: navigate the pre-opened window.
    try {
      fallbackWindow.location.href = waUrl;
    } catch {
      // Cross-origin/security edge case — close it and try anchor click.
      fallbackWindow.close();
      openWaViaAnchor(waUrl);
    }
  } else {
    // Pop-up was blocked at the outset. Try synthesized anchor click —
    // browsers treat `<a target=_blank>` clicks more leniently than
    // `window.open` after async work, but this still might fail under
    // very strict popup policies. If it does, the PDF has at least been
    // downloaded and the caller can show a toast.
    openWaViaAnchor(waUrl);
  }

  return { method: 'fallback-download' };
};

/** Synthesize an anchor click. More lenient with popup blockers than
 *  `window.open` after an async gap. */
const openWaViaAnchor = (waUrl: string): void => {
  const link = document.createElement('a');
  link.href = waUrl;
  link.target = '_blank';
  link.rel = 'noopener,noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
