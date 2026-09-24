'use client';

import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { NamerFilePreview } from '@/lib/namer/types';

type FilterType = 'all' | 'images' | 'videos';

/** List = the name-comparison table. Grid = the visual contact sheet. */
export type PreviewViewMode = 'list' | 'grid';
export type TileSize = 's' | 'm' | 'l';

/** Tile edge in px, and the Drive thumbnail size worth requesting for it. */
const TILE_SPECS: Record<TileSize, { px: number; thumb: number }> = {
    s: { px: 120, thumb: 220 },
    m: { px: 180, thumb: 400 },
    l: { px: 260, thumb: 400 },
};

const IMAGE_MIMES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'image/tiff', 'image/heic', 'image/heif',
]);
const VIDEO_MIMES = new Set([
    'video/mp4', 'video/quicktime', 'video/x-msvideo',
    'video/x-matroska', 'video/webm', 'video/mpeg',
]);

/**
 * Drive thumbnail links end in a `=s<N>` size suffix. Swap in the size we
 * actually want rather than string-matching one specific value — Drive does
 * not always hand back `=s220`.
 */
function thumbUrl(link: string, size: number): string {
    return link.replace(/=s\d+(-c)?$/, `=s${size}`);
}

const PLACEHOLDER_ICON = (
    <svg width="60%" height="60%" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
    </svg>
);

interface FilePreviewTableProps {
    files: NamerFilePreview[];
    onToggleExclude: (fileId: string) => void;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    onReloadFiles: () => void;
    onExecute: () => void;
    canExecute: boolean;
    isProcessing: boolean;
    onSelectFiltered?: (ids: string[]) => void;
    onDeselectFiltered?: (ids: string[]) => void;
    /** Bulk-set a shift-click range to one status. */
    onSetRange: (ids: string[], status: 'pending' | 'excluded') => void;
    /** View mode lives in the parent — this component remounts on every load. */
    viewMode: PreviewViewMode;
    onViewModeChange: (mode: PreviewViewMode) => void;
    tileSize: TileSize;
    onTileSizeChange: (size: TileSize) => void;
}

