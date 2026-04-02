'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import * as namerApi from '@/lib/namer/namer-api';
import { logger } from '@/lib/logger';

interface FolderPickerProps {
    label: string;
    folderId: string;
    folderName: string;
    onSelect: (id: string, name: string) => void;
}

/**
 * Extract a Google Drive folder ID from a URL.
 * Supports formats like:
 *   https://drive.google.com/drive/folders/FOLDER_ID
 *   https://drive.google.com/drive/u/0/folders/FOLDER_ID
 *   https://drive.google.com/drive/folders/FOLDER_ID?resourcekey=...
 */
function extractFolderIdFromUrl(input: string): string | null {
    const trimmed = input.trim();
    // Match Drive folder URLs
    const match = trimmed.match(/drive\.google\.com\/(?:drive\/)?(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return null;
}

export default function FolderPicker({ label, folderId, folderName, onSelect }: FolderPickerProps) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<Array<{ id: string; name: string }>>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [resolving, setResolving] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Search folders with debounce
    const searchFolders = useCallback(async (q: string) => {
        if (q.length < 2) {
            setResults([]);
            return;
        }
        setLoading(true);
        try {
            const folders = await namerApi.searchFolders(q);
            setResults(folders.map(f => ({ id: f.id, name: f.name })));
        } catch (err) {
            logger.error('folder-picker', 'Search error', { error: err instanceof Error ? err.message : String(err) });
            setResults([]);
        } finally {
            setLoading(false);
        }
    }, []);

    // Handle URL paste → parse folder ID and resolve name
    const handleUrlPaste = useCallback(async (extractedId: string) => {
        setResolving(true);
        setResults([]);
        try {
            const folder = await namerApi.getFolder(extractedId);
            onSelect(folder.id, folder.name);
            setIsOpen(false);
            setQuery('');
        } catch (err) {
            logger.error('folder-picker', 'URL resolve error', { error: err instanceof Error ? err.message : String(err) });
            // Fall back to showing error in results
            setResults([]);
        } finally {
            setResolving(false);
        }
    }, [onSelect]);

    // Handle input change — detect URLs vs search queries
    const handleInputChange = useCallback((value: string) => {
        setQuery(value);

        const extractedId = extractFolderIdFromUrl(value);
        if (extractedId) {
            // It's a URL — resolve directly, skip search debounce
            if (debounceRef.current) clearTimeout(debounceRef.current);
            handleUrlPaste(extractedId);
            return;
        }

        // Normal text search
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => searchFolders(value), 300);
    }, [handleUrlPaste, searchFolders]);

    // Also handle paste event directly (catches Cmd+V)
    const handlePaste = useCallback((e: React.ClipboardEvent) => {
        const pasted = e.clipboardData.getData('text');
        const extractedId = extractFolderIdFromUrl(pasted);
        if (extractedId) {
            e.preventDefault();
            setQuery(pasted);
            handleUrlPaste(extractedId);
        }
    }, [handleUrlPaste]);

    // Cleanup debounce on unmount
    useEffect(() => {
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, []);

    // Click outside to close
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    return (
        <div ref={containerRef} className="relative">
            <label className="block font-medium mb-1" style={{ color: 'var(--ram-text-secondary)', fontSize: '12px' }}>
                {label}
            </label>
            <div
                onClick={() => setIsOpen(true)}
                className="w-full px-3 py-2 rounded-lg cursor-pointer flex items-center gap-2"
                style={{
                    background: 'var(--ram-bg-secondary)',
                    color: folderName ? 'var(--ram-text-primary)' : 'var(--ram-text-secondary)',
                    border: `1px solid ${isOpen ? 'var(--ram-accent)' : 'var(--ram-border)'}`,
                    transition: 'border-color 0.15s',
                    fontSize: '12px',
                }}
            >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span className="truncate flex-1">{folderName || 'Search or paste Drive URL…'}</span>
                {folderId && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onSelect('', ''); setQuery(''); }}
                        className="hover:text-[var(--ram-red)]"
                    >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                )}
            </div>

            {isOpen && (
                <div
                    className="absolute left-0 right-0 top-full mt-1 rounded-lg shadow-xl overflow-hidden z-50"
                    style={{
                        background: '#1e2028',
                        border: '1px solid var(--ram-border)',
                    }}
                >
                    <div className="p-2">
                        <input
                            autoFocus
                            value={query}
                            onChange={(e) => handleInputChange(e.target.value)}
                            onPaste={handlePaste}
                            placeholder="Search folders or paste Drive URL…"
                            className="w-full text-xs px-3 py-1.5 rounded-md"
                            style={{
                                background: 'var(--ram-bg-secondary)',
                                color: 'var(--ram-text-primary)',
                                border: '1px solid var(--ram-border)',
                                outline: 'none',
                            }}
                        />
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                        {resolving ? (
                            <div className="flex items-center gap-2 px-3 py-3 text-[11px]" style={{ color: 'var(--ram-teal)' }}>
                                <div className="w-3 h-3 rounded-full border-2 animate-spin"
                                    style={{ borderColor: 'transparent', borderTopColor: 'currentColor' }} />
                                Resolving folder from URL…
                            </div>
                        ) : loading ? (
                            <div className="flex items-center justify-center py-4">
                                <div className="w-4 h-4 rounded-full border-2 animate-spin"
                                    style={{ borderColor: 'var(--ram-border)', borderTopColor: 'var(--ram-accent)' }} />
                            </div>
                        ) : results.length === 0 ? (
                            <p className="text-[11px] px-3 py-3 text-center" style={{ color: 'var(--ram-text-tertiary)' }}>
                                {query.length < 2 ? 'Type at least 2 characters or paste a Drive URL' : 'No folders found'}
                            </p>
                        ) : (
                            results.map(f => (
                                <button
                                    key={f.id}
                                    onClick={() => {
                                        onSelect(f.id, f.name);
                                        setIsOpen(false);
                                        setQuery('');
                                    }}
                                    className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors hover:bg-[var(--ram-bg-hover)]"
                                    style={{ color: 'var(--ram-text-primary)' }}
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ram-accent)" strokeWidth="2">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                    </svg>
                                    <span className="truncate">{f.name}</span>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
