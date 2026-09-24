'use client';

import { useState, useEffect } from 'react';
import type { PendingIngest } from '@/hooks/useDeferredIngest';
import type { BatchFile, BatchInfo } from '@/lib/namer/types';
import { isRetryable, revertTargets } from '@/lib/namer/batch-utils';

// Batch state shapes live in src/lib/namer/types.ts (shared with batch-utils)
export type { BatchFile, BatchInfo } from '@/lib/namer/types';

interface NamerQueueProps {
    batches: BatchInfo[];
    onClearCompleted?: () => void;  // kept for backward compat, now handled by header
    /** Revert a completed batch, or retry the failed part of a revert. */
    onRevertBatch: (batchId: string) => void;
    /** Re-run the pipeline for a completed batch's failed files. */
    onRetryFailed: (batchId: string) => void;
    /** Stop a queued/running batch before its next file. */
    onCancelBatch: (batchId: string) => void;
    pendingIngests?: PendingIngest[];
    onCancelIngest?: (batchId: string) => void;
    onTriggerIngestNow?: (batchId: string) => void;
    onRetryIngest?: (batchId: string) => void;
}

/**
 * Countdown display component for pending ingests.
 */
function IngestCountdown({ firesAt }: { firesAt: number }) {
    const [remaining, setRemaining] = useState(() => Math.max(0, firesAt - Date.now()));

    useEffect(() => {
        const interval = setInterval(() => {
            const r = Math.max(0, firesAt - Date.now());
            setRemaining(r);
            if (r <= 0) clearInterval(interval);
        }, 1000);
        return () => clearInterval(interval);
    }, [firesAt]);

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    return <>{mins}:{secs.toString().padStart(2, '0')}</>;
}

const WARNING_ICON = (size: number) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2.5" className="flex-shrink-0">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
);

/** Small bordered header action, tinted by `color` (an rgb triple). */
function headerButtonStyle(rgb: string, color: string): React.CSSProperties {
    return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: `1px solid rgba(${rgb},0.3)`,
        background: `rgba(${rgb},0.08)`,
        color,
        fontSize: '11px',
        fontWeight: 600,
        cursor: 'pointer',
        flexShrink: 0,
    };
}

/** Why a file failed or what didn't fully apply — shown on hover and when expanded. */
function fileDetails(file: BatchFile): { tone: 'error' | 'warning' | 'muted'; lines: string[] } | null {
    if (file.revert === 'failed') return { tone: 'error', lines: [`Revert failed: ${file.revertError ?? 'unknown error'}`] };
    if (file.status === 'error') return { tone: 'error', lines: [file.error ?? 'Failed'] };
    if (file.status === 'success' && file.warnings?.length) {
        return { tone: 'warning', lines: ['Renamed and moved, but:', ...file.warnings] };
    }
    if (file.status === 'cancelled') {
        return { tone: 'muted', lines: ['Cancelled — not renamed or moved (Reload Files lists it again)'] };
    }
    if (file.revert === 'done') return { tone: 'muted', lines: ['Reverted to the source folder'] };
    return null;
}

