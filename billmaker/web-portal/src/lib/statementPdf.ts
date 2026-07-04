// Browser-side statement PDF generator. Produces a detailed multi-page A4
// document listing every bill for a single customer in a date range, with
// per-bill line items, payment status, and period totals.
//
// Uses pdf-lib (same library as the mobile app's bill generator), which works
// identically in Node and the browser. Pure-JS, no native deps.
//
// Output: a base64 string suitable for handing to the worker (which posts it
// as an attachment to Brevo). The same generator powers the in-app preview
// (opened in a new tab via blob:// URL).

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { Bill, Customer } from '../types';

// Same palette as the mobile bill generator — keeps visual consistency
// between bills and statements.
const PRIMARY = rgb(0.0117, 0.5176, 0.7803); // sky-700
const TEXT = rgb(0.118, 0.161, 0.231);
const MUTED = rgb(0.392, 0.455, 0.545);
const HAIRLINE = rgb(0.835, 0.871, 0.898);
const ROW_ALT = rgb(0.976, 0.98, 0.988); // very light grey
const DUE = rgb(0.875, 0.176, 0.275); // red for unpaid balance
const PAID = rgb(0.063, 0.643, 0.376); // green for paid

// pdf-lib's StandardFonts use WinAnsi; ₹ and a few smart-quote chars aren't
// in that range. drawText also can't render newline / carriage-return /
// tab — they have to be collapsed to spaces.
const safe = (s: unknown): string => {
  if (s == null) return '';
  return String(s)
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    // Collapse all whitespace control chars (newline / CR / tab / vertical
    // tab / form feed) into a single space — drawText would otherwise throw
    // "WinAnsi cannot encode '\n' (0x000a)".
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    // Strip remaining non-WinAnsi to '?' (covers emoji etc.)
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
    // Collapse runs of spaces created by the substitutions above.
    .replace(/\s+/g, ' ')
    .trim();
};

