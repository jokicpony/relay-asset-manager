'use client';

import { FolderNode } from '@/types';
import { useState, useEffect, useCallback } from 'react';

interface FolderSidebarProps {
    tree: FolderNode;
    selectedPath: string | null;
    onSelectFolder: (path: string | null) => void;
    isOpen: boolean;
    onToggle: () => void;
    pinboardCount?: number;
    pinboardActive?: boolean;
    onTogglePinboard?: () => void;
    onClearPinboard?: () => void;
    onSelectAllPinboard?: () => void;
    hiddenFolders?: string[];
    onToggleHidden?: (path: string) => void;
}

export default function FolderSidebar({
    tree,
    selectedPath,
    onSelectFolder,
    isOpen,
    onToggle,
    pinboardCount = 0,
    pinboardActive = false,
    onTogglePinboard,
    onClearPinboard,
    onSelectAllPinboard,
    hiddenFolders = [],
    onToggleHidden,
}: FolderSidebarProps) {
    // ── Context menu for "Copy link" and "Open in Drive" ──
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    const [folderDriveIds, setFolderDriveIds] = useState<Record<string, string>>({});

    // Load folder path → Drive folder ID mapping (persisted during sync)
    useEffect(() => {
        fetch('/api/folders/drive-ids')
            .then(res => res.json())
            .then(data => { if (data && typeof data === 'object') setFolderDriveIds(data); })
            .catch(() => {}); // silent fail — feature degrades gracefully
    }, []);

    // Close context menu on any click
    useEffect(() => {
        if (!ctxMenu) return;
        const close = () => setCtxMenu(null);
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, [ctxMenu]);

    const handleCopyLink = useCallback((folderPath: string) => {
        const url = new URL(window.location.href);
        url.search = '';
        // Strip leading slash and keep path separators readable
        const clean = folderPath.replace(/^\//, '');
        url.search = `?folder=${encodeURIComponent(clean).replace(/%2F/gi, '/').replace(/%20/g, '+')}`;
        navigator.clipboard.writeText(url.toString()).then(() => {
            setToast('Link copied!');
            setTimeout(() => setToast(null), 2000);
        });
        setCtxMenu(null);
    }, []);

    const handleOpenInDrive = useCallback((folderPath: string) => {
        const folderId = folderDriveIds[folderPath];
        if (folderId) {
            window.open(`https://drive.google.com/drive/folders/${folderId}`, '_blank');
        } else {
            setToast('Drive link not available — run a sync first');
            setTimeout(() => setToast(null), 2000);
        }
        setCtxMenu(null);
    }, [folderDriveIds]);

    const handleCopyDriveLink = useCallback((folderPath: string) => {
        const folderId = folderDriveIds[folderPath];
        if (folderId) {
            navigator.clipboard.writeText(`https://drive.google.com/drive/folders/${folderId}`).then(() => {
                setToast('Google Drive link copied!');
                setTimeout(() => setToast(null), 2000);
            });
        } else {
            setToast('Drive link not available — run a sync first');
            setTimeout(() => setToast(null), 2000);
        }
        setCtxMenu(null);
    }, [folderDriveIds]);

    const handleContextMenu = useCallback((e: React.MouseEvent, path: string) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY, path });
    }, []);

    // ── Eye icon tooltip (fixed position to escape overflow clipping) ──
    const [eyeTooltip, setEyeTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
    return (
        <>
            {/* Toggle button (visible when sidebar is closed) */}
            {!isOpen && (
                <button
                    onClick={onToggle}
                    className="fixed left-4 top-20 z-30 p-2 rounded-lg transition-colors hover:bg-[var(--ram-bg-hover)]"
                    style={{
                        background: 'var(--ram-bg-secondary)',
                        border: '1px solid var(--ram-border)',
                    }}
                    title="Open folder browser"
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-secondary)" strokeWidth="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                </button>
            )}

            {/* Sidebar */}
            <div
                className="flex-shrink-0 h-full overflow-y-auto transition-all duration-300"
                style={{
                    width: isOpen ? '240px' : '0px',
                    opacity: isOpen ? 1 : 0,
                    background: 'var(--ram-bg-secondary)',
                    borderRight: '1px solid var(--ram-border)',
                }}
            >
                <div className="p-3" style={{ minWidth: '240px' }}>
                    {/* Header */}
                    <div className="flex items-center justify-between mb-3 px-2">
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--ram-text-tertiary)' }}>
                            Folders
                        </span>
                        <button
                            onClick={onToggle}
                            className="p-1 rounded hover:bg-[var(--ram-bg-hover)] transition-colors"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2">
                                <path d="M15 18l-6-6 6-6" />
                            </svg>
                        </button>
                    </div>

                    {/* ── Pinboard section ────────────────────────────── */}
                    {pinboardCount > 0 && (
                        <div className="mb-3">
                            <div
                                className={`pinboard-section ${pinboardActive ? 'active' : ''}`}
                                onClick={onTogglePinboard}
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <svg width="14" height="14" viewBox="0 0 24 24"
                                            fill={pinboardActive ? 'var(--ram-accent)' : 'none'}
                                            stroke="var(--ram-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                                        >
                                            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                                        </svg>
                                        <span className="text-[13px] font-semibold" style={{ color: pinboardActive ? 'var(--ram-accent)' : 'var(--ram-text-primary)' }}>
                                            Pinboard
                                        </span>
                                        <span
                                            className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                                            style={{
                                                background: 'var(--ram-accent-muted)',
                                                color: 'var(--ram-accent)',
                                            }}
                                        >
                                            {pinboardCount}
                                        </span>
                                    </div>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onClearPinboard?.();
                                        }}
                                        className="p-1 rounded hover:bg-[var(--ram-bg-hover)] transition-colors"
                                        title="Clear pinboard"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2">
                                            <path d="M18 6L6 18M6 6l12 12" />
                                        </svg>
                                    </button>
                                </div>
                                <p className="text-[10px] mt-1.5 ml-[22px]" style={{ color: 'var(--ram-text-tertiary)' }}>
                                    Session only · clears on refresh
                                </p>
                                {pinboardActive && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onSelectAllPinboard?.();
                                        }}
                                        className="flex items-center justify-center gap-1.5 w-full mt-2 py-1.5 rounded-md text-[11px] font-medium transition-all hover:brightness-110 active:scale-[0.98]"
                                        style={{
                                            color: 'var(--ram-accent)',
                                            background: 'var(--ram-accent-muted)',
                                            border: '1px solid rgba(232, 168, 56, 0.2)',
                                        }}
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="9 11 12 14 22 4" />
                                            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                                        </svg>
                                        Select All
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* "All Folders" option */}
                    <div
                        className={`folder-item ${selectedPath === null && !pinboardActive ? 'active' : ''}`}
                        onClick={() => { onSelectFolder(null); }}
                    >
                        <div className="flex items-center gap-2">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                            </svg>
                            <span>All Folders</span>
                        </div>
                    </div>

                    {/* Folder tree */}
                    <div className="mt-1">
                        {tree.children.map((node, index) => (
                            <div key={node.id}>
                                {index > 0 && <div className="folder-section-divider" />}
                                <FolderTreeNode
                                    node={node}
                                    selectedPath={selectedPath}
                                    onSelect={onSelectFolder}
                                    depth={0}
                                    pinboardActive={pinboardActive}
                                    hiddenFolders={hiddenFolders}
                                    onToggleHidden={onToggleHidden}
                                    onContextMenu={handleContextMenu}
                                    onEyeTooltip={setEyeTooltip}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Context menu */}
            {ctxMenu && (
                <div
                    className="fixed z-[9999] rounded-lg shadow-xl overflow-hidden"
                    style={{
                        left: ctxMenu.x,
                        top: ctxMenu.y,
                        background: 'var(--ram-bg-elevated)',
                        border: '1px solid var(--ram-border)',
                        minWidth: 200,
                    }}
                >
                    <button
                        onClick={() => handleCopyLink(ctxMenu.path)}
                        className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors hover:bg-[var(--ram-bg-hover)]"
                        style={{ color: 'var(--ram-text-primary)' }}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                        </svg>
                        Copy Relay Direct Link
                    </button>
                    <div style={{ height: 1, background: 'var(--ram-border)' }} />
                    <button
                        onClick={() => handleCopyDriveLink(ctxMenu.path)}
                        className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors hover:bg-[var(--ram-bg-hover)]"
                        style={{
                            color: folderDriveIds[ctxMenu.path] ? 'var(--ram-text-primary)' : 'var(--ram-text-tertiary)',
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                            <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                        </svg>
                        Copy Google Drive Link
                    </button>
                    <div style={{ height: 1, background: 'var(--ram-border)' }} />
                    <button
                        onClick={() => handleOpenInDrive(ctxMenu.path)}
                        className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors hover:bg-[var(--ram-bg-hover)]"
                        style={{
                            color: folderDriveIds[ctxMenu.path] ? 'var(--ram-text-primary)' : 'var(--ram-text-tertiary)',
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                        Open in Google Drive
                    </button>
                </div>
            )}

            {/* Eye icon tooltip (fixed position to escape sidebar overflow) */}
            {eyeTooltip && (
                <div
                    className="fixed z-[9999] pointer-events-none whitespace-nowrap rounded-lg px-3 py-2 text-xs shadow-xl"
                    style={{
                        left: eyeTooltip.x,
                        top: eyeTooltip.y,
                        background: 'var(--ram-bg-elevated)',
                        border: '1px solid var(--ram-border)',
                        color: 'var(--ram-text-primary)',
                    }}
                >
                    {eyeTooltip.text}
                </div>
            )}

            {/* Toast */}
            {toast && (
                <div
                    className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-lg text-xs font-medium shadow-lg"
                    style={{
                        background: 'var(--ram-accent)',
                        color: 'var(--ram-bg-primary)',
                    }}
                >
                    {toast}
                </div>
            )}
        </>
    );
}

function FolderTreeNode({
    node,
    selectedPath,
    onSelect,
    depth,
    pinboardActive = false,
    hiddenFolders = [],
    onToggleHidden,
    onContextMenu,
    onEyeTooltip,
}: {
    node: FolderNode;
    selectedPath: string | null;
    onSelect: (path: string | null) => void;
    depth: number;
    pinboardActive?: boolean;
    hiddenFolders?: string[];
    onToggleHidden?: (path: string) => void;
    onContextMenu?: (e: React.MouseEvent, path: string) => void;
    onEyeTooltip?: (tooltip: { x: number; y: number; text: string } | null) => void;
}) {
    const [expanded, setExpanded] = useState(depth < 1);
    const hasChildren = node.children.length > 0;
    const isSelected = !pinboardActive && selectedPath === node.path;
    const isTopLevel = depth === 0;
    const isHidden = hiddenFolders.includes(node.path);

    return (
        <div>
            <div
                className={`folder-item group ${isSelected ? 'active' : ''} ${isTopLevel ? 'top-level' : ''}`}
                style={{ paddingLeft: `${isTopLevel ? 8 : (depth) * 12 + 8}px` }}
                onClick={() => onSelect(node.path)}
                onContextMenu={onContextMenu ? (e) => onContextMenu(e, node.path) : undefined}
            >
                <div className="flex items-center gap-2">
                    {hasChildren ? (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setExpanded(!expanded);
                            }}
                            className="p-0 flex-shrink-0"
                        >
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                style={{
                                    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                                    transition: 'transform 0.15s ease',
                                }}
                            >
                                <path d="M9 18l6-6-6-6" />
                            </svg>
                        </button>
                    ) : (
                        <span className="w-3" />
                    )}
                    {/* Folder icon — amber filled for top-level, outlined for children */}
                    {isTopLevel ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="var(--ram-accent)" stroke="var(--ram-accent)" strokeWidth="1" className="flex-shrink-0" style={{ opacity: 0.85 }}>
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                    ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                    )}
                    <span className="truncate">{node.name}</span>
                    {/* Eye toggle for top-level folders — hide/show from master view */}
                    {isTopLevel && onToggleHidden && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onEyeTooltip?.(null);
                                const confirmed = window.confirm(
                                    isHidden
                                        ? `Show "${node.name}" in All Folders?\n\nThis folder's assets will appear again in the master view for all users.`
                                        : `Hide "${node.name}" from All Folders?\n\nThis folder's assets will only appear when you navigate directly to it. This is an org-wide setting that affects all users.`
                                );
                                if (confirmed) onToggleHidden(node.path);
                            }}
                            onMouseEnter={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                onEyeTooltip?.({
                                    x: rect.right + 8,
                                    y: rect.top,
                                    text: isHidden
                                        ? 'Assets hidden from All Folders — select this folder to view'
                                        : 'Click to hide from All Folders view',
                                });
                            }}
                            onMouseLeave={() => onEyeTooltip?.(null)}
                            className="ml-auto p-1 rounded flex-shrink-0 transition-all"
                            style={{
                                opacity: isHidden ? 1 : 0.4,
                            }}
                        >
                            {isHidden ? (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                                    stroke="var(--ram-accent)" strokeWidth="2"
                                    strokeLinecap="round" strokeLinejoin="round"
                                >
                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                                    <line x1="1" y1="1" x2="23" y2="23" />
                                </svg>
                            ) : (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                                    stroke="var(--ram-text-tertiary)" strokeWidth="1.5"
                                    strokeLinecap="round" strokeLinejoin="round"
                                >
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                </svg>
                            )}
                        </button>
                    )}
                </div>
            </div>
            {expanded && hasChildren && (
                <div className={isTopLevel ? 'folder-children' : ''}>
                    {node.children.map((child) => (
                        <FolderTreeNode
                            key={child.id}
                            node={child}
                            selectedPath={selectedPath}
                            onSelect={onSelect}
                            depth={depth + 1}
                            onContextMenu={onContextMenu}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
