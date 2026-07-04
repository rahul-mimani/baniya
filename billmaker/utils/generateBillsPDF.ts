import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Bill, BusinessInfo, Product } from '../types';
import { EXPORT_DIR } from '../storage/paths';
import { getBusinessInfo } from '../storage/businessStorage';
import { numberToIndianWords } from './numberToWords';

const PRIMARY = rgb(0.0117, 0.5176, 0.7803); // sky-700 #0284c7
const TEXT = rgb(0.118, 0.161, 0.231); // slate-800
const MUTED = rgb(0.392, 0.455, 0.545); // slate-500
const HAIRLINE = rgb(0.835, 0.871, 0.898); // slate-300

const calculateTotal = (products: Product[] | undefined) => {
  if (!products) return 0;
  return products.reduce((acc, p) => {
    const q = parseFloat(p.quantity) || 0;
    const pr = parseFloat(p.price) || 0;
    return acc + q * pr;
  }, 0);
};

const fmtINR = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// pdf-lib's StandardFonts use WinAnsi which doesn't include ₹. Fall back to "Rs."
const safeMoney = (n: number) =>
  `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d: Date) => {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
};

/**
 * pdf-lib's StandardFonts use WinAnsi (Latin-1) encoding — they throw on any character
 * outside that range (₹, Devanagari, emoji, etc.). Sanitize user-provided text before
 * drawing so PDF generation never silently fails on a bill with special characters.
 */
const safe = (s: any): string => {
  if (s == null) return '';
  return String(s)
    .replace(/₹/g, 'Rs.')           // ₹ Indian rupee
    .replace(/[‘’]/g, "'")      // smart single quotes
    .replace(/[“”]/g, '"')      // smart double quotes
    .replace(/[–—]/g, '-')      // en/em dash
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?'); // strip non-Latin-1
};

export interface GeneratePDFOptions {
  paperSize?: 'A4' | 'QUARTER';
}

export interface GeneratedPDF {
  uri: string;
  fileName: string;
  base64: string;
}

/**
 * Renders one full-page A4 bill with solid lines, business header, itemized table,
 * subtotal/total, amount in words, and a clean footer.
 */
/**
 * One A4 page of a (potentially multi-page) bill.
 *
 * Multi-page bills used to overflow off the bottom of a single A4 sheet —
 * 30+ items would crash into the grand-total band. The chunker (below)
 * splits a bill into A4PageSlice records and this function draws ONE slice;
 * the call site loops one bill across as many pages as it needs.
 *
 * `isFirstPage` chooses between the FULL header (business band + meta row)
 * and a COMPACT continuation header (bill# + customer only).
 * `isLastPage` decides whether to draw the totals + footer or just a
 * "Continued on next page" indicator.
 */
interface A4PageSlice {
  bill: Bill;
  pageInBill: number;
  totalPagesInBill: number;
  productSlice: Product[];
  itemStartIndex: number;
}

const drawA4Bill = (
  page: PDFPage,
  slice: A4PageSlice,
  business: BusinessInfo,
  font: PDFFont,
  bold: PDFFont,
) => {
  const { bill, pageInBill, totalPagesInBill, productSlice, itemStartIndex } = slice;
  const isFirstPage = pageInBill === 1;
  const isLastPage = pageInBill === totalPagesInBill;

  const W = page.getWidth();
  const H = page.getHeight();
  const M = 40;
  const BLACK = rgb(0, 0, 0);
  const fb = bold;

  // Fixed bottom-of-page anchors. The continued/total/words/footer blocks
  // are positioned from the BOTTOM, not appended after items — so a page
  // with only 5 items has the same visual structure as one with 25.
  const FOOTER_BASE_Y = 50;  // bottom-most footer line baseline
  const FOOTER_SEP_Y  = 78;  // hairline above the footer
  // y position of "Continued on next page" on non-last pages (right above
  // the page-number stamp). Pinned to the bottom by user request.
  const CONTINUED_Y   = 92;

  let y: number;

  if (isFirstPage) {
    // ---------- Full header ----------
    const headerTopY = H - 50;
    const headerBottomY = H - 110;

    page.drawLine({
      start: { x: M, y: headerTopY }, end: { x: W - M, y: headerTopY },
      thickness: 1.5, color: BLACK,
    });
    const headerTitle = safe(business.name?.trim() || 'Bill Summary');
    page.drawText(headerTitle, { x: M, y: H - 75, size: 18, font: fb, color: BLACK });

    const subBits = [business.gst && `ID: ${business.gst}`].filter(Boolean) as string[];
    let subY = H - 93;
    if (subBits.length) {
      page.drawText(safe(subBits.join(' · ')), { x: M, y: subY, size: 10, font: fb, color: BLACK });
      subY -= 12;
    }
    if (business.address) {
      page.drawText(safe(business.address.replace(/\n/g, ', ')), {
        x: M, y: subY, size: 10, font: fb, color: BLACK,
      });
    }

    page.drawLine({
      start: { x: M, y: headerBottomY }, end: { x: W - M, y: headerBottomY },
      thickness: 1.2, color: BLACK,
    });

    y = headerBottomY - 22;
    page.drawText('Bill No.', { x: M, y, size: 10, font: fb, color: BLACK });
    drawRight(page, 'Date', W / 2 + 80, y, 10, fb, BLACK);
    drawRight(page, 'Customer', W - M, y, 10, fb, BLACK);
    y -= 16;
    page.drawText(safe(bill.billNumber || '-'), { x: M, y, size: 13, font: fb, color: BLACK });
    drawRight(page, fmtDate(bill.createdAt), W / 2 + 80, y, 13, fb, BLACK);
    drawRight(page, safe((bill.customerName || '-').toUpperCase()), W - M, y, 14, fb, BLACK);
    y -= 18;
  } else {
    // Compact continuation header.
    y = H - 68;
    page.drawText(safe(bill.billNumber || '-'), { x: M, y, size: 13, font: fb, color: BLACK });
    drawRight(page, '(continued)', W / 2 + 80, y, 11, fb, BLACK);
    drawRight(page, safe((bill.customerName || '-').toUpperCase()), W - M, y, 14, fb, BLACK);
    y -= 18;
  }

  page.drawLine({
    start: { x: M, y }, end: { x: W - M, y },
    thickness: 1.2, color: BLACK,
  });

  // ---------- Items table ----------
  // Serial column reserves room for THREE digits (max 999 products per
  // bill) and right-aligns numbers so "10" doesn't put its leading digit
  // under "9" — units digit always lines up. Larger fonts across the
  // board for client readability.
  const COL_SR_RIGHT  = M + 30;   // right edge of "#" column (fits "999" at 12pt bold)
  const COL_NAME_X    = M + 36;   // small gap to item name
  const COL_QTY_END   = M + 295;
  const COL_UNIT_X    = M + 310;
  const COL_RATE_END  = M + 435;
  const COL_AMT_END   = W - M - 4;
  const NAME_MAX_W    = COL_QTY_END - COL_NAME_X - 35;
  const ROW_H         = 22;   // taller rows for the bigger body font

  y -= 22;
  drawRight(page, '#', COL_SR_RIGHT, y, A4_HEADER_SIZE, fb, BLACK);
  page.drawText('Item', { x: COL_NAME_X, y, size: A4_HEADER_SIZE, font: fb, color: BLACK });
  drawRight(page, 'Qty', COL_QTY_END, y, A4_HEADER_SIZE, fb, BLACK);
  page.drawText('Unit', { x: COL_UNIT_X, y, size: A4_HEADER_SIZE, font: fb, color: BLACK });
  drawRight(page, 'Rate', COL_RATE_END, y, A4_HEADER_SIZE, fb, BLACK);
  drawRight(page, 'Amount', COL_AMT_END, y, A4_HEADER_SIZE, fb, BLACK);

  y -= 8;
  page.drawLine({
    start: { x: M, y }, end: { x: W - M, y },
    thickness: 1.0, color: BLACK,
  });

  // Body rows. Item name + numeric cells use the REGULAR font (`font`) —
  // bold on a long name like "ITRACONAZOLE 200 INJ" eats too much
  // horizontal real estate. Headers + serial number remain bold so the
  // table structure stays scannable. Name preserved as the user typed
  // it (no uppercase) — uppercasing also widens the line.
  productSlice.forEach((p, i) => {
    y -= A4_ROW_H;
    const qty = parseFloat(p.quantity) || 0;
    const price = parseFloat(p.price) || 0;
    const total = qty * price;
    const idx = itemStartIndex + i + 1;

    drawRight(page, String(idx), COL_SR_RIGHT, y, A4_NAME_SIZE, fb, BLACK);
    const nameLines = wrapText(safe(p.name), font, A4_NAME_SIZE, A4_NAME_MAX_W, 2);
    nameLines.forEach((line, lineIdx) => {
      page.drawText(line, {
        x: COL_NAME_X,
        y: y - lineIdx * A4_ROW_H_EXTRA_LINE,
        size: A4_NAME_SIZE,
        font,
        color: BLACK,
      });
    });
    drawRight(page, String(qty), COL_QTY_END, y, A4_NUMBER_SIZE, font, BLACK);
    page.drawText(safe(p.prefix || ''), { x: COL_UNIT_X, y, size: A4_NUMBER_SIZE, font, color: BLACK });
    drawRight(page, safeMoney(price), COL_RATE_END, y, A4_NUMBER_SIZE, font, BLACK);
    drawRight(page, safeMoney(total), COL_AMT_END, y, A4_NUMBER_SIZE, font, BLACK);
    if (nameLines.length > 1) y -= A4_ROW_H_EXTRA_LINE;
  });

  y -= 10;
  page.drawLine({
    start: { x: M, y }, end: { x: W - M, y },
    thickness: 1.0, color: BLACK,
  });

  if (!isLastPage) {
    // Non-last page: the "Continued" indicator is anchored at the BOTTOM
    // of the page (just above the page-number stamp) rather than dangling
    // right after the last item row. Same visual position whether the
    // page has 5 items or 25 — no awkward floating mid-page line.
    page.drawLine({
      start: { x: M, y: CONTINUED_Y + 14 }, end: { x: W - M, y: CONTINUED_Y + 14 },
      thickness: 0.8, color: BLACK,
    });
    drawRight(page, 'Continued on next page >>', W - M, CONTINUED_Y, 13, fb, BLACK);
    return;
  }

  // ---------- Totals (last page only) ----------
  // Anchor the totals block ABOVE the footer so the position is stable
  // regardless of item count. Avoids the "tons of empty space then
  // totals at the very bottom" we had before.
  const grandTotal = calculateTotal(bill.products);
  const totalsLeft = W - M - 230;
  const subtotalY = FOOTER_SEP_Y + 110;
  const grandY = FOOTER_SEP_Y + 78;
  const wordsLabelY = FOOTER_SEP_Y + 42;
  const wordsValueY = FOOTER_SEP_Y + 26;

  page.drawText('Subtotal', { x: totalsLeft, y: subtotalY, size: 12, font: fb, color: BLACK });
  drawRight(page, safeMoney(grandTotal), COL_AMT_END, subtotalY, 12, fb, BLACK);

  page.drawLine({
    start: { x: totalsLeft - 8, y: grandY + 16 }, end: { x: W - M, y: grandY + 16 },
    thickness: 1.4, color: BLACK,
  });
  page.drawText('Grand Total', { x: totalsLeft, y: grandY, size: 16, font: fb, color: BLACK });
  drawRight(page, safeMoney(grandTotal), COL_AMT_END, grandY, 16, fb, BLACK);
  page.drawLine({
    start: { x: totalsLeft - 8, y: grandY - 8 }, end: { x: W - M, y: grandY - 8 },
    thickness: 0.8, color: BLACK,
  });

  page.drawText('Amount in words:', { x: M, y: wordsLabelY, size: 10, font: fb, color: BLACK });
  page.drawText(numberToIndianWords(grandTotal), { x: M, y: wordsValueY, size: 11, font: fb, color: BLACK });

  // ---------- Footer ----------
  page.drawLine({
    start: { x: M, y: FOOTER_SEP_Y }, end: { x: W - M, y: FOOTER_SEP_Y },
    thickness: 0.8, color: BLACK,
  });
  if (bill.createdByProfileName) {
    page.drawText(safe(`Generated by: ${bill.createdByProfileName}`), {
      x: M, y: FOOTER_BASE_Y + 14, size: 10, font: fb, color: BLACK,
    });
  }
  page.drawText(
    `Issued on ${fmtDate(bill.createdAt)} ${pad(bill.createdAt.getHours())}:${pad(bill.createdAt.getMinutes())}`,
    { x: M, y: FOOTER_BASE_Y, size: 10, font: fb, color: BLACK },
  );
  const thanksText = 'Thank you for your business';
  const thanksW = fb.widthOfTextAtSize(thanksText, 11);
  page.drawText(thanksText, { x: W - M - thanksW, y: FOOTER_BASE_Y + 14, size: 11, font: fb, color: BLACK });
};

// A4 dynamic-fit constants. Each item's height is measured (single- or
// two-line wrap) and packed onto the page until the NEXT item would
// exceed the budget. Budgets are sized assuming THIS page may turn out
// to be the last — they leave just enough room at the bottom for the
// Subtotal + Grand Total + words + footer + page-#. Pages that don't end
// up being last simply leave the unused tail blank, which is fine since
// "Continued >>" is bottom-anchored.
const A4_ROW_H = 26;
const A4_ROW_H_EXTRA_LINE = 16;
// Item name + numeric cells use the REGULAR font (not bold) — bold ink on
// a long product name like "ITRACONAZOLE 200 INJ" eats more horizontal
// space than the regular weight, pushing the qty/rate/amount columns
// into the serial number. Slightly smaller too so 5–6 digit amounts
// (23000.00) still fit comfortably. Headers + totals stay bold.
const A4_NAME_SIZE = 13;
const A4_NUMBER_SIZE = 12;
const A4_HEADER_SIZE = 11;
// Items area = (y after table header) − (top of Subtotal − margin).
// First page header eats ~172pt; continuation header eats ~92pt. Totals
// chrome reserves ~200pt at the bottom of the last page.
const A4_FIRST_PAGE_ITEMS_BUDGET = 420;
const A4_CONT_PAGE_ITEMS_BUDGET = 540;
const A4_NAME_MAX_W = 230;

function chunkBillIntoA4Pages(bill: Bill, font: PDFFont): A4PageSlice[] {
  const products = bill.products || [];
  if (products.length === 0) {
    return [{ bill, pageInBill: 1, totalPagesInBill: 1, productSlice: [], itemStartIndex: 0 }];
  }

  // Measure with the REGULAR font + the name as the user typed it (no
  // uppercase) so the planner sees the same width the renderer will draw.
  const itemHeight = (p: Product): number => {
    const lines = wrapText(safe(p.name), font, A4_NAME_SIZE, A4_NAME_MAX_W, 2);
    return A4_ROW_H + (lines.length > 1 ? A4_ROW_H_EXTRA_LINE : 0);
  };

  const chunks: Product[][] = [];
  let current: Product[] = [];
  let consumed = 0;
  let onFirstPage = true;
  for (const p of products) {
    const ih = itemHeight(p);
    const budget = onFirstPage ? A4_FIRST_PAGE_ITEMS_BUDGET : A4_CONT_PAGE_ITEMS_BUDGET;
    if (consumed + ih > budget && current.length > 0) {
      chunks.push(current);
      current = [];
      consumed = 0;
      onFirstPage = false;
    }
    current.push(p);
    consumed += ih;
  }
  if (current.length) chunks.push(current);

  let startIdx = 0;
  return chunks.map((slice, i) => {
    const out: A4PageSlice = {
      bill,
      pageInBill: i + 1,
      totalPagesInBill: chunks.length,
      productSlice: slice,
      itemStartIndex: startIdx,
    };
    startIdx += slice.length;
    return out;
  });
}

// Dynamic-fit chunker constants. Instead of capping items per page at a
// fixed number (which left blank space on pages where every product name
// was short), we measure each row's height (single- or two-line) and
// pack the page until the NEXT row would overflow the items budget.
//
// Budgets in points = (block height) − (top header chrome) − (bottom
// reserved for Grand Total + page label). Two budgets: first page has
// the 2-row bill# + customer header (taller); continuation pages have a
// shorter header.
// Sized to use the entire items area up to (but not into) the Grand
// Total band on the last page. First page eats more chrome up top (full
// header), so its budget is slightly smaller than continuation pages.
const QUARTER_FIRST_PAGE_ITEMS_BUDGET = 305;
const QUARTER_CONT_PAGE_ITEMS_BUDGET = 320;
// Approximate name-column width on a quarter block. Slightly conservative
// so the chunker doesn't over-pack when the live renderer wraps a row
// that the estimator thought would fit on one line.
const QUARTER_NAME_MAX_W = 128;

interface QuarterBlock {
  bill: Bill;
  billIndex: number;     // 1-based among all selected bills
  billTotal: number;     // total bills in this print job
  pageInBill: number;    // 1-based within this bill
  totalPagesInBill: number;
  productSlice: Product[];
  itemStartIndex: number; // 0-based index of the first item in productSlice within bill.products
}

// Row-height step + body font sizes used by both the chunker (planning)
// and the renderer (drawing). Body uses the REGULAR font (not bold) and
// the name is preserved as-typed — bold + ALL CAPS made long product
// names like "Stainless Steel Bottle 750ml" overflow the column. Headers + grand
// total stay bold so the structure remains scannable.
const QUARTER_ROW_H = 18;
const QUARTER_ROW_H_EXTRA_LINE = 12;
const QUARTER_NAME_SIZE = 11;
const QUARTER_NUMBER_SIZE = 10;

/** Chunks a bill's products across as many quarter blocks as needed.
 *  Dynamic-fit: walks products and places each on the current page until
 *  the next item's measured height would overflow the page budget — then
 *  starts a new block. No fixed item-count cap. */
function chunkBillIntoQuarters(
  bill: Bill,
  billIndex: number,
  billTotal: number,
  font: PDFFont,
): QuarterBlock[] {
  const products = bill.products || [];
  if (products.length === 0) {
    return [{
      bill, billIndex, billTotal,
      pageInBill: 1, totalPagesInBill: 1,
      productSlice: [], itemStartIndex: 0,
    }];
  }

  // Measure with the REGULAR font + raw name (no uppercase) so the
  // planner sees the same width the renderer will draw.
  const itemHeight = (p: Product): number => {
    const lines = wrapText(safe(p.name), font, QUARTER_NAME_SIZE, QUARTER_NAME_MAX_W, 2);
    return QUARTER_ROW_H + (lines.length > 1 ? QUARTER_ROW_H_EXTRA_LINE : 0);
  };

  const chunks: Product[][] = [];
  let current: Product[] = [];
  let consumed = 0;
  let onFirstPage = true;
  for (const p of products) {
    const ih = itemHeight(p);
    const budget = onFirstPage
      ? QUARTER_FIRST_PAGE_ITEMS_BUDGET
      : QUARTER_CONT_PAGE_ITEMS_BUDGET;
    if (consumed + ih > budget && current.length > 0) {
      chunks.push(current);
      current = [];
      consumed = 0;
      onFirstPage = false;
    }
    current.push(p);
    consumed += ih;
  }
  if (current.length) chunks.push(current);

  let startIdx = 0;
  return chunks.map((slice, i) => {
    const block: QuarterBlock = {
      bill, billIndex, billTotal,
      pageInBill: i + 1,
      totalPagesInBill: chunks.length,
      productSlice: slice,
      itemStartIndex: startIdx,
    };
    startIdx += slice.length;
    return block;
  });
}

/**
 * Renders a single quarter-block. May be the first, a continuation, and/or the last
 * page of a multi-page bill. Full bill header appears only on the first page; grand
 * total only on the last page; non-final pages get a "Continued →" indicator.
 */
const drawQuarterBlock = (
  page: PDFPage,
  originX: number,
  originY: number,
  width: number,
  height: number,
  blk: QuarterBlock,
  business: BusinessInfo,
  font: PDFFont,
  bold: PDFFont,
) => {
  const { bill, pageInBill, totalPagesInBill, productSlice, itemStartIndex } = blk;
  const isFirstPage = pageInBill === 1;
  const isLastPage = pageInBill === totalPagesInBill;
  const pad = 14;

  // Quarter format prints to a B&W slip printer — every glyph stays
  // bold + pure black for maximum contrast. No color fills, no greys.
  const BLACK = rgb(0, 0, 0);
  const fb = bold;

  page.drawRectangle({
    x: originX,
    y: originY - height,
    width, height,
    borderWidth: 0.6,
    borderColor: BLACK,
  });

  let y = originY - pad - 4;

  if (isFirstPage) {
    // New layout — LEFT-STACKED bill identity:
    //   Top-left:   bill number (bold)
    //   Below:      customer name (UPPERCASE, slightly larger)
    //   Top-right:  business name (small)
    //   Below:      date
    // Putting bill# + customer on the same column means the eye scans the
    // most important info in one vertical sweep instead of zig-zagging.
    page.drawText(safe(bill.billNumber || ''), { x: originX + pad, y, size: 10, font: fb, color: BLACK });
    // Business name in the TOP-RIGHT corner (above the date). Natural
    // casing — e.g. "Acme Store" — at 9pt so it reads as the brand
    // anchor without crowding the bill number.
    if (business.name) {
      drawRight(page, safe(business.name), originX + width - pad, y, 9, fb, BLACK);
    }
    y -= 13;
    page.drawText(safe((bill.customerName || '-').toUpperCase()), { x: originX + pad, y, size: 10, font: fb, color: BLACK });
    drawRight(page, fmtDate(bill.createdAt), originX + width - pad, y, 9, fb, BLACK);
    y -= 8;
  } else {
    page.drawText(safe(bill.billNumber || ''), { x: originX + pad, y, size: 10, font: fb, color: BLACK });
    drawRight(page, '(continued)', originX + width - pad, y, 8, fb, BLACK);
    y -= 13;
    page.drawText(safe((bill.customerName || '-').toUpperCase()), { x: originX + pad, y, size: 10, font: fb, color: BLACK });
    y -= 8;
  }

  page.drawLine({
    start: { x: originX + pad, y },
    end: { x: originX + width - pad, y },
    thickness: 0.6,
    color: BLACK,
  });

  // Table header — units live in the header (`(B/P)`, `(Rs.)`) so the body
  // cells stay short and fit larger amounts/quantities. Headers stay bold
  // (10pt) so the column structure stands out against the regular-weight
  // body rows below them.
  y -= 16;
  // Reserve a SERIAL column wide enough for 3 digits ("999") at the body
  // font; numbers right-align so "10" sits its 0 under "9".
  const COL_SR_RIGHT = originX + pad + 20;
  const COL_NAME_X = originX + pad + 24;
  const COL_AMT_END = originX + width - pad;
  const COL_RATE_END = COL_AMT_END - 62;
  const COL_QTY_END = COL_RATE_END - 50;
  drawRight(page, '#', COL_SR_RIGHT, y, 10, fb, BLACK);
  page.drawText('Item', { x: COL_NAME_X, y, size: 10, font: fb, color: BLACK });
  drawRight(page, 'Qty', COL_QTY_END, y, 10, fb, BLACK);
  drawRight(page, 'Rate(Rs.)', COL_RATE_END, y, 10, fb, BLACK);
  drawRight(page, 'Amt(Rs.)', COL_AMT_END, y, 10, fb, BLACK);

  y -= 5;
  page.drawLine({
    start: { x: originX + pad, y },
    end: { x: originX + width - pad, y },
    thickness: 0.6,
    color: BLACK,
  });

  // Body rows.
  // - Item name: 11pt REGULAR (preserves the user's casing — "Itraconazole
  //   200 inj" reads naturally instead of being shouted in caps + bold).
  // - Numeric cells: 10pt regular. Bold here pushed 5-6 digit amounts
  //   over the column line.
  // - Serial number stays bold so it anchors the row.
  const nameMaxW = COL_QTY_END - COL_NAME_X - 12;
  const moneyStr = (n: number) =>
    n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  productSlice.forEach((p, i) => {
    y -= QUARTER_ROW_H;
    const idx = itemStartIndex + i + 1;
    const qty = parseFloat(p.quantity) || 0;
    const price = parseFloat(p.price) || 0;
    const total = qty * price;
    const unitWord = String(p.prefix || 'Box').toLowerCase().startsWith('p') ? 'pcs' : 'box';

    drawRight(page, `${idx}.`, COL_SR_RIGHT, y, QUARTER_NAME_SIZE, fb, BLACK);
    const lines = wrapText(safe(p.name), font, QUARTER_NAME_SIZE, nameMaxW, 2);
    lines.forEach((line, lineIdx) => {
      page.drawText(line, {
        x: COL_NAME_X,
        y: y - lineIdx * QUARTER_ROW_H_EXTRA_LINE,
        size: QUARTER_NAME_SIZE,
        font,
        color: BLACK,
      });
    });
    drawRight(page, `${qty} ${unitWord}`, COL_QTY_END, y, QUARTER_NUMBER_SIZE, font, BLACK);
    drawRight(page, moneyStr(price), COL_RATE_END, y, QUARTER_NUMBER_SIZE, font, BLACK);
    drawRight(page, moneyStr(total), COL_AMT_END, y, QUARTER_NUMBER_SIZE, font, BLACK);
    if (lines.length > 1) y -= QUARTER_ROW_H_EXTRA_LINE;
  });

  if (!isLastPage) {
    // "Continued" is BOTTOM-ANCHORED inside the quarter block — pinned
    // just above the page label so the line is always in the same place
    // regardless of how many items the page held.
    const continuedY = originY - height + pad + 18;
    page.drawLine({
      start: { x: originX + pad, y: continuedY + 14 },
      end: { x: originX + width - pad, y: continuedY + 14 },
      thickness: 0.6,
      color: BLACK,
    });
    drawRight(page, 'Continued on next page >>', originX + width - pad, continuedY, 10, fb, BLACK);
  } else {
    // Grand total — bottom-anchored, no fill. Single thick rule above,
    // single hairline below.
    const grandTotal = calculateTotal(bill.products);
    const totalY = originY - height + pad + 18;

    page.drawLine({
      start: { x: originX + pad, y: totalY + 14 },
      end: { x: originX + width - pad, y: totalY + 14 },
      thickness: 0.8,
      color: BLACK,
    });
    page.drawText('Grand Total', { x: originX + pad, y: totalY, size: 12, font: fb, color: BLACK });
    drawRight(page, safeMoney(grandTotal), originX + width - pad, totalY, 13, fb, BLACK);
    page.drawLine({
      start: { x: originX + pad, y: totalY - 5 },
      end: { x: originX + width - pad, y: totalY - 5 },
      thickness: 0.5,
      color: BLACK,
    });
  }

  // Page label — bottom-right of the block, OUTSIDE the totals zone so
  // it never overlaps the date in the header row.
  const cornerText = `Page ${pageInBill} of ${totalPagesInBill}`;
  const cornerW = fb.widthOfTextAtSize(cornerText, 7);
  page.drawText(cornerText, {
    x: originX + width - pad - cornerW,
    y: originY - height + 6,
    size: 7,
    font: fb,
    color: BLACK,
  });
};

async function buildPdfDoc(selectedBills: Bill[], options: GeneratePDFOptions): Promise<PDFDocument> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const business = await getBusinessInfo();

  const A4_WIDTH = 595.28;
  const A4_HEIGHT = 841.89;
  const isQuarter = options.paperSize === 'QUARTER';

  if (!isQuarter) {
    // Chunk every bill across as many A4 pages as it needs, then stamp
    // PER-BILL page numbers ("Page X of Y" reset for each bill). Multi-
    // page bills no longer crash totals into the footer — when the items
    // overflow the items area, drawA4Bill writes "Continued >>" and the
    // totals + grand total + footer render on the FINAL page only.
    for (const bill of selectedBills) {
      // Pass the REGULAR font — the chunker measures item names with it
      // so the planner agrees with the renderer (which now draws names
      // in the regular weight, not bold).
      const slices = chunkBillIntoA4Pages(bill, font);
      for (const slice of slices) {
        const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
        drawA4Bill(page, slice, business, font, bold);
        stampPageNumber(page, font, slice.pageInBill, slice.totalPagesInBill);
      }
    }
  } else {
    const cols = 2;
    const rows = 2;
    const blockW = A4_WIDTH / cols;
    const blockH = A4_HEIGHT / rows;

    // Build a flat list of quarter blocks — one per (bill, bill-page).
    // chunkBillIntoQuarters needs the REGULAR font for measurement since
    // the renderer draws item names in the regular weight (not bold).
    const blocks: QuarterBlock[] = [];
    selectedBills.forEach((bill, i) => {
      blocks.push(...chunkBillIntoQuarters(bill, i + 1, selectedBills.length, font));
    });

    let page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
    blocks.forEach((blk, slotIdx) => {
      if (slotIdx > 0 && slotIdx % (cols * rows) === 0) {
        page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
      }
      const slotOnPage = slotIdx % (cols * rows);
      const col = slotOnPage % cols;
      const row = Math.floor(slotOnPage / cols);
      drawQuarterBlock(
        page,
        col * blockW,
        A4_HEIGHT - row * blockH,
        blockW,
        blockH,
        blk,
        business,
        font,
        bold,
      );
    });
  }
  return pdfDoc;
}

function stampPageNumber(page: PDFPage, font: PDFFont, current: number, total: number): void {
  const text = `Page ${current} of ${total}`;
  const size = 8;
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: page.getWidth() / 2 - w / 2,
    y: 28,
    size,
    font,
    color: rgb(0, 0, 0),
  });
}

async function savePdfDoc(pdfDoc: PDFDocument, fileName: string): Promise<GeneratedPDF> {
  const base64Data = await pdfDoc.saveAsBase64();

  // Prefer the public Downloads folder so the user finds the PDF where they
  // expect (Files app → Downloads). Android's Filesystem.ExternalStorage +
  // "Download/<name>" maps to /storage/emulated/0/Download/, which is the
  // standard public Downloads directory. Scoped storage on Android 11+ can
  // refuse the write — in that case we fall back to the app-private external
  // dir which always succeeds.
  try {
    const downloadPath = `Download/${fileName}`;
    await Filesystem.writeFile({
      path: downloadPath,
      data: base64Data,
      directory: Directory.ExternalStorage,
    });
    const { uri } = await Filesystem.getUri({
      path: downloadPath,
      directory: Directory.ExternalStorage,
    });
    return { uri, fileName, base64: base64Data };
  } catch {
    // Fallback — app-private external storage. Always writable.
    await Filesystem.writeFile({ path: fileName, data: base64Data, directory: EXPORT_DIR });
    const { uri } = await Filesystem.getUri({ path: fileName, directory: EXPORT_DIR });
    return { uri, fileName, base64: base64Data };
  }
}

/** Writes the PDF to device storage WITHOUT auto-opening. Caller decides what to do next. */
export async function generateBillsPDF(
  selectedBills: Bill[],
  options: GeneratePDFOptions = {},
): Promise<GeneratedPDF> {
  const pdfDoc = await buildPdfDoc(selectedBills, options);
  return savePdfDoc(pdfDoc, `Bills_${Date.now()}.pdf`);
}

/** Alias retained for backwards compat. Both functions are now identical. */
export const generateBillsPDFForShare = generateBillsPDF;

// ---------- small helpers ----------

function drawRight(
  page: PDFPage,
  text: string,
  rightX: number,
  y: number,
  size: number,
  font: PDFFont,
  color: any,
): void {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rightX - w, y, size, font, color });
}

/**
 * Greedy word-wrap that fits `text` into at most `maxLines` lines of width
 * `maxWidth`. Tokens longer than maxWidth (a single huge word) are broken
 * character-by-character. If the text still doesn't fit in maxLines, the
 * last line ends with an ellipsis via truncate(). Used for ALL-CAPS product
 * names in the quarter bill — short names render on one row, long ones
 * wrap to a second row instead of being clipped.
 */
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const measure = (s: string) => font.widthOfTextAtSize(s, size);
  const lines: string[] = [];
  let current = '';

  const pushWord = (word: string) => {
    // If a single word overflows maxWidth on its own, split it character-
    // wise so we don't drop content. Rare for product names but possible
    // with concatenated SKU codes.
    if (measure(word) > maxWidth) {
      let buf = '';
      for (const ch of word) {
        if (measure(buf + ch) > maxWidth) {
          if (current) lines.push(current);
          current = buf;
          if (lines.length >= maxLines - 1) {
            return false;
          }
          lines.push(current);
          current = '';
          buf = ch;
        } else {
          buf += ch;
        }
      }
      word = buf;
    }
    const trial = current ? `${current} ${word}` : word;
    if (measure(trial) <= maxWidth) {
      current = trial;
      return true;
    }
    if (current) lines.push(current);
    current = word;
    return true;
  };

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (lines.length >= maxLines) break;
    pushWord(word);
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = truncate(lines[maxLines - 1], font, size, maxWidth);
  }
  return lines.length ? lines : [''];
}

function truncate(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (!text) return '';
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(0, mid) + '…';
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  return text.slice(0, Math.max(1, lo - 1)) + '…';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
