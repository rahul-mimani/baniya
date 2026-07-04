import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { Filesystem } from '@capacitor/filesystem';
import { Bill, BusinessInfo, Product } from '../types';
import { EXPORT_DIR } from '../storage/paths';
import { getBusinessInfo } from '../storage/businessStorage';
import { numberToIndianWords } from './numberToWords';

const PRIMARY = rgb(0.0117, 0.5176, 0.7803); // sky-700
const TEXT = rgb(0.118, 0.161, 0.231); // slate-800
const MUTED = rgb(0.392, 0.455, 0.545); // slate-500
const HAIRLINE = rgb(0.835, 0.871, 0.898); // slate-300
const BAND = rgb(0.94, 0.97, 1); // sky-50

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 40;

const calcTotal = (products: Product[]) =>
  products.reduce(
    (a, p) => a + (parseFloat(p.quantity) || 0) * (parseFloat(p.price) || 0),
    0,
  );

const fmtMoney = (n: number) =>
  `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d: Date) => {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
};

/** Strip characters pdf-lib's WinAnsi (Latin-1) font can't encode. */
const safe = (s: any): string => {
  if (s == null) return '';
  return String(s)
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');
};

function drawRight(page: PDFPage, text: string, rightX: number, y: number, size: number, font: PDFFont, color: any) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rightX - w, y, size, font, color });
}

function truncate(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (!text) return '';
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (font.widthOfTextAtSize(text.slice(0, mid) + '…', size) <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  return text.slice(0, Math.max(1, lo - 1)) + '…';
}

export interface BlotterArgs {
  bills: Bill[];
  customerName: string;
  startDate: Date;
  endDate: Date;
}

export interface GeneratedBlotterPDF {
  uri: string;
  fileName: string;
  base64: string;
}

interface PageContext {
  page: PDFPage;
  y: number;
}

function drawTopBand(
  pdfDoc: PDFDocument,
  business: BusinessInfo,
  args: BlotterArgs,
  isFirst: boolean,
  font: PDFFont,
  bold: PDFFont,
): PageContext {
  const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  const bandHeight = isFirst ? 110 : 60;

  // Sky band
  page.drawRectangle({ x: 0, y: A4_HEIGHT - bandHeight, width: A4_WIDTH, height: bandHeight, color: PRIMARY });

  // Business name (or fallback)
  page.drawText(safe(business.name || 'Customer Statement'), {
    x: MARGIN,
    y: A4_HEIGHT - 36,
    size: 18,
    font: bold,
    color: rgb(1, 1, 1),
  });

  // Right-aligned title
  const titleText = 'CUSTOMER STATEMENT';
  const titleW = bold.widthOfTextAtSize(titleText, 13);
  page.drawText(titleText, {
    x: A4_WIDTH - MARGIN - titleW,
    y: A4_HEIGHT - 36,
    size: 13,
    font: bold,
    color: rgb(1, 1, 1),
  });

  if (isFirst) {
    // Business meta
    const subBits = [business.phone, business.gst && `ID: ${business.gst}`].filter(Boolean) as string[];
    if (subBits.length) {
      page.drawText(safe(subBits.join('  •  ')), {
        x: MARGIN,
        y: A4_HEIGHT - 54,
        size: 9,
        font,
        color: rgb(0.85, 0.94, 0.99),
      });
    }

    // Customer + range info
    const infoY = A4_HEIGHT - 90;
    page.drawText('Customer', { x: MARGIN, y: infoY, size: 9, font: bold, color: rgb(1, 1, 1) });
    page.drawText(truncate(safe(args.customerName), bold, 13, 320), {
      x: MARGIN, y: infoY - 14, size: 13, font: bold, color: rgb(1, 1, 1),
    });

    page.drawText('Period', { x: MARGIN + 360, y: infoY, size: 9, font: bold, color: rgb(1, 1, 1) });
    page.drawText(`${fmtDate(args.startDate)} — ${fmtDate(args.endDate)}`, {
      x: MARGIN + 360, y: infoY - 14, size: 11, font, color: rgb(1, 1, 1),
    });

    return { page, y: A4_HEIGHT - bandHeight - 30 };
  }

  return { page, y: A4_HEIGHT - bandHeight - 20 };
}

function ensureSpace(ctx: PageContext, needed: number, pdfDoc: PDFDocument, business: BusinessInfo, args: BlotterArgs, font: PDFFont, bold: PDFFont, pages: PDFPage[]): PageContext {
  if (ctx.y - needed >= MARGIN + 30) return ctx;
  const next = drawTopBand(pdfDoc, business, args, false, font, bold);
  pages.push(next.page);
  return next;
}

function drawBillBlock(
  ctx: PageContext,
  bill: Bill,
  font: PDFFont,
  bold: PDFFont,
): PageContext {
  const { page } = ctx;
  let y = ctx.y;
  const left = MARGIN;
  const right = A4_WIDTH - MARGIN;

  // Bill header line
  page.drawText(safe(bill.billNumber || '—'), { x: left, y, size: 11, font: bold, color: PRIMARY });
  drawRight(page, fmtDate(bill.createdAt), right, y, 10, font, MUTED);
  y -= 16;

  // Items table header
  page.drawRectangle({ x: left, y: y - 4, width: right - left, height: 16, color: BAND });
  page.drawText('Item', { x: left + 6, y: y, size: 8, font: bold, color: TEXT });
  drawRight(page, 'Qty', right - 180, y, 8, bold, TEXT);
  page.drawText('Unit', { x: right - 165, y, size: 8, font: bold, color: TEXT });
  drawRight(page, 'Rate', right - 90, y, 8, bold, TEXT);
  drawRight(page, 'Amount', right - 6, y, 8, bold, TEXT);
  y -= 14;

  // Items rows
  for (const p of bill.products) {
    const qty = parseFloat(p.quantity) || 0;
    const price = parseFloat(p.price) || 0;
    const total = qty * price;
    page.drawText(truncate(safe(p.name), font, 10, right - left - 260), { x: left + 6, y, size: 10, font, color: TEXT });
    drawRight(page, String(qty), right - 180, y, 10, font, TEXT);
    page.drawText(safe(p.prefix || ''), { x: right - 165, y, size: 10, font, color: TEXT });
    drawRight(page, fmtMoney(price), right - 90, y, 10, font, TEXT);
    drawRight(page, fmtMoney(total), right - 6, y, 10, font, TEXT);
    y -= 14;
  }
  // single solid line below the last item, above the bill total
  page.drawLine({ start: { x: left, y: y + 6 }, end: { x: right, y: y + 6 }, thickness: 0.5, color: HAIRLINE });

  // Bill total
  const billTotal = calcTotal(bill.products);
  y -= 4;
  drawRight(page, `Bill Total: ${fmtMoney(billTotal)}`, right - 6, y, 11, bold, TEXT);
  y -= 18;

  // Solid block separator
  page.drawLine({ start: { x: left, y: y + 4 }, end: { x: right, y: y + 4 }, thickness: 1, color: PRIMARY });
  y -= 20;

  return { page, y };
}

function stampPageNumber(page: PDFPage, font: PDFFont, current: number, total: number, customerLabel: string) {
  const footerY = 28;
  // Customer + page label
  page.drawText(customerLabel, { x: MARGIN, y: footerY, size: 8, font, color: MUTED });
  const pageText = `Page ${current} of ${total}`;
  const w = font.widthOfTextAtSize(pageText, 8);
  page.drawText(pageText, { x: A4_WIDTH - MARGIN - w, y: footerY, size: 8, font, color: MUTED });
}

export async function generateBlotterPDF(args: BlotterArgs): Promise<GeneratedBlotterPDF> {
  if (args.bills.length === 0) throw new Error('No bills to include in the statement.');

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const business = await getBusinessInfo();

  // Sort bills ascending by date
  const sorted = [...args.bills].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const pages: PDFPage[] = [];
  let ctx = drawTopBand(pdfDoc, business, args, true, font, bold);
  pages.push(ctx.page);

  for (const bill of sorted) {
    // Estimate height: header + per-row + total + separator
    const needed = 16 + 16 + bill.products.length * 14 + 22 + 24;
    ctx = ensureSpace(ctx, needed, pdfDoc, business, args, font, bold, pages);
    ctx = drawBillBlock(ctx, bill, font, bold);
  }

  // Final cumulative total
  const cumulativeTotal = sorted.reduce((s, b) => s + calcTotal(b.products), 0);
  ctx = ensureSpace(ctx, 80, pdfDoc, business, args, font, bold, pages);
  const { page } = ctx;
  let y = ctx.y;

  page.drawRectangle({ x: MARGIN, y: y - 28, width: A4_WIDTH - 2 * MARGIN, height: 36, color: PRIMARY });
  page.drawText('Cumulative Total', { x: MARGIN + 12, y: y - 14, size: 13, font: bold, color: rgb(1, 1, 1) });
  drawRight(page, fmtMoney(cumulativeTotal), A4_WIDTH - MARGIN - 12, y - 14, 14, bold, rgb(1, 1, 1));
  y -= 56;

  // Amount in words
  page.drawText('Amount in words:', { x: MARGIN, y, size: 9, font: bold, color: MUTED });
  y -= 14;
  page.drawText(numberToIndianWords(cumulativeTotal), { x: MARGIN, y, size: 10, font, color: TEXT });

  // Stamp page numbers on every page
  const customerLabel = `${args.customerName} • ${fmtDate(args.startDate)} to ${fmtDate(args.endDate)}`;
  pages.forEach((p, i) => stampPageNumber(p, font, i + 1, pages.length, customerLabel));

  // Save
  const base64Data = await pdfDoc.saveAsBase64();
  const safeCustomer = args.customerName.replace(/[^\w-]+/g, '_').slice(0, 30);
  const fileName = `Statement_${safeCustomer}_${Date.now()}.pdf`;
  await Filesystem.writeFile({ path: fileName, data: base64Data, directory: EXPORT_DIR });
  const { uri } = await Filesystem.getUri({ path: fileName, directory: EXPORT_DIR });
  return { uri, fileName, base64: base64Data };
}