export default function FilePreviewTable({
    files,
    onToggleExclude,
    onSelectAll,
    onDeselectAll,
    onReloadFiles,
    onExecute,
    canExecute,
    isProcessing,
    onSelectFiltered,
    onDeselectFiltered,
    onSetRange,
    viewMode,
    onViewModeChange,
    tileSize,
    onTileSizeChange,
}: FilePreviewTableProps) {
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const previewRef = useRef<HTMLDivElement>(null);
    // Filter/search state resets per file load: the parent keys this component
    // by load counter, so a fresh load remounts with clean state.
    const [filterType, setFilterType] = useState<FilterType>('all');
    const [searchQuery, setSearchQuery] = useState('');
    // Drive thumbnail URLs are short-lived. In grid view a wall of broken
    // images is the whole UI, so track failures and nudge toward a reload.
    const [failedThumbs, setFailedThumbs] = useState<Set<string>>(new Set());
    // Anchor for shift-click range selection, with the status the anchor click
    // produced — a shift-click paints that same status across the range.
    const anchorRef = useRef<{ id: string; status: 'pending' | 'excluded' } | null>(null);

    const visibleFiles = files.filter(file => {
        if (file.status === 'processing' || file.status === 'success' || file.status === 'error') return true;
        if (filterType === 'images' && !IMAGE_MIMES.has(file.mimeType)) return false;
        if (filterType === 'videos' && !VIDEO_MIMES.has(file.mimeType)) return false;
        if (searchQuery.trim()) {
            const q = searchQuery.trim().toLowerCase();
            if (!file.originalName.toLowerCase().includes(q)) return false;
        }
        return true;
    });
    const isFiltered = filterType !== 'all' || searchQuery.trim() !== '';
    const filteredToggleableIds = visibleFiles
        .filter(f => f.status === 'pending' || f.status === 'excluded')
        .map(f => f.id);

    const pendingCount = files.filter(f => f.status === 'pending').length;
    const excludedCount = files.filter(f => f.status === 'excluded').length;
    const totalCount = files.length;

    const markThumbFailed = (id: string) => {
        setFailedThumbs(prev => {
            if (prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
        });
    };

    /**
     * Toggle one file, or paint a range when shift is held. Ranges follow the
     * currently visible (filtered) order, so what you see is what you get.
     */
    const handleToggle = (file: NamerFilePreview, shiftKey: boolean) => {
        const anchor = anchorRef.current;
        if (shiftKey && anchor && anchor.id !== file.id) {
            const from = visibleFiles.findIndex(f => f.id === anchor.id);
            const to = visibleFiles.findIndex(f => f.id === file.id);
            if (from !== -1 && to !== -1) {
                const [lo, hi] = from < to ? [from, to] : [to, from];
                const ids = visibleFiles
                    .slice(lo, hi + 1)
                    .filter(f => f.status === 'pending' || f.status === 'excluded')
                    .map(f => f.id);
                onSetRange(ids, anchor.status);
                return; // anchor stays put so the range can be re-dragged
            }
        }
        onToggleExclude(file.id);
        anchorRef.current = {
            id: file.id,
            status: file.status === 'excluded' ? 'pending' : 'excluded',
        };
    };

    const statusIcon = (status: NamerFilePreview['status'], size = 14) => {
        if (status === 'success') {
            return (
                <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--ram-green, #34d399)" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            );
        }
        if (status === 'error') {
            return (
                <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--ram-red, #f87171)" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
            );
        }
        return null;
    };

    const tile = TILE_SPECS[tileSize];

    return (
        <div className="px-6 py-3 flex flex-col" style={{ minHeight: 0 }}>
            {/* Row 1 — counts */}
            <p style={{ fontSize: '12px', color: 'var(--ram-text-secondary)', fontWeight: 500, marginBottom: 8 }}>
                <span style={{ color: 'var(--ram-teal)', fontWeight: 700 }}>{pendingCount}</span> file{pendingCount !== 1 ? 's' : ''} selected
                <span style={{ color: 'var(--ram-text-tertiary)' }}> ({totalCount} total)</span>
                {excludedCount > 0 && (
                    <span style={{ color: 'var(--ram-text-tertiary)' }}> · {excludedCount} excluded</span>
                )}
                {isFiltered && (
                    <span style={{ color: 'var(--ram-text-tertiary)' }}> · showing {visibleFiles.length} of {totalCount}</span>
                )}
            </p>

            {/* Row 2 — filter pills + Select All / Deselect All + search + view toggle */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
                <div className="order-pill-group">
                    {(['all', 'images', 'videos'] as FilterType[]).map(t => (
                        <button key={t} className={`order-pill${filterType === t ? ' active' : ''}`}
                            onClick={() => setFilterType(t)}>
                            {t === 'all' ? 'All' : t === 'images' ? 'Images' : 'Videos'}
                        </button>
                    ))}
                </div>
                <span style={{ color: 'var(--ram-border)' }}>|</span>
                <button
                    onClick={() => isFiltered && onSelectFiltered
                        ? onSelectFiltered(filteredToggleableIds)
                        : onSelectAll()}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--ram-text-tertiary)',
                        fontSize: '12px',
                        cursor: 'pointer',
                        padding: 0,
                        fontWeight: 500,
                    }}
                >
                    Select All
                </button>
                <button
                    onClick={() => isFiltered && onDeselectFiltered
                        ? onDeselectFiltered(filteredToggleableIds)
                        : onDeselectAll()}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: (isFiltered
                            ? visibleFiles.some(f => f.status === 'pending')
                            : excludedCount < totalCount)
                            ? 'var(--ram-teal)' : 'var(--ram-text-tertiary)',
                        fontSize: '12px',
                        cursor: 'pointer',
                        padding: 0,
                        fontWeight: 600,
                    }}
                >
                    Deselect All
                </button>
                <span style={{ color: 'var(--ram-border)' }}>|</span>
                <div
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md"
                    style={{
                        background: 'var(--ram-bg-tertiary)',
                        border: '1px solid var(--ram-border)',
                        maxWidth: 220,
                        flex: 1,
                    }}
                >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                        stroke="var(--ram-text-tertiary)" strokeWidth="2" style={{ flexShrink: 0 }}>
                        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                    </svg>
                    <input
                        type="text"
                        placeholder="Filter by name…"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="bg-transparent outline-none flex-1"
                        style={{ fontSize: '11px', color: 'var(--ram-text-primary)', minWidth: 0 }}
                    />
                    {searchQuery && (
                        <button onClick={() => setSearchQuery('')} style={{ lineHeight: 0, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                                stroke="var(--ram-text-tertiary)" strokeWidth="2.5">
                                <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>

                <div className="flex-1" />

                {/* Tile size — grid only */}
                {viewMode === 'grid' && (
                    <div className="order-pill-group" title="Thumbnail size">
                        {(['s', 'm', 'l'] as TileSize[]).map(s => (
                            <button key={s} className={`order-pill${tileSize === s ? ' active' : ''}`}
                                onClick={() => onTileSizeChange(s)}
                                style={{ padding: '4px 8px' }}>
                                {s.toUpperCase()}
                            </button>
                        ))}
                    </div>
                )}

                {/* List / Grid toggle */}
                <div className="order-pill-group">
                    <button className={`order-pill${viewMode === 'list' ? ' active' : ''}`}
                        onClick={() => onViewModeChange('list')} title="List view">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" />
                            <line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" />
                            <line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                        </svg>
                        List
                    </button>
                    <button className={`order-pill${viewMode === 'grid' ? ' active' : ''}`}
                        onClick={() => onViewModeChange('grid')} title="Grid view">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                            <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                        </svg>
                        Grid
                    </button>
                </div>
            </div>

            {/* Expired-thumbnail nudge */}
            {failedThumbs.size >= 3 && (
                <div
                    className="flex items-center gap-2 mb-3 px-3 py-2 rounded-md"
                    style={{
                        background: 'rgba(251, 191, 36, 0.08)',
                        border: '1px solid rgba(251, 191, 36, 0.25)',
                        fontSize: '12px',
                        color: '#fbbf24',
                    }}
                >
                    <span>⚠️</span>
                    <span>{failedThumbs.size} thumbnails failed to load — Drive preview links expire. Reload Files to refresh them.</span>
                </div>
            )}

            {/* ── Grid view ───────────────────────────────────────────── */}
            {viewMode === 'grid' ? (
                <div className="flex-1" style={{ minHeight: 0 }}>
                    {visibleFiles.length === 0 && isFiltered ? (
                        <div className="flex items-center justify-center py-16" style={{ color: 'var(--ram-text-tertiary)', fontSize: '14px' }}>
                            No files match the current filter
                        </div>
                    ) : (
                        <div
                            className="grid gap-3"
                            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tile.px}px, 1fr))` }}
                        >
                            {visibleFiles.map(file => {
                                const isExcluded = file.status === 'excluded';
                                const isProcessed = file.status === 'success' || file.status === 'error';
                                const showThumb = file.thumbnailLink && !failedThumbs.has(file.id);

                                return (
                                    <button
                                        key={file.id}
                                        onClick={e => !isProcessed && handleToggle(file, e.shiftKey)}
                                        disabled={isProcessed}
                                        title={`${file.originalName}\n→ ${file.proposedName}`}
                                        className="flex flex-col text-left rounded-lg overflow-hidden transition-all"
                                        style={{
                                            border: isExcluded
                                                ? '2px solid var(--ram-border)'
                                                : '2px solid var(--ram-accent)',
                                            background: 'var(--ram-bg-tertiary)',
                                            opacity: isExcluded ? 0.45 : 1,
                                            cursor: isProcessed ? 'default' : 'pointer',
                                            padding: 0,
                                        }}
                                    >
                                        {/* Thumbnail */}
                                        <div
                                            className="relative w-full flex items-center justify-center"
                                            style={{
                                                aspectRatio: '1 / 1',
                                                background: 'var(--ram-bg-primary)',
                                                filter: isExcluded ? 'grayscale(1)' : 'none',
                                            }}
                                        >
                                            {showThumb ? (
                                                // eslint-disable-next-line @next/next/no-img-element -- short-lived googleusercontent thumbnail URLs; next/image can't cache or optimize these
                                                <img
                                                    src={thumbUrl(file.thumbnailLink!, tile.thumb)}
                                                    alt={file.originalName}
                                                    loading="lazy"
                                                    className="w-full h-full object-cover"
                                                    referrerPolicy="no-referrer"
                                                    onError={() => markThumbFailed(file.id)}
                                                />
                                            ) : PLACEHOLDER_ICON}

                                            {/* Selection / status badge */}
                                            <div
                                                className="absolute flex items-center justify-center rounded-md"
                                                style={{
                                                    top: 6,
                                                    right: 6,
                                                    width: 22,
                                                    height: 22,
                                                    background: isProcessed
                                                        ? 'rgba(0,0,0,0.6)'
                                                        : isExcluded
                                                            ? 'rgba(0,0,0,0.5)'
                                                            : 'var(--ram-accent)',
                                                    border: isExcluded && !isProcessed
                                                        ? '2px solid rgba(255,255,255,0.35)'
                                                        : '2px solid transparent',
                                                    boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                                                }}
                                            >
                                                {isProcessed
                                                    ? statusIcon(file.status, 13)
                                                    : !isExcluded && (
                                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ram-bg-primary)" strokeWidth="3.5">
                                                            <polyline points="20 6 9 17 4 12" />
                                                        </svg>
                                                    )}
                                            </div>

                                            {/* Type chip */}
                                            <span
                                                className="absolute rounded"
                                                style={{
                                                    bottom: 6,
                                                    left: 6,
                                                    padding: '1px 5px',
                                                    fontSize: '9px',
                                                    fontWeight: 600,
                                                    letterSpacing: '0.3px',
                                                    color: 'var(--ram-text-secondary)',
                                                    background: 'rgba(0,0,0,0.6)',
                                                }}
                                            >
                                                {file.mimeType?.split('/')[1]?.toUpperCase() || '—'}
                                            </span>
                                        </div>

                                        {/* Caption — proposed name is what you're approving */}
                                        <div className="px-2 py-1.5" style={{ minWidth: 0 }}>
                                            <p className="truncate" style={{
                                                fontSize: '11px',
                                                fontWeight: 600,
                                                color: isExcluded ? 'var(--ram-text-tertiary)' : 'var(--ram-accent)',
                                            }}>
                                                {file.proposedName}
                                            </p>
                                            <p className="truncate" style={{
                                                fontSize: '10px',
                                                color: 'var(--ram-text-tertiary)',
                                                textDecoration: isExcluded ? 'line-through' : 'none',
                                            }}>
                                                {file.originalName}
                                            </p>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            ) : (
                /* ── List view ───────────────────────────────────────── */
                <div className="rounded-lg overflow-hidden flex-1" style={{ border: '1px solid var(--ram-border)', minHeight: 0 }}>
                    {/* Header — columns: Current Name | Proposed Name | Type | Preview | Include */}
                    <div
                        className="grid items-center px-3 py-2 font-medium"
                        style={{
                            gridTemplateColumns: '1fr 1fr 70px 60px 70px',
                            background: 'rgba(255,255,255,0.03)',
                            color: 'var(--ram-text-secondary)',
                            borderBottom: '1px solid var(--ram-border)',
                            fontSize: '11px',
                            textTransform: 'uppercase' as const,
                            letterSpacing: '0.3px',
                        }}
                    >
                        <span>Current Name</span>
                        <span>Proposed Name</span>
                        <span>Type</span>
                        <span className="text-center">Preview</span>
                        <span className="text-center">Include</span>
                    </div>

                    {/* Rows */}
                    <div>
                        {visibleFiles.length === 0 && isFiltered && (
                            <div className="flex items-center justify-center py-16" style={{ color: 'var(--ram-text-tertiary)', fontSize: '14px' }}>
                                No files match the current filter
                            </div>
                        )}
                        {visibleFiles.map(file => {
                            const isExcluded = file.status === 'excluded';
                            const isProcessed = file.status === 'success' || file.status === 'error';
                            const isHovered = hoveredId === file.id;
                            const showThumb = file.thumbnailLink && !failedThumbs.has(file.id);

                            return (
                                <div
                                    key={file.id}
                                    className="grid items-center px-3 py-1.5 transition-colors"
                                    style={{
                                        gridTemplateColumns: '1fr 1fr 70px 60px 70px',
                                        borderBottom: '1px solid var(--ram-border)',
                                        background: isExcluded
                                            ? 'var(--ram-bg-primary)'
                                            : isHovered
                                                ? 'rgba(255,255,255,0.02)'
                                                : 'transparent',
                                        opacity: isExcluded ? 0.5 : 1,
                                        fontSize: '12px',
                                    }}
                                >
                                    {/* Current name */}
                                    <span className="truncate pr-2" style={{
                                        color: 'var(--ram-text-secondary)',
                                        textDecoration: isExcluded ? 'line-through' : 'none',
                                    }}>
                                        {file.originalName}
                                    </span>

                                    {/* Proposed name */}
                                    <span className="truncate pr-2 font-medium" style={{
                                        color: isExcluded ? 'var(--ram-text-tertiary)' : 'var(--ram-accent)',
                                    }}>
                                        {file.proposedName}
                                    </span>

                                    {/* Type */}
                                    <span className="truncate" style={{ color: 'var(--ram-text-tertiary)', fontSize: '11px' }}>
                                        {file.mimeType?.split('/')[1]?.toUpperCase() || '—'}
                                    </span>

                                    {/* Preview thumbnail */}
                                    <div
                                        className="flex justify-center relative"
                                        onMouseEnter={(e) => {
                                            setHoveredId(file.id);
                                            setHoverPos({ x: e.clientX, y: e.clientY });
                                        }}
                                        onMouseMove={(e) => {
                                            if (hoveredId === file.id) {
                                                setHoverPos({ x: e.clientX, y: e.clientY });
                                            }
                                        }}
                                        onMouseLeave={() => setHoveredId(null)}
                                    >
                                        <div className="w-7 h-7 rounded overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ background: 'var(--ram-bg-tertiary)', cursor: showThumb ? 'pointer' : 'default' }}>
                                            {showThumb ? (
                                                // eslint-disable-next-line @next/next/no-img-element -- short-lived googleusercontent thumbnail URLs; next/image can't cache or optimize these
                                                <img
                                                    src={file.thumbnailLink}
                                                    alt=""
                                                    className="w-full h-full object-cover"
                                                    referrerPolicy="no-referrer"
                                                    onError={() => markThumbFailed(file.id)}
                                                />
                                            ) : PLACEHOLDER_ICON}
                                        </div>

                                        {/* Fixed-position hover preview rendered via portal */}
                                        {isHovered && showThumb && createPortal(
                                            <div
                                                ref={previewRef}
                                                style={{
                                                    position: 'fixed',
                                                    left: `${Math.max(10, hoverPos.x - 240)}px`,
                                                    top: `${Math.max(10, Math.min(hoverPos.y - 120, window.innerHeight - 220))}px`,
                                                    zIndex: 99999,
                                                    width: '220px',
                                                    borderRadius: '8px',
                                                    overflow: 'hidden',
                                                    border: '1px solid var(--ram-border)',
                                                    boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
                                                    background: '#1e2028',
                                                    padding: '4px',
                                                    pointerEvents: 'none',
                                                }}
                                            >
                                                {/* eslint-disable-next-line @next/next/no-img-element -- short-lived googleusercontent thumbnail URLs; next/image can't cache or optimize these */}
                                                <img
                                                    src={thumbUrl(file.thumbnailLink!, 400)}
                                                    alt={file.originalName}
                                                    style={{
                                                        width: '100%',
                                                        borderRadius: '6px',
                                                        display: 'block',
                                                    }}
                                                    referrerPolicy="no-referrer"
                                                />
                                                <p style={{
                                                    fontSize: '10px',
                                                    color: 'var(--ram-text-tertiary)',
                                                    padding: '4px 4px 2px',
                                                    textAlign: 'center',
                                                    whiteSpace: 'nowrap',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                }}>
                                                    {file.originalName}
                                                </p>
                                            </div>,
                                            document.body
                                        )}
                                    </div>

                                    {/* Include toggle — high contrast */}
                                    <div className="flex justify-center">
                                        {!isProcessed && (
                                            <button
                                                onClick={e => handleToggle(file, e.shiftKey)}
                                                className="w-5 h-5 rounded flex items-center justify-center transition-all"
                                                style={{
                                                    border: isExcluded
                                                        ? '2px solid rgba(255,255,255,0.25)'
                                                        : '2px solid var(--ram-accent)',
                                                    background: isExcluded
                                                        ? 'rgba(255,255,255,0.05)'
                                                        : 'var(--ram-accent)',
                                                    cursor: 'pointer',
                                                }}
                                                title={isExcluded ? 'Click to include (shift-click for a range)' : 'Click to exclude (shift-click for a range)'}
                                            >
                                                {!isExcluded && (
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ram-bg-primary)" strokeWidth="3">
                                                        <polyline points="20 6 9 17 4 12" />
                                                    </svg>
                                                )}
                                            </button>
                                        )}
                                        {statusIcon(file.status)}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Bottom action bar — Reload + Review and Execute */}
            <div
                className="flex items-center gap-3 mt-3 pt-3"
                style={{ borderTop: '2px solid var(--ram-border)' }}
            >
                <p style={{ fontSize: '12px', color: 'var(--ram-text-secondary)', fontWeight: 500 }}>
                    <span style={{ color: 'var(--ram-teal)', fontWeight: 700 }}>{pendingCount}</span> file{pendingCount !== 1 ? 's' : ''} selected
                    <span style={{ color: 'var(--ram-text-tertiary)' }}> ({totalCount} total)</span>
                </p>

                <div className="flex-1" />

                {/* Reload Files */}
                <button
                    onClick={onReloadFiles}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 14px',
                        borderRadius: '6px',
                        border: '1px solid var(--ram-border)',
                        background: 'var(--ram-bg-tertiary)',
                        color: 'var(--ram-text-secondary)',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                    }}
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    Reload Files
                </button>

                {/* Review and Execute */}
                <button
                    onClick={onExecute}
                    disabled={!canExecute}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '8px 20px',
                        borderRadius: '8px',
                        border: 'none',
                        fontWeight: 700,
                        fontSize: '13px',
                        background: canExecute
                            ? 'linear-gradient(135deg, var(--ram-accent), #d4922e)'
                            : 'var(--ram-bg-tertiary)',
                        color: canExecute
                            ? '#fff'
                            : 'var(--ram-text-tertiary)',
                        cursor: !canExecute ? 'not-allowed' : 'pointer',
                        opacity: !canExecute ? 0.5 : 1,
                        transition: 'all 0.15s',
                        boxShadow: canExecute ? '0 2px 12px rgba(232,160,72,0.3)' : 'none',
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                    {isProcessing ? `Queue Another Batch (${pendingCount})` : `Review and Execute (${pendingCount})`}
                </button>
            </div>
        </div>
    );
}
