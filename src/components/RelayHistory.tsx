'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { logger } from '@/lib/logger';

// ─── Types ───────────────────────────────────────────────────────

export type RelayStatus = 'complete' | 'partial' | 'failed' | 'undone';

export interface RelayHistoryItem {
    id: string;
    assetNames: string[];
    assetIds: string[];
    shortcutIds: string[];
    targetFolder: string;
    targetPath: string;
    succeeded: number;
    failed: number;
    total: number;
    status: RelayStatus;
    timestamp: number;
}

// ─── Hook: useRelayHistory ───────────────────────────────────────

export function useRelayHistory() {
    const [items, setItems] = useState<RelayHistoryItem[]>([]);

    const record = useCallback(
        (entry: {
            assetNames: string[];
            assetIds: string[];
            shortcutIds: string[];
            targetFolder: string;
            targetPath: string;
            succeeded: number;
            failed: number;
            total: number;
        }) => {
            const item: RelayHistoryItem = {
                id: `relay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                ...entry,
                status:
                    entry.failed === 0
                        ? 'complete'
                        : entry.succeeded === 0
                            ? 'failed'
                            : 'partial',
                timestamp: Date.now(),
            };
            setItems((prev) => [item, ...prev]);
        },
        []
    );

    const markUndone = useCallback((relayId: string) => {
        setItems((prev) =>
            prev.map((item) =>
                item.id === relayId ? { ...item, status: 'undone' as RelayStatus } : item
            )
        );
    }, []);

    const clearAll = useCallback(() => setItems([]), []);

    const totalRelayed = items.reduce(
        (sum, i) => sum + (i.status === 'undone' ? 0 : i.succeeded),
        0
    );

    // Set of asset IDs that have been relayed and not undone
    const relayedAssetIds = new Set(
        items
            .filter((i) => i.status !== 'undone' && i.status !== 'failed')
            .flatMap((i) => i.assetIds)
    );

    return { items, record, markUndone, clearAll, totalRelayed, relayedAssetIds };
}

// ─── Helpers ─────────────────────────────────────────────────────

function timeAgo(ts: number): string {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
}

// ─── Props ───────────────────────────────────────────────────────

interface RelayHistoryProps {
    items: RelayHistoryItem[];
    totalRelayed: number;
    onClearAll: () => void;
    onUndo: (item: RelayHistoryItem) => void;
}

// ─── Component ───────────────────────────────────────────────────

export default function RelayHistory({ items, totalRelayed, onClearAll, onUndo }: RelayHistoryProps) {
    const [open, setOpen] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    // Close on outside click
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        if (open) document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    if (items.length === 0) return null;

    return (
        <div className="relative" ref={panelRef}>
            {/* Header button */}
            <button
                onClick={() => setOpen(!open)}
                className="relative flex items-center gap-2 rounded-lg transition-all"
                style={{
                    padding: '8px',
                    background: open ? 'var(--ram-bg-hover)' : 'transparent',
                    border: '1px solid transparent',
                    color: 'var(--ram-text-secondary)',
                }}
                title="Shortcut History"
            >
                {/* Relay / share icon */}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 3H5a2 2 0 0 0-2 2v4" />
                    <path d="M15 3h4a2 2 0 0 1 2 2v4" />
                    <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
                    <path d="M15 21h4a2 2 0 0 0 2-2v-4" />
                </svg>

                {/* Badge showing total relayed count */}
                <span
                    className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] rounded-full flex items-center justify-center text-[9px] font-bold px-0.5"
                    style={{
                        background: 'var(--ram-green, #22c55e)',
                        color: 'var(--ram-bg-primary)',
                    }}
                >
                    {totalRelayed}
                </span>
            </button>

            {/* Dropdown panel */}
            {open && (
                <div
                    className="absolute right-0 top-full mt-2 w-[340px] rounded-xl overflow-hidden shadow-xl z-50"
                    style={{
                        background: 'var(--ram-bg-elevated)',
                        border: '1px solid var(--ram-border)',
                    }}
                >
                    {/* Panel header */}
                    <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--ram-border)' }}>
                        <span className="text-xs font-semibold" style={{ color: 'var(--ram-text-primary)' }}>
                            Shortcut History
                        </span>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px]" style={{ color: 'var(--ram-text-tertiary)' }}>
                                {totalRelayed} shortcuts this session
                            </span>
                            <button
                                onClick={onClearAll}
                                className="text-[10px] px-1.5 py-0.5 rounded transition-colors hover:bg-[var(--ram-bg-hover)]"
                                style={{ color: 'var(--ram-text-tertiary)' }}
                            >
                                Clear
                            </button>
                        </div>
                    </div>

                    {/* Relay items */}
                    <div className="max-h-[360px] overflow-y-auto">
                        {items.map((item) => (
                            <RelayRow
                                key={item.id}
                                item={item}
                                expanded={expandedId === item.id}
                                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                                onUndo={() => onUndo(item)}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Row: single relay entry ─────────────────────────────────────

function RelayRow({
    item,
    expanded,
    onToggle,
    onUndo,
}: {
    item: RelayHistoryItem;
    expanded: boolean;
    onToggle: () => void;
    onUndo: () => void;
}) {
    const [undoing, setUndoing] = useState(false);
    const isUndone = item.status === 'undone';

    const statusColor =
        isUndone
            ? 'var(--ram-text-tertiary)'
            : item.status === 'complete'
                ? 'var(--ram-green, #22c55e)'
                : item.status === 'partial'
                    ? 'var(--ram-amber, #f59e0b)'
                    : 'var(--ram-red, #ef4444)';

    const handleUndo = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (undoing || isUndone || item.shortcutIds.length === 0) return;
        setUndoing(true);
        try {
            const res = await fetch('/api/drive/shortcut/delete', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shortcutIds: item.shortcutIds }),
            });
            if (res.ok) {
                onUndo();
            }
        } catch (err) {
            logger.error('relay-history', 'Undo relay failed', { error: err instanceof Error ? err.message : String(err) });
        } finally {
            setUndoing(false);
        }
    };

    return (
        <div style={{ borderBottom: '1px solid var(--ram-border)', opacity: isUndone ? 0.5 : 1 }}>
            <div className="flex items-center gap-3 px-4 py-3 transition-colors">
                {/* Status icon */}
                <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center">
                    {isUndone && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 7v6h6" />
                            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.69 3L3 13" />
                        </svg>
                    )}
                    {item.status === 'complete' && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                        </svg>
                    )}
                    {item.status === 'partial' && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                    )}
                    {item.status === 'failed' && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="15" y1="9" x2="9" y2="15" />
                            <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                    )}
                </div>

                {/* Summary */}
                <div className="flex-1 min-w-0">
                    <p
                        className="text-xs font-medium truncate"
                        style={{
                            color: isUndone ? 'var(--ram-text-tertiary)' : 'var(--ram-text-primary)',
                            textDecoration: isUndone ? 'line-through' : 'none',
                        }}
                    >
                        {item.total === 1 ? item.assetNames[0] : `${item.total} assets`}
                    </p>
                    <p className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--ram-text-tertiary)' }}>
                        {isUndone ? 'Undone' : `→ ${item.targetFolder}`}
                        <span className="ml-2">{timeAgo(item.timestamp)}</span>
                    </p>
                </div>

                {/* Undo button — only for non-undone, non-failed items with shortcutIds */}
                {!isUndone && item.status !== 'failed' && item.shortcutIds.length > 0 && (
                    <button
                        onClick={handleUndo}
                        disabled={undoing}
                        className="flex-shrink-0 flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-lg transition-all hover:bg-[var(--ram-bg-hover)]"
                        style={{
                            color: undoing ? 'var(--ram-text-tertiary)' : 'var(--ram-text-secondary)',
                            border: 'none',
                            background: 'none',
                            cursor: undoing ? 'wait' : 'pointer',
                        }}
                        title="Undo — remove shortcuts from Drive"
                    >
                        {undoing ? (
                            <div
                                className="w-3 h-3 rounded-full"
                                style={{ border: '1.5px solid var(--ram-text-tertiary)', borderTopColor: 'transparent', animation: 'spin 1s linear infinite' }}
                            />
                        ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 7v6h6" />
                                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.69 3L3 13" />
                            </svg>
                        )}
                        Undo
                    </button>
                )}

                {/* Expand chevron */}
                {!isUndone && (
                    <button
                        onClick={onToggle}
                        className="flex-shrink-0 flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors"
                        style={{
                            background: 'var(--ram-bg-hover)',
                            color: 'var(--ram-text-tertiary)',
                            border: 'none',
                            cursor: 'pointer',
                        }}
                    >
                        {item.succeeded}/{item.total}
                        <svg
                            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                            style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.15s ease' }}
                        >
                            <polyline points="6 9 12 15 18 9" />
                        </svg>
                    </button>
                )}
            </div>

            {/* Expanded file list */}
            {expanded && !isUndone && (
                <div className="px-4 pb-3 pl-[52px]">
                    <div
                        className="flex flex-col gap-1 py-2 px-3 rounded-lg"
                        style={{ background: 'var(--ram-bg-secondary)' }}
                    >
                        {/* Destination path */}
                        <p className="text-[10px] font-medium mb-1" style={{ color: 'var(--ram-text-tertiary)' }}>
                            {item.targetPath}
                        </p>
                        {item.assetNames.map((name, idx) => (
                            <div
                                key={idx}
                                className="flex items-center gap-1.5 text-[10px]"
                                style={{ color: 'var(--ram-text-secondary)' }}
                            >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--ram-green, #22c55e)" strokeWidth="2.5" className="flex-shrink-0">
                                    <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span className="truncate">{name}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
