'use client';

import { useState, useMemo, useCallback, useEffect, useRef, useDeferredValue } from 'react';
import { Asset, SearchFilters, FolderNode } from '@/types';
import { fetchAssetPayload, expandAssetList, loadCachedAssets, writeCachedAssetList, buildFolderTree } from '@/lib/supabase/queries';
import { parseFilename, resolveCreator } from '@/lib/filename-utils';
import { isAssetFullyExpired, isAnyRightExpired, getComplianceBadges } from '@/lib/badge-utils';
import AssetCard from '@/components/AssetCard';
import SearchBar from '@/components/SearchBar';
import ActionBar from '@/components/ActionBar';
import FolderSidebar from '@/components/FolderSidebar';
import ExpandedAssetView from '@/components/ExpandedAssetView';
import SettingsPanel from '@/components/SettingsPanel';
import TrashPanel, { type TrashItem } from '@/components/TrashPanel';
import FolderPickerModal, { type RecentFolder } from '@/components/FolderPickerModal';
import DownloadQueue, { useDownloadQueue } from '@/components/DownloadQueue';
import RelayHistory, { useRelayHistory } from '@/components/RelayHistory';
import NamerView from '@/components/namer/NamerView';

const PAGE_SIZE = 48;

// Ascending by days remaining; Infinity (no expiry) last. Plain subtraction
// gives NaN for Infinity - Infinity, which breaks sort stability.
const compareDays = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
const LS_HIDDEN_FOLDERS = 'ram_hidden_folders';
// Roughly the first screen of cards: loaded eagerly at high priority rather
// than waiting on lazy-loading's intersection check.
const EAGER_CARDS = 12;

// True when `path` is `parent` itself or nested inside it. Plain startsWith
// would also match sibling folders sharing a name prefix ("/Studio Archive"
// under "/Studio").
function isPathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

const DEFAULT_FILTERS: SearchFilters = {
  query: '',
  folderPath: null,
  orientation: 'all',
  expiredMode: 'hide',
  assetType: 'all',
  sortBy: 'newest',
};

// ── Shareable URL params ────────────────────────────────────────
// Only folder, sort (newest/oldest), assetType, and orientation are
// encoded in the URL. Everything else stays at app defaults.
const SHAREABLE_SORTS = new Set(['newest', 'oldest']);
const SHAREABLE_TYPES = new Set(['photo', 'video', 'all']);
const SHAREABLE_ORIENTATIONS = new Set(['all', 'landscape', 'portrait', 'square']);

function filtersFromUrl(): Partial<SearchFilters> {
  if (typeof window === 'undefined') return {};

  // Check for a stashed destination from the pre-login flow
  const stashed = localStorage.getItem('relay_post_login_redirect');
  let search = window.location.search;
  if (stashed) {
    localStorage.removeItem('relay_post_login_redirect');
    // The stashed value is a full path+query like "/?folder=X&sort=oldest"
    const qIdx = stashed.indexOf('?');
    if (qIdx >= 0) {
      search = stashed.substring(qIdx);
      // Update the browser URL to reflect the restored destination
      window.history.replaceState(null, '', stashed);
    }
  }

  const params = new URLSearchParams(search);
  const partial: Partial<SearchFilters> = {};

  const folder = params.get('folder');
  // Re-add leading slash (stripped for prettier URLs)
  if (folder) partial.folderPath = folder.startsWith('/') ? folder : `/${folder}`;

  const sort = params.get('sort');
  if (sort && SHAREABLE_SORTS.has(sort)) partial.sortBy = sort as SearchFilters['sortBy'];

  const type = params.get('type');
  if (type && SHAREABLE_TYPES.has(type)) partial.assetType = type as SearchFilters['assetType'];

  const orientation = params.get('orientation');
  if (orientation && SHAREABLE_ORIENTATIONS.has(orientation)) partial.orientation = orientation as SearchFilters['orientation'];

  return partial;
}

