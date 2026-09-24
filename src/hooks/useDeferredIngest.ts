'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingIngest {
    batchId: string;
    fileIds: string[];
    destFolderId: string;
    scheduledAt: number;  // Date.now() when scheduled
    firesAt: number;      // Date.now() + delay
    status: 'pending' | 'firing' | 'complete' | 'error' | 'cancelled';
    result?: {
        ingested: number;
        thumbnails: number;
        skipped: number;
        errors: string[];
    };
}

// LocalStorage key for client-side persistence
const LS_KEY = 'ram_pending_ingests';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFromStorage(): PendingIngest[] {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as PendingIngest[];
        // Filter out completed/cancelled items older than 1 hour
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        return parsed.filter(p =>
            p.status === 'pending' || p.status === 'firing' || p.scheduledAt > oneHourAgo
        );
    } catch {
        return [];
    }
}

function saveToStorage(ingests: PendingIngest[]) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(ingests));
    } catch {
        // localStorage might be full or unavailable
    }
}

/**
 * Write pending ingest intent to Supabase for recovery across sessions.
 * This is the "hybrid" part — if the user closes the tab, the next visitor
 * (or the same user) will pick it up and fire it.
 */
async function persistToServer(ingest: PendingIngest) {
    try {
        await fetch('/api/sync/ingest/pending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ingest),
        });
    } catch {
        // Non-critical — client-side timer is the primary mechanism
    }
}

async function removeFromServer(batchId: string) {
    try {
        await fetch(`/api/sync/ingest/pending?batchId=${encodeURIComponent(batchId)}`, {
            method: 'DELETE',
        });
    } catch {
        // Non-critical
    }
}

async function loadStaleFromServer(): Promise<PendingIngest[]> {
    try {
        const res = await fetch('/api/sync/ingest/pending');
        if (!res.ok) return [];
        const data = await res.json();
        return (data.pending || []) as PendingIngest[];
    } catch {
        return [];
    }
}

/**
 * An entry is identified by batchId + scheduledAt: re-scheduling a batch
 * (namer "Retry failed") replaces its entry, and a still-running fire of the
 * old entry must not overwrite the new one's status.
 */