export default function NamerQueue({ batches, onRevertBatch, onRetryFailed, onCancelBatch, pendingIngests, onCancelIngest, onTriggerIngestNow, onRetryIngest }: NamerQueueProps) {
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

    const toggleExpand = (id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const formatTime = (ts: number) => {
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };

    const orientationColor = (o?: string) => {
        if (o === 'Horizontal') return '#60a5fa';
        if (o === 'Vertical') return '#a78bfa';
        if (o === 'Square') return '#fbbf24';
        return 'var(--ram-text-tertiary)';
    };

    if (batches.length === 0) return null;

    return (
        <div className="px-6 pt-4 pb-8">

            {/* Batch list — newest first */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {[...batches].reverse().map(batch => {
                    const isExpanded = expandedIds.has(batch.id);
                    const progressPct = batch.progress.total > 0
                        ? (batch.progress.completed / batch.progress.total) * 100
                        : 0;
                    const revertCount = revertTargets(batch).length;
                    const canRevert = batch.status === 'completed' && revertCount > 0;
                    const isReverted = batch.status === 'reverted';
                    const isReverting = batch.status === 'reverting';
                    const revertFailed = batch.status === 'revert-failed';
                    const retryCount = batch.status === 'completed' ? batch.files.filter(isRetryable).length : 0;
                    const canCancel = batch.status === 'queued' || batch.status === 'processing';
                    const failedCount = batch.files.filter(f => f.status === 'error').length;
                    const warnedCount = batch.files.filter(f => f.status === 'success' && (f.warnings?.length ?? 0) > 0).length;
                    const cancelledCount = batch.files.filter(f => f.status === 'cancelled').length;
                    const revertFailedCount = batch.files.filter(f => f.revert === 'failed').length;
                    const summary = [
                        failedCount > 0 && { text: `${failedCount} failed`, color: 'var(--ram-red, #f87171)' },
                        warnedCount > 0 && { text: `${warnedCount} with warnings`, color: '#fbbf24' },
                        cancelledCount > 0 && { text: `${cancelledCount} cancelled`, color: 'var(--ram-text-tertiary)' },
                        revertFailedCount > 0 && { text: `${revertFailedCount} not reverted`, color: 'var(--ram-red, #f87171)' },
                    ].filter((x): x is { text: string; color: string } => !!x);

                    return (
                        <div
                            key={batch.id}
                            style={{
                                background: isReverted ? 'rgba(251,191,36,0.04)' : 'var(--ram-bg-secondary)',
                                border: `1px solid ${isReverted ? 'rgba(251,191,36,0.2)' : 'var(--ram-border)'}`,
                                borderRadius: '10px',
                                overflow: 'hidden',
                            }}
                        >
                            {/* Batch header — clickable to expand */}
                            <div
                                role="button"
                                tabIndex={0}
                                onClick={() => toggleExpand(batch.id)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(batch.id); } }}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '10px',
                                    width: '100%',
                                    padding: '10px 14px',
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    textAlign: 'left',
                                }}
                            >
                                {/* Status icon */}
                                {(batch.status === 'processing' || isReverting) ? (
                                    <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
                                        style={{ borderColor: 'transparent', borderTopColor: isReverting ? '#fbbf24' : 'var(--ram-teal)' }} />
                                ) : revertFailed ? (
                                    WARNING_ICON(14)
                                ) : isReverted ? (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2.5" className="flex-shrink-0">
                                        <polyline points="1 4 1 10 7 10" />
                                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                                    </svg>
                                ) : batch.status === 'completed' ? (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-green, #34d399)" strokeWidth="3" className="flex-shrink-0">
                                        <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                ) : (
                                    <div className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ background: 'var(--ram-bg-tertiary)', border: '2px solid var(--ram-border)' }} />
                                )}

                                {/* Batch title + timestamp */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                                        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ram-text-primary)' }}>
                                            {isReverted ? 'Reverted ' : revertFailed ? 'Partly reverted ' : ''}Batch ({batch.progress.total} file{batch.progress.total !== 1 ? 's' : ''})
                                        </span>
                                        <span style={{ fontSize: '10px', color: 'var(--ram-text-tertiary)' }}>
                                            {formatTime(batch.timestamp)}
                                        </span>
                                        {summary.map(item => (
                                            <span key={item.text} style={{ fontSize: '10px', fontWeight: 600, color: item.color, whiteSpace: 'nowrap' }}>
                                                · {item.text}
                                            </span>
                                        ))}
                                    </div>
                                    {batch.labelsSummary && (
                                        <p style={{
                                            fontSize: '10px',
                                            color: 'var(--ram-text-tertiary)',
                                            margin: '2px 0 0',
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                        }}>
                                            {batch.labelsSummary}
                                        </p>
                                    )}
                                </div>

                                {/* Cancel (queued or running) — the current file finishes */}
                                {canCancel && (
                                    batch.cancelRequested ? (
                                        <span style={{ fontSize: '11px', color: 'var(--ram-text-tertiary)', fontWeight: 600, flexShrink: 0 }}>
                                            Cancelling…
                                        </span>
                                    ) : (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onCancelBatch(batch.id);
                                            }}
                                            title="Stop before the next file — files already processed stay as they are"
                                            style={headerButtonStyle('148,163,184', 'var(--ram-text-secondary)')}
                                        >
                                            Cancel
                                        </button>
                                    )
                                )}

                                {/* Retry failed (completed batches with failures/warnings) */}
                                {retryCount > 0 && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onRetryFailed(batch.id);
                                        }}
                                        title="Re-run only the steps that failed — files already renamed and moved aren't renamed or moved again"
                                        style={headerButtonStyle('248,113,113', 'var(--ram-red, #f87171)')}
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <polyline points="23 4 23 10 17 10" />
                                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                                        </svg>
                                        Retry failed ({retryCount})
                                    </button>
                                )}

                                {/* Revert (completed batches), or retry a partly failed revert */}
                                {(canRevert || revertFailed) && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onRevertBatch(batch.id);
                                        }}
                                        title={revertFailed ? 'Retry reverting the files that failed' : 'Revert Batch'}
                                        style={headerButtonStyle('251,191,36', '#fbbf24')}
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <polyline points="1 4 1 10 7 10" />
                                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                                        </svg>
                                        {revertFailed ? `Retry revert (${revertCount})` : 'Revert'}
                                    </button>
                                )}

                                {isReverting && (
                                    <span style={{ fontSize: '11px', color: '#fbbf24', fontWeight: 600, flexShrink: 0 }}>
                                        Reverting…
                                    </span>
                                )}

                                {/* Progress bar */}
                                <div style={{ width: '80px', flexShrink: 0 }}>
                                    <div style={{
                                        height: '4px',
                                        borderRadius: '2px',
                                        background: 'var(--ram-bg-tertiary)',
                                        overflow: 'hidden',
                                    }}>
                                        <div style={{
                                            height: '100%',
                                            width: `${progressPct}%`,
                                            borderRadius: '2px',
                                            background: isReverted || revertFailed
                                                ? '#fbbf24'
                                                : batch.progress.errors > 0
                                                    ? 'linear-gradient(90deg, var(--ram-teal), var(--ram-red, #f87171))'
                                                    : batch.status === 'completed'
                                                        ? 'var(--ram-green, #34d399)'
                                                        : 'linear-gradient(90deg, var(--ram-teal), #2aa878)',
                                            transition: 'width 0.3s ease',
                                        }} />
                                    </div>
                                </div>

                                {/* Count */}
                                <span style={{ fontSize: '11px', color: 'var(--ram-text-tertiary)', flexShrink: 0, minWidth: '32px', textAlign: 'right' }}>
                                    {batch.progress.completed}/{batch.progress.total}
                                </span>

                                {/* Expand chevron */}
                                <svg
                                    width="12" height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="var(--ram-text-tertiary)"
                                    strokeWidth="2"
                                    style={{
                                        flexShrink: 0,
                                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                        transition: 'transform 0.15s',
                                    }}
                                >
                                    <polyline points="6 9 12 15 18 9" />
                                </svg>
                            </div>

                            {/* Deferred Ingest Pill — shows countdown, controls, and status */}
                            {(() => {
                                const ingest = pendingIngests?.find(p => p.batchId === batch.id);
                                if (!ingest) return null;

                                if (ingest.status === 'pending') {
                                    return (
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            padding: '6px 14px',
                                            borderTop: '1px solid var(--ram-border)',
                                            background: 'rgba(45, 212, 191, 0.04)',
                                        }}>
                                            <span style={{ fontSize: '13px' }}>⏱</span>
                                            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--ram-teal)' }}>
                                                Syncing to library in <IngestCountdown firesAt={ingest.firesAt} />
                                            </span>
                                            <div style={{ flex: 1 }} />
                                            <button
                                                onClick={(e) => { e.stopPropagation(); onTriggerIngestNow?.(batch.id); }}
                                                style={{
                                                    fontSize: '10px',
                                                    fontWeight: 600,
                                                    padding: '3px 8px',
                                                    borderRadius: '4px',
                                                    border: '1px solid rgba(45, 212, 191, 0.3)',
                                                    background: 'rgba(45, 212, 191, 0.1)',
                                                    color: 'var(--ram-teal)',
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                Sync Now
                                            </button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); onCancelIngest?.(batch.id); }}
                                                style={{
                                                    fontSize: '10px',
                                                    fontWeight: 600,
                                                    padding: '3px 8px',
                                                    borderRadius: '4px',
                                                    border: '1px solid var(--ram-border)',
                                                    background: 'var(--ram-bg-tertiary)',
                                                    color: 'var(--ram-text-tertiary)',
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    );
                                }

                                if (ingest.status === 'firing') {
                                    return (
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            padding: '6px 14px',
                                            borderTop: '1px solid var(--ram-border)',
                                            background: 'rgba(45, 212, 191, 0.04)',
                                        }}>
                                            <div className="w-3 h-3 rounded-full border-2 animate-spin"
                                                style={{ borderColor: 'transparent', borderTopColor: 'var(--ram-teal)' }} />
                                            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--ram-teal)' }}>
                                                Syncing to library…
                                            </span>
                                        </div>
                                    );
                                }

                                if (ingest.status === 'complete') {
                                    const hasErrors = (ingest.result?.errors?.length ?? 0) > 0;
                                    const hasSkipped = (ingest.result?.skipped ?? 0) > 0;
                                    const isPartial = hasErrors || (hasSkipped && (ingest.result?.ingested ?? 0) === 0);

                                    return (
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                            padding: '6px 14px',
                                            borderTop: '1px solid var(--ram-border)',
                                            background: isPartial
                                                ? 'rgba(251, 191, 36, 0.04)'
                                                : 'rgba(52, 211, 153, 0.04)',
                                        }}>
                                            {isPartial ? (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2.5">
                                                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                                                    <line x1="12" y1="9" x2="12" y2="13" />
                                                    <line x1="12" y1="17" x2="12.01" y2="17" />
                                                </svg>
                                            ) : (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ram-green, #34d399)" strokeWidth="3">
                                                    <polyline points="20 6 9 17 4 12" />
                                                </svg>
                                            )}
                                            <span style={{
                                                fontSize: '11px',
                                                fontWeight: 600,
                                                color: isPartial ? '#fbbf24' : 'var(--ram-green, #34d399)',
                                            }}>
                                                {(ingest.result?.ingested ?? 0) > 0
                                                    ? `Added ${ingest.result?.ingested} asset${(ingest.result?.ingested ?? 0) !== 1 ? 's' : ''} to library`
                                                    : 'No assets ingested'
                                                }
                                                {hasSkipped && (
                                                    <span style={{ fontWeight: 400, color: 'var(--ram-text-tertiary)', marginLeft: '4px' }}>
                                                        ({ingest.result?.skipped} skipped)
                                                    </span>
                                                )}
                                                {hasErrors && (
                                                    <span style={{ fontWeight: 400, color: '#fbbf24', marginLeft: '4px' }}>
                                                        · {ingest.result?.errors?.length} error{(ingest.result?.errors?.length ?? 0) !== 1 ? 's' : ''}
                                                    </span>
                                                )}
                                            </span>
                                            {isPartial && (
                                                <>
                                                    <div style={{ flex: 1 }} />
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); onRetryIngest?.(batch.id); }}
                                                        style={{
                                                            fontSize: '10px',
                                                            fontWeight: 600,
                                                            padding: '3px 8px',
                                                            borderRadius: '4px',
                                                            border: '1px solid rgba(251, 191, 36, 0.3)',
                                                            background: 'rgba(251, 191, 36, 0.1)',
                                                            color: '#fbbf24',
                                                            cursor: 'pointer',
                                                        }}
                                                    >
                                                        Retry
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    );
                                }

                                if (ingest.status === 'error') {
                                    return (
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                            padding: '6px 14px',
                                            borderTop: '1px solid var(--ram-border)',
                                            background: 'rgba(248, 113, 113, 0.04)',
                                        }}>
                                            <span style={{ fontSize: '12px' }}>⚠️</span>
                                            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--ram-red, #f87171)' }}>
                                                Library sync failed
                                                {ingest.result?.errors?.[0] && (
                                                    <span style={{ fontWeight: 400, marginLeft: '4px' }}>
                                                        — {ingest.result.errors[0].substring(0, 80)}
                                                    </span>
                                                )}
                                            </span>
                                            <div style={{ flex: 1 }} />
                                            <button
                                                onClick={(e) => { e.stopPropagation(); onRetryIngest?.(batch.id); }}
                                                style={{
                                                    fontSize: '10px',
                                                    fontWeight: 600,
                                                    padding: '3px 8px',
                                                    borderRadius: '4px',
                                                    border: '1px solid rgba(248, 113, 113, 0.3)',
                                                    background: 'rgba(248, 113, 113, 0.1)',
                                                    color: '#f87171',
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                Retry
                                            </button>
                                        </div>
                                    );
                                }

                                if (ingest.status === 'cancelled') {
                                    return (
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                            padding: '6px 14px',
                                            borderTop: '1px solid var(--ram-border)',
                                            background: 'rgba(251, 191, 36, 0.04)',
                                        }}>
                                            <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--ram-text-tertiary)' }}>
                                                Library sync cancelled
                                            </span>
                                        </div>
                                    );
                                }

                                return null;
                            })()}

                            {/* Expanded file list */}
                            {isExpanded && (
                                <div style={{
                                    borderTop: '1px solid var(--ram-border)',
                                    padding: '4px 0',
                                    maxHeight: '260px',
                                    overflowY: 'auto',
                                }}>
                                    {batch.files.map(file => {
                                        const details = fileDetails(file);
                                        const warned = file.status === 'success' && (file.warnings?.length ?? 0) > 0;
                                        const active = file.status === 'processing' || file.status === 'analyzing';
                                        return (
                                            <div
                                                key={file.id}
                                                title={details ? details.lines.join('\n') : undefined}
                                                style={{
                                                    padding: '5px 14px',
                                                    fontSize: '11px',
                                                    borderLeft: active
                                                        ? '3px solid var(--ram-teal)'
                                                        : '3px solid transparent',
                                                    background: active
                                                        ? 'rgba(45,212,191,0.05)'
                                                        : 'transparent',
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    {/* Status icon */}
                                                    {file.status === 'success' && !warned && (
                                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--ram-green, #34d399)" strokeWidth="3" className="flex-shrink-0">
                                                            <polyline points="20 6 9 17 4 12" />
                                                        </svg>
                                                    )}
                                                    {warned && WARNING_ICON(10)}
                                                    {file.status === 'error' && (
                                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--ram-red, #f87171)" strokeWidth="3" className="flex-shrink-0">
                                                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                                                        </svg>
                                                    )}
                                                    {file.status === 'cancelled' && (
                                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="3" className="flex-shrink-0">
                                                            <line x1="5" y1="12" x2="19" y2="12" />
                                                        </svg>
                                                    )}
                                                    {active && (
                                                        <div className="w-2.5 h-2.5 rounded-full border-[1.5px] animate-spin flex-shrink-0"
                                                            style={{ borderColor: 'transparent', borderTopColor: 'var(--ram-teal)' }} />
                                                    )}
                                                    {file.status === 'queued' && (
                                                        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: 'var(--ram-border)' }} />
                                                    )}

                                                    {/* Original name → Proposed/final name */}
                                                    <span className="truncate" style={{ color: 'var(--ram-text-tertiary)', maxWidth: '30%' }}>
                                                        {file.name}
                                                    </span>
                                                    <span style={{ color: 'var(--ram-text-tertiary)', flexShrink: 0 }}>→</span>
                                                    <span className="truncate" style={{
                                                        flex: 1,
                                                        color: file.status === 'success'
                                                            ? 'var(--ram-teal)'
                                                            : active
                                                                ? 'var(--ram-accent)'
                                                                : 'var(--ram-text-secondary)',
                                                        fontWeight: file.status === 'success' ? 600 : 400,
                                                        textDecoration: file.status === 'cancelled' || file.revert === 'done' ? 'line-through' : 'none',
                                                    }}>
                                                        {file.status === 'analyzing' ? `🧠 ${file.finalName || file.proposedName}` : (file.finalName || file.targetName || file.proposedName)}
                                                    </span>

                                                    {/* Orientation tag */}
                                                    {file.orientation && (
                                                        <span
                                                            style={{
                                                                fontSize: '9px',
                                                                fontWeight: 600,
                                                                padding: '2px 6px',
                                                                borderRadius: '4px',
                                                                background: `${orientationColor(file.orientation)}15`,
                                                                color: orientationColor(file.orientation),
                                                                flexShrink: 0,
                                                                textTransform: 'capitalize',
                                                            }}
                                                        >
                                                            {file.orientation}
                                                        </span>
                                                    )}
                                                </div>

                                                {/* Failure reason / warnings */}
                                                {details && (
                                                    <div style={{
                                                        margin: '2px 0 0 18px',
                                                        fontSize: '10px',
                                                        lineHeight: 1.4,
                                                        color: details.tone === 'error'
                                                            ? 'var(--ram-red, #f87171)'
                                                            : details.tone === 'warning'
                                                                ? '#fbbf24'
                                                                : 'var(--ram-text-tertiary)',
                                                        wordBreak: 'break-word',
                                                    }}>
                                                        {details.lines.map((line, i) => <div key={i}>{line}</div>)}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