const fmtMoney = (n: number): string =>
  `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (iso: string): string => {
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  } catch {
    return iso;
  }
};

/**
 * Truncate text to fit within maxWidth at the given font/size, appending an
 * ellipsis if cut. pdf-lib's drawText `maxWidth` parameter clips rendering
 * but doesn't show the user that text was cut — this returns a string that
 * fits.
 */
const fitText = (s: string, font: PDFFont, size: number, maxWidth: number): string => {
  const safeText = safe(s);
  if (font.widthOfTextAtSize(safeText, size) <= maxWidth) return safeText;
  let lo = 0, hi = safeText.length;
  // Binary search for the longest prefix that fits with "..." appended
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = safeText.slice(0, mid) + '...';
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? safeText.slice(0, lo) + '...' : '';
};

export interface StatementData {
  customer: Customer;
  bills: Bill[];                  // already filtered to the date range
  periodLabel: string;            // e.g. "May 2026" or "01 May 2026 – 22 May 2026"
  periodFromIso: string;
  periodToIso: string;
  shopName: string;
  shopAddress?: string;
  shopPhone?: string;
  shopEmail?: string;
  generatedAt: Date;
}

export interface StatementTotals {
  billed: number;
  paid: number;
  outstanding: number;
  billCount: number;
}

export const computeTotals = (bills: Bill[]): StatementTotals => {
  let billed = 0;
  let paid = 0;
  for (const b of bills) {
    billed += Number(b.total) || 0;
    paid += Number(b.paid) || 0;
  }
  return {
    billed,
    paid,
    outstanding: Math.max(0, billed - paid),
    billCount: bills.length,
  };
};

interface DrawContext {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  pageWidth: number;
  pageHeight: number;
  margin: number;
}

interface Cursor {
  page: PDFPage;
  y: number;
}

const newPage = (ctx: DrawContext): Cursor => {
  const page = ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
  return { page, y: ctx.pageHeight - 40 };
};

const ensureRoom = (cursor: Cursor, ctx: DrawContext, needed: number): Cursor => {
  if (cursor.y - needed > 60) return cursor;
  return newPage(ctx);
};

const drawHeader = (
  cursor: Cursor,
  ctx: DrawContext,
  data: StatementData,
  totals: StatementTotals,
  pageNumber: number,
): Cursor => {
  const { page } = cursor;
  const { pageWidth: W, pageHeight: H, margin: M, font, bold } = ctx;

  // Top primary band
  page.drawRectangle({ x: 0, y: H - 80, width: W, height: 80, color: PRIMARY });
  page.drawText(safe(data.shopName) || 'Statement', {
    x: M, y: H - 38, size: 20, font: bold, color: rgb(1, 1, 1),
  });
  if (data.shopAddress) {
    page.drawText(safe(data.shopAddress), {
      x: M, y: H - 56, size: 9, font, color: rgb(1, 1, 1),
    });
  }
  if (data.shopPhone || data.shopEmail) {
    const line = [data.shopPhone, data.shopEmail].filter(Boolean).join('  ·  ');
    page.drawText(safe(line), {
      x: M, y: H - 68, size: 9, font, color: rgb(1, 1, 1),
    });
  }

  // STATEMENT label top-right
  page.drawText('STATEMENT', {
    x: W - M - 100, y: H - 38, size: 16, font: bold, color: rgb(1, 1, 1),
  });
  page.drawText(`Page ${pageNumber}`, {
    x: W - M - 100, y: H - 56, size: 9, font, color: rgb(1, 1, 1),
  });

  let y = H - 110;

  // Customer + period block (only on page 1).
  // Two-column layout with a hard gutter so long names can't overflow into
  // the period block.
  if (pageNumber === 1) {
    const GUTTER = 20;
    const colWidthAvail = (W - M * 2 - GUTTER) / 2;
    const leftMaxW  = colWidthAvail;
    const rightX    = M + colWidthAvail + GUTTER;
    const rightMaxW = colWidthAvail;

    // --- Left column: customer ---
    let leftY = y;
    page.drawText('STATEMENT FOR', {
      x: M, y: leftY, size: 8, font: bold, color: MUTED,
    });
    leftY -= 14;
    page.drawText(fitText(data.customer.name, bold, 14, leftMaxW), {
      x: M, y: leftY, size: 14, font: bold, color: TEXT,
    });
    leftY -= 14;
    const meta = [
      data.customer.phone,
      data.customer.email,
      data.customer.gstNumber && `GST: ${data.customer.gstNumber}`,
    ].filter(Boolean).join('  ·  ');
    if (meta) {
      page.drawText(fitText(meta, font, 9, leftMaxW), { x: M, y: leftY, size: 9, font, color: MUTED });
      leftY -= 12;
    }
    if (data.customer.address) {
      page.drawText(fitText(data.customer.address, font, 9, leftMaxW), { x: M, y: leftY, size: 9, font, color: MUTED });
      leftY -= 12;
    }

    // --- Right column: period ---
    let rightY = y;
    page.drawText('PERIOD', { x: rightX, y: rightY, size: 8, font: bold, color: MUTED });
    rightY -= 14;
    page.drawText(fitText(data.periodLabel, bold, 12, rightMaxW), {
      x: rightX, y: rightY, size: 12, font: bold, color: TEXT,
    });
    rightY -= 14;
    page.drawText(fitText(`Generated ${fmtDate(data.generatedAt.toISOString())}`, font, 9, rightMaxW), {
      x: rightX, y: rightY, size: 9, font, color: MUTED,
    });
    rightY -= 12;

    // Continue below whichever column is taller.
    y = Math.min(leftY, rightY) - 8;

    // Totals strip
    page.drawRectangle({
      x: M, y: y - 50, width: W - M * 2, height: 50,
      color: rgb(0.965, 0.973, 0.984),
      borderColor: HAIRLINE,
      borderWidth: 0.5,
    });
    const statColW = (W - M * 2) / 4;
    const drawStat = (col: number, label: string, value: string, valueColor = TEXT) => {
      const x = M + col * statColW + 12;
      const w = statColW - 24;
      page.drawText(fitText(label, bold, 7, w), { x, y: y - 14, size: 7, font: bold, color: MUTED });
      page.drawText(fitText(value, bold, 13, w), { x, y: y - 32, size: 13, font: bold, color: valueColor });
    };
    drawStat(0, 'BILLS', String(totals.billCount));
    drawStat(1, 'TOTAL BILLED', fmtMoney(totals.billed));
    drawStat(2, 'PAID', fmtMoney(totals.paid), PAID);
    drawStat(3, 'OUTSTANDING', fmtMoney(totals.outstanding),
      totals.outstanding > 0 ? DUE : PAID);
    y -= 64;
  }

  return { page, y };
};

const drawFooter = (cursor: Cursor, ctx: DrawContext, data: StatementData): void => {
  const { page } = cursor;
  const { pageWidth: W, margin: M, font } = ctx;
  const y = 30;
  page.drawLine({
    start: { x: M, y: y + 14 }, end: { x: W - M, y: y + 14 },
    thickness: 0.5, color: HAIRLINE,
  });
  page.drawText(
    safe(`${data.shopName} · Statement generated ${fmtDate(data.generatedAt.toISOString())}`),
    { x: M, y, size: 8, font, color: MUTED },
  );
  page.drawText(safe('For queries, reply to this email or visit the client portal.'), {
    x: W - M - 280, y, size: 8, font, color: MUTED,
  });
};

/**
 * Build a single consolidated table summarizing every line item across all
 * bills in the statement period. Items are grouped by case-insensitive name
 * + unit; quantities + totals are summed.
 *
 * Rendered on the front page(s) before the per-bill detail. Auto-paginates
 * if the consolidated list is long.
 */
const drawConsolidatedItems = (
  cursor: Cursor,
  ctx: DrawContext,
  bills: Bill[],
  data: StatementData,
  totals: StatementTotals,
): Cursor => {
  const { font, bold, pageWidth: W, margin: M } = ctx;

  // Aggregate items across bills.
  type Bucket = { name: string; unit: string; quantity: number; amount: number };
  const map = new Map<string, Bucket>();
  for (const b of bills) {
    for (const it of b.items || []) {
      const name = (it.productName || '').trim();
      const unit = (it.unit || '').trim();
      const key = `${name.toLowerCase()}|${unit.toLowerCase()}`;
      const existing = map.get(key);
      if (existing) {
        existing.quantity += Number(it.quantity) || 0;
        existing.amount   += Number(it.amount) || 0;
      } else {
        map.set(key, {
          name,
          unit,
          quantity: Number(it.quantity) || 0,
          amount:   Number(it.amount) || 0,
        });
      }
    }
  }
  const consolidated = Array.from(map.values()).sort((a, b) =>
    b.amount - a.amount,
  );

  if (consolidated.length === 0) return cursor;

  // Section title
  let y = cursor.y;
  cursor = ensureRoom(cursor, ctx, 40);
  y = cursor.y;
  cursor.page.drawText('ITEMS PURCHASED (CONSOLIDATED)', {
    x: M, y, size: 10, font: bold, color: PRIMARY,
  });
  cursor.page.drawText(
    safe(`${consolidated.length} unique item${consolidated.length === 1 ? '' : 's'} across ${totals.billCount} bill${totals.billCount === 1 ? '' : 's'}`),
    { x: M + 250, y, size: 9, font, color: MUTED },
  );
  y -= 18;

  // Column boundaries — same as per-bill table but with "QTY (TOTAL)" header
  const itemX      = M + 16;
  const qtyX       = W - M - 230;
  const amountX    = W - M - 80;
  const itemMaxW   = qtyX - itemX - 8;
  const qtyMaxW    = (amountX - 4) - qtyX - 8;
  const amountMaxW = (W - M) - amountX - 4;

  // Header strip
  cursor.page.drawRectangle({
    x: M, y: y - 4, width: W - M * 2, height: 16, color: rgb(0.945, 0.961, 0.98),
  });
  cursor.page.drawText('ITEM',         { x: itemX,   y, size: 7, font: bold, color: MUTED });
  cursor.page.drawText('TOTAL QTY',    { x: qtyX,    y, size: 7, font: bold, color: MUTED });
  cursor.page.drawText('TOTAL AMOUNT', { x: amountX, y, size: 7, font: bold, color: MUTED });
  y -= 14;

  // Rows
  for (let i = 0; i < consolidated.length; i++) {
    if (y < 80) {
      cursor = newPage(ctx);
      cursor = drawHeader(cursor, ctx, data, totals, ctx.doc.getPageCount());
      y = cursor.y;
      // re-draw column headers on continuation page
      cursor.page.drawText('ITEM',         { x: itemX,   y, size: 7, font: bold, color: MUTED });
      cursor.page.drawText('TOTAL QTY',    { x: qtyX,    y, size: 7, font: bold, color: MUTED });
      cursor.page.drawText('TOTAL AMOUNT', { x: amountX, y, size: 7, font: bold, color: MUTED });
      y -= 14;
    }
    const item = consolidated[i];
    if (i % 2 === 0) {
      cursor.page.drawRectangle({
        x: M, y: y - 4, width: W - M * 2, height: 14, color: ROW_ALT,
      });
    }
    cursor.page.drawText(fitText(item.name, font, 9, itemMaxW), {
      x: itemX, y, size: 9, font, color: TEXT,
    });
    cursor.page.drawText(
      fitText(`${item.quantity}${item.unit ? ' ' + item.unit : ''}`, font, 9, qtyMaxW),
      { x: qtyX, y, size: 9, font, color: TEXT },
    );
    cursor.page.drawText(fitText(fmtMoney(item.amount), font, 9, amountMaxW), {
      x: amountX, y, size: 9, font, color: TEXT,
    });
    y -= 14;
  }

  // Footer totals row
  cursor.page.drawLine({
    start: { x: M, y: y - 2 }, end: { x: W - M, y: y - 2 },
    thickness: 0.5, color: HAIRLINE,
  });
  y -= 16;
  const grandTotal = consolidated.reduce((s, it) => s + it.amount, 0);
  const grandQty = consolidated.reduce((s, it) => s + it.quantity, 0);
  cursor.page.drawText(safe(`Total qty: ${grandQty}`), {
    x: itemX, y, size: 9, font: bold, color: TEXT,
  });
  cursor.page.drawText(safe(fmtMoney(grandTotal)), {
    x: amountX, y, size: 10, font: bold, color: PRIMARY,
  });
  y -= 20;

  return { page: cursor.page, y };
};

const drawBillSection = (
  cursor: Cursor,
  ctx: DrawContext,
  bill: Bill,
  index: number,
): Cursor => {
  const { font, bold, pageWidth: W, margin: M } = ctx;
  // Estimated height: header (28) + per-item (~14) + totals row (28) + padding (10)
  const itemCount = bill.items?.length || 0;
  const neededHeight = 28 + (Math.max(1, itemCount) * 14) + 28 + 12;
  cursor = ensureRoom(cursor, ctx, neededHeight);

  const { page } = cursor;
  let y = cursor.y;

  // ----- Bill header row -----
  // Layout (left → right):
  //   billNumberCol: M+8         → 35% width
  //   dateCol:       35%         → 20% width
  //   statusCol:     55%         → 15% width
  //   totalCol:      right-aligned at W-M-8, last 25% width
  const usable = W - M * 2 - 16;        // inner width after small pads
  const billNumX  = M + 8;
  const dateX     = M + 8 + Math.floor(usable * 0.35);
  const statusX   = M + 8 + Math.floor(usable * 0.55);
  const totalX    = M + 8 + Math.floor(usable * 0.75);
  const billNumW  = Math.floor(usable * 0.33);
  const dateW     = Math.floor(usable * 0.18);
  const statusW   = Math.floor(usable * 0.18);
  const totalW    = Math.floor(usable * 0.24);

  page.drawRectangle({
    x: M, y: y - 22, width: W - M * 2, height: 22,
    color: rgb(0.949, 0.965, 0.984),
  });
  page.drawText(fitText(`Bill #${bill.billNumber}`, bold, 10, billNumW), {
    x: billNumX, y: y - 15, size: 10, font: bold, color: PRIMARY,
  });
  page.drawText(fitText(fmtDate(bill.createdAt), font, 9, dateW), {
    x: dateX, y: y - 15, size: 9, font, color: TEXT,
  });
  const ackText = bill.acknowledged ? 'Released' : 'Pending';
  const ackColor = bill.acknowledged ? PAID : MUTED;
  page.drawText(fitText(ackText, bold, 9, statusW), {
    x: statusX, y: y - 15, size: 9, font: bold, color: ackColor,
  });
  // Bill total — right-align within its column so amounts visually align
  const totalStr = fmtMoney(Number(bill.total) || 0);
  const totalStrW = bold.widthOfTextAtSize(safe(totalStr), 10);
  const totalDrawX = Math.max(totalX, W - M - 8 - totalStrW);
  page.drawText(safe(totalStr), {
    x: totalDrawX, y: y - 15, size: 10, font: bold, color: TEXT,
  });
  y -= 30;

  // ----- Line items table -----
  // Column boundaries (recomputed for clarity):
  //   ITEM column:   M+16          → up to QTY col (with gutter)
  //   QTY column:    W-M-230       width 50
  //   RATE column:   W-M-170       width 80
  //   AMOUNT column: W-M-80        width 70 (right-edge of page minus margin)
  const itemX      = M + 16;
  const qtyX       = W - M - 230;
  const rateX      = W - M - 170;
  const amountX    = W - M - 80;
  const itemMaxW   = qtyX - itemX - 8;  // hard cap on item name width
  const qtyMaxW    = rateX - qtyX - 8;
  const rateMaxW   = amountX - rateX - 8;
  const amountMaxW = (W - M) - amountX - 4;

  if (itemCount === 0) {
    page.drawText(safe('(no items)'), {
      x: itemX, y: y - 4, size: 9, font, color: MUTED,
    });
    y -= 14;
  } else {
    // Column headers
    page.drawText('ITEM',   { x: itemX,   y, size: 7, font: bold, color: MUTED });
    page.drawText('QTY',    { x: qtyX,    y, size: 7, font: bold, color: MUTED });
    page.drawText('RATE',   { x: rateX,   y, size: 7, font: bold, color: MUTED });
    page.drawText('AMOUNT', { x: amountX, y, size: 7, font: bold, color: MUTED });
    y -= 12;

    for (let i = 0; i < bill.items.length; i++) {
      const item = bill.items[i];
      // Alternating row tint
      if (i % 2 === 0) {
        page.drawRectangle({
          x: M, y: y - 4, width: W - M * 2, height: 14, color: ROW_ALT,
        });
      }
      page.drawText(fitText(item.productName, font, 9, itemMaxW), {
        x: itemX, y, size: 9, font, color: TEXT,
      });
      page.drawText(fitText(`${item.quantity} ${item.unit || ''}`.trim(), font, 9, qtyMaxW), {
        x: qtyX, y, size: 9, font, color: TEXT,
      });
      page.drawText(fitText(fmtMoney(Number(item.rate) || 0), font, 9, rateMaxW), {
        x: rateX, y, size: 9, font, color: TEXT,
      });
      page.drawText(fitText(fmtMoney(Number(item.amount) || 0), font, 9, amountMaxW), {
        x: amountX, y, size: 9, font, color: TEXT,
      });
      y -= 14;
      // Page-break mid-bill if needed
      if (y < 80) {
        cursor = newPage(ctx);
        y = cursor.y;
      }
    }
  }

  // ----- Per-bill totals row (right-aligned) -----
  const paid = Number(bill.paid) || 0;
  const total = Number(bill.total) || 0;
  const due = Math.max(0, total - paid);
  page.drawLine({
    start: { x: M, y: y - 2 }, end: { x: W - M, y: y - 2 },
    thickness: 0.5, color: HAIRLINE,
  });
  y -= 14;
  // Lay out 3 right-aligned labels with predictable gaps so amounts don't
  // overlap when values get long.
  const drawRightAligned = (text: string, rightX: number, isBold: boolean, color: any) => {
    const f = isBold ? bold : font;
    const safeText = safe(text);
    const w = f.widthOfTextAtSize(safeText, 9);
    page.drawText(safeText, { x: rightX - w, y, size: 9, font: f, color });
  };
  // Right edges: Due flush right; Paid before it; Subtotal before that.
  const dueRight = W - M - 4;
  const paidRight = dueRight - 110;
  const subtotalRight = paidRight - 110;
  drawRightAligned(`Subtotal:  ${fmtMoney(total)}`, subtotalRight, false, TEXT);
  drawRightAligned(`Paid:  ${fmtMoney(paid)}`,      paidRight,     false, PAID);
  drawRightAligned(`Due:  ${fmtMoney(due)}`,        dueRight,      true,  due > 0 ? DUE : PAID);
  y -= 18;

  // Suppress unused warning
  void index;

  return { page, y };
};