function isSame(p: PendingIngest, ingest: PendingIngest): boolean {
    return p.batchId === ingest.batchId && p.scheduledAt === ingest.scheduledAt;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDeferredIngest(defaultDelayMs: number = 300000) {
    const [ingests, setIngests] = useState<PendingIngest[]>([]);
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const initializedRef = useRef(false);
    // Latest ingests, for scheduleIngest's merge (it must not read state
    // through a setState updater — those have to stay pure).
    const ingestsRef = useRef<PendingIngest[]>([]);
    useEffect(() => { ingestsRef.current = ingests; }, [ingests]);

    // ── Fire the actual ingest ──
    const fireIngest = useCallback(async (ingest: PendingIngest) => {
        // Mark as firing
        setIngests(prev => {
            const updated = prev.map(p =>
                isSame(p, ingest) ? { ...p, status: 'firing' as const } : p
            );
            saveToStorage(updated);
            return updated;
        });

        try {
            const res = await fetch('/api/sync/ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fileIds: ingest.fileIds,
                    destFolderId: ingest.destFolderId,
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || `Ingest failed: ${res.status}`);
            }

            // Mark complete
            setIngests(prev => {
                const updated = prev.map(p =>
                    isSame(p, ingest)
                        ? {
                            ...p,
                            status: 'complete' as const,
                            result: {
                                ingested: data.ingested ?? 0,
                                thumbnails: data.thumbnails ?? 0,
                                skipped: data.skipped?.length ?? 0,
                                errors: data.errors ?? [],
                            },
                        }
                        : p
                );
                saveToStorage(updated);
                return updated;
            });

            // Notify the main page to re-fetch assets so newly ingested
            // files appear without requiring a manual page refresh.
            if (typeof window !== 'undefined' && (data.ingested ?? 0) > 0) {
                window.dispatchEvent(new CustomEvent('ram:ingest-complete', {
                    detail: { ingested: data.ingested, thumbnails: data.thumbnails },
                }));
            }

            // Clean up server-side pending record — unless the batch was
            // re-scheduled meanwhile (that newer record must survive)
            if (!ingestsRef.current.some(p => p.batchId === ingest.batchId && p.scheduledAt !== ingest.scheduledAt)) {
                removeFromServer(ingest.batchId);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            setIngests(prev => {
                const updated = prev.map(p =>
                    isSame(p, ingest)
                        ? {
                            ...p,
                            status: 'error' as const,
                            result: { ingested: 0, thumbnails: 0, skipped: 0, errors: [message] },
                        }
                        : p
                );
                saveToStorage(updated);
                return updated;
            });
        }

        // Clean up timer reference (only if it's still this entry's timer)
        if (!ingestsRef.current.some(p => p.batchId === ingest.batchId && p.scheduledAt !== ingest.scheduledAt)) {
            timersRef.current.delete(ingest.batchId);
        }
    }, []);

    // ── Start a timer for a pending ingest ──
    const startTimer = useCallback((ingest: PendingIngest) => {
        // Clear existing timer if any
        const existing = timersRef.current.get(ingest.batchId);
        if (existing) clearTimeout(existing);

        const remaining = Math.max(0, ingest.firesAt - Date.now());

        const timer = setTimeout(() => {
            fireIngest(ingest);
        }, remaining);

        timersRef.current.set(ingest.batchId, timer);
    }, [fireIngest]);

    // ── Initialize: load from localStorage + check server for stale ingests ──
    useEffect(() => {
        if (initializedRef.current) return;
        initializedRef.current = true;

        const init = async () => {
            // 1. Load from localStorage
            const local = loadFromStorage();

            // 2. Check server for stale pending ingests (tab was closed)
            const stale = await loadStaleFromServer();

            // Merge: stale server records that aren't already in local
            const localBatchIds = new Set(local.map(l => l.batchId));
            const merged = [...local];
            for (const s of stale) {
                if (!localBatchIds.has(s.batchId)) {
                    merged.push(s);
                }
            }

            // Start timers for all pending ingests
            const now = Date.now();
            for (const ingest of merged) {
                if (ingest.status === 'pending') {
                    if (ingest.firesAt <= now) {
                        // Past due — fire immediately
                        fireIngest(ingest);
                    } else {
                        startTimer(ingest);
                    }
                }
            }

            setIngests(merged);
            saveToStorage(merged);
        };

        init();

        // Cleanup timers on unmount. The Map itself is never reassigned, so
        // capturing it here is safe and satisfies the ref-in-cleanup lint rule.
        const timers = timersRef.current;
        return () => {
            for (const timer of timers.values()) {
                clearTimeout(timer);
            }
        };
    }, [fireIngest, startTimer]);

    // ── Schedule a new ingest ──
    const scheduleIngest = useCallback(async (
        batchId: string,
        fileIds: string[],
        destFolderId: string,
        delayMs?: number,
    ) => {
        // First check if destination is in sync scope
        try {
            const scopeRes = await fetch(`/api/sync/scope?folderId=${encodeURIComponent(destFolderId)}`);
            const scopeData = await scopeRes.json();
            if (!scopeData.inScope) {
                // Not in DAM scope — don't schedule
                return false;
            }
        } catch {
            // Scope check failed — don't schedule (err on the side of caution)
            return false;
        }

        const delay = delayMs ?? defaultDelayMs;
        const now = Date.now();

        // Scheduling a batch that already has an entry (namer "Retry failed")
        // replaces it. The entry's files are folded in unless its ingest
        // already completed — a pending, firing or failed entry still owes
        // those files an ingest, and replacing it would drop them.
        const existing = ingestsRef.current.find(p => p.batchId === batchId);
        const mergedIds = existing && existing.status !== 'complete' && existing.status !== 'cancelled'
            ? [...new Set([...existing.fileIds, ...fileIds])]
            : fileIds;

        const ingest: PendingIngest = {
            batchId,
            fileIds: mergedIds,
            destFolderId,
            // Strictly newer than the entry it replaces (see isSame)
            scheduledAt: existing && existing.scheduledAt >= now ? existing.scheduledAt + 1 : now,
            firesAt: now + delay,
            status: 'pending',
        };

        setIngests(prev => {
            const updated = [...prev.filter(p => p.batchId !== batchId), ingest];
            saveToStorage(updated);
            return updated;
        });
        ingestsRef.current = [...ingestsRef.current.filter(p => p.batchId !== batchId), ingest];

        // Start client-side timer
        startTimer(ingest);

        // Persist to server for recovery
        persistToServer(ingest);

        return true;
    }, [defaultDelayMs, startTimer]);

    // ── Cancel a pending ingest ──
    const cancelIngest = useCallback((batchId: string) => {
        // Clear client timer
        const timer = timersRef.current.get(batchId);
        if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(batchId);
        }

        // Update state
        setIngests(prev => {
            const updated = prev.map(p =>
                p.batchId === batchId && p.status === 'pending'
                    ? { ...p, status: 'cancelled' as const }
                    : p
            );
            saveToStorage(updated);
            return updated;
        });

        // Remove from server
        removeFromServer(batchId);
    }, []);

    // ── Trigger immediately ──
    const triggerNow = useCallback((batchId: string) => {
        // Clear scheduled timer
        const timer = timersRef.current.get(batchId);
        if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(batchId);
        }

        const ingest = ingests.find(p => p.batchId === batchId);
        if (ingest && ingest.status === 'pending') {
            fireIngest(ingest);
        }
    }, [ingests, fireIngest]);

    // ── Retry a completed/errored ingest ──
    const retryIngest = useCallback((batchId: string) => {
        const ingest = ingests.find(p => p.batchId === batchId);
        if (!ingest || (ingest.status !== 'complete' && ingest.status !== 'error')) return;

        // Reset status and clear previous result, then fire immediately
        const retryEntry: PendingIngest = {
            ...ingest,
            status: 'pending',
            result: undefined,
            scheduledAt: Date.now(),
            firesAt: Date.now(),
        };

        setIngests(prev => {
            const updated = prev.map(p =>
                p.batchId === batchId ? retryEntry : p
            );
            saveToStorage(updated);
            return updated;
        });

        fireIngest(retryEntry);
    }, [ingests, fireIngest]);

    return {
        pendingIngests: ingests,
        scheduleIngest,
        cancelIngest,
        triggerNow,
        retryIngest,
    };
}
