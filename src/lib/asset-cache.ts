import type { AssetListPayload } from '@/types';

/**
 * Last-known asset list in IndexedDB, so a returning visit can paint the
 * library immediately and revalidate in the background (the network fetch
 * takes seconds at ~7k assets). Everyone on the team sees the same library,
 * so the cache isn't user-scoped.
 *
 * Best-effort throughout: private windows, blocked storage or a corrupt
 * entry just mean no cache — every failure resolves to null / no-op.
 */

const DB_NAME = 'relay-asset-cache';
const STORE = 'kv';
// Bump when AssetListPayload's shape changes so stale shapes are ignored.
const KEY = 'asset-list-v1';

function openDb(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        try {
            if (typeof indexedDB === 'undefined') return resolve(null);
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

export async function readCachedAssetList(): Promise<AssetListPayload | null> {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
            req.onsuccess = () => {
                const v = req.result as AssetListPayload | undefined;
                resolve(v && Array.isArray(v.assets) && Array.isArray(v.shortcuts) ? v : null);
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        } finally {
            db.close();
        }
    });
}

export async function writeCachedAssetList(payload: AssetListPayload): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        db.transaction(STORE, 'readwrite').objectStore(STORE).put(payload, KEY);
    } catch {
        /* quota or blocked — skip caching */
    } finally {
        db.close();
    }
}
