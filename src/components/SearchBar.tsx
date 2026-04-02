'use client';

import { SearchFilters } from '@/types';

interface SearchBarProps {
    filters: SearchFilters;
    onFiltersChange: (filters: SearchFilters) => void;
    onSearchSubmit?: () => void;
    isSearching?: boolean;
    resultCount: number;
    totalCount: number;
    totalAssetCount: number;
    isShuffled: boolean;
    onShuffle: () => void;
}

export default function SearchBar({ filters, onFiltersChange, onSearchSubmit, isSearching, resultCount, totalCount, totalAssetCount, isShuffled, onShuffle }: SearchBarProps) {
    const updateFilter = <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => {
        onFiltersChange({ ...filters, [key]: value });
    };

    // Determine which ordering mode is active
    const activeOrder = isShuffled ? 'shuffle' : filters.sortBy;

    const handleOrderChange = (value: string) => {
        if (value === 'shuffle') {
            // Always reshuffle (new seed) when clicking shuffle
            onShuffle();
        } else {
            // Selecting a sort option exits shuffle mode automatically
            // (page.tsx clears shuffleSeed when filters change)
            onFiltersChange({ ...filters, sortBy: value as SearchFilters['sortBy'] });
        }
    };

    return (
        <div className="flex flex-col gap-3">
            {/* Main search input */}
            <div className="search-bar">
                <div
                    className="flex items-center gap-3 px-4 py-3 rounded-xl"
                    style={{
                        background: 'var(--ram-bg-tertiary)',
                        border: '1px solid var(--ram-border)',
                    }}
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2" className="flex-shrink-0" style={isSearching ? { animation: 'search-pulse 1.2s ease-in-out infinite', opacity: 0.7 } : undefined}>
                        <circle cx="11" cy="11" r="8" />
                        <path d="M21 21l-4.35-4.35" />
                    </svg>
                    <input
                        type="text"
                        placeholder="Search by concept, mood, or description..."
                        value={filters.query}
                        onChange={(e) => updateFilter('query', e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && onSearchSubmit) {
                                e.preventDefault();
                                onSearchSubmit();
                            }
                        }}
                        className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ram-text-tertiary)]"
                        style={{ color: 'var(--ram-text-primary)' }}
                    />
                    {filters.query.trim().length >= 2 && onSearchSubmit && (
                        <button
                            onClick={onSearchSubmit}
                            className="search-enter-hint"
                            title="Press Enter for AI-powered search"
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="9 10 4 15 9 20" />
                                <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                            </svg>
                            <span>Search</span>
                        </button>
                    )}
                    {filters.query && (
                        <button
                            onClick={() => updateFilter('query', '')}
                            className="p-1 rounded hover:bg-[var(--ram-bg-hover)] transition-colors"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2">
                                <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>
            </div>

            {/* Filters: Sort + Type + Orientation + Expired + Count — single row */}
            <div className="flex items-center gap-2 flex-wrap">
                {/* Order mode — segmented pill group */}
                <OrderPillGroup
                    activeValue={activeOrder}
                    onChange={handleOrderChange}
                    options={[
                        { value: 'shuffle', label: '🎲', name: 'Shuffle' },
                        { value: 'newest', label: '📅', name: 'Newest' },
                        { value: 'oldest', label: '📅', name: 'Oldest' },
                        { value: 'expiring-organic', label: '⏳', name: 'Org Expiring' },
                        { value: 'expiring-paid', label: '⏳', name: 'Paid Expiring' },
                    ]}
                />

                {/* Divider */}
                <div
                    className="self-stretch mx-0.5"
                    style={{
                        width: '1px',
                        background: 'var(--ram-border)',
                        minHeight: '24px',
                    }}
                />

                {/* Asset Type */}
                <FilterSelect
                    value={filters.assetType}
                    onChange={(v) => updateFilter('assetType', v as SearchFilters['assetType'])}
                    options={[
                        { value: 'all', label: 'All Types' },
                        { value: 'photo', label: 'Photos' },
                        { value: 'video', label: 'Videos' },
                    ]}
                />

                {/* Orientation */}
                <FilterSelect
                    value={filters.orientation}
                    onChange={(v) => updateFilter('orientation', v as SearchFilters['orientation'])}
                    options={[
                        { value: 'all', label: 'Any Orientation' },
                        { value: 'landscape', label: 'Landscape' },
                        { value: 'portrait', label: 'Portrait' },
                        { value: 'square', label: 'Square' },
                    ]}
                />

                {/* Divider */}
                <div
                    className="self-stretch mx-0.5"
                    style={{
                        width: '1px',
                        background: 'var(--ram-border)',
                        minHeight: '24px',
                    }}
                />

                {/* Expired toggle */}
                <ExpiredToggle
                    mode={filters.expiredMode}
                    onChange={(mode) => onFiltersChange({ ...filters, expiredMode: mode })}
                />

                {/* Spacer + result count */}
                <div className="flex-1" />
                <span className="text-xs flex-shrink-0" style={{ color: 'var(--ram-text-tertiary)' }}>
                    {totalCount === totalAssetCount
                        ? `${totalAssetCount.toLocaleString()} assets`
                        : `${totalCount.toLocaleString()} filtered · ${totalAssetCount.toLocaleString()} total`}
                </span>
            </div>
        </div>
    );
}

