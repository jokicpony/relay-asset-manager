'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Asset } from '@/types';
import { logger } from '@/lib/logger';

interface FolderPickerModalProps {
    assets: Asset[];
    onClose: () => void;
    onComplete: () => void;
    recentFolders: RecentFolder[];
    onRecentFoldersChange: (folders: RecentFolder[]) => void;
    onRelayRecorded?: (entry: {
        assetNames: string[];
        assetIds: string[];
        shortcutIds: string[];
        targetFolder: string;
        targetPath: string;
        succeeded: number;
        failed: number;
        total: number;
    }) => void;
}

interface DriveFolder {
    id: string;
    name: string;
}

interface BreadcrumbItem {
    id: string;
    name: string;
}

export interface RecentFolder {
    id: string;
    name: string;
    path: string;
}

export default function FolderPickerModal({
    assets,
    onClose,
    onComplete,
    recentFolders,
    onRecentFoldersChange,
    onRelayRecorded,
}: FolderPickerModalProps) {
    // Split assets into relayable originals and skipped shortcuts
    const originalAssets = assets.filter((a) => !a.isShortcut);
    const skippedShortcuts = assets.filter((a) => a.isShortcut);

    const [folders, setFolders] = useState<DriveFolder[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
        { id: '', name: 'Shared Drive' },
    ]);

    // Search
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<DriveFolder[] | null>(null);
    const [searching, setSearching] = useState(false);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // New folder creation
    const [creatingFolder, setCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [createError, setCreateError] = useState<string | null>(null);

    // Relay progress
    const [relaying, setRelaying] = useState(false);
    const [relayResult, setRelayResult] = useState<{
        succeeded: number;
        failed: number;
        total: number;
        targetPath: string;
        results: { name: string; success: boolean; error?: string }[];
    } | null>(null);

    const currentFolderId = breadcrumbs[breadcrumbs.length - 1].id;
    const currentFolderPath = '/' + breadcrumbs.slice(1).map((b) => b.name).join('/');

    const fetchFolders = useCallback(async (parentId: string) => {
        setLoading(true);
        setError(null);
        try {
            const url = parentId
                ? `/api/drive/folders?parentId=${encodeURIComponent(parentId)}`
                : '/api/drive/folders';
            const res = await fetch(url);
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setFolders(data.folders || []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load folders');
        } finally {
            setLoading(false);
        }
    }, []);

    // Fetch folders on mount and when navigation changes
    useEffect(() => {
        fetchFolders(currentFolderId);
        setSearchQuery('');
        setSearchResults(null);
    }, [currentFolderId, fetchFolders]);

    // Debounced server-side search
    useEffect(() => {
        if (!searchQuery.trim()) {
            setSearchResults(null);
            setSearching(false);
            return;
        }

        setSearching(true);

        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(async () => {
            try {
                const res = await fetch(
                    `/api/drive/folders?search=${encodeURIComponent(searchQuery.trim())}`
                );
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                const data = await res.json();
                setSearchResults(data.folders || []);
            } catch (err) {
                logger.error('folder-picker-modal', 'Folder search error', { error: err instanceof Error ? err.message : String(err) });
                setSearchResults([]);
            } finally {
                setSearching(false);
            }
        }, 350);

        return () => {
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        };
    }, [searchQuery]);

    // Which folders to display
    const displayFolders = searchResults !== null ? searchResults : folders;

    const navigateInto = (folder: DriveFolder) => {
        setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    };

    const navigateToBreadcrumb = (index: number) => {
        setBreadcrumbs((prev) => prev.slice(0, index + 1));
    };

    // Track a folder as recently used
    const addToRecent = useCallback((folder: { id: string; name: string }, path: string) => {
        const filtered = recentFolders.filter((r) => r.id !== folder.id);
        onRecentFoldersChange(
            [{ id: folder.id, name: folder.name, path }, ...filtered].slice(0, 5)
        );
    }, [recentFolders, onRecentFoldersChange]);

    const handleCreateFolder = async () => {
        if (!newFolderName.trim()) return;
        setCreateError(null);
        try {
            const res = await fetch('/api/drive/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    parentId: currentFolderId || undefined,
                    name: newFolderName.trim(),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            const created = await res.json();
            setFolders((prev) => [...prev, { id: created.id, name: created.name }].sort((a, b) => a.name.localeCompare(b.name)));
            setNewFolderName('');
            setCreatingFolder(false);

            // Auto-navigate into the newly created folder
            setBreadcrumbs((prev) => [...prev, { id: created.id, name: created.name }]);
        } catch (err) {
            setCreateError(err instanceof Error ? err.message : 'Failed to create folder');
        }
    };

    const handleRelay = async () => {
        if (originalAssets.length === 0) return;
        setRelaying(true);

        // Track as recently used
        const lastCrumb = breadcrumbs[breadcrumbs.length - 1];
        addToRecent(lastCrumb, currentFolderPath);

        try {
            const res = await fetch('/api/drive/shortcut', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assets: originalAssets.map((a) => ({
                        driveFileId: a.driveFileId,
                        assetId: a.id.includes('::sc::') ? a.id.split('::sc::')[0] : a.id,
                        name: a.name,
                    })),
                    targetFolderId: currentFolderId,
                    targetFolderPath: currentFolderPath || '/',
                }),
            });
            const data = await res.json();
            setRelayResult({ ...data, targetPath: currentFolderPath || 'Shared Drive root' });

            // Record in relay history
            const successfulResults = (data.results || []).filter((r: { success: boolean; shortcutId?: string }) => r.success && r.shortcutId);
            onRelayRecorded?.({
                assetNames: originalAssets.map((a) => a.name),
                assetIds: originalAssets.map((a) => a.id.includes('::sc::') ? a.id.split('::sc::')[0] : a.id),
                shortcutIds: successfulResults.map((r: { shortcutId: string }) => r.shortcutId),
                targetFolder: breadcrumbs[breadcrumbs.length - 1].name,
                targetPath: currentFolderPath || '/',
                succeeded: data.succeeded,
                failed: data.failed,
                total: data.total ?? originalAssets.length,
            });

            if (data.succeeded > 0) {
                setTimeout(() => {
                    onComplete();
                }, 2500);
            }
        } catch (err) {
            setRelayResult({
                succeeded: 0,
                failed: originalAssets.length,
                total: originalAssets.length,
                targetPath: currentFolderPath || 'Shared Drive root',
                results: originalAssets.map((a) => ({
                    name: a.name,
                    success: false,
                    error: err instanceof Error ? err.message : 'Network error',
                })),
            });
        } finally {
            setRelaying(false);
        }
    };

    // Navigate to a recent folder
    const handleRecentClick = (recent: RecentFolder) => {
        setBreadcrumbs([
            { id: '', name: 'Shared Drive' },
            { id: recent.id, name: recent.name },
        ]);
    };

    // Navigate to a search result folder
    const handleSearchResultClick = (folder: DriveFolder) => {
        // Jump directly into the folder, clearing search
        setSearchQuery('');
        setSearchResults(null);
        setBreadcrumbs([
            { id: '', name: 'Shared Drive' },
            { id: folder.id, name: folder.name },
        ]);
    };

    // ─── Result screen after relay ──────────────────────────────
    if (relayResult) {
        const succeeded = relayResult.results.filter((r) => r.success);
        const failed = relayResult.results.filter((r) => !r.success);

        return (
            <div className="modal-overlay" onClick={onClose}>
                <div
                    className="modal-content flex flex-col w-full max-w-lg mx-4 rounded-2xl overflow-hidden"
                    style={{ background: 'var(--ram-bg-secondary)', border: '1px solid var(--ram-border)' }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--ram-border)' }}>
                        <h2 className="text-sm font-semibold" style={{ color: 'var(--ram-text-primary)' }}>
                            {failed.length === 0 ? '✅ Shortcuts Created' : '⚠️ Shortcuts Created'}
                        </h2>
                        <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--ram-bg-hover)] transition-colors">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-secondary)" strokeWidth="2">
                                <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    {/* Results */}
                    <div className="px-5 py-4 flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
                        {/* Summary counts */}
                        <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--ram-green)' }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M20 6L9 17l-5-5" />
                                </svg>
                                {relayResult.succeeded} created
                            </div>
                            {relayResult.failed > 0 && (
                                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--ram-red)' }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <circle cx="12" cy="12" r="10" />
                                        <path d="M15 9l-6 6M9 9l6 6" />
                                    </svg>
                                    {relayResult.failed} failed
                                </div>
                            )}
                        </div>

                        {/* Destination */}
                        <p className="text-xs" style={{ color: 'var(--ram-text-tertiary)' }}>
                            Shortcuts created in <strong>{relayResult.targetPath}</strong>
                        </p>

                        {/* Succeeded files list */}
                        {succeeded.length > 0 && (
                            <div className="flex flex-col gap-1">
                                <p className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--ram-text-tertiary)' }}>
                                    Shortcutted files
                                </p>
                                <div className="flex flex-col gap-1 max-h-40 overflow-y-auto rounded-lg p-2" style={{ background: 'var(--ram-bg-tertiary)' }}>
                                    {succeeded.map((r, i) => (
                                        <div key={i} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded" style={{ color: 'var(--ram-text-primary)' }}>
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ram-green)" strokeWidth="2.5" className="flex-shrink-0">
                                                <polyline points="20 6 9 17 4 12" />
                                            </svg>
                                            <span className="truncate">{r.name}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Failed files list */}
                        {failed.length > 0 && (
                            <div className="flex flex-col gap-1">
                                <p className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--ram-red)' }}>
                                    Failed
                                </p>
                                <div className="flex flex-col gap-1 max-h-32 overflow-y-auto rounded-lg p-2" style={{ background: 'rgba(248, 113, 113, 0.06)' }}>
                                    {failed.map((r, i) => (
                                        <div key={i} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded" style={{ color: 'var(--ram-red)' }}>
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="flex-shrink-0">
                                                <line x1="18" y1="6" x2="6" y2="18" />
                                                <line x1="6" y1="6" x2="18" y2="18" />
                                            </svg>
                                            <span className="truncate flex-1">{r.name}</span>
                                            <span className="text-[10px] opacity-70 flex-shrink-0">{r.error}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="modal-content flex flex-col w-full max-w-lg mx-4 rounded-2xl overflow-hidden"
                style={{
                    background: 'var(--ram-bg-secondary)',
                    border: '1px solid var(--ram-border)',
                    maxHeight: '80vh',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--ram-border)' }}>
                    <div className="flex items-center gap-3">
                        <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center"
                            style={{ background: 'var(--ram-accent-muted)' }}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ram-accent)" strokeWidth="2">
                                <path d="M9 3H5a2 2 0 0 0-2 2v4" />
                                <path d="M15 3h4a2 2 0 0 1 2 2v4" />
                                <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
                                <path d="M15 21h4a2 2 0 0 0 2-2v-4" />
                                <path d="M12 8v8" />
                                <path d="M8 12h8" />
                            </svg>
                        </div>
                        <div>
                            <h2 className="text-sm font-semibold" style={{ color: 'var(--ram-text-primary)' }}>
                                Shortcut to Folder
                            </h2>
                            <p className="text-[11px]" style={{ color: 'var(--ram-text-tertiary)' }}>
                                Choose a destination for {originalAssets.length} asset{originalAssets.length !== 1 ? 's' : ''}
                            </p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--ram-bg-hover)] transition-colors flex-shrink-0">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-secondary)" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Shortcut skip warning */}
                {skippedShortcuts.length > 0 && (
                    <div className="mx-5 mt-4 p-3 rounded-lg flex gap-3" style={{ background: 'rgba(251, 191, 36, 0.08)', border: '1px solid rgba(251, 191, 36, 0.2)' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ram-amber)" strokeWidth="2" className="flex-shrink-0 mt-0.5">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <div className="flex flex-col gap-1.5 min-w-0">
                            <p className="text-xs font-medium" style={{ color: 'var(--ram-amber)' }}>
                                {skippedShortcuts.length} shortcut{skippedShortcuts.length !== 1 ? 's' : ''} will be skipped
                            </p>
                            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--ram-text-tertiary)' }}>
                                Shortcuts can only be created from original files. The following will be skipped:
                            </p>
                            <div className="flex flex-col gap-1 max-h-20 overflow-y-auto mt-0.5">
                                {skippedShortcuts.map((a) => (
                                    <div key={a.id} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--ram-text-secondary)' }}>
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--ram-amber)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                                            <path d="M7 17L17 7" />
                                            <path d="M7 7h10v10" />
                                        </svg>
                                        <span className="truncate">{a.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* Search bar — always visible */}
                <div className="px-5 pt-4 pb-1">
                    <div
                        className="flex items-center gap-2 px-3 py-2 rounded-lg"
                        style={{ background: 'var(--ram-bg-tertiary)', border: '1px solid var(--ram-border)' }}
                    >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search all folders in Shared Drive…"
                            className="flex-1 bg-transparent text-xs outline-none"
                            style={{ color: 'var(--ram-text-primary)' }}
                        />
                        {searchQuery && (
                            <button
                                onClick={() => { setSearchQuery(''); setSearchResults(null); }}
                                className="p-0.5 rounded hover:bg-[var(--ram-bg-hover)] transition-colors"
                                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                            >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2">
                                    <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                            </button>
                        )}
                        {searching && (
                            <div
                                className="w-3.5 h-3.5 rounded-full flex-shrink-0"
                                style={{ border: '2px solid var(--ram-border)', borderTopColor: 'var(--ram-accent)', animation: 'spin 1s linear infinite' }}
                            />
                        )}
                    </div>
                </div>

                {/* Recent folders — session only, shown at root when not searching */}
                {recentFolders.length > 0 && !searchQuery && breadcrumbs.length === 1 && (
                    <div className="px-5 pt-3 pb-1">
                        <p className="text-[10px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--ram-text-tertiary)' }}>
                            Recently Used
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                            {recentFolders.map((recent) => (
                                <button
                                    key={recent.id}
                                    onClick={() => handleRecentClick(recent)}
                                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors hover:bg-[var(--ram-bg-hover)]"
                                    style={{
                                        background: 'var(--ram-bg-tertiary)',
                                        color: 'var(--ram-text-secondary)',
                                        border: '1px solid var(--ram-border)',
                                    }}
                                    title={recent.path}
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--ram-accent)" stroke="var(--ram-accent)" strokeWidth="1" style={{ opacity: 0.6 }}>
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                    </svg>
                                    {recent.name}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Breadcrumbs — hide when searching */}
                {!searchQuery && (
                    <div className="px-5 pt-3 pb-2 flex items-center gap-1 flex-wrap flex-shrink-0">
                        {breadcrumbs.map((crumb, i) => (
                            <span key={i} className="flex items-center gap-1">
                                {i > 0 && (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2">
                                        <path d="M9 18l6-6-6-6" />
                                    </svg>
                                )}
                                <button
                                    onClick={() => navigateToBreadcrumb(i)}
                                    className={`text-xs px-1.5 py-0.5 rounded transition-colors ${i === breadcrumbs.length - 1
                                        ? 'font-medium'
                                        : 'hover:bg-[var(--ram-bg-hover)]'
                                        }`}
                                    style={{
                                        color: i === breadcrumbs.length - 1 ? 'var(--ram-text-primary)' : 'var(--ram-text-tertiary)',
                                    }}
                                >
                                    {crumb.name}
                                </button>
                            </span>
                        ))}
                    </div>
                )}

                {/* Folder list / search results */}
                <div className="flex-1 overflow-y-auto px-5 pb-2 min-h-[200px]">
                    {/* Search mode */}
                    {searchQuery ? (
                        searching ? (
                            <div className="flex items-center justify-center py-12">
                                <div
                                    className="w-6 h-6 rounded-full border-2 animate-spin"
                                    style={{ borderColor: 'var(--ram-border)', borderTopColor: 'var(--ram-accent)' }}
                                />
                            </div>
                        ) : searchResults && searchResults.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-2">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="1">
                                    <circle cx="11" cy="11" r="8" />
                                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                                <p className="text-xs" style={{ color: 'var(--ram-text-tertiary)' }}>
                                    No folders matching &ldquo;{searchQuery}&rdquo;
                                </p>
                            </div>
                        ) : searchResults ? (
                            <div className="flex flex-col gap-0.5">
                                <p className="text-[10px] uppercase tracking-wider font-semibold mb-2 px-1" style={{ color: 'var(--ram-text-tertiary)' }}>
                                    {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} across Shared Drive
                                </p>
                                {searchResults.map((folder) => (
                                    <button
                                        key={folder.id}
                                        onClick={() => handleSearchResultClick(folder)}
                                        className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-lg transition-colors hover:bg-[var(--ram-bg-hover)] group"
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--ram-accent)" stroke="var(--ram-accent)" strokeWidth="1" style={{ opacity: 0.7 }}>
                                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                        </svg>
                                        <span className="text-sm truncate" style={{ color: 'var(--ram-text-primary)' }}>
                                            {folder.name}
                                        </span>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2"
                                            className="ml-auto flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <path d="M9 18l6-6-6-6" />
                                        </svg>
                                    </button>
                                ))}
                            </div>
                        ) : null
                    ) : (
                        /* Normal browse mode */
                        loading ? (
                            <div className="flex items-center justify-center py-12">
                                <div
                                    className="w-6 h-6 rounded-full border-2 animate-spin"
                                    style={{ borderColor: 'var(--ram-border)', borderTopColor: 'var(--ram-accent)' }}
                                />
                            </div>
                        ) : error ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-2">
                                <p className="text-xs" style={{ color: 'var(--ram-red)' }}>❌ {error}</p>
                                <button
                                    onClick={() => fetchFolders(currentFolderId)}
                                    className="text-xs px-3 py-1.5 rounded-lg"
                                    style={{ background: 'var(--ram-accent-muted)', color: 'var(--ram-accent)' }}
                                >
                                    Retry
                                </button>
                            </div>
                        ) : displayFolders.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-2">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="1">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                </svg>
                                <p className="text-xs" style={{ color: 'var(--ram-text-tertiary)' }}>
                                    No subfolders — you can create shortcuts here or add a new folder
                                </p>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-0.5">
                                {displayFolders.map((folder) => (
                                    <button
                                        key={folder.id}
                                        onClick={() => navigateInto(folder)}
                                        className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-lg transition-colors hover:bg-[var(--ram-bg-hover)] group"
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--ram-accent)" stroke="var(--ram-accent)" strokeWidth="1" style={{ opacity: 0.7 }}>
                                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                        </svg>
                                        <span className="text-sm truncate" style={{ color: 'var(--ram-text-primary)' }}>
                                            {folder.name}
                                        </span>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2"
                                            className="ml-auto flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <path d="M9 18l6-6-6-6" />
                                        </svg>
                                    </button>
                                ))}
                            </div>
                        )
                    )}
                </div>

                {/* New folder inline creation — only in browse mode */}
                {!searchQuery && (
                    <>
                        {creatingFolder ? (
                            <div className="mx-5 mb-3 flex items-center gap-2">
                                <div className="flex items-center gap-2 flex-1 px-3 py-2 rounded-lg" style={{ background: 'var(--ram-bg-tertiary)', border: '1px solid var(--ram-border-hover)' }}>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-accent)" strokeWidth="2">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                        <line x1="12" y1="11" x2="12" y2="17" />
                                        <line x1="9" y1="14" x2="15" y2="14" />
                                    </svg>
                                    <input
                                        type="text"
                                        value={newFolderName}
                                        onChange={(e) => setNewFolderName(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setCreatingFolder(false); }}
                                        placeholder="Folder name"
                                        autoFocus
                                        className="flex-1 bg-transparent text-sm outline-none"
                                        style={{ color: 'var(--ram-text-primary)' }}
                                    />
                                </div>
                                <button
                                    onClick={handleCreateFolder}
                                    disabled={!newFolderName.trim()}
                                    className="px-3 py-2 rounded-lg text-xs font-medium transition-all"
                                    style={{
                                        background: newFolderName.trim() ? 'var(--ram-accent)' : 'var(--ram-bg-tertiary)',
                                        color: newFolderName.trim() ? 'var(--ram-bg-primary)' : 'var(--ram-text-tertiary)',
                                    }}
                                >
                                    Create
                                </button>
                                <button
                                    onClick={() => { setCreatingFolder(false); setNewFolderName(''); setCreateError(null); }}
                                    className="p-2 rounded-lg hover:bg-[var(--ram-bg-hover)] transition-colors"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="2">
                                        <path d="M18 6L6 18M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        ) : (
                            <div className="mx-5 mb-3">
                                <button
                                    onClick={() => setCreatingFolder(true)}
                                    className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg transition-colors hover:bg-[var(--ram-bg-hover)] w-full"
                                    style={{ color: 'var(--ram-text-secondary)' }}
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <line x1="12" y1="5" x2="12" y2="19" />
                                        <line x1="5" y1="12" x2="19" y2="12" />
                                    </svg>
                                    New Folder
                                </button>
                            </div>
                        )}
                        {createError && (
                            <p className="mx-5 mb-2 text-xs" style={{ color: 'var(--ram-red)' }}>❌ {createError}</p>
                        )}
                    </>
                )}

                {/* Footer */}
                <div
                    className="flex items-center justify-between px-5 py-4 flex-shrink-0"
                    style={{ borderTop: '1px solid var(--ram-border)' }}
                >
                    <button
                        onClick={onClose}
                        className="px-4 py-2 rounded-lg text-sm transition-colors hover:bg-[var(--ram-bg-hover)]"
                        style={{ color: 'var(--ram-text-secondary)' }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleRelay}
                        disabled={relaying || originalAssets.length === 0}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
                        style={{
                            background: originalAssets.length > 0 ? 'var(--ram-accent)' : 'var(--ram-bg-tertiary)',
                            color: originalAssets.length > 0 ? 'var(--ram-bg-primary)' : 'var(--ram-text-tertiary)',
                        }}
                    >
                        {relaying ? (
                            <>
                                <div
                                    className="w-4 h-4 rounded-full border-2 animate-spin"
                                    style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }}
                                />
                                Creating Shortcuts…
                            </>
                        ) : (
                            <>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M9 3H5a2 2 0 0 0-2 2v4" />
                                    <path d="M15 3h4a2 2 0 0 1 2 2v4" />
                                    <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
                                    <path d="M15 21h4a2 2 0 0 0 2-2v-4" />
                                    <path d="M12 8v8" />
                                    <path d="M8 12h8" />
                                </svg>
                                Shortcut {originalAssets.length} Asset{originalAssets.length !== 1 ? 's' : ''} Here
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
