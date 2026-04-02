'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { NamerFilePreview } from '@/lib/namer/types';

interface FilePreviewTableProps {
    files: NamerFilePreview[];
    onToggleExclude: (fileId: string) => void;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    onReloadFiles: () => void;
    onExecute: () => void;
    canExecute: boolean;
    isProcessing: boolean;
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
}: FilePreviewTableProps) {
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const previewRef = useRef<HTMLDivElement>(null);
    const pendingCount = files.filter(f => f.status === 'pending').length;
    const excludedCount = files.filter(f => f.status === 'excluded').length;
    const totalCount = files.length;

    return (
        <div className="px-6 py-3 flex flex-col" style={{ minHeight: 0 }}>
            {/* Summary bar with Select All / Deselect All */}
            <div className="flex items-center gap-3 mb-3">
                <p style={{ fontSize: '12px', color: 'var(--ram-text-secondary)', fontWeight: 500 }}>
                    <span style={{ color: 'var(--ram-teal)', fontWeight: 700 }}>{pendingCount}</span> file{pendingCount !== 1 ? 's' : ''} selected
                    <span style={{ color: 'var(--ram-text-tertiary)' }}> ({totalCount} total)</span>
                    {excludedCount > 0 && (
                        <span style={{ color: 'var(--ram-text-tertiary)' }}> · {excludedCount} excluded</span>
                    )}
                </p>
                <span style={{ color: 'var(--ram-border)' }}>|</span>
                <button
                    onClick={onSelectAll}
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
                    onClick={onDeselectAll}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: excludedCount < totalCount ? 'var(--ram-teal)' : 'var(--ram-text-tertiary)',
                        fontSize: '12px',
                        cursor: 'pointer',
                        padding: 0,
                        fontWeight: 600,
                    }}
                >
                    Deselect All
                </button>
            </div>

            {/* Table */}
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
                    {files.map(file => {
                        const isExcluded = file.status === 'excluded';
                        const isProcessed = file.status === 'success' || file.status === 'error';
                        const isHovered = hoveredId === file.id;

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
                                    <div className="w-7 h-7 rounded overflow-hidden flex-shrink-0" style={{ background: 'var(--ram-bg-tertiary)', cursor: file.thumbnailLink ? 'pointer' : 'default' }}>
                                        {file.thumbnailLink ? (
                                            <img
                                                src={file.thumbnailLink}
                                                alt=""
                                                className="w-full h-full object-cover"
                                                referrerPolicy="no-referrer"
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="1.5">
                                                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                                                    <circle cx="8.5" cy="8.5" r="1.5" />
                                                    <polyline points="21 15 16 10 5 21" />
                                                </svg>
                                            </div>
                                        )}
                                    </div>

                                    {/* Fixed-position hover preview rendered via portal */}
                                    {isHovered && file.thumbnailLink && createPortal(
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
                                            <img
                                                src={file.thumbnailLink.replace('=s220', '=s400')}
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
                                            onClick={() => onToggleExclude(file.id)}
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
                                            title={isExcluded ? 'Click to include' : 'Click to exclude'}
                                        >
                                            {!isExcluded && (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ram-bg-primary)" strokeWidth="3">
                                                    <polyline points="20 6 9 17 4 12" />
                                                </svg>
                                            )}
                                        </button>
                                    )}
                                    {file.status === 'success' && (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-green, #34d399)" strokeWidth="2.5">
                                            <polyline points="20 6 9 17 4 12" />
                                        </svg>
                                    )}
                                    {file.status === 'error' && (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-red, #f87171)" strokeWidth="2.5">
                                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                                        </svg>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

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
