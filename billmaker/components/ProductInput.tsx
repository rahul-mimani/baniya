// src/components/ProductInput.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Fuse from 'fuse.js';
import { getProducts } from '../storage/productStorage';
import { KeyboardSuggestionsBar } from './ui';

interface ProductInputProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  maxSuggestions?: number;
}

const ProductInput: React.FC<ProductInputProps> = ({
  value,
  onChange,
  placeholder = 'Enter product name',
  maxSuggestions = 12,
}) => {
  const [products, setProducts] = useState<string[]>([]);
  const [filtered, setFiltered] = useState<string[]>([]);
  const [showList, setShowList] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refresh on mount, on focus, and on tab visibility change — same reason as
  // CustomerInput: Firestore listener can update products.json after this
  // component has already mounted, and the in-memory list would otherwise stay stale.
  const reloadProducts = async () => {
    try {
      const list = await getProducts();
      setProducts(list);
    } catch {}
  };

  useEffect(() => {
    reloadProducts();
    const onVisible = () => {
      if (document.visibilityState === 'visible') reloadProducts();
    };
    // Live refresh when the Firestore products subscription mutates the local
    // file (e.g. admin deletes a product from the portal). Without this the
    // autocomplete shows stale entries until the next visibility change.
    const onProductsUpdated = () => reloadProducts();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('billmaker-products-updated', onProductsUpdated);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('billmaker-products-updated', onProductsUpdated);
    };
  }, []);

  const fuse = useMemo(
    () =>
      new Fuse(products, {
        threshold: 0.4,
        distance: 100,
        minMatchCharLength: 1,
      }),
    [products]
  );

  const computeFiltered = (val: string): string[] => {
    if (val.trim() === '') return [];
    const pre = products.filter(p =>
      p.toLowerCase().startsWith(val.toLowerCase()),
    );
    if (pre.length >= 5) return pre.slice(0, maxSuggestions);
    const results = fuse.search(val);
    return results.map(r => r.item).slice(0, maxSuggestions);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onChange(val);
    const next = computeFiltered(val);
    setFiltered(next);
    setShowList(next.length > 0);
  };

  const handleSelect = (name: string) => {
    onChange(name);
    setFiltered([]);
    setShowList(false);
    // Drop focus so the keyboard dismisses — the user picked a value and
    // the next thing they'll tap is the qty/price field anyway.
    inputRef.current?.blur();
  };

  const handleFocus = () => {
    reloadProducts();
    if (value.trim()) {
      const next = computeFiltered(value);
      setFiltered(next);
      setShowList(next.length > 0);
    }
    // When the soft keyboard appears it pushes the input down. Scroll the
    // row to TOP of the scroll container (block: 'start'), letting the
    // input's scroll-margin-top reserve room for the sticky "Items" bar
    // so the focused field lands just BELOW that bar — never covered by
    // the keyboard, the chip bar, or the sticky header.
    window.setTimeout(() => {
      inputRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 250);
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onFocus={handleFocus}
        // Slight delay so a tap on a chip can fire onMouseDown before blur
        // clears the list. The chip bar uses preventDefault on mousedown so
        // focus stays put — but if the user taps elsewhere, hide.
        onBlur={() => setTimeout(() => setShowList(false), 150)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 transition bg-white text-slate-900"
        // scrollMarginTop reserves room for the sticky "Items" header
        // (~52pt) so block:'start' scrollIntoView puts the field BELOW
        // that bar. scrollMarginBottom keeps room for the keyboard
        // suggestion chip strip.
        style={{ scrollMarginTop: 60, scrollMarginBottom: 80 }}
        autoComplete="off"
      />
      {showList && (
        <KeyboardSuggestionsBar
          suggestions={filtered}
          onSelect={handleSelect}
        />
      )}
    </div>
  );
};

export default ProductInput;
