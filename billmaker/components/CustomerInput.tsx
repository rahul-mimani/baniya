// src/components/CustomerInput.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Fuse from 'fuse.js';
import { getCustomers } from '../storage/customerStorage';
import { KeyboardSuggestionsBar } from './ui';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxSuggestions?: number;
}

const CustomerInput: React.FC<Props> = ({ value, onChange, maxSuggestions = 12 }) => {
  const [customers, setCustomers] = useState<string[]>([]);
  const [filtered, setFiltered] = useState<string[]>([]);
  const [showList, setShowList] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refresh the customer list on (a) mount, (b) when the input gains focus,
  // and (c) whenever the tab/app becomes visible again. Without this, names
  // pushed into customers.json by the Firestore listener after the bill screen
  // has opened would never appear in autocomplete until app restart.
  const reloadCustomers = async () => {
    try {
      const list = await getCustomers();
      setCustomers(list);
    } catch {}
  };

  useEffect(() => {
    reloadCustomers();
    const onVisible = () => {
      if (document.visibilityState === 'visible') reloadCustomers();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const fuse = useMemo(() => {
    return new Fuse(customers, {
      threshold: 0.45,
      distance: 100,
      minMatchCharLength: 1,
    });
  }, [customers]);

  const computeFiltered = (val: string): string[] => {
    if (val.trim() === '') return [];
    const pre = customers.filter(c => c.toLowerCase().startsWith(val.toLowerCase()));
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
    inputRef.current?.blur();
  };

  const handleFocus = () => {
    reloadCustomers();
    if (value.trim()) {
      const next = computeFiltered(value);
      setFiltered(next);
      setShowList(next.length > 0);
    }
    // Anchor the field to the TOP of the scroll container — scrollMarginTop
    // keeps it clear of the sticky header so it can't be covered by the
    // soft keyboard.
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
        onBlur={() => setTimeout(() => setShowList(false), 150)}
        placeholder="Enter customer's name"
        className="w-full px-4 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 transition bg-white text-slate-900"
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

export default CustomerInput;
