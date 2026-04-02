'use client';

import { useEffect, useRef, useState } from 'react';

interface TrashItem {
    id: string;
    name: string;
    thumbnail_url: string | null;
    folder_path: string;
    asset_type: 'photo' | 'video';
    deleted_at: string;
    deleted_reason: 'orphaned' | 'ignored' | null;
    daysRemaining: number;
}

interface TrashPanelProps {
    items: TrashItem[];
    onAction: (id: string, action: 'restore' | 'purge') => void;
    onClose: () => void;
}

export default function TrashPanel({ items, onAction, onClose }: TrashPanelProps) {
    const overlayRef = useRef<HTMLDivElement>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    // Close on overlay click
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (overlayRef.current === e.target) onClose();
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [onClose]);

    // Close on Escape
    useEffect(() => {
        function handleKey(e: KeyboardEvent) {
            if (e.key === 'Escape') onClose();
        }
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [onClose]);

    function reasonLabel(reason: TrashItem['deleted_reason']) {
        switch (reason) {
            case 'ignored':
                return { text: 'In ignored folder', icon: '🚫', color: 'var(--ram-amber, #f59e0b)' };
            case 'orphaned':
            default:
                return { text: 'Removed from Drive', icon: '☁️', color: 'var(--ram-text-tertiary)' };
        }
    }

    function formatDate(dateStr: string) {
        return new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    }

    return (
        <div
            ref={overlayRef}
            className="modal-overlay"
            style={{ zIndex: 100 }}
        >
            <div
                className="modal-content"
                style={{
                    background: 'var(--ram-bg-secondary)',
                    border: '1px solid var(--ram-border)',
                    borderRadius: 16,
                    width: '100%',
                    maxWidth: 540,
                    maxHeight: '85vh',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
                }}
            >
                {/* Header */}
                <div style={{
                    padding: '20px 24px 16px',
                    borderBottom: '1px solid var(--ram-border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexShrink: 0,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>🗑️ Trash</h2>
                        <span style={{
                            fontSize: 11,
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: 10,
                            background: items.length > 0
                                ? 'rgba(239, 68, 68, 0.15)'
                                : 'rgba(255,255,255,0.06)',
                            color: items.length > 0
                                ? 'var(--ram-red, #f87171)'
                                : 'var(--ram-text-tertiary)',
                        }}>
                            {items.length} item{items.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--ram-text-tertiary)',
                            fontSize: 20,
                            cursor: 'pointer',
                            padding: '4px 8px',
                            borderRadius: 6,
                            lineHeight: 1,
                            transition: 'color 0.15s',
                        }}
                        onMouseOver={(e) => (e.currentTarget.style.color = 'var(--ram-text-primary)')}
                        onMouseOut={(e) => (e.currentTarget.style.color = 'var(--ram-text-tertiary)')}
                    >
                        ✕
                    </button>
                </div>

                {/* Subheader */}
                <div style={{
                    padding: '10px 24px',
                    borderBottom: '1px solid var(--ram-border)',
                    flexShrink: 0,
                }}>
                    <p style={{
                        fontSize: 11,
                        color: 'var(--ram-text-tertiary)',
                        margin: 0,
                        lineHeight: 1.5,
                    }}>
                        Assets removed from your sync scope are auto-purged after <strong style={{ color: 'var(--ram-text-secondary)' }}>14 days</strong>.
                        Restore to bring them back to your library.
                    </p>
                </div>

                {/* Items list */}
                <div style={{
                    overflow: 'auto',
                    flex: 1,
                    minHeight: 0,
                }}>
                    {items.length === 0 ? (
                        <div style={{
                            padding: '48px 24px',
                            textAlign: 'center',
                        }}>
                            <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.4 }}>🧹</div>
                            <p style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: 'var(--ram-text-secondary)',
                                margin: '0 0 4px',
                            }}>
                                No items pending deletion
                            </p>
                            <p style={{
                                fontSize: 11,
                                color: 'var(--ram-text-tertiary)',
                                margin: 0,
                            }}>
                                Trash is empty — all assets are synced
                            </p>
                        </div>
                    ) : (
                        items.map((item, index) => {
                            const reason = reasonLabel(item.deleted_reason);
                            const urgencyPct = Math.max(0, Math.min(1, 1 - item.daysRemaining / 14));
                            const urgencyColor = urgencyPct > 0.7
                                ? 'var(--ram-red, #ef4444)'
                                : urgencyPct > 0.4
                                    ? 'var(--ram-amber, #f59e0b)'
                                    : 'var(--ram-text-tertiary)';
                            const isExpanded = expandedId === item.id;

                            return (
                                <div
                                    key={item.id}
                                    style={{
                                        padding: '14px 24px',
                                        borderBottom: index < items.length - 1
                                            ? '1px solid var(--ram-border)'
                                            : 'none',
                                        display: 'flex',
                                        gap: 14,
                                        alignItems: 'flex-start',
                                        transition: 'background 0.15s',
                                    }}
                                    onMouseOver={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                                    onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                                >
                                    {/* Thumbnail — larger when expanded */}
                                    <div style={{
                                        width: isExpanded ? 72 : 48,
                                        height: isExpanded ? 72 : 48,
                                        borderRadius: 8,
                                        overflow: 'hidden',
                                        flexShrink: 0,
                                        background: 'var(--ram-bg-tertiary)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        border: '1px solid var(--ram-border)',
                                        transition: 'width 0.2s ease, height 0.2s ease',
                                    }}>
                                        {item.thumbnail_url ? (
                                            <img
                                                src={item.thumbnail_url}
                                                alt=""
                                                style={{
                                                    width: '100%',
                                                    height: '100%',
                                                    objectFit: 'cover',
                                                }}
                                            />
                                        ) : (
                                            <span style={{
                                                fontSize: isExpanded ? 24 : 18,
                                                opacity: 0.3,
                                                transition: 'font-size 0.2s ease',
                                            }}>
                                                {item.asset_type === 'video' ? '🎬' : '📷'}
                                            </span>
                                        )}
                                    </div>

                                    {/* Info */}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <p
                                            onClick={() => setExpandedId(isExpanded ? null : item.id)}
                                            style={{
                                                fontSize: 12,
                                                fontWeight: 500,
                                                color: 'var(--ram-text-primary)',
                                                margin: '0 0 3px',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                cursor: 'pointer',
                                            }}
                                        >
                                            {item.name}
                                        </p>
                                        <FolderBreadcrumb
                                            path={item.folder_path}
                                            expanded={isExpanded}
                                            onToggle={() => setExpandedId(isExpanded ? null : item.id)}
                                        />
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 8,
                                            flexWrap: 'wrap',
                                            marginTop: 5,
                                        }}>
                                            {/* Reason badge */}
                                            <span style={{
                                                fontSize: 10,
                                                fontWeight: 500,
                                                color: reason.color,
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 3,
                                            }}>
                                                {reason.icon} {reason.text}
                                            </span>
                                            <span style={{
                                                width: 3,
                                                height: 3,
                                                borderRadius: '50%',
                                                background: 'var(--ram-text-tertiary)',
                                                opacity: 0.4,
                                                flexShrink: 0,
                                            }} />
                                            {/* Countdown */}
                                            <span style={{
                                                fontSize: 10,
                                                fontWeight: 500,
                                                color: urgencyColor,
                                            }}>
                                                {item.daysRemaining === 0
                                                    ? 'Purging soon'
                                                    : `${item.daysRemaining} day${item.daysRemaining !== 1 ? 's' : ''} left`}
                                            </span>
                                            <span style={{
                                                width: 3,
                                                height: 3,
                                                borderRadius: '50%',
                                                background: 'var(--ram-text-tertiary)',
                                                opacity: 0.4,
                                                flexShrink: 0,
                                            }} />
                                            {/* Deleted date */}
                                            <span style={{
                                                fontSize: 10,
                                                color: 'var(--ram-text-tertiary)',
                                            }}>
                                                {formatDate(item.deleted_at)}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Actions */}
                                    <div style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 6,
                                        flexShrink: 0,
                                        paddingTop: 2,
                                    }}>
                                        <button
                                            onClick={() => onAction(item.id, 'restore')}
                                            style={{
                                                padding: '5px 12px',
                                                borderRadius: 6,
                                                fontSize: 11,
                                                fontWeight: 600,
                                                border: 'none',
                                                cursor: 'pointer',
                                                background: 'var(--ram-accent)',
                                                color: 'var(--ram-bg-primary)',
                                                transition: 'opacity 0.15s',
                                            }}
                                            onMouseOver={(e) => (e.currentTarget.style.opacity = '0.85')}
                                            onMouseOut={(e) => (e.currentTarget.style.opacity = '1')}
                                            title="Restore to library"
                                        >
                                            Restore
                                        </button>
                                        <button
                                            onClick={() => onAction(item.id, 'purge')}
                                            style={{
                                                padding: '5px 12px',
                                                borderRadius: 6,
                                                fontSize: 11,
                                                fontWeight: 600,
                                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                                cursor: 'pointer',
                                                background: 'transparent',
                                                color: 'var(--ram-red, #f87171)',
                                                transition: 'all 0.15s',
                                            }}
                                            onMouseOver={(e) => {
                                                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                                                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.5)';
                                            }}
                                            onMouseOut={(e) => {
                                                e.currentTarget.style.background = 'transparent';
                                                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.3)';
                                            }}
                                            title="Delete permanently"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}


