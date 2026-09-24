'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { DownloadPreflightResponse, SkippedDownloadFile } from '@/lib/download/shared';

// ─── Types ───────────────────────────────────────────────────────
// 'complete' / 'partial' mean "handed to the browser's download manager" —
// the file streams straight to disk there, so the page can't observe the
// final byte. 'partial' = some requested files were skipped (see `skipped`).
export type DownloadStatus = 'pending' | 'downloading' | 'complete' | 'partial' | 'error';

export interface DownloadItem {
    id: string;
    name: string;
    status: DownloadStatus;
    startedAt: number;
    completedAt?: number;
    error?: string;
    isAuthError?: boolean;
    /** number of files (for batch zips) */
    fileCount: number;
    /** individual file names (for batch zips) */
    fileNames: string[];
    /** Drive file IDs for "Open in Drive" fallback links */
    driveFileIds: string[];
    /** Files left out of the download, with the server's reason */
    skipped?: SkippedDownloadFile[];
}

/** How long the hidden download frame lingers — long enough for the browser
 *  to take over the response and for an error page to be read back. */
const DOWNLOAD_FRAME_TTL_MS = 5 * 60_000;

/**
 * Start a browser-native download inside a hidden iframe: a GET for single
 * files, a form POST for zips. The response streams to disk through the
 * browser's download manager — nothing is held in page memory, unlike the old
 * fetch → Blob path which buffered entire multi-GB zips.
 *
 * Attachment responses never render in the frame, but an error response
 * (JSON from the route) does, so a frame `load` with a readable body means
 * the server refused the download.
 */
function startNativeDownload(
    frameName: string,
    target: { url: string; payload?: unknown },
    onServerError: (message: string) => void
) {
    const iframe = document.createElement('iframe');
    iframe.name = frameName;
    iframe.style.display = 'none';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    document.body.appendChild(iframe);

    iframe.addEventListener('load', () => {
        let text = '';
        try {
            text = iframe.contentDocument?.body?.textContent?.trim() ?? '';
        } catch {
            return; // not same-origin → not one of our error responses
        }
        if (!text) return; // initial about:blank
        let message = 'Download failed';
        try {
            const data = JSON.parse(text) as { error?: string };
            if (data.error) message = data.error;
        } catch { /* non-JSON error page */ }
        onServerError(message);
    });

    if (target.payload === undefined) {
        iframe.src = target.url;
    } else {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = target.url;
        form.target = frameName;
        form.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'payload';
        input.value = JSON.stringify(target.payload);
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        form.remove();
    }

    setTimeout(() => iframe.remove(), DOWNLOAD_FRAME_TTL_MS);
}

// ─── Hook: useDownloadQueue ──────────────────────────────────────
// Manages the queue state + background fetch logic.
// Returns helpers that page.tsx will use.

