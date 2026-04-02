'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

interface NamerSelectProps {
    options: string[];
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    /** Show search input when options exceed this threshold */
    searchThreshold?: number;
    /** Visual variant */
    variant?: 'default' | 'required' | 'optional';
    /** Custom display label for options (defaults to raw value) */
    formatLabel?: (value: string) => string;
}

const SEARCH_THRESHOLD = 6;

export default function NamerSelect({
    options,
    value,
    onChange,
    placeholder = 'Select…',
    disabled = false,
    searchThreshold = SEARCH_THRESHOLD,
    variant = 'default',
    formatLabel,
}: NamerSelectProps) {
    const label = (v: string) => formatLabel ? formatLabel(v) : v;
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [highlightedIndex, setHighlightedIndex] = useState(-1);
    const containerRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const showSearch = options.length >= searchThreshold;

    const filtered = search
        ? options.filter(o => label(o).toLowerCase().includes(search.toLowerCase()))
        : options;

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
                setSearch('');
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [isOpen]);

    // Focus search on open
    useEffect(() => {
        if (isOpen && showSearch) {
            setTimeout(() => searchRef.current?.focus(), 0);
        }
    }, [isOpen, showSearch]);

    // Scroll highlighted item into view
    useEffect(() => {
        if (highlightedIndex < 0 || !listRef.current) return;
        const items = listRef.current.querySelectorAll('[data-option]');
        items[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
    }, [highlightedIndex]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (!isOpen) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault();
                setIsOpen(true);
            }
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setHighlightedIndex(prev => Math.min(prev + 1, filtered.length - 1));
                break;
            case 'ArrowUp':
                e.preventDefault();
                setHighlightedIndex(prev => Math.max(prev - 1, 0));
                break;
            case 'Enter':
                e.preventDefault();
                if (highlightedIndex >= 0 && filtered[highlightedIndex]) {
                    onChange(filtered[highlightedIndex]);
                    setIsOpen(false);
                    setSearch('');
                }
                break;
            case 'Escape':
                e.preventDefault();
                setIsOpen(false);
                setSearch('');
                break;
        }
    }, [isOpen, filtered, highlightedIndex, onChange]);

    const select = (opt: string) => {
        onChange(opt);
        setIsOpen(false);
        setSearch('');
        setHighlightedIndex(-1);
    };

    // Border color based on variant
    const borderColor = variant === 'required'
        ? 'var(--ram-accent)'
        : variant === 'optional'
            ? 'var(--ram-teal)'
            : 'var(--ram-border)';

    const triggerBg = variant === 'required' && !value
        ? 'rgba(232, 160, 72, 0.08)'
        : variant === 'optional'
            ? 'rgba(45, 212, 191, 0.05)'
            : 'var(--ram-bg-secondary)';

    return (
        <div ref={containerRef} className="namer-select" style={{ position: 'relative' }} onKeyDown={handleKeyDown}>
            {/* Trigger */}
            <button
                type="button"
                onClick={() => { if (!disabled) { setIsOpen(!isOpen); setHighlightedIndex(-1); } }}
                disabled={disabled}
                className="namer-select__trigger"
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: '6px',
                    border: `1px solid ${borderColor}`,
                    background: triggerBg,
                    color: value ? 'var(--ram-text-primary)' : (
                        variant === 'required' ? 'var(--ram-accent)' : 'var(--ram-text-tertiary)'
                    ),
                    fontSize: '12px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.5 : 1,
                    textAlign: 'left',
                    transition: 'border-color 0.15s, background 0.15s',
                }}
            >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {value ? label(value) : placeholder}
                </span>
                <svg
                    width="10" height="10" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="2.5"
                    style={{
                        flexShrink: 0,
                        marginLeft: '6px',
                        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.15s',
                    }}
                >
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>

            {/* Dropdown */}
            {isOpen && (
                <div
                    className="namer-select__dropdown"
                    style={{
                        position: 'absolute',
                        top: 'calc(100% + 4px)',
                        left: 0,
                        right: 0,
                        minWidth: '180px',
                        maxHeight: '260px',
                        background: '#1e2028',
                        border: '1px solid var(--ram-border)',
                        borderRadius: '8px',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                        zIndex: 100,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                    }}
                >
                    {/* Search */}
                    {showSearch && (
                        <div style={{
                            padding: '8px 8px 4px',
                            borderBottom: '1px solid var(--ram-border)',
                        }}>
                            <div style={{ position: 'relative' }}>
                                <svg
                                    width="12" height="12" viewBox="0 0 24 24"
                                    fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2"
                                    style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)' }}
                                >
                                    <circle cx="11" cy="11" r="8" />
                                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                                <input
                                    ref={searchRef}
                                    type="text"
                                    value={search}
                                    onChange={e => { setSearch(e.target.value); setHighlightedIndex(0); }}
                                    placeholder="Search…"
                                    style={{
                                        width: '100%',
                                        padding: '6px 8px 6px 28px',
                                        border: '1px solid var(--ram-border)',
                                        borderRadius: '5px',
                                        background: 'var(--ram-bg-secondary)',
                                        color: 'var(--ram-text-primary)',
                                        fontSize: '11px',
                                        outline: 'none',
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    {/* Options list */}
                    <div ref={listRef} style={{ overflowY: 'auto', padding: '4px' }}>
                        {/* Clear option for optional fields with a value */}
                        {variant === 'optional' && value && (
                            <div
                                data-option
                                onClick={() => select('')}
                                onMouseEnter={() => setHighlightedIndex(-2)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    padding: '6px 8px',
                                    borderRadius: '4px',
                                    fontSize: '12px',
                                    cursor: 'pointer',
                                    color: 'var(--ram-text-tertiary)',
                                    fontStyle: 'italic',
                                    background: highlightedIndex === -2 ? 'var(--ram-bg-tertiary)' : 'transparent',
                                    transition: 'background 0.1s',
                                    borderBottom: '1px solid var(--ram-border)',
                                    marginBottom: '4px',
                                }}
                            >
                                <span style={{
                                    width: '14px',
                                    flexShrink: 0,
                                    fontSize: '11px',
                                    color: 'var(--ram-text-tertiary)',
                                }}>
                                    ✕
                                </span>
                                <span>Clear selection</span>
                            </div>
                        )}
                        {filtered.length === 0 ? (
                            <div style={{
                                padding: '12px 8px',
                                fontSize: '11px',
                                color: 'var(--ram-text-tertiary)',
                                textAlign: 'center',
                            }}>
                                No matches
                            </div>
                        ) : (
                            filtered.map((opt, i) => {
                                const isSelected = opt === value;
                                const isHighlighted = i === highlightedIndex;
                                return (
                                    <div
                                        key={opt}
                                        data-option
                                        onClick={() => select(opt)}
                                        onMouseEnter={() => setHighlightedIndex(i)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            padding: '6px 8px',
                                            borderRadius: '4px',
                                            fontSize: '12px',
                                            cursor: 'pointer',
                                            color: isSelected ? 'var(--ram-teal)' : 'var(--ram-text-primary)',
                                            background: isHighlighted ? 'var(--ram-bg-tertiary)' : 'transparent',
                                            transition: 'background 0.1s',
                                        }}
                                    >
                                        {/* Checkmark for selected */}
                                        <span style={{
                                            width: '14px',
                                            flexShrink: 0,
                                            color: 'var(--ram-teal)',
                                            fontSize: '11px',
                                        }}>
                                            {isSelected ? '✓' : ''}
                                        </span>
                                        <span>{label(opt)}</span>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
