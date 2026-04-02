'use client';

import { useState, useCallback, useRef } from 'react';

interface ActionBarProps {
    selectedCount: number;
    onRelay: () => void;
    onDownload: () => void;
    onClearSelection: () => void;
    downloading?: boolean;
    googleConnected?: boolean;
    onReconnect?: () => void;
    onPinToBoard?: () => void;
    onUnpinFromBoard?: () => void;
}

export default function ActionBar({
    selectedCount,
    onRelay,
    onDownload,
    onClearSelection,
    downloading = false,
    googleConnected = true,
    onReconnect,
    onPinToBoard,
    onUnpinFromBoard,
}: ActionBarProps) {
    // Local feedback state: 'idle' → 'spinning' → 'confirmed' → 'idle'
    const [downloadFeedback, setDownloadFeedback] = useState<'idle' | 'spinning' | 'confirmed'>('idle');
    const feedbackTimer = useRef<NodeJS.Timeout | null>(null);

    const handleDownload = useCallback(() => {
        if (!googleConnected || downloading || downloadFeedback !== 'idle') return;
        onDownload();
        setDownloadFeedback('spinning');
        feedbackTimer.current = setTimeout(() => {
            setDownloadFeedback('confirmed');
            feedbackTimer.current = setTimeout(() => {
                setDownloadFeedback('idle');
            }, 800);
        }, 800);
    }, [googleConnected, downloading, downloadFeedback, onDownload]);

    return (
        <div className={`action-bar ${selectedCount > 0 ? 'visible' : ''}`}>
            <div
                className="mx-4 mb-4 px-5 py-3 rounded-2xl flex items-center gap-4"
                style={{
                    background: 'var(--ram-bg-elevated)',
                    border: '1px solid var(--ram-border-hover)',
                    boxShadow: '0 -4px 32px rgba(0, 0, 0, 0.5)',
                    backdropFilter: 'blur(12px)',
                }}
            >
                {/* Left: Selection management */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={onClearSelection}
                        className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-[var(--ram-bg-hover)]"
                        title="Clear selection"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2.5">
                            <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                    </button>
                    <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold"
                        style={{
                            background: 'var(--ram-accent-muted)',
                            color: 'var(--ram-accent)',
                        }}
                    >
                        {selectedCount}
                    </div>
                    <span className="text-sm" style={{ color: 'var(--ram-text-secondary)' }}>
                        selected
                    </span>
                </div>

                <div className="flex-1" />

                {/* Right: Actions */}
                <div className="flex items-center gap-2">
                    {/* Reconnect button when disconnected */}
                    {!googleConnected && (
                        <button
                            onClick={onReconnect}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                            style={{
                                background: 'rgba(251, 191, 36, 0.12)',
                                border: '1px solid rgba(251, 191, 36, 0.35)',
                                color: 'var(--ram-amber, #fbbf24)',
                            }}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                                <polyline points="10 17 15 12 10 7" />
                                <line x1="15" y1="12" x2="3" y2="12" />
                            </svg>
                            Reconnect Drive
                        </button>
                    )}

                    {/* Pin to Board (browse mode) */}
                    {onPinToBoard && (
                        <button
                            onClick={onPinToBoard}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                            style={{
                                background: 'var(--ram-accent-muted)',
                                border: '1px solid rgba(232, 168, 56, 0.25)',
                                color: 'var(--ram-accent)',
                            }}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                            </svg>
                            Pin
                        </button>
                    )}

                    {/* Unpin from Board (pinboard view) */}
                    {onUnpinFromBoard && (
                        <button
                            onClick={onUnpinFromBoard}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                            style={{
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.25)',
                                color: 'rgb(239, 68, 68)',
                            }}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                                <line x1="4" y1="4" x2="20" y2="20" />
                            </svg>
                            Unpin
                        </button>
                    )}

                    {/* Shortcut to Folder — secondary */}
                    <button
                        onClick={googleConnected ? onRelay : undefined}
                        disabled={!googleConnected || downloading}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
                        style={{
                            background: 'var(--ram-bg-hover)',
                            border: '1px solid var(--ram-border-hover)',
                            color: 'var(--ram-text-primary)',
                            opacity: !googleConnected ? 0.35 : 1,
                            cursor: !googleConnected ? 'not-allowed' : 'pointer',
                        }}
                    >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 3H5a2 2 0 0 0-2 2v4" />
                            <path d="M15 3h4a2 2 0 0 1 2 2v4" />
                            <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
                            <path d="M15 21h4a2 2 0 0 0 2-2v-4" />
                            <path d="M12 8v8" />
                            <path d="M8 12h8" />
                        </svg>
                        Shortcut
                    </button>

                    {/* Download — primary */}
                    <button
                        onClick={handleDownload}
                        disabled={!googleConnected || downloading || downloadFeedback !== 'idle'}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
                        style={{
                            background: downloadFeedback === 'confirmed'
                                ? 'rgba(52, 211, 153, 0.1)'
                                : downloadFeedback === 'spinning' || downloading
                                    ? 'var(--ram-accent-muted)'
                                    : 'var(--ram-accent)',
                            border: downloadFeedback === 'confirmed'
                                ? '1px solid rgba(52, 211, 153, 0.3)'
                                : '1px solid transparent',
                            color: downloadFeedback === 'confirmed'
                                ? 'var(--ram-green, #34d399)'
                                : downloadFeedback === 'spinning' || downloading
                                    ? 'var(--ram-accent)'
                                    : 'var(--ram-bg-primary)',
                            opacity: !googleConnected ? 0.35 : 1,
                            cursor: !googleConnected ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {downloadFeedback === 'confirmed' ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                        ) : downloadFeedback === 'spinning' || downloading ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                            </svg>
                        ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                        )}
                        {downloadFeedback === 'confirmed'
                            ? 'Queued ✓'
                            : downloadFeedback === 'spinning' || downloading
                                ? 'Downloading…'
                                : 'Download'}
                    </button>
                </div>
            </div>
        </div>
    );
}