export function useDownloadQueue(onAuthError?: () => void) {
    const [items, setItems] = useState<DownloadItem[]>([]);

    // Latest-callback ref: keeps `enqueue` referentially stable without
    // capturing a stale onAuthError from the first render.
    const onAuthErrorRef = useRef(onAuthError);
    useEffect(() => { onAuthErrorRef.current = onAuthError; });

    // Warn user before navigating away while a download is being prepared.
    // Once handed off, the browser's download manager owns it and survives
    // navigation.
    useEffect(() => {
        const hasActive = items.some(
            (i) => i.status === 'pending' || i.status === 'downloading'
        );
        if (!hasActive) return;

        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            // Modern browsers show a generic message; returnValue is for legacy support
            e.returnValue = 'Downloads are in progress. Are you sure you want to leave?';
        };

        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [items]);

    const enqueue = useCallback(
        (files: { driveFileId: string; name: string }[]) => {
            const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const label =
                files.length === 1
                    ? files[0].name
                    : `${files.length} assets (zip)`;

            const item: DownloadItem = {
                id,
                name: label,
                status: 'pending',
                startedAt: Date.now(),
                fileCount: files.length,
                fileNames: files.map((f) => f.name),
                driveFileIds: files.map((f) => f.driveFileId),
            };

            setItems((prev) => [item, ...prev]);

            const update = (patch: Partial<DownloadItem>) =>
                setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));

            // A late error from the download frame (the route refused after a
            // clean preflight — e.g. the session expired in between)
            const failAfterHandoff = (message: string) => {
                const isAuth = message === 'Not authenticated';
                if (isAuth) onAuthErrorRef.current?.();
                update({
                    status: 'error',
                    error: isAuth ? 'Google Drive disconnected' : message,
                    isAuthError: isAuth,
                    completedAt: Date.now(),
                });
            };

            // Start the download
            (async () => {
                update({ status: 'downloading' });

                try {
                    // ── Preflight: the server applies the same scope check the
                    // download will, plus a Drive metadata lookup, and tells us
                    // up front which files can't be included and why ──
                    const res = await fetch('/api/drive/download', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ files, mode: 'preflight' }),
                    });

                    if (!res.ok) {
                        const errData = await res.json().catch(() => ({}));
                        const isAuth = res.status === 401;
                        if (isAuth) onAuthErrorRef.current?.();
                        const err = new Error(errData.error || `Download failed: ${res.status}`) as Error & { isAuthError?: boolean };
                        err.isAuthError = isAuth;
                        throw err;
                    }

                    const { ready, skipped } = await res.json() as DownloadPreflightResponse;

                    if (ready.length === 0) {
                        update({
                            status: 'error',
                            error: files.length === 1
                                ? skipped[0]?.reason ?? 'File is not available'
                                : `None of the ${files.length} files could be downloaded`,
                            skipped,
                            completedAt: Date.now(),
                        });
                        return;
                    }

                    if (ready.length === 1) {
                        // ── Single file: browser-native download via GET endpoint ──
                        const file = ready[0];
                        startNativeDownload(
                            `relay-${id}`,
                            { url: `/api/drive/download/${encodeURIComponent(file.driveFileId)}?name=${encodeURIComponent(file.name)}` },
                            failAfterHandoff
                        );
                    } else {
                        // ── Multi-file: streaming zip via form POST, straight to disk.
                        // Only the preflight-approved files are sent; the route
                        // re-checks scope regardless ──
                        startNativeDownload(
                            `relay-${id}`,
                            { url: '/api/drive/download', payload: { files: ready, mode: 'zip' } },
                            failAfterHandoff
                        );
                    }

                    // Honest status: handed to the browser, and flagged partial
                    // when anything was left out
                    update({
                        status: skipped.length > 0 ? 'partial' : 'complete',
                        skipped,
                        completedAt: Date.now(),
                    });
                } catch (err) {
                    const isAuthErr = (err as { isAuthError?: boolean } | null)?.isAuthError === true;
                    update({
                        status: 'error',
                        error: isAuthErr
                            ? 'Google Drive disconnected'
                            : err instanceof Error
                                ? err.message
                                : 'Download failed',
                        isAuthError: isAuthErr,
                        completedAt: Date.now(),
                    });
                }
            })();

            return id;
        },
        []
    );

    const clearCompleted = useCallback(() => {
        setItems((prev) => prev.filter((i) => i.status === 'pending' || i.status === 'downloading'));
    }, []);

    const clearAll = useCallback(() => {
        setItems((prev) => prev.filter((i) => i.status === 'downloading'));
    }, []);

    const activeCount = items.filter(
        (i) => i.status === 'pending' || i.status === 'downloading'
    ).length;

    return { items, enqueue, clearCompleted, clearAll, activeCount };
}

// ─── Component: DownloadQueue ────────────────────────────────────
// Header icon + dropdown panel.

interface DownloadQueueProps {
    items: DownloadItem[];
    activeCount: number;
    onClearCompleted: () => void;
    onClearAll: () => void;
    onReconnect?: () => void;
}