/* ── Chevron icon ──────────────────────────────────────────────── */

function ChevronIcon() {
    return (
        <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, opacity: 0.35 }}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    );
}


/* ── Folder breadcrumb ─────────────────────────────────────────── */

/**
 * Click-to-expand folder breadcrumb.
 * Collapsed: folder icon + last 2 segments + "…" prefix.
 * Expanded: all segments, wrapping across lines, with a subtle background.
 */
function FolderBreadcrumb({
    path,
    expanded,
    onToggle,
}: {
    path: string;
    expanded: boolean;
    onToggle: () => void;
}) {
    if (!path) return null;

    // Clean up and split the path
    const cleanPath = path.replace(/^\/+|\/+$/g, '');
    const segments = cleanPath.split('/').filter(Boolean);

    // Collapsed: last 2 segments only
    const MAX_VISIBLE = 2;
    const showEllipsis = segments.length > MAX_VISIBLE;
    const collapsedSegments = showEllipsis
        ? segments.slice(segments.length - MAX_VISIBLE)
        : segments;

    const displaySegments = expanded ? segments : collapsedSegments;

    return (
        <div
            onClick={onToggle}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 10,
                color: 'var(--ram-text-tertiary)',
                margin: '2px 0 0',
                cursor: 'pointer',
                position: 'relative',
                // Expanded: wrap and show full path with bg
                ...(expanded
                    ? {
                        flexWrap: 'wrap',
                        background: 'rgba(255,255,255,0.03)',
                        borderRadius: 6,
                        padding: '5px 8px',
                        border: '1px solid var(--ram-border)',
                    }
                    : {
                        overflow: 'hidden',
                        flexWrap: 'nowrap',
                    }),
                transition: 'all 0.15s ease',
            }}
            title={expanded ? 'Click to collapse' : 'Click to see full path'}
        >
            {/* Folder icon */}
            <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0, opacity: 0.5 }}
            >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>

            {/* Collapsed ellipsis prefix */}
            {!expanded && showEllipsis && (
                <>
                    <span style={{ opacity: 0.5 }}>…</span>
                    <ChevronIcon />
                </>
            )}

            {displaySegments.map((seg, i) => (
                <span
                    key={i}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                    }}
                >
                    {i > 0 && <ChevronIcon />}
                    <span style={{
                        whiteSpace: expanded ? 'normal' : 'nowrap',
                        overflow: expanded ? 'visible' : 'hidden',
                        textOverflow: expanded ? 'unset' : 'ellipsis',
                        maxWidth: expanded ? 'none' : 160,
                        wordBreak: expanded ? 'break-word' : undefined,
                    }}>
                        {seg}
                    </span>
                </span>
            ))}

            {/* Expand/collapse hint */}
            {!expanded && showEllipsis && (
                <span style={{
                    marginLeft: 2,
                    opacity: 0.4,
                    fontSize: 8,
                    flexShrink: 0,
                }}>
                    ▼
                </span>
            )}
            {expanded && (
                <span style={{
                    marginLeft: 'auto',
                    opacity: 0.4,
                    fontSize: 8,
                    flexShrink: 0,
                    paddingLeft: 6,
                }}>
                    ▲
                </span>
            )}
        </div>
    );
}