function filtersToUrl(filters: SearchFilters): string {
  const parts: string[] = [];
  // Strip leading slash and keep path separators readable
  if (filters.folderPath) {
    const clean = filters.folderPath.replace(/^\//, '');
    parts.push(`folder=${encodeURIComponent(clean).replace(/%2F/gi, '/').replace(/%20/g, '+')}`);
  }
  if (filters.sortBy !== DEFAULT_FILTERS.sortBy && SHAREABLE_SORTS.has(filters.sortBy)) parts.push(`sort=${filters.sortBy}`);
  if (filters.assetType !== DEFAULT_FILTERS.assetType) parts.push(`type=${filters.assetType}`);
  if (filters.orientation !== DEFAULT_FILTERS.orientation) parts.push(`orientation=${filters.orientation}`);
  return parts.length ? `?${parts.join('&')}` : window.location.pathname;
}

export default function Home() {
  // Data state
  const [assets, setAssets] = useState<Asset[]>([]);
  const [folderTree, setFolderTree] = useState<FolderNode>({
    id: 'root', name: 'All Folders', path: '/', children: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // App mode — toggle between Browse and Ingest (Namer)
  const [appMode, setAppMode] = useState<'browse' | 'ingest'>('browse');
  const [namerOpened, setNamerOpened] = useState(false);

  // UI state
  const [filters, setFilters] = useState<SearchFilters>(() => ({
    ...DEFAULT_FILTERS,
    ...filtersFromUrl(),
  }));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedAsset, setExpandedAsset] = useState<Asset | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [shuffleSeed, setShuffleSeed] = useState<number | null>(null);

  // Pinboard — session-scoped asset collection
  const [pinboardIds, setPinboardIds] = useState<Set<string>>(new Set());
  const [pinboardActive, setPinboardActive] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Scheduled-sync health for the header indicator (see /api/sync/activity).
  // Checked on load, every 15 minutes, and when Settings closes (a sync may
  // have just been run from there).
  const [syncHealth, setSyncHealth] = useState<{
    issue: 'failed' | 'stale' | null; latestError: string | null; staleAfterHours: number;
  } | null>(null);
  const checkSyncHealth = useCallback(() => {
    fetch('/api/sync/activity?limit=0', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(body => { if (body?.health) setSyncHealth(body.health); })
      .catch(() => { /* indicator is best-effort */ });
  }, []);
  useEffect(() => {
    checkSyncHealth();
    const t = setInterval(checkSyncHealth, 15 * 60_000);
    return () => clearInterval(t);
  }, [checkSyncHealth]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [semanticResults, setSemanticResults] = useState<Map<string, number> | null>(null); // null = not searching
  const [semanticLoading, setSemanticLoading] = useState(false);
  // Seeded from localStorage so a cached asset list (painted before
  // /api/settings/config returns) doesn't briefly show hidden folders.
  const [hiddenFolders, setHiddenFolders] = useState<string[]>(() => {
    try {
      const v = typeof window !== 'undefined' ? JSON.parse(localStorage.getItem(LS_HIDDEN_FOLDERS) ?? '[]') : [];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_HIDDEN_FOLDERS, JSON.stringify(hiddenFolders)); } catch { /* storage blocked */ }
  }, [hiddenFolders]);


  const [userInitials, setUserInitials] = useState('?');
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  // Callback-ref state, not useRef: the grid isn't in the DOM on first render
  // (loading skeleton), and an effect keyed on a plain ref never re-ran once
  // it mounted — gridColWidth stayed at its 300px default forever.
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  // The grid's scroll container — the infinite-scroll observer's root.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const loadMore = useCallback(() => setVisibleCount((v) => v + PAGE_SIZE), []);
  const [gridColWidth, setGridColWidth] = useState(300);


  // Sync shareable filter params → URL (no page reload). Cheap on unrelated
  // filter changes — replaceState only fires when the URL actually differs.
  useEffect(() => {
    const url = filtersToUrl(filters);
    if (url !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', url);
    }
  }, [filters]);

  // Trash queue state
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [trashModalOpen, setTrashModalOpen] = useState(false);

  // Relay (Folder Picker) state
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [recentRelayFolders, setRecentRelayFolders] = useState<RecentFolder[]>([]);
  const [relayTargetAssets, setRelayTargetAssets] = useState<Asset[]>([]);

  // Download queue — on auth error, immediately flag connection as lost
  const downloadQueue = useDownloadQueue();

  // Relay history
  const relayHistory = useRelayHistory();




  // Close user menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    if (userMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [userMenuOpen]);



  // Fetch logged-in user info to derive initials
  useEffect(() => {
    (async () => {
      try {
        const { createClient } = await import('@/lib/supabase/client');
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        setUserEmail(user.email ?? null);

        // Google OAuth populates user_metadata.full_name
        const fullName = user.user_metadata?.full_name as string | undefined;
        if (fullName) {
          const parts = fullName.trim().split(/\s+/);
          const initials = parts.length >= 2
            ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
            : parts[0].slice(0, 2).toUpperCase();
          setUserInitials(initials);
        } else if (user.email) {
          setUserInitials(user.email.slice(0, 2).toUpperCase());
        }
      } catch { /* silent */ }
    })();
  }, []);

  // Refresh the asset list + folder tree from the server. Single source of
  // truth for the flows that re-pull after a mutation (ingest, relay, trash) —
  // fresh:true bypasses the 60s browser cache so the change shows immediately.
  // Every asset-list fetch takes a sequence number; a response is applied
  // (and cached) only if no newer fetch has started since. Otherwise a slow
  // first load could land after a post-mutation refresh and revert it.
  const assetFetchSeqRef = useRef(0);
  const loadAssetList = useCallback(async (fresh: boolean): Promise<Asset[] | null> => {
    const seq = ++assetFetchSeqRef.current;
    const payload = await fetchAssetPayload({ fresh });
    if (seq !== assetFetchSeqRef.current) return null; // superseded
    const data = expandAssetList(payload);
    setAssets(data);
    setFolderTree(buildFolderTree(data));
    void writeCachedAssetList(payload);
    return data;
  }, []);

  const refreshAssets = useCallback(async () => {
    await loadAssetList(true);
  }, [loadAssetList]);

  // Fetch trash queue
  const fetchTrash = useCallback(async () => {
    try {
      const res = await fetch('/api/trash');
      if (res.ok) {
        const data = await res.json();
        setTrashItems(data.items || []);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash]);

  const handleTrashAction = async (id: string, action: 'restore' | 'purge') => {
    try {
      const res = await fetch('/api/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      // 404 = no longer in the trash (restored/purged elsewhere) — drop it too
      if (res.ok || res.status === 404) {
        setTrashItems((prev) => prev.filter((item) => item.id !== id));
        if (res.ok && action === 'restore') {
          // Re-fetch assets to show the restored one
          await refreshAssets();
        }
      }
    } catch { /* silent */ }
  };

  // Semantic search — hybrid approach:
  // 1. Text search runs instantly on keystroke (free, client-side)
  // 2. Semantic search fires after 800ms pause (reduces API calls)
  // 3. Enter key triggers semantic search immediately
  const searchCounterRef = useRef(0);

  const runSemanticSearch = useCallback(async (query: string, signal?: AbortSignal) => {
    const requestId = ++searchCounterRef.current;
    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(query)}&limit=100`,
        signal ? { signal } : undefined
      );
      if (requestId !== searchCounterRef.current) return;
      if (res.ok) {
        const data = await res.json();
        // Store as Map<id, similarity> for score display
        const map = new Map<string, number>();
        for (const r of data.results) {
          map.set(r.id, r.similarity);
        }
        // Always set the map — empty Map means "searched, no results" vs null means "not searching"
        setSemanticResults(map);
      } else {
        // On API error, clear semantic state so text search takes over
        setSemanticResults(null);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (requestId !== searchCounterRef.current) return;
      // On network error, clear semantic state so text search takes over
      setSemanticResults(null);
    } finally {
      if (requestId === searchCounterRef.current) {
        setSemanticLoading(false);
      }
    }
  }, []);

  // The debounce timer pending for the current query, so Enter can fire the
  // search immediately instead of also letting the timer fire a duplicate.
  const pendingSearchRef = useRef<{ timer: ReturnType<typeof setTimeout>; controller: AbortController } | null>(null);

  // Debounced semantic search on query change (800ms pause)
  useEffect(() => {
    const query = filters.query.trim();
    if (query.length < 2) {
      // Invalidate any in-flight search and clear its spinner — a timer
      // cancelled before it fired never reaches runSemanticSearch's finally,
      // which left the loading indicator pulsing forever.
      searchCounterRef.current++;
      setSemanticResults(null);
      setSemanticLoading(false);
      return;
    }

    setSemanticLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      pendingSearchRef.current = null;
      runSemanticSearch(query, controller.signal);
    }, 800);
    pendingSearchRef.current = { timer, controller };

    return () => {
      clearTimeout(timer);
      controller.abort();
      pendingSearchRef.current = null;
      // Don't reset semanticLoading here — the finally block in
      // runSemanticSearch handles it. Resetting here caused flicker
      // on every keystroke.
    };
  }, [filters.query, runSemanticSearch]);

  // Immediate semantic search on Enter key
  const triggerSemanticSearch = useCallback(() => {
    const query = filters.query.trim();
    if (query.length < 2) return;
    // Take over the pending debounce (its abort signal still cancels this
    // search if the query changes) rather than searching twice.
    const pending = pendingSearchRef.current;
    if (pending) {
      clearTimeout(pending.timer);
      pendingSearchRef.current = null;
    }
    setSemanticLoading(true);
    runSemanticSearch(query, pending?.controller.signal);
  }, [filters.query, runSemanticSearch]);

  // Load assets from Supabase on mount + fetch hidden folders config
  useEffect(() => {
    let cancelled = false;

    async function loadAssets() {
      setLoading(true);
      setError(null);

      // Start the network fetch right away, then paint the last-known list
      // from IndexedDB while it's in flight (stale-while-revalidate): a
      // returning visit shows the library immediately instead of a skeleton.
      let freshApplied = false;
      const freshPromise = loadAssetList(false).then((r) => { freshApplied = true; return r; });
      const mySeq = assetFetchSeqRef.current; // loadAssetList bumps it synchronously

      // Hidden folders apply independently of the asset fetch's outcome
      fetch('/api/settings/config')
        .then(r => r.ok ? r.json() : null)
        .then(configRes => {
          if (!cancelled && Array.isArray(configRes?.hiddenFolders)) setHiddenFolders(configRes.hiddenFolders);
        })
        .catch(() => { /* keep the locally cached hidden folders */ });

      let showedCache = false;
      const cached = await loadCachedAssets();
      // Only if the network hasn't already delivered (or been superseded)
      if (!cancelled && cached && cached.length > 0 && assetFetchSeqRef.current === mySeq && !freshApplied) {
        setAssets(cached);
        setFolderTree(buildFolderTree(cached));
        setLoading(false);
        showedCache = true;
      }

      try {
        await freshPromise;
        if (!cancelled) setLoading(false);
      } catch (err) {
        // With a cached list on screen, a failed refresh isn't fatal — keep
        // showing it rather than replacing the library with an error.
        if (!cancelled && !showedCache) {
          setError(err instanceof Error ? err.message : 'Failed to load assets');
          setLoading(false);
        }
      }
    }

    loadAssets();
    return () => { cancelled = true; };
  }, [loadAssetList]); // stable (useCallback with no deps) — runs once

  // Re-fetch assets when a deferred ingest completes (namer → DAM pipeline)
  useEffect(() => {
    const handler = async () => {
      try {
        await refreshAssets();
      } catch { /* silent */ }
    };
    window.addEventListener('ram:ingest-complete', handler);
    return () => window.removeEventListener('ram:ingest-complete', handler);
  }, [refreshAssets]);

  // Precompute one lowercased search string per asset, rebuilt only when the
  // asset list changes — not on every keystroke or sort comparison.
  const searchIndex = useMemo(() => {
    const idx = new Map<string, string>();
    for (const asset of assets) {
      const creator = resolveCreator(asset);
      const parsed = parseFilename(asset.name);
      idx.set(asset.id, [
        asset.name,
        asset.description,
        ...asset.tags,
        creator,
        parsed.shootDescription,
        asset.projectDescription,
      ].filter(Boolean).join(' ').toLowerCase());
    }
    return idx;
  }, [assets]);

  // Per-asset values the filter/sort pass needs, computed once per asset list.
  // They used to be recomputed inside the filter and the sort comparator on
  // every keystroke — Date parsing and full compliance-badge evaluation,
  // O(n log n) times for the "expiring" sorts.
  const derived = useMemo(() => {
    const map = new Map<string, {
      createdMs: number; orgDays: number; paidDays: number;
      fullyExpired: boolean; anyExpired: boolean; ratio: number;
    }>();
    for (const asset of assets) {
      const [orgBadge, paidBadge] = getComplianceBadges(asset);
      map.set(asset.id, {
        createdMs: new Date(asset.createdAt).getTime() || 0,
        orgDays: orgBadge.daysRemaining ?? Infinity,
        paidDays: paidBadge.daysRemaining ?? Infinity,
        fullyExpired: isAssetFullyExpired(asset),
        anyExpired: isAnyRightExpired(asset),
        ratio: asset.width / asset.height,
      });
    }
    return map;
  }, [assets]);

  // Typing updates `filters` immediately (the input stays responsive); the
  // grid recomputes from this deferred copy, which React can interrupt.
  const deferredFilters = useDeferredValue(filters);

  // Filter and sort assets based on current filters
  const { filteredAssets, textMatchIds } = useMemo((): { filteredAssets: Asset[]; textMatchIds: Set<string> } => {
    const filters = deferredFilters;
    const d = (asset: Asset) => derived.get(asset.id)!;
    const textMatchIds = new Set<string>();
    const filtered = assets.filter((asset) => {
      // Folder scope
      if (filters.folderPath && !isPathWithin(asset.folderPath, filters.folderPath)) {
        return false;
      }

      // Hidden folders — excluded from "All Folders" master view only
      if (!filters.folderPath && hiddenFolders.length > 0) {
        if (hiddenFolders.some(hp => isPathWithin(asset.folderPath, hp))) {
          return false;
        }
      }

      // Asset type
      if (filters.assetType !== 'all' && asset.assetType !== filters.assetType) {
        return false;
      }

      // Orientation
      if (filters.orientation !== 'all') {
        const ratio = d(asset).ratio;
        if (filters.orientation === 'landscape' && ratio <= 1.1) return false;
        if (filters.orientation === 'portrait' && ratio >= 0.9) return false;
        if (filters.orientation === 'square' && (ratio < 0.9 || ratio > 1.1)) return false;
      }

      // Expired mode filter
      // 'hide' = fully expired (both sides dead) — still shows assets with one valid side
      // 'only' = any expired (either side) — surfaces everything needing attention
      if (filters.expiredMode === 'hide' && d(asset).fullyExpired) return false;
      if (filters.expiredMode === 'only' && !d(asset).anyExpired) return false;

      // Text query — hybrid approach:
      // Include assets matching EITHER semantic IDs OR client-side text search.
      // This prevents results from vanishing when semantic search returns
      // IDs outside the current folder scope.
      if (filters.query) {
        const q = filters.query.toLowerCase();
        const searchable = searchIndex.get(asset.id) ?? '';
        const textMatch = searchable.includes(q);
        const semanticMatch = semanticResults !== null && semanticResults.size > 0 && semanticResults.has(asset.id);

        // Track text matches for HUD display
        if (textMatch) textMatchIds.add(asset.id);

        // Include if either matcher hits (union, not intersection)
        if (!textMatch && !semanticMatch) return false;
      }

      return true;
    });

    // Shuffle mode — seeded Fisher-Yates for reproducible remix
    if (shuffleSeed !== null) {
      const shuffled = [...filtered];
      let seed = shuffleSeed;
      const random = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return { filteredAssets: shuffled, textMatchIds };
    }

    // Sort — use semantic similarity rank when available, else normal sort
    if (filters.query && semanticResults !== null && semanticResults.size > 0) {
      const q = filters.query.toLowerCase();
      // Overlap boost: assets matching BOTH text + semantic get a bump
      const OVERLAP_BOOST = 0.05;
      const effectiveScore = (asset: Asset) => {
        const base = semanticResults.get(asset.id) ?? -1;
        if (base < 0) return base; // text-only match, sort last
        // Check text overlap
        const searchable = searchIndex.get(asset.id) ?? '';
        return searchable.includes(q) ? base + OVERLAP_BOOST : base;
      };
      filtered.sort((a, b) => effectiveScore(b) - effectiveScore(a));
    } else {
      filtered.sort((a: Asset, b: Asset) => {
        switch (filters.sortBy) {
          case 'newest':
            return d(b).createdMs - d(a).createdMs;
          case 'oldest':
            return d(a).createdMs - d(b).createdMs;
          case 'expiring-organic':
            return compareDays(d(a).orgDays, d(b).orgDays);
          case 'expiring-paid':
            return compareDays(d(a).paidDays, d(b).paidDays);
          default:
            return 0;
        }
      });
    }

    return { filteredAssets: filtered, textMatchIds };
  }, [assets, deferredFilters, derived, shuffleSeed, semanticResults, hiddenFolders, searchIndex]);

  // When pinboard is active, scope to only pinned assets
  const scopedAssets = useMemo(() => {
    if (!pinboardActive) return filteredAssets;
    return filteredAssets.filter(a => pinboardIds.has(a.id));
  }, [filteredAssets, pinboardActive, pinboardIds]);

  const visibleAssets = useMemo(
    () => scopedAssets.slice(0, visibleCount),
    [scopedAssets, visibleCount]
  );

  const hasMore = visibleCount < scopedAssets.length;

  // Measure actual grid column width via ResizeObserver.
  // This accounts for sidebar open/close, padding, and window resize.
  useEffect(() => {
    const el = gridEl;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const cols = style.gridTemplateColumns.split(' ').length || 4;
      const gap = parseFloat(style.columnGap) || 12;
      const available = el.offsetWidth - (cols - 1) * gap;
      const cw = Math.round(available / cols);
      if (cw > 0) setGridColWidth(cw);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [gridEl]);

  // Note: CSS Grid fills row-major natively, so no transpose/reorder
  // is needed — visibleAssets can be rendered directly in sort order.

  // Selection handlers
  const handleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Pinboard handlers
  const togglePin = useCallback((id: string) => {
    setPinboardIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleBatchPin = useCallback(() => {
    setPinboardIds(prev => {
      const next = new Set(prev);
      selectedIds.forEach(id => next.add(id));
      return next;
    });
    clearSelection();
  }, [selectedIds, clearSelection]);

  const clearPinboard = useCallback(() => {
    setPinboardIds(new Set());
    setPinboardActive(false);
  }, []);

  const handleBatchUnpin = useCallback(() => {
    setPinboardIds(prev => {
      const next = new Set(prev);
      selectedIds.forEach(id => next.delete(id));
      return next;
    });
    clearSelection();
  }, [selectedIds, clearSelection]);

  const togglePinboardView = useCallback(() => {
    setPinboardActive(prev => !prev);
    setFilters(f => ({ ...f, folderPath: null }));
    setVisibleCount(PAGE_SIZE);
  }, []);

  const selectAllPinboard = useCallback(() => {
    setSelectedIds(new Set(pinboardIds));
  }, [pinboardIds]);

  // Expanded view navigation
  const expandedIndex = expandedAsset
    ? scopedAssets.findIndex((a) => a.id === expandedAsset.id)
    : -1;

  const handlePrev = useCallback(() => {
    if (expandedIndex > 0) {
      setExpandedAsset(scopedAssets[expandedIndex - 1]);
    }
  }, [expandedIndex, scopedAssets]);

  const handleNext = useCallback(() => {
    if (expandedIndex < scopedAssets.length - 1) {
      setExpandedAsset(scopedAssets[expandedIndex + 1]);
    }
  }, [expandedIndex, scopedAssets]);

  // Keyboard navigation for expanded view
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (expandedAsset) {
        if (e.key === 'ArrowLeft') handlePrev();
        if (e.key === 'ArrowRight') handleNext();
        if (e.key === 'Escape') setExpandedAsset(null);
      }
    },
    [expandedAsset, handlePrev, handleNext]
  );

  // Folder selection handler
  const handleFolderSelect = useCallback((path: string | null) => {
    setPinboardActive(false); // exit pinboard when selecting a folder
    setFilters((prev) => ({ ...prev, folderPath: path }));
    setVisibleCount(PAGE_SIZE);
  }, []);

  // Toggle a folder's "hidden from master view" status
  const handleToggleHidden = useCallback(async (path: string) => {
    setHiddenFolders(prev => {
      const next = prev.includes(path)
        ? prev.filter(p => p !== path)
        : [...prev, path];
      // Persist in the background (optimistic UI)
      fetch('/api/settings/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'hidden_folders', value: next }),
      }).catch(() => { /* silent */ });
      return next;
    });
  }, []);

  // Download handler — enqueues to background download queue
  const { enqueue: enqueueDownload } = downloadQueue;
  const handleDownload = useCallback((targetAssets: Asset[]) => {
    if (targetAssets.length === 0) return;
    enqueueDownload(
      targetAssets.map((a) => ({ driveFileId: a.driveFileId, name: a.name }))
    );
  }, [enqueueDownload]);

  // Batch download
  const handleBatchDownload = useCallback(() => {
    const selected = assets.filter((a) => selectedIds.has(a.id));
    handleDownload(selected);
  }, [assets, selectedIds, handleDownload]);

  // Batch relay — opens folder picker
  const handleBatchRelay = useCallback(() => {
    const selected = assets.filter((a) => selectedIds.has(a.id));
    setRelayTargetAssets(selected);
    setFolderPickerOpen(true);
  }, [assets, selectedIds]);

  // Single-asset download from ExpandedAssetView
  const handleSingleDownload = useCallback((asset: Asset) => {
    handleDownload([asset]);
  }, [handleDownload]);

  // Single-asset relay from ExpandedAssetView
  const handleSingleRelay = useCallback((asset: Asset) => {
    setRelayTargetAssets([asset]);
    setFolderPickerOpen(true);
  }, []);

  // After relay completes, refresh assets and close modal
  const handleRelayComplete = useCallback(async () => {
    await refreshAssets();
    clearSelection();
  }, [refreshAssets, clearSelection]);

  // Inject relay target folder into the folder tree for instant feedback
  const handleRelayRecorded = useCallback((entry: Parameters<typeof relayHistory.record>[0]) => {
    relayHistory.record(entry);
    if (entry.succeeded > 0 && entry.targetPath && entry.targetPath !== '/') {
      setFolderTree(prev => {
        // Clone to avoid mutation
        const clone = JSON.parse(JSON.stringify(prev)) as FolderNode;
        const segments = entry.targetPath.split('/').filter(Boolean);
        let current = clone;
        for (let i = 0; i < segments.length; i++) {
          const pathSoFar = '/' + segments.slice(0, i + 1).join('/');
          let child = current.children.find(c => c.path === pathSoFar);
          if (!child) {
            child = { id: pathSoFar, name: segments[i], path: pathSoFar, children: [] };
            current.children.push(child);
            current.children.sort((a, b) => a.name.localeCompare(b.name));
          }
          current = child;
        }
        return clone;
      });
    }
  }, [relayHistory]);

  // Loading state — skeleton UI so the user sees the app shell immediately
  if (loading) {
    return (
      <div className="flex h-screen overflow-hidden" style={{ background: 'var(--ram-bg-primary)' }}>
        {/* Sidebar placeholder */}
        <div
          className="flex-shrink-0 w-56 p-4 space-y-3"
          style={{ borderRight: '1px solid var(--ram-border)', background: 'var(--ram-bg-secondary)' }}
        >
          <div className="h-5 w-24 rounded animate-pulse" style={{ background: 'var(--ram-bg-tertiary)' }} />
          {[80, 65, 90, 70, 85, 60].map((w, i) => (
            <div key={i} className="h-4 rounded animate-pulse" style={{ background: 'var(--ram-bg-tertiary)', width: `${w}%` }} />
          ))}
        </div>
        {/* Main content placeholder */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header placeholder */}
          <header
            className="flex-shrink-0 px-6 py-4 flex items-center gap-4"
            style={{ borderBottom: '1px solid var(--ram-border)' }}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold"
              style={{ background: 'linear-gradient(135deg, var(--ram-accent), #d4922e)', color: 'var(--ram-bg-primary)' }}
            >
              R
            </div>
            <div>
              <h1 className="text-sm font-semibold" style={{ color: 'var(--ram-text-primary)' }}>Relay Asset Manager</h1>
              <p className="text-[11px]" style={{ color: 'var(--ram-text-tertiary)' }}>Loading assets...</p>
            </div>
          </header>
          {/* Skeleton grid */}
          <div className="flex-1 overflow-hidden p-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
              {[...Array(24)].map((_, i) => (
                <div key={i} className="rounded-lg overflow-hidden" style={{ background: 'var(--ram-bg-secondary)', border: '1px solid var(--ram-border)' }}>
                  <div className="aspect-[4/3] animate-pulse" style={{ background: 'var(--ram-bg-tertiary)' }} />
                  <div className="p-2 space-y-1.5">
                    <div className="h-3 rounded animate-pulse" style={{ background: 'var(--ram-bg-tertiary)', width: '75%' }} />
                    <div className="h-2.5 rounded animate-pulse" style={{ background: 'var(--ram-bg-tertiary)', width: '50%' }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-screen items-center justify-center" style={{ background: 'var(--ram-bg-primary)' }}>
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <p className="text-sm" style={{ color: 'var(--ram-red)' }}>
            ❌ {error}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg text-sm"
            style={{ background: 'var(--ram-accent-muted)', color: 'var(--ram-accent)' }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden" onKeyDown={handleKeyDown} tabIndex={0}>
      {/* Folder sidebar (Browse mode only) */}
      {appMode === 'browse' && (
        <FolderSidebar
          tree={folderTree}
          selectedPath={filters.folderPath}
          onSelectFolder={handleFolderSelect}
          isOpen={sidebarOpen}
          onToggle={() => setSidebarOpen(!sidebarOpen)}
          pinboardCount={pinboardIds.size}
          pinboardActive={pinboardActive}
          onTogglePinboard={togglePinboardView}
          onClearPinboard={clearPinboard}
          onSelectAllPinboard={selectAllPinboard}
          hiddenFolders={hiddenFolders}
          onToggleHidden={handleToggleHidden}
        />
      )}

      {/* Main content */}
      <div className={`flex-1 flex flex-col min-w-0 ${appMode === 'ingest' ? 'overflow-y-auto' : 'overflow-hidden'}`}>
        {/* Top bar */}
        <header
          className="flex-shrink-0 px-6 py-4 flex items-center gap-4"
          style={{ borderBottom: '1px solid var(--ram-border)' }}
        >
          <div className="flex items-center gap-3">
            {/* Logo / brand */}
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold"
              style={{
                background: 'linear-gradient(135deg, var(--ram-accent), #d4922e)',
                color: 'var(--ram-bg-primary)',
              }}
            >
              R
            </div>
            <div>
              <h1 className="text-sm font-semibold" style={{ color: 'var(--ram-text-primary)' }}>
                Relay {appMode === 'browse' ? 'Asset Manager' : 'Asset Namer'}
              </h1>
              <p className="text-[11px]" style={{ color: 'var(--ram-text-tertiary)' }}>
                {appMode === 'browse'
                  ? `${filters.folderPath || 'All Folders'} · ${assets.length.toLocaleString()} assets`
                  : 'Name, organize, and tag assets for Google Drive'}
              </p>
            </div>
          </div>

          <div className="flex-1" />

          {/* Download queue */}
          <DownloadQueue
            items={downloadQueue.items}
            activeCount={downloadQueue.activeCount}
            onClearCompleted={downloadQueue.clearCompleted}
            onClearAll={downloadQueue.clearAll}
          />

          {/* Relay history */}
          <RelayHistory
            items={relayHistory.items}
            totalRelayed={relayHistory.totalRelayed}
            onClearAll={relayHistory.clearAll}
            onUndo={async (item) => {
              relayHistory.markUndone(item.id);
              // Refresh assets to update relay count badges
              await refreshAssets();
            }}
          />

          {/* Mode toggle */}
          <div
            className="flex items-center rounded-lg p-0.5 gap-0.5"
            style={{ background: 'var(--ram-bg-tertiary)', border: '1px solid var(--ram-border)' }}
          >
            <button
              onClick={() => setAppMode('browse')}
              className="text-xs font-semibold px-4 py-1.5 rounded-md transition-all"
              style={{
                background: appMode === 'browse' ? 'var(--ram-bg-elevated)' : 'transparent',
                color: appMode === 'browse' ? 'var(--ram-accent)' : 'var(--ram-text-tertiary)',
                boxShadow: appMode === 'browse' ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
              }}
            >
              📂 Library
            </button>
            <button
              onClick={() => { setAppMode('ingest'); setNamerOpened(true); }}
              className="text-xs font-semibold px-4 py-1.5 rounded-md transition-all"
              style={{
                background: appMode === 'ingest' ? 'var(--ram-bg-elevated)' : 'transparent',
                color: appMode === 'ingest' ? 'var(--ram-accent)' : 'var(--ram-text-tertiary)',
                boxShadow: appMode === 'ingest' ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
              }}
            >
              🏷️ Namer
            </button>
          </div>

          {/* Sync health — shown only when the scheduled sync failed or
              hasn't succeeded recently; opens Settings → Recent activity */}
          {syncHealth?.issue && (
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-[11px] font-medium px-2.5 py-1 rounded-full transition-opacity hover:opacity-80"
              style={{ color: 'var(--ram-red)', background: 'var(--ram-red-bg)', border: 'none', cursor: 'pointer' }}
              title={syncHealth.issue === 'failed'
                ? `Last scheduled sync failed${syncHealth.latestError ? `: ${syncHealth.latestError}` : ''}`
                : `No successful sync in over ${syncHealth.staleAfterHours} hours`}
            >
              {syncHealth.issue === 'failed' ? '⚠ Sync failed' : '⚠ Sync overdue'}
            </button>
          )}

          {/* User menu dropdown */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="relative flex items-center gap-1.5 cursor-pointer transition-all hover:ring-2 hover:ring-[var(--ram-accent)] rounded-full pr-1"
              style={{ background: 'transparent', border: 'none' }}
            >
              <span
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium"
                style={{
                  background: 'var(--ram-bg-tertiary)',
                  color: 'var(--ram-text-secondary)',
                  border: '1px solid var(--ram-border)',
                }}
              >
                {userInitials}
              </span>

              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="var(--ram-text-tertiary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ transition: 'transform 0.2s', transform: userMenuOpen ? 'rotate(180deg)' : 'rotate(0)' }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {userMenuOpen && (
              <div
                className="absolute right-0 top-full mt-2 w-48 rounded-xl overflow-hidden shadow-xl z-50"
                style={{
                  background: 'var(--ram-bg-elevated)',
                  border: '1px solid var(--ram-border)',
                }}
              >
                <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--ram-border)' }}>
                  <p className="text-xs font-medium" style={{ color: 'var(--ram-text-primary)' }}>
                    {userEmail ? `Signed in as ${userEmail}` : 'Signed in'}
                  </p>
                </div>

                <button
                  onClick={() => { setSettingsOpen(true); setUserMenuOpen(false); }}
                  className="w-full text-left px-4 py-2.5 text-xs transition-colors hover:bg-[var(--ram-bg-hover)] flex items-center gap-2"
                  style={{ color: 'var(--ram-text-secondary)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                  Sync & Settings
                </button>
                <button
                  onClick={() => { setTrashModalOpen(true); setUserMenuOpen(false); }}
                  className="w-full text-left px-4 py-2.5 text-xs transition-colors hover:bg-[var(--ram-bg-hover)] flex items-center gap-2"
                  style={{ color: 'var(--ram-text-secondary)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  Trash{trashItems.length > 0 && (
                    <span style={{
                      marginLeft: 'auto',
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '1px 6px',
                      borderRadius: 8,
                      background: 'rgba(239, 68, 68, 0.15)',
                      color: 'var(--ram-red, #f87171)',
                    }}>{trashItems.length}</span>
                  )}
                </button>
                <button
                  onClick={async () => {
                    const { createClient } = await import('@/lib/supabase/client');
                    const supabase = createClient();
                    await supabase.auth.signOut();
                    window.location.href = '/login';
                  }}
                  className="w-full text-left px-4 py-2.5 text-xs transition-colors hover:bg-[var(--ram-bg-hover)] flex items-center gap-2"
                  style={{ color: 'var(--ram-red, #f87171)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </header>

        {/* MODE-DEPENDENT CONTENT */}
        {/* Once opened, the Namer stays mounted (just hidden) while browsing:
            its batch queue lives in component state, and unmounting mid-batch
            orphaned the running loop — lost progress, no library ingest
            scheduled, and files re-listed for a second concurrent rename. */}
        {namerOpened && (
          <div hidden={appMode !== 'ingest'} className="flex flex-col flex-1 min-h-0">
            <NamerView />
          </div>
        )}
        {appMode !== 'ingest' && (
          <>
        {/* Search + filters */}
        <div className="flex-shrink-0 px-6 py-4">
          <SearchBar
            filters={filters}
            onFiltersChange={(f) => {
              setFilters(f);
              setShuffleSeed(null); // clear shuffle when filters change
              setVisibleCount(PAGE_SIZE);
            }}
            onSearchSubmit={triggerSemanticSearch}
            isSearching={semanticLoading}
            totalCount={filteredAssets.length}
            totalAssetCount={assets.length}
            isShuffled={shuffleSeed !== null}
            onShuffle={() => {
              setShuffleSeed(Date.now());
              setVisibleCount(PAGE_SIZE);
            }}
          />
        </div>


        {/* Asset grid */}
        <div className="flex-1 overflow-y-auto px-6 pb-24" ref={setScrollEl}>
          {filteredAssets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="1">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <p className="text-sm" style={{ color: 'var(--ram-text-tertiary)' }}>
                No assets match your filters
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setFilters(DEFAULT_FILTERS);
                    setVisibleCount(PAGE_SIZE);
                  }}
                  className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{
                    background: 'var(--ram-accent-muted)',
                    color: 'var(--ram-accent)',
                  }}
                >
                  Reset filters
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="masonry-grid" ref={setGridEl}>
                {visibleAssets.map((asset, i) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    eager={i < EAGER_CARDS}
                    selected={selectedIds.has(asset.id)}
                    isExpired={derived.get(asset.id)?.anyExpired ?? isAnyRightExpired(asset)}
                    similarity={semanticResults?.get(asset.id)}
                    textMatch={deferredFilters.query ? textMatchIds.has(asset.id) : undefined}
                    onSelect={handleSelect}
                    onExpand={setExpandedAsset}
                    isPinned={pinboardIds.has(asset.id)}
                    onTogglePin={togglePin}
                    colWidth={gridColWidth}
                  />
                ))}
              </div>

              {/* Infinite scroll sentinel */}
              {hasMore && (
                <InfiniteScrollSentinel root={scrollEl} version={visibleCount} onIntersect={loadMore} />
              )}
            </>
          )}
        </div>
          </> /* end Browse mode */
        )}
      </div>

      {/* Action bar */}
      <ActionBar
        selectedCount={selectedIds.size}
        onRelay={handleBatchRelay}
        onDownload={handleBatchDownload}
        onClearSelection={clearSelection}

        onPinToBoard={pinboardActive ? undefined : handleBatchPin}
        onUnpinFromBoard={pinboardActive ? handleBatchUnpin : undefined}
      />

      {/* Expanded view modal */}
      {expandedAsset && (
        <ExpandedAssetView
          asset={expandedAsset}
          onClose={() => setExpandedAsset(null)}
          onPrev={handlePrev}
          onNext={handleNext}
          hasPrev={expandedIndex > 0}
          hasNext={expandedIndex < scopedAssets.length - 1}
          onDownload={handleSingleDownload}
          onRelay={handleSingleRelay}
          isQueued={downloadQueue.items.some(
            (i) => i.name === expandedAsset.name && (i.status === 'pending' || i.status === 'downloading')
          )}
          isRelayed={relayHistory.relayedAssetIds.has(
            expandedAsset.id.includes('::sc::') ? expandedAsset.id.split('::sc::')[0] : expandedAsset.id
          )}

          isPinned={pinboardIds.has(expandedAsset.id)}
          onTogglePin={(asset) => togglePin(asset.id)}
          onThumbnailUpdated={(assetId, newUrl) => {
            // Update master list so the grid card refreshes
            setAssets(prev => prev.map(a =>
              a.id === assetId ? { ...a, thumbnailUrl: newUrl } : a
            ));
            // Update expanded view in-place
            if (expandedAsset?.id === assetId) {
              setExpandedAsset(prev => prev ? { ...prev, thumbnailUrl: newUrl } : prev);
            }
          }}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => { setSettingsOpen(false); checkSyncHealth(); }}
          onSyncComplete={async () => {
            await refreshAssets();
          }}
        />
      )}

      {trashModalOpen && (
        <TrashPanel
          items={trashItems}
          onAction={handleTrashAction}
          onClose={() => setTrashModalOpen(false)}
        />
      )}

      {/* Folder picker modal */}
      {folderPickerOpen && (
        <FolderPickerModal
          assets={relayTargetAssets}
          onClose={() => { setFolderPickerOpen(false); setRelayTargetAssets([]); }}
          onComplete={handleRelayComplete}
          recentFolders={recentRelayFolders}
          onRecentFoldersChange={setRecentRelayFolders}
          onRelayRecorded={handleRelayRecorded}
        />
      )}
    </div>
  );
}

// Sentinel that triggers loading when scrolled into view
function InfiniteScrollSentinel({ root, version, onIntersect }: {
  root: HTMLElement | null;
  /** Changes after each load; re-observing re-checks a still-visible sentinel. */
  version: number;
  onIntersect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !root) return;

    // root must be the scroll container: with the default (viewport) root,
    // the container clips the sentinel and rootMargin can't extend past that
    // clip, so the lookahead never happened and users hit the spinner.
    // A new observer reports the current state on creation, so re-creating
    // it per `version` keeps loading while the sentinel is still in range.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onIntersect();
      },
      { root, rootMargin: '0px 0px 150% 0px' } // ~1.5 screens of lookahead
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [root, version, onIntersect]);

  return (
    <div ref={ref} className="flex justify-center py-8">
      <div
        className="w-6 h-6 rounded-full border-2 animate-spin"
        style={{
          borderColor: 'var(--ram-border)',
          borderTopColor: 'var(--ram-accent)',
        }}
      />
    </div>
  );
}
