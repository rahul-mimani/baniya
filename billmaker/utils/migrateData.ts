import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Bill, Product } from '../types';
import { APP_DIR, LEGACY_DIR } from '../storage/paths';

export interface MigrationReport {
  bills: { total: number; fixed: number };
  customers: { total: number; fixed: number };
  products: { total: number; fixed: number };
  errors: string[];
}

const readFrom = async (path: string, dir: Directory): Promise<unknown> => {
  try {
    const result = await Filesystem.readFile({
      path,
      directory: dir,
      encoding: Encoding.UTF8,
    });
    const dataStr = typeof result.data === 'string' ? result.data : await result.data.text();
    return JSON.parse(dataStr);
  } catch {
    return null;
  }
};

/** Reads from APP_DIR first, falls back to LEGACY_DIR (Documents from older builds). */
const readAnywhere = async (path: string): Promise<{ raw: unknown; source: 'app' | 'legacy' | 'none' }> => {
  const current = await readFrom(path, APP_DIR);
  if (current !== null) return { raw: current, source: 'app' };
  const legacy = await readFrom(path, LEGACY_DIR);
  if (legacy !== null) return { raw: legacy, source: 'legacy' };
  return { raw: null, source: 'none' };
};

const writeApp = async (path: string, data: unknown): Promise<void> => {
  await Filesystem.writeFile({
    path,
    directory: APP_DIR,
    encoding: Encoding.UTF8,
    data: JSON.stringify(data, null, 2),
  });
};

const coerceString = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name.trim() || null;
    if (typeof obj.title === 'string') return obj.title.trim() || null;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
};

const isProductCanonical = (p: any): boolean =>
  !!p &&
  typeof p === 'object' &&
  typeof p.id === 'string' &&
  typeof p.name === 'string' &&
  (p.prefix === 'Box' || p.prefix === 'Pieces') &&
  typeof p.quantity === 'string' &&
  typeof p.price === 'string';

const coerceProduct = (p: any, i: number, j: number): Product => ({
  id: p?.id != null ? String(p.id) : `${Date.now()}-${i}-${j}`,
  name: typeof p?.name === 'string' ? p.name : '',
  prefix: p?.prefix === 'Pieces' ? 'Pieces' : 'Box',
  quantity: p?.quantity != null ? String(p.quantity) : '0',
  price: p?.price != null ? String(p.price) : '0',
});

const isBillCanonical = (b: any): boolean =>
  !!b &&
  typeof b === 'object' &&
  typeof b.id === 'string' &&
  typeof b.billNumber === 'string' &&
  typeof b.customerName === 'string' &&
  Array.isArray(b.products) &&
  b.products.every(isProductCanonical) &&
  typeof b.createdAt === 'string' && // serialized form
  typeof b.updatedAt === 'string';

export const migrateAllData = async (): Promise<MigrationReport> => {
  const report: MigrationReport = {
    bills: { total: 0, fixed: 0 },
    customers: { total: 0, fixed: 0 },
    products: { total: 0, fixed: 0 },
    errors: [],
  };

  const readBoth = async (path: string): Promise<unknown[]> => {
    const fromApp = await readFrom(path, APP_DIR);
    const fromLegacy = await readFrom(path, LEGACY_DIR);
    const out: unknown[] = [];
    if (Array.isArray(fromApp)) out.push(...fromApp);
    if (Array.isArray(fromLegacy)) out.push(...fromLegacy);
    return out;
  };

  // ------- Bills (merge app + legacy by id) -------
  try {
    const entries = await readBoth('bills.json');
    report.bills.total = entries.length;

    const parseDate = (v: any): { iso: string; fixed: boolean } => {
      if (typeof v === 'string') {
        const d = new Date(v);
        if (!isNaN(d.getTime())) return { iso: d.toISOString(), fixed: false };
      }
      if (v instanceof Date && !isNaN(v.getTime())) return { iso: v.toISOString(), fixed: false };
      return { iso: new Date().toISOString(), fixed: true };
    };

    const seenIds = new Set<string>();
    const migrated: any[] = [];
    entries.forEach((entry: any, i) => {
      const wasCanonical = isBillCanonical(entry);
      const products = Array.isArray(entry?.products)
        ? entry.products.map((p: any, j: number) => coerceProduct(p, i, j))
        : [];
      const created = parseDate(entry?.createdAt);
      const updated = parseDate(entry?.updatedAt ?? entry?.createdAt);
      const id = entry?.id != null ? String(entry.id) : `legacy-${Date.now()}-${i}`;
      if (seenIds.has(id)) {
        report.bills.fixed++;
        return;
      }
      seenIds.add(id);
      const bill = {
        id,
        billNumber:
          typeof entry?.billNumber === 'string' && entry.billNumber.trim()
            ? entry.billNumber
            : `LE-${String(migrated.length + 1).padStart(7, '0')}`,
        customerName: typeof entry?.customerName === 'string' ? entry.customerName : 'Unknown',
        products,
        createdAt: created.iso,
        updatedAt: updated.iso,
        createdByProfileId:
          typeof entry?.createdByProfileId === 'string' ? entry.createdByProfileId : null,
        createdByProfileName:
          typeof entry?.createdByProfileName === 'string' ? entry.createdByProfileName : null,
      };
      if (!wasCanonical || created.fixed || updated.fixed) report.bills.fixed++;
      migrated.push(bill);
    });

    await writeApp('bills.json', migrated);
  } catch (e: any) {
    report.errors.push(`Bills: ${e?.message || 'unknown error'}`);
  }

  // ------- Customers (merge unique, case-insensitive) -------
  try {
    const entries = await readBoth('customers.json');
    report.customers.total = entries.length;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of entries) {
      const s = coerceString(entry);
      if (typeof entry !== 'string') report.customers.fixed++;
      if (s && !seen.has(s.toLowerCase())) {
        seen.add(s.toLowerCase());
        out.push(s);
      }
    }
    await writeApp('customers.json', out);
  } catch (e: any) {
    report.errors.push(`Customers: ${e?.message || 'unknown error'}`);
  }

  // ------- Products (merge unique, case-insensitive) -------
  try {
    const entries = await readBoth('products.json');
    report.products.total = entries.length;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of entries) {
      const s = coerceString(entry);
      if (typeof entry !== 'string') report.products.fixed++;
      if (s && !seen.has(s.toLowerCase())) {
        seen.add(s.toLowerCase());
        out.push(s);
      }
    }
    await writeApp('products.json', out);
  } catch (e: any) {
    report.errors.push(`Products: ${e?.message || 'unknown error'}`);
  }

  return report;
};