// Segmented pill group for ordering modes — only one active at a time
function OrderPillGroup({
    activeValue,
    onChange,
    options,
}: {
    activeValue: string;
    onChange: (value: string) => void;
    options: { value: string; label: string; name: string }[];
}) {
    return (
        <div className="order-pill-group">
            {options.map((opt) => {
                const isActive = activeValue === opt.value;
                const isShuffle = opt.value === 'shuffle';
                return (
                    <button
                        key={opt.value}
                        onClick={() => onChange(opt.value)}
                        className={`order-pill${isActive ? ' active' : ''}${isShuffle && isActive ? ' shuffle-active' : ''}`}
                        title={isShuffle && isActive ? 'Click to reshuffle' : opt.name}
                    >
                        <span className={isShuffle && isActive ? 'shuffle-dice spin' : ''}>{opt.label}</span>
                        <span>{opt.name}</span>
                    </button>
                );
            })}
        </div>
    );
}

// Sub-component: styled filter dropdown
function FilterSelect({
    value,
    onChange,
    options,
}: {
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
}) {
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="text-xs px-3 py-1.5 rounded-lg outline-none cursor-pointer transition-colors"
            style={{
                background: 'var(--ram-bg-tertiary)',
                border: '1px solid var(--ram-border)',
                color: 'var(--ram-text-secondary)',
            }}
        >
            {options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                    {opt.label}
                </option>
            ))}
        </select>
    );
}

// 3-state expired assets toggle — uses same pill styling as OrderPillGroup
const EXPIRED_MODES: { value: 'hide' | 'show' | 'only'; label: string; emoji: string }[] = [
    { value: 'hide', label: 'Hide Expired', emoji: '🙈' },
    { value: 'show', label: 'Show All', emoji: '👁' },
    { value: 'only', label: 'Only Expired', emoji: '⚠️' },
];

function ExpiredToggle({
    mode,
    onChange,
}: {
    mode: 'hide' | 'show' | 'only';
    onChange: (mode: 'hide' | 'show' | 'only') => void;
}) {
    return (
        <div className="order-pill-group">
            {EXPIRED_MODES.map((opt) => {
                const isActive = mode === opt.value;
                const isWarning = opt.value === 'only';
                return (
                    <button
                        key={opt.value}
                        onClick={() => onChange(opt.value)}
                        className={`order-pill${isActive ? ' active' : ''}`}
                        style={isActive && !isWarning ? {
                            background: 'rgba(52, 211, 153, 0.12)',
                            borderColor: 'rgba(52, 211, 153, 0.3)',
                            color: 'var(--ram-green)',
                        } : isActive && isWarning ? {
                            background: 'rgba(251, 191, 36, 0.12)',
                            borderColor: 'rgba(251, 191, 36, 0.3)',
                            color: '#fbbf24',
                        } : undefined}
                        title={opt.label}
                    >
                        <span>{opt.emoji}</span>
                        <span>{opt.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