/**
 * Build the statement PDF for one customer and return it as a base64 string.
 * Use the same function for in-browser preview (turn the base64 into a blob)
 * and for sending (forward base64 to the worker which forwards to Brevo).
 */
export const generateStatementPdf = async (data: StatementData): Promise<string> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28;  // A4 width in points
  const pageHeight = 841.89; // A4 height
  const margin = 40;
  const ctx: DrawContext = { doc, font, bold, pageWidth, pageHeight, margin };

  const totals = computeTotals(data.bills);

  let cursor = newPage(ctx);
  let pageNum = 1;
  cursor = drawHeader(cursor, ctx, data, totals, pageNum);

  if (data.bills.length === 0) {
    const msg = 'No bills in the selected period.';
    cursor.page.drawText(safe(msg), {
      x: margin, y: cursor.y - 20, size: 11, font, color: MUTED,
    });
  } else {
    // FRONT PAGE(S): consolidated table summarizing every line item across
    // all bills. Auto-paginates if the consolidated list is long.
    cursor = drawConsolidatedItems(cursor, ctx, data.bills, data, totals);

    // PER-BILL DETAIL: each bill starts on its OWN new page.
    const sorted = [...data.bills].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (let i = 0; i < sorted.length; i++) {
      // Force a page break before every bill so each gets its own page.
      cursor = newPage(ctx);
      pageNum = doc.getPageCount();
      cursor = drawHeader(cursor, ctx, data, totals, pageNum);
      // If the bill is long enough that drawBillSection itself needs to break
      // mid-items, the inner page-break handles continuation.
      cursor = drawBillSection(cursor, ctx, sorted[i], i);
    }
  }

  drawFooter(cursor, ctx, data);
  // Footer on any other pages too
  for (let p = 1; p < doc.getPageCount(); p++) {
    drawFooter({ page: doc.getPage(p), y: 0 }, ctx, data);
  }

  const bytes = await doc.save();
  return uint8ToBase64(bytes);
};

/**
 * Convert Uint8Array → base64 without spawning a giant string concat. Browsers
 * have `btoa(String.fromCharCode(...bytes))` but that fails on big buffers
 * (call stack). This chunks safely.
 */
const uint8ToBase64 = (bytes: Uint8Array): string => {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(''));
};

/** Convenience: open the generated PDF in a new browser tab. */
export const previewStatementPdf = async (data: StatementData): Promise<void> => {
  const b64 = await generateStatementPdf(data);
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  // Revoke after a delay so the new tab has time to load
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};

export const buildFileName = (customerName: string, periodLabel: string): string => {
  const slug = (s: string) =>
    s.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'statement';
  return `statement-${slug(customerName)}-${slug(periodLabel)}.pdf`;
};