export default function DownloadQueue({
    items,
    activeCount,
    onClearCompleted,
    onClearAll,
    onReconnect,
}: DownloadQueueProps) {
    const [open, setOpen] = useState(false);
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

    // Don't render anything if no downloads ever
    if (items.length === 0) return null;

    const hasCompleted = items.some(
        (i) => i.status === 'complete' || i.status === 'partial' || i.status === 'error'
    );

    return (
        <div className="relative" ref={panelRef}>
            {/* Header button — larger and more prominent when active */}
            <button
                onClick={() => setOpen(!open)}
                className="relative flex items-center gap-2 rounded-lg transition-all"
                style={{
                    padding: activeCount > 0 ? '6px 12px 6px 10px' : '8px',
                    background: open
                        ? 'var(--ram-bg-hover)'
                        : activeCount > 0
                            ? 'var(--ram-accent-muted)'
                            : 'transparent',
                    border: activeCount > 0
                        ? '1px solid rgba(232, 168, 56, 0.3)'
                        : '1px solid transparent',
                    color: activeCount > 0 ? 'var(--ram-accent)' : 'var(--ram-text-secondary)',
                    animation: activeCount > 0 ? 'downloadPulse 2s ease-in-out infinite' : 'none',
                }}
                title="Downloads"
            >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                </svg>

                {/* Active count label */}
                {activeCount > 0 && (
                    <span className="text-xs font-semibold" style={{ color: 'var(--ram-accent)' }}>
                        {activeCount} active
                    </span>
                )}

                {/* Badge for total items when panel is closed */}
                {activeCount === 0 && items.length > 0 && (
                    <span
                        className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] rounded-full flex items-center justify-center text-[9px] font-bold px-0.5"
                        style={{
                            background: 'var(--ram-text-tertiary)',
                            color: 'var(--ram-bg-primary)',
                        }}
                    >
                        {items.length}
                    </span>
                )}
            </button>

            {/* Dropdown panel */}
            {open && (
                <div
                    className="absolute right-0 top-full mt-2 w-80 rounded-xl overflow-hidden"
                    style={{
                        background: 'var(--ram-bg-elevated)',
                        border: '1px solid var(--ram-border-hover)',
                        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.4)',
                        zIndex: 100,
                    }}
                >
                    {/* Header */}
                    <div
                        className="flex items-center justify-between px-4 py-3"
                        style={{ borderBottom: '1px solid var(--ram-border)' }}
                    >
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--ram-text-tertiary)' }}>
                            Downloads
                        </span>
                        {hasCompleted && (
                            <button
                                onClick={onClearCompleted}
                                className="text-[11px] font-medium transition-colors"
                                style={{ color: 'var(--ram-text-tertiary)', background: 'none', border: 'none', cursor: 'pointer' }}
                                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ram-accent)')}
                                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ram-text-tertiary)')}
                            >
                                Clear finished
                            </button>
                        )}
                    </div>

                    {/* Items */}
                    <div className="max-h-72 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        {items.map((item) => (
                            <DownloadRow key={item.id} item={item} onReconnect={onReconnect} />
                        ))}
                    </div>

                    {/* Footer */}
                    {items.length > 3 && (
                        <div
                            className="px-4 py-2 text-center"
                            style={{ borderTop: '1px solid var(--ram-border)' }}
                        >
                            <button
                                onClick={onClearAll}
                                className="text-[11px] font-medium transition-colors"
                                style={{ color: 'var(--ram-text-tertiary)', background: 'none', border: 'none', cursor: 'pointer' }}
                                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ram-red, #ef4444)')}
                                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ram-text-tertiary)')}
                            >
                                Clear all
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Row: single download item ───────────────────────────────────

function DownloadRow({ item, onReconnect }: { item: DownloadItem; onReconnect?: () => void }) {
    // null = follow the default: partial/failed batches open so the skipped
    // files and their reasons are visible without an extra click
    const [expandedOverride, setExpanded] = useState<boolean | null>(null);
    const [showSlowHint, setShowSlowHint] = useState(false);
    const elapsed = item.completedAt
        ? formatDuration(item.completedAt - item.startedAt)
        : null;
    const isBatch = item.fileCount > 1;
    const skipped = item.skipped ?? [];
    const skippedById = new Map(skipped.map((s) => [s.driveFileId, s.reason]));
    const expanded = expandedOverride ?? (isBatch && skipped.length > 0);

    // Show "Taking a while?" hint after 30s of downloading. No reset needed:
    // the render condition gates on status, and items never re-enter
    // 'downloading' once they complete or fail.
    useEffect(() => {
        if (item.status !== 'downloading') return;
        const timer = setTimeout(() => setShowSlowHint(true), 30_000);
        return () => clearTimeout(timer);
    }, [item.status]);

    // Helper to build a Google Drive link
    const driveLink = (fileId: string) =>
        `https://drive.google.com/file/d/${fileId}/view`;

    return (
        <div style={{ borderBottom: '1px solid var(--ram-border)' }}>
            <div className="flex items-center gap-3 px-4 py-3 transition-colors">
                {/* Status icon */}
                <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center">
                    {(item.status === 'pending' || item.status === 'downloading') && (
                        <div
                            className="w-4 h-4 rounded-full"
                            style={{
                                border: `2px solid ${item.status === 'downloading' ? 'var(--ram-accent)' : 'var(--ram-text-tertiary)'}`,
                                borderTopColor: 'transparent',
                                animation: 'spin 1s linear infinite',
                            }}
                        />
                    )}
                    {item.status === 'complete' && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ram-green, #22c55e)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                        </svg>
                    )}
                    {item.status === 'partial' && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ram-amber, #f59e0b)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                    )}
                    {item.status === 'error' && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ram-red, #ef4444)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="15" y1="9" x2="9" y2="15" />
                            <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                    )}
                </div>

                {/* Name + status */}
                <div className="flex-1 min-w-0">
                    <p
                        className="text-xs font-medium truncate"
                        style={{
                            color: item.status === 'error' ? 'var(--ram-red, #ef4444)' : 'var(--ram-text-primary)',
                        }}
                        title={item.name}
                    >
                        {item.name}
                    </p>
                    <p className="text-[10px] mt-0.5" style={{ color: 'var(--ram-text-tertiary)' }}>
                        {item.status === 'pending' && 'Queued…'}
                        {item.status === 'downloading' && !showSlowHint && 'Checking files…'}
                        {item.status === 'downloading' && showSlowHint && (
                            <span style={{ color: 'var(--ram-amber, #f59e0b)' }}>
                                Taking a while?{' '}
                                <a
                                    href={driveLink(item.driveFileIds[0])}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ color: 'var(--ram-accent)', textDecoration: 'underline', fontWeight: 600 }}
                                >
                                    Open in Drive ↗
                                </a>
                            </span>
                        )}
                        {item.status === 'complete' && `Sent to browser downloads${elapsed ? ` · ${elapsed}` : ''}`}
                        {item.status === 'partial' && (
                            <span style={{ color: 'var(--ram-amber, #f59e0b)' }}>
                                Sent to browser · {skipped.length} of {item.fileCount} skipped
                            </span>
                        )}
                        {item.status === 'error' && !item.isAuthError && (
                            <span>
                                {item.error || 'Failed'}
                                {' · '}
                                <a
                                    href={driveLink(item.driveFileIds[0])}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ color: 'var(--ram-accent)', textDecoration: 'underline', fontWeight: 600 }}
                                >
                                    Open in Drive ↗
                                </a>
                            </span>
                        )}
                        {item.status === 'error' && item.isAuthError && (
                            <span style={{ color: 'var(--ram-amber, #f59e0b)' }}>
                                Drive disconnected —{' '}
                                {onReconnect ? (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onReconnect(); }}
                                        style={{ color: 'var(--ram-accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600, textDecoration: 'underline', fontSize: 'inherit' }}
                                    >
                                        Reconnect
                                    </button>
                                ) : 'sign in again'}
                            </span>
                        )}
                    </p>
                </div>

                {/* Open in Drive icon (always visible for single files) */}
                {!isBatch && item.driveFileIds.length > 0 && (
                    <a
                        href={driveLink(item.driveFileIds[0])}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded transition-colors"
                        style={{ color: 'var(--ram-text-tertiary)' }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ram-accent)')}
                        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ram-text-tertiary)')}
                        title="Open in Google Drive"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                    </a>
                )}

                {/* Expand chevron for batch zips */}
                {isBatch && (
                    <button
                        onClick={() => setExpanded(!expanded)}
                        className="flex-shrink-0 flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors"
                        style={{
                            background: 'var(--ram-bg-hover)',
                            color: 'var(--ram-text-tertiary)',
                            border: 'none',
                            cursor: 'pointer',
                        }}
                    >
                        {item.fileCount} files
                        <svg
                            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                            style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.15s ease' }}
                        >
                            <polyline points="6 9 12 15 18 9" />
                        </svg>
                    </button>
                )}
            </div>

            {/* Expanded file list with individual Drive links */}
            {isBatch && expanded && (
                <div className="px-4 pb-3 pl-[52px]">
                    <div
                        className="flex flex-col gap-1 py-2 px-3 rounded-lg"
                        style={{ background: 'var(--ram-bg-secondary)' }}
                    >
                        {item.fileNames.map((name, idx) => {
                            const skipReason = skippedById.get(item.driveFileIds[idx]);
                            return (
                            <div key={idx} className="flex items-center gap-2 group">
                                <div className="flex-1 min-w-0">
                                    <p
                                        className="text-[10px] truncate"
                                        style={{
                                            color: skipReason ? 'var(--ram-text-tertiary)' : 'var(--ram-text-secondary)',
                                            textDecoration: skipReason ? 'line-through' : 'none',
                                        }}
                                        title={name}
                                    >
                                        {name}
                                    </p>
                                    {skipReason && (
                                        <p className="text-[10px]" style={{ color: 'var(--ram-amber, #f59e0b)' }}>
                                            {skipReason}
                                        </p>
                                    )}
                                </div>
                                {item.driveFileIds[idx] && (
                                    <a
                                        href={driveLink(item.driveFileIds[idx])}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                        style={{ color: 'var(--ram-text-tertiary)' }}
                                        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ram-accent)')}
                                        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ram-text-tertiary)')}
                                        title={`Open ${name} in Drive`}
                                    >
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                            <polyline points="15 3 21 3 21 9" />
                                            <line x1="10" y1="14" x2="21" y2="3" />
                                        </svg>
                                    </a>
                                )}
                            </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Helpers ─────────────────────────────────────────────────────

function formatDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem}s`;
}
