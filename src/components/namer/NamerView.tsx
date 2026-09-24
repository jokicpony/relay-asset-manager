'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as namerApi from '@/lib/namer/namer-api';
import { logger } from '@/lib/logger';
import type {
    NamerFilePreview,
    NamerSettings,
    SchemaField,
    DriveLabel,
    AIMetadata,
    BatchInfo,
    BatchFile,
    BatchStep,
    LabelFieldValue,
} from '@/lib/namer/types';
import { PASSTHROUGH_SCHEMA_KEY } from '@/lib/namer/types';
import {
    buildProposedName,
    counterTokenIndex,
    dedupeName,
    findFreeCounterStart,
} from '@/lib/namer/naming';
import {
    batchProgress,
    hiddenSourceFileIds,
    isMoved,
    isRetryable,
    revertTargets,
    statusOnCancel,
} from '@/lib/namer/batch-utils';
import SchemaSelector from './SchemaSelector';
import FolderPicker from './FolderPicker';
import NamingBuilder from './NamingBuilder';
import LabelSelector from './LabelSelector';
import FilePreviewTable from './FilePreviewTable';
import type { PreviewViewMode, TileSize } from './FilePreviewTable';
import NamerQueue from './NamerQueue';
import NamerSettingsPanel from './NamerSettings';
import BatchConfirmModal from './BatchConfirmModal';
import { useDeferredIngest } from '@/hooks/useDeferredIngest';

// LocalStorage keys for the file-preview view preference
const LS_PREVIEW_VIEW = 'ram_namer_preview_view';
const LS_TILE_SIZE = 'ram_namer_tile_size';

const errMessage = (err: unknown) => err instanceof Error ? err.message : String(err);

/** Batches the header's Clear Completed removes (nothing left to run). */
const isClearable = (b: BatchInfo) =>
    b.status === 'completed' || b.status === 'reverted' || b.status === 'revert-failed';

// ---------------------------------------------------------------------------
// NamerView — Top-level orchestrator for the Ingest workflow.
// Mirrors the original FileProcessor.jsx functionality, rebuilt in TSX.
// ---------------------------------------------------------------------------

export default function NamerView() {
    // ─── Settings ──────────────────────────────────────────────
    const [settings, setSettings] = useState<NamerSettings | null>(null);
    const [settingsLoading, setSettingsLoading] = useState(true);
    const [settingsOpen, setSettingsOpen] = useState(false);

    // ─── Schema ────────────────────────────────────────────────
    const [selectedSchema, setSelectedSchema] = useState<string>('');
    const [schemaFields, setSchemaFields] = useState<SchemaField[]>([]);

    // ─── Folders ───────────────────────────────────────────────
    const [sourceFolderId, setSourceFolderId] = useState('');
    const [sourceFolderName, setSourceFolderName] = useState('');
    const [destFolderId, setDestFolderId] = useState('');
    const [destFolderName, setDestFolderName] = useState('');

    // ─── Files ─────────────────────────────────────────────────
    const [files, setFiles] = useState<NamerFilePreview[]>([]);
    const [filesLoading, setFilesLoading] = useState(false);

    // ─── Labels ────────────────────────────────────────────────
    const [labels, setLabels] = useState<DriveLabel[]>([]);
    const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
    const [labelFieldValues, setLabelFieldValues] = useState<Record<string, Record<string, { value: string | string[]; type: string }>>>({});

    // ─── AI ────────────────────────────────────────────────────
    const [aiEnabled, setAiEnabled] = useState(true);

    // ─── Queue (batches processed inline) ──────────────────────
    const [batches, setBatches] = useState<BatchInfo[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);

    // Closing or reloading the tab mid-batch abandons the rest of the queue
    // (some files renamed/moved, others not) — ask first.
    useEffect(() => {
        if (!isProcessing) return;
        const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [isProcessing]);
    const processingRef = useRef(false);
    const batchFileIdsRef = useRef<Set<string>>(new Set());
    // Batch IDs whose Cancel was clicked — the runner checks before each file
    const cancelRequestsRef = useRef<Set<string>>(new Set());

    // Keep batchFileIdsRef in sync so loadFiles can filter without re-creating.
    // Only files a batch still owns are hidden; cancelled and reverted files
    // reappear in the source list (see hiddenSourceFileIds).
    useEffect(() => {
        batchFileIdsRef.current = hiddenSourceFileIds(batches);
    }, [batches]);

    /** Patch one file of a batch; progress is re-derived from file statuses. */
    const patchFile = useCallback((batchId: string, fileId: string, patch: Partial<BatchFile>) => {
        setBatches(prev => prev.map(b => {
            if (b.id !== batchId) return b;
            const files = b.files.map(f => f.id === fileId ? { ...f, ...patch } : f);
            return { ...b, files, progress: batchProgress(files) };
        }));
    }, []);

    const patchBatch = useCallback((batchId: string, patch: Partial<BatchInfo>) => {
        setBatches(prev => prev.map(b => b.id === batchId ? { ...b, ...patch } : b));
    }, []);

    // ─── Deferred ingest (namer → DAM pipeline) ───────────────
    const { pendingIngests, scheduleIngest, cancelIngest, triggerNow, retryIngest } = useDeferredIngest();

    // ─── Tag summary ──────────────────────────────────────────


    // ─── Confirm modal ────────────────────────────────────────
    const [showConfirmModal, setShowConfirmModal] = useState(false);

    // ─── Counter ──────────────────────────────────────────────
    const [counter, setCounter] = useState(1);

    // ─── UI layout ────────────────────────────────────────────
    const [setupCollapsed, setSetupCollapsed] = useState(false);
    // queueOpen state removed — queue is always visible with scroll

    // ==========================================================
    // Load settings on mount
    // ==========================================================
    useEffect(() => {
        (async () => {
            try {
                const s = await namerApi.getSettings();
                setSettings(s);
                setAiEnabled(s.aiSettings?.enabled ?? true);
                // Auto-select first schema so a naming template loads immediately
                if (s.schemas) {
                    const keys = Object.keys(s.schemas);
                    if (keys.length > 0) {
                        setSelectedSchema(keys[0]);
                    }
                }
            } catch (err) {
                logger.error('namer', 'Failed to load settings', { error: err instanceof Error ? err.message : String(err) });
            } finally {
                setSettingsLoading(false);
            }
        })();
    }, []);

    // Also load labels on mount
    useEffect(() => {
        (async () => {
            try {
                const l = await namerApi.getLabels();
                setLabels(l);
            } catch (err) {
                // Labels are optional — silently degrade if the Labels API isn't accessible
                logger.warn('namer', 'Labels unavailable (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
            }
        })();
    }, []);

    // ==========================================================
    // When schema changes, load its fields
    // ==========================================================
    const isPassthrough = selectedSchema === PASSTHROUGH_SCHEMA_KEY;
    const lastSchemaRef = useRef('');

    useEffect(() => {
        if (!selectedSchema) {
            setSchemaFields([]);
            return;
        }
        // Passthrough mode — no schema fields, AI defaults on
        if (selectedSchema === PASSTHROUGH_SCHEMA_KEY) {
            setSchemaFields([]);
            setAiEnabled(true);
            return;
        }
        if (!settings?.schemas) {
            setSchemaFields([]);
            return;
        }
        const schema = settings.schemas[selectedSchema];
        if (!schema) {
            // Schema was renamed or deleted in Settings — don't keep stale fields
            setSelectedSchema('');
            setSchemaFields([]);
            return;
        }
        // Same schema re-applied (e.g. after saving Settings): keep what the
        // user already typed into the builder, matched by field id. Constants
        // and frozen fields always take the Settings value.
        const sameSchema = lastSchemaRef.current === selectedSchema;
        lastSchemaRef.current = selectedSchema;
        const today = new Date();
        const yyyymmdd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
        setSchemaFields(prev => {
            const typed = sameSchema ? new Map(prev.map(f => [f.id, f.value])) : new Map<string, string>();
            return schema.fields.map(f => {
                const kept = f.type !== 'constant' && (f.type === 'date' || !f.frozen) ? typed.get(f.id) : undefined;
                return {
                    ...f,
                    // Date fields: auto-populate with today and ensure editable
                    value: kept || (f.type === 'date' && !f.value ? yyyymmdd : f.value),
                    frozen: f.type === 'date' ? false : f.frozen,
                };
            });
        });
        if (!sameSchema) setAiEnabled(schema.aiEnabled ?? true);
    }, [selectedSchema, settings]);

    // ==========================================================
    // Load files from source folder
    // ==========================================================
    // Sequence guard: a slower earlier listing (or one for a folder the user
    // has since switched away from) must not overwrite the current list.
    const loadSeqRef = useRef(0);
    const [filesError, setFilesError] = useState<string | null>(null);
    const [loadedFolderId, setLoadedFolderId] = useState('');
    // Folder the counter was last reset for. Reloads of the same folder (e.g.
    // right after queueing a batch) keep counting, so the next batch to the
    // same destination doesn't reuse 001… and collide.
    const counterFolderRef = useRef('');
    // Current source folder, for async flows that outlive a folder switch
    const sourceFolderRef = useRef(sourceFolderId);
    useEffect(() => { sourceFolderRef.current = sourceFolderId; }, [sourceFolderId]);

    const loadFiles = useCallback(async () => {
        if (!sourceFolderId) return;
        const seq = ++loadSeqRef.current;
        setFilesLoading(true);
        setFilesError(null);
        try {
            const raw = await namerApi.listFiles(sourceFolderId);
            if (seq !== loadSeqRef.current) return;
            // Filter out files already tracked in any batch (processing, completed, etc.)
            const knownIds = batchFileIdsRef.current;
            const fresh = raw.filter(f => !knownIds.has(f.id));
            const previews: NamerFilePreview[] = fresh.map(f => ({
                ...f,
                originalName: f.name,
                proposedName: f.name, // derived later (namedFiles)
                status: 'pending',
            }));
            setFiles(previews);
            setLoadedFolderId(sourceFolderId);
            setLoadCount(c => c + 1);
            if (counterFolderRef.current !== sourceFolderId) {
                counterFolderRef.current = sourceFolderId;
                setCounter(1); // New source folder — start numbering over
            }
        } catch (err) {
            if (seq !== loadSeqRef.current) return;
            logger.error('namer', 'Failed to load files', { error: err instanceof Error ? err.message : String(err) });
            // Don't leave the previous list on screen looking current — it may
            // include files that were just queued.
            setFiles([]);
            setFilesError(err instanceof Error ? err.message : 'Failed to load files');
        } finally {
            if (seq === loadSeqRef.current) setFilesLoading(false);
        }
    }, [sourceFolderId]);

    // Files load on explicit "Load Files" button click — no auto-load

    // ==========================================================
    // Generate proposed names based on schema fields
    // ==========================================================
    const buildName = useCallback((file: NamerFilePreview, index: number): string => {
        // Passthrough — keep original filename unchanged
        if (isPassthrough) return file.originalName;
        return buildProposedName(schemaFields, file.originalName, counter + index);
    }, [schemaFields, counter, isPassthrough]);

    // Proposed names are derived, never stored. They used to be written into
    // `files` by an effect keyed on [buildName, files.length], which missed
    // reloads with the same file count (names silently reverted to the
    // originals — and the batch then moved files without renaming them) and
    // exclude/re-include toggles (stale, duplicated counter numbers).
    // The counter indexes pending files only, in list order.
    const namedFiles = useMemo(() => {
        let idx = 0;
        return files.map(f => f.status === 'pending'
            ? { ...f, proposedName: buildName(f, idx++) }
            : f);
    }, [files, buildName]);

    // ==========================================================
    // Toggle exclude a file
    // ==========================================================
    const toggleExclude = useCallback((fileId: string) => {
        setFiles(prev => prev.map(f => {
            if (f.id !== fileId) return f;
            return {
                ...f,
                status: f.status === 'excluded' ? 'pending' : 'excluded',
            };
        }));
    }, []);

    const selectAll = useCallback(() => {
        setFiles(prev => prev.map(f =>
            f.status === 'excluded' ? { ...f, status: 'pending' as const } : f
        ));
    }, []);

    const deselectAll = useCallback(() => {
        setFiles(prev => prev.map(f =>
            f.status === 'pending' ? { ...f, status: 'excluded' as const } : f
        ));
    }, []);

    const [loadCount, setLoadCount] = useState(0);

    const selectFiltered = useCallback((ids: string[]) => {
        const s = new Set(ids);
        setFiles(prev => prev.map(f =>
            s.has(f.id) && f.status === 'excluded' ? { ...f, status: 'pending' as const } : f
        ));
    }, []);

    const deselectFiltered = useCallback((ids: string[]) => {
        const s = new Set(ids);
        setFiles(prev => prev.map(f =>
            s.has(f.id) && f.status === 'pending' ? { ...f, status: 'excluded' as const } : f
        ));
    }, []);

    /** Shift-click range paint — set every toggleable id in the range to one status. */
    const setRangeStatus = useCallback((ids: string[], status: 'pending' | 'excluded') => {
        const s = new Set(ids);
        setFiles(prev => prev.map(f =>
            s.has(f.id) && (f.status === 'pending' || f.status === 'excluded')
                ? { ...f, status }
                : f
        ));
    }, []);

    // ==========================================================
    // File preview view mode (list / grid)
    // Lives here, not in FilePreviewTable: that component is keyed by
    // loadCount and remounts on every load, which would reset the choice.
    // ==========================================================
    const [previewView, setPreviewView] = useState<PreviewViewMode>('list');
    const [tileSize, setTileSize] = useState<TileSize>('m');

    useEffect(() => {
        try {
            const v = localStorage.getItem(LS_PREVIEW_VIEW);
            if (v === 'list' || v === 'grid') setPreviewView(v);
            const t = localStorage.getItem(LS_TILE_SIZE);
            if (t === 's' || t === 'm' || t === 'l') setTileSize(t);
        } catch {
            // localStorage unavailable — fall back to defaults
        }
    }, []);

    const changePreviewView = useCallback((mode: PreviewViewMode) => {
        setPreviewView(mode);
        try {
            localStorage.setItem(LS_PREVIEW_VIEW, mode);
        } catch {
            // localStorage unavailable — choice just won't persist
        }
    }, []);

    const changeTileSize = useCallback((size: TileSize) => {
        setTileSize(size);
        try {
            localStorage.setItem(LS_TILE_SIZE, size);
        } catch {
            // localStorage unavailable — choice just won't persist
        }
    }, []);

    // ==========================================================
    // Enqueue batch — checks the destination for name collisions, then
    // creates the batch; the queue runner picks it up.
    // ==========================================================
    const enqueueingRef = useRef(false);
    const [enqueueing, setEnqueueing] = useState(false);

    const enqueueBatch = useCallback(async () => {
        if (enqueueingRef.current) return;
        // Snapshot what the user confirmed — state can change during the await
        const pendingFiles = files.filter(f => f.status === 'pending');
        if (pendingFiles.length === 0 || !destFolderId) return;
        const batchSourceFolderId = sourceFolderId;
        const batchDestFolderId = destFolderId;
        const fields = schemaFields;
        const passthrough = isPassthrough;
        const counterIndex = passthrough ? null : counterTokenIndex(fields);
        const nameAt = (num: number, i: number) => passthrough
            ? pendingFiles[i].originalName
            : buildProposedName(fields, pendingFiles[i].originalName, num);

        enqueueingRef.current = true;
        setEnqueueing(true);
        try {
            // Start the counter past names already in the destination (an
            // earlier batch, or files named elsewhere), so the batch doesn't
            // fall back to per-file dedupe. Only the schema's counter can move.
            let start = counter;
            if (counterIndex !== null) {
                try {
                    const batchIds = new Set(pendingFiles.map(f => f.id));
                    const taken = new Set(
                        (await namerApi.listFiles(batchDestFolderId))
                            .filter(f => !batchIds.has(f.id)) // renaming in place
                            .map(f => f.name)
                    );
                    start = findFreeCounterStart(counter, pendingFiles.length, nameAt, n => taken.has(n));
                } catch (err) {
                    // Not fatal — the batch still dedupes each name against
                    // the destination before renaming
                    logger.warn('namer', 'Destination name check failed', { error: err instanceof Error ? err.message : String(err) });
                }
            }

            const batchId = `batch-${Date.now()}`;

            // Build labels summary for the batch card
            const labelParts: string[] = [];
            for (const labelId of selectedLabelIds) {
                const label = labels.find(l => l.id === labelId);
                const fv = labelFieldValues[labelId] || {};
                const fieldItems = Object.entries(fv)
                    .filter(([, v]) => Array.isArray(v.value) ? v.value.length > 0 : !!v.value)
                    .map(([fId, v]) => {
                        const field = label?.fields?.find(f => f.id === fId);
                        const name = field?.properties?.displayName || fId;
                        const rawValues = Array.isArray(v.value) ? v.value : [v.value];
                        let val: string;
                        if (field?.selectionOptions?.choices) {
                            val = rawValues.map(id => {
                                const choice = field.selectionOptions!.choices.find(c => c.id === id);
                                return choice?.properties?.displayName || id;
                            }).join(', ');
                        } else {
                            val = rawValues.join(', ');
                        }
                        return `${name}: ${val}`;
                    });
                if (fieldItems.length > 0) {
                    const labelName = label?.properties?.title || labelId;
                    labelParts.push(`${labelName} (${fieldItems.join('; ')})`);
                }
            }

            const batchFiles: BatchFile[] = pendingFiles.map((f, i) => ({
                id: f.id,
                name: f.name,
                proposedName: nameAt(start + i, i),
                status: 'queued',
                finalName: null,
                imageMediaMetadata: f.imageMediaMetadata,
                videoMediaMetadata: f.videoMediaMetadata,
            }));
            const batch: BatchInfo = {
                id: batchId,
                files: batchFiles,
                progress: batchProgress(batchFiles),
                status: 'queued',
                timestamp: Date.now(),
                labelsSummary: labelParts.length > 0 ? `Content Tags (${labelParts.join(' | ')})` : undefined,
                sourceFolderId: batchSourceFolderId,
                destFolderId: batchDestFolderId,
                // Snapshot the current settings so they're preserved even if the user
                // changes labels/AI/schema between queueing and processing
                _snapshot: {
                    selectedLabelIds: [...selectedLabelIds],
                    labelFieldValues: JSON.parse(JSON.stringify(labelFieldValues)),
                    aiEnabled,
                    labels: labels,
                    settings,
                    counterIndex,
                },
            };

            setBatches(prev => [...prev, batch]);

            // Continue numbering after this batch (the reload below no longer
            // resets it), so the next batch to this destination doesn't collide
            if (counterIndex !== null) setCounter(start + pendingFiles.length);

            // Eagerly add file IDs so loadFiles filters them out, then reload —
            // unless the user switched source folders while we checked names
            for (const f of batch.files) batchFileIdsRef.current.add(f.id);
            if (batchSourceFolderId && sourceFolderRef.current === batchSourceFolderId) loadFiles();
        } finally {
            enqueueingRef.current = false;
            setEnqueueing(false);
        }
    }, [files, destFolderId, sourceFolderId, schemaFields, isPassthrough, counter, selectedLabelIds, labelFieldValues, labels, aiEnabled, settings, loadFiles]);

    // ==========================================================
    // Process one batch — runs the file-by-file processing loop
    // ==========================================================
    const processOneBatch = useCallback(async (batch: BatchInfo) => {
        const batchId = batch.id;
        const batchDestFolderId = batch.destFolderId;
        const batchSourceFolderId = batch.sourceFolderId;

        // Pull settings from snapshot (or fallback to current)
        const snap = batch._snapshot;
        const batchLabelIds: string[] = snap?.selectedLabelIds || selectedLabelIds;
        const batchLabelFieldValues = snap?.labelFieldValues || labelFieldValues;
        const batchAiEnabled: boolean = snap?.aiEnabled ?? aiEnabled;
        const batchLabels: typeof labels = snap?.labels || labels;
        const batchSettings = snap?.settings || settings;

        // Build labelParts from snapshot for semantic description
        const labelParts: string[] = [];
        for (const labelId of batchLabelIds) {
            const label = batchLabels.find((l) => l.id === labelId);
            const fv = batchLabelFieldValues[labelId] || {};
            const fieldItems = Object.entries(fv)
                .filter(([, v]) => Array.isArray(v.value) ? v.value.length > 0 : !!v.value)
                .map(([fId, v]) => {
                    const field = label?.fields?.find((f) => f.id === fId);
                    const name = field?.properties?.displayName || fId;
                    const rawValues = Array.isArray(v.value) ? v.value : [v.value];
                    let val: string;
                    if (field?.selectionOptions?.choices) {
                        val = rawValues.map((id: string) => {
                            const choice = field.selectionOptions!.choices.find((c) => c.id === id);
                            return choice?.properties?.displayName || id;
                        }).join(', ');
                    } else {
                        val = rawValues.join(', ');
                    }
                    return `${name}: ${val}`;
                });
            if (fieldItems.length > 0) {
                const labelName = label?.properties?.title || labelId;
                labelParts.push(`${labelName} (${fieldItems.join('; ')})`);
            }
        }

        // Mark batch as processing
        patchBatch(batchId, { status: 'processing' });

        // Destination listing: names for collision checks, and file IDs so a
        // retry can tell a move that actually landed (response lost) from one
        // that didn't — a retry must never rename or move a file twice.
        const nameOwner = new Map<string, string>();  // name → file id
        const destNameById = new Map<string, string>(); // file id → name
        try {
            for (const f of await namerApi.listFiles(batchDestFolderId)) {
                nameOwner.set(f.name, f.id);
                destNameById.set(f.id, f.name);
            }
        } catch (err) {
            logger.warn('namer-batch', 'Could not list destination for duplicate checks', { error: errMessage(err) });
        }
        const counterIndex = snap?.counterIndex ?? null;

        // First run: every file is queued. "Retry failed" re-queues only the
        // failed ones; their doneSteps say what to skip.
        const toRun = batch.files.filter(f => f.status === 'queued');
        const succeededIds: string[] = [];

        for (let i = 0; i < toRun.length; i++) {
            const file = toRun[i];

            // Cancel is checked before each file starts: the current file
            // finishes, the rest are marked cancelled (not failed)
            if (cancelRequestsRef.current.has(batchId)) {
                const remaining = new Set(toRun.slice(i).map(f => f.id));
                setBatches(prev => prev.map(b => {
                    if (b.id !== batchId) return b;
                    const files = b.files.map(f => remaining.has(f.id) && f.status === 'queued'
                        ? { ...f, status: statusOnCancel(f) }
                        : f);
                    return { ...b, files, progress: batchProgress(files) };
                }));
                break;
            }

            patchFile(batchId, file.id, { status: 'processing', error: undefined, warnings: undefined });

            const done = new Set<BatchStep>(file.doneSteps ?? []);
            const warnings: string[] = [];
            let finalName = file.finalName;

            try {
                // 1. Rename + Move — the one fatal step
                if (!done.has('move')) {
                    const takenByOther = (name: string) => {
                        const owner = nameOwner.get(name);
                        return owner !== undefined && owner !== file.id;
                    };
                    if (file.targetName && destNameById.get(file.id) === file.targetName) {
                        // An earlier attempt landed even though it reported failure
                        finalName = file.targetName;
                    } else {
                        // Reuse an earlier attempt's target so the name can't drift
                        const target = file.targetName && !takenByOther(file.targetName)
                            ? file.targetName
                            : dedupeName(file.proposedName, takenByOther, counterIndex);
                        nameOwner.set(target, file.id); // reserve for later files
                        patchFile(batchId, file.id, { targetName: target });
                        try {
                            await namerApi.updateFile(file.id, target, batchDestFolderId, batchSourceFolderId || undefined);
                        } catch (moveErr) {
                            const reason = errMessage(moveErr);
                            logger.error('namer-batch', `Rename/move failed on ${file.name}`, { error: reason });
                            patchFile(batchId, file.id, {
                                status: 'error',
                                error: `Rename/move failed: ${reason}`,
                                doneSteps: [...done],
                            });
                            continue;
                        }
                        finalName = target;
                    }
                    done.add('move');
                }
                const name = finalName ?? file.proposedName;

                // 2. Apply labels (with throttle to avoid Drive Labels API rate limits)
                for (const labelId of batchLabelIds) {
                    const step: BatchStep = `label:${labelId}`;
                    if (done.has(step)) continue;
                    try {
                        const fv = batchLabelFieldValues[labelId] || {};
                        await namerApi.applyLabel(file.id, labelId, fv as Record<string, LabelFieldValue>);
                        done.add(step);
                        await new Promise(r => setTimeout(r, 500));
                    } catch (labelErr: unknown) {
                        const title = batchLabels.find(l => l.id === labelId)?.properties?.title || labelId;
                        warnings.push(`Label "${title}": ${errMessage(labelErr)}`);
                        logger.error('namer-batch', `Label ${labelId} failed on ${file.name}`, { error: errMessage(labelErr) });
                    }
                }

                // 3. Orientation label
                let orientationValue: 'Horizontal' | 'Vertical' | 'Square' | undefined;
                const meta = file.imageMediaMetadata || file.videoMediaMetadata;
                if (meta?.width && meta?.height) {
                    const ratio = meta.width / meta.height;
                    orientationValue = ratio > 1.05 ? 'Horizontal' : ratio < 0.95 ? 'Vertical' : 'Square';
                }
                if (orientationValue && meta && !done.has('orientation')) {
                    try {
                        await namerApi.setAppProperties(file.id, {
                            orientation: orientationValue,
                            width: String(meta.width),
                            height: String(meta.height),
                        });

                        const contentTagsLabel = batchLabels.find((l) =>
                            l.properties?.title?.toLowerCase() === 'content tags'
                        );
                        if (contentTagsLabel?.fields) {
                            const orientField = contentTagsLabel.fields.find(
                                (f) => f.properties?.displayName?.toLowerCase() === 'orientation'
                                    && f.selectionOptions?.choices && f.selectionOptions.choices.length > 0
                            );
                            if (orientField?.selectionOptions?.choices) {
                                const choice = orientField.selectionOptions.choices.find(
                                    (c) => c.properties?.displayName?.toLowerCase() === orientationValue!.toLowerCase()
                                );
                                if (choice) {
                                    await namerApi.applyLabel(file.id, contentTagsLabel.id, {
                                        [orientField.id]: { value: choice.id, type: 'selection' },
                                    });
                                    await new Promise(r => setTimeout(r, 500));
                                }
                            }
                        }
                        done.add('orientation');
                    } catch (oErr) {
                        warnings.push(`Orientation: ${errMessage(oErr)}`);
                        logger.error('namer-batch', `Orientation failed on ${file.name}`, { error: errMessage(oErr) });
                    }
                }

                // Inter-file delay
                if (i < toRun.length - 1) {
                    await new Promise(r => setTimeout(r, 500));
                }

                // 4. AI Analysis (photos only)
                let aiMetadata: AIMetadata | null = file.aiMetadata ?? null;
                let aiRanNow = false;
                const isPhoto = file.name?.match(/\.(jpg|jpeg|png|webp|gif|tiff|heic|heif)$/i);
                if (isPhoto && batchAiEnabled && batchSettings?.aiSettings && !done.has('ai')) {
                    try {
                        patchFile(batchId, file.id, { status: 'analyzing' });

                        aiMetadata = await namerApi.analyzeImage(file.id, batchSettings.aiSettings);

                        if (aiMetadata) {
                            const toTruncated = (val: unknown, maxLen: number): string => {
                                if (!val) return '';
                                const str = Array.isArray(val) ? val.join(', ') : String(val);
                                return str.substring(0, maxLen);
                            };
                            await namerApi.setAppProperties(file.id, {
                                ai_env: toTruncated(aiMetadata.context_environment, 50),
                                ai_season: toTruncated(aiMetadata.seasonality, 40),
                                ai_mood: toTruncated(aiMetadata.lighting_mood, 40),
                                ai_exp: toTruncated(aiMetadata.human_experience, 50),
                                ai_labels: toTruncated(aiMetadata.label_csv, 60),
                                ai_colors: toTruncated(aiMetadata.color_palette, 30),
                            });
                        }
                        done.add('ai');
                        aiRanNow = true;

                        const delayMs = batchSettings.aiSettings.delayMs || 500;
                        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

                    } catch (aiErr) {
                        warnings.push(`AI analysis: ${errMessage(aiErr)}`);
                        logger.error('namer-batch', `AI analysis failed on ${file.name}`, { error: errMessage(aiErr) });
                    }
                }

                // 5. Build semantic description — redone after a fresh AI
                // result so a retried analysis reaches the description too
                if (!done.has('description') || aiRanNow) {
                    try {
                        const descParts: string[] = [];

                        if (aiMetadata) {
                            const semParts: string[] = [];
                            if (aiMetadata.human_experience) {
                                const exp = Array.isArray(aiMetadata.human_experience)
                                    ? aiMetadata.human_experience.join(', ')
                                    : aiMetadata.human_experience;
                                semParts.push(exp);
                            }
                            const ctxParts = [aiMetadata.context_environment, aiMetadata.seasonality, aiMetadata.lighting_mood].filter(Boolean);
                            if (ctxParts.length) semParts.push(ctxParts.join(', '));
                            if (semParts.length) descParts.push(semParts.join(' | '));
                        }

                        const nameNoExt = name.includes('.') ? name.substring(0, name.lastIndexOf('.')) : name;
                        const nameParts = nameNoExt.split('_').filter(p => !/^\d+$/.test(p)).map(p => p.replace(/-/g, ' '));
                        descParts.push(nameParts.join(', '));

                        if (aiMetadata?.label_csv) descParts.push(`Keywords: ${aiMetadata.label_csv}`);
                        if (labelParts.length > 0) descParts.push(`Labels: ${labelParts.join('; ')}`);

                        await namerApi.setDescription(file.id, descParts.join(' — '));
                        done.add('description');
                    } catch (descErr) {
                        warnings.push(`Description: ${errMessage(descErr)}`);
                        logger.error('namer-batch', `Description failed on ${file.name}`, { error: errMessage(descErr) });
                    }
                }

                // Moved = success; failed later steps ride along as warnings
                succeededIds.push(file.id);
                patchFile(batchId, file.id, {
                    status: 'success',
                    finalName: name,
                    orientation: orientationValue,
                    warnings: warnings.length > 0 ? warnings : undefined,
                    doneSteps: [...done],
                    aiMetadata,
                });

            } catch (err) {
                // Nothing above should throw past its own catch — this guards
                // against a bug leaving a file stuck on "processing"
                logger.error('namer-batch', `Failed to process ${file.name}`, { error: errMessage(err) });
                patchFile(batchId, file.id, {
                    status: done.has('move') ? 'success' : 'error',
                    finalName: finalName ?? null,
                    ...(done.has('move')
                        ? { warnings: [...warnings, `Unexpected error: ${errMessage(err)}`] }
                        : { error: `Unexpected error: ${errMessage(err)}` }),
                    doneSteps: [...done],
                });
                if (done.has('move')) succeededIds.push(file.id);
            }
        }

        // Mark batch complete
        cancelRequestsRef.current.delete(batchId);
        patchBatch(batchId, { status: 'completed', cancelRequested: false });

        // Schedule deferred ingest into DAM. Called directly — it used to run
        // inside a setBatches updater, which must be pure (StrictMode runs
        // updaters twice → duplicate pending-ingest records). On a retry this
        // re-schedules the batch's entry with the retried files.
        if (succeededIds.length > 0) {
            scheduleIngest(batchId, succeededIds, batchDestFolderId);
        }
    }, [selectedLabelIds, labelFieldValues, labels, aiEnabled, settings, scheduleIngest, patchFile, patchBatch]);

    // ==========================================================
    // Queue runner — processes batches one at a time
    // ==========================================================
    useEffect(() => {
        const nextQueued = batches.find(b => b.status === 'queued');
        const anyProcessing = batches.some(b => b.status === 'processing');

        if (nextQueued && !anyProcessing && !processingRef.current) {
            processingRef.current = true;
            setIsProcessing(true);

            processOneBatch(nextQueued).finally(() => {
                processingRef.current = false;
                // isProcessing stays true if there are more queued — the next
                // effect cycle will pick up the next batch. If no more, set false.
                setBatches(prev => {
                    const moreQueued = prev.some(b => b.status === 'queued');
                    if (!moreQueued) setIsProcessing(false);
                    return prev;
                });
            });
        }
    }, [batches, processOneBatch]);

    // ==========================================================
    // Retry failed files / cancel a batch
    // ==========================================================
    const retryFailed = useCallback((batchId: string) => {
        const batch = batches.find(b => b.id === batchId);
        if (!batch || batch.status !== 'completed') return;
        const ids = new Set(batch.files.filter(isRetryable).map(f => f.id));
        if (ids.size === 0) return;
        cancelRequestsRef.current.delete(batchId);
        // Back to 'queued' — the runner picks it up and processes only the
        // re-queued files, skipping each one's doneSteps
        setBatches(prev => prev.map(b => {
            if (b.id !== batchId) return b;
            const files = b.files.map(f => ids.has(f.id)
                // error/warnings are kept until the file actually starts (so a
                // cancel can restore them — see statusOnCancel)
                ? { ...f, status: 'queued' as const }
                : f);
            return { ...b, files, status: 'queued', cancelRequested: false, progress: batchProgress(files) };
        }));
    }, [batches]);

    const cancelBatch = useCallback((batchId: string) => {
        const batch = batches.find(b => b.id === batchId);
        if (!batch || (batch.status !== 'queued' && batch.status !== 'processing')) return;
        cancelRequestsRef.current.add(batchId);
        if (batch.status === 'processing') {
            // The runner stops before its next file
            patchBatch(batchId, { cancelRequested: true });
            return;
        }
        // Not started yet — nothing to wait for
        setBatches(prev => prev.map(b => {
            if (b.id !== batchId) return b;
            const files = b.files.map(f => f.status === 'queued' ? { ...f, status: statusOnCancel(f) } : f);
            return { ...b, files, status: 'completed', progress: batchProgress(files) };
        }));
        // Cancelled files are listed again on the next Load/Reload Files — not
        // reloaded here, which would reset the selection the user is building
    }, [batches, patchBatch]);

    // ==========================================================
    // Revert batch (also retries a partially failed revert)
    // ==========================================================
    const revertBatch = useCallback(async (batchId: string) => {
        const batch = batches.find(b => b.id === batchId);
        if (!batch || (batch.status !== 'completed' && batch.status !== 'revert-failed')) return;
        // Files reported failed whose move actually landed (e.g. the request
        // timed out after Drive applied it) are in the destination under their
        // target name — revert those too, or "Reverted" would leave them there.
        const landed = new Set<string>();
        if (batch.destFolderId) {
            try {
                const destById = new Map((await namerApi.listFiles(batch.destFolderId)).map(f => [f.id, f.name]));
                for (const f of batch.files) {
                    if (!isMoved(f) && f.targetName && f.revert !== 'done' && destById.get(f.id) === f.targetName) landed.add(f.id);
                }
            } catch (err) {
                logger.warn('namer-batch', 'Could not list destination before revert', { error: errMessage(err) });
            }
        }
        const targets = [...revertTargets(batch), ...batch.files.filter(f => landed.has(f.id))];
        if (targets.length === 0) return;

        // One click moves and renames every file in the batch — confirm first
        // (a retry of the failed remainder was already confirmed).
        const count = targets.length;
        if (batch.status === 'completed'
            && !window.confirm(`Revert ${count} file${count === 1 ? '' : 's'}? They'll be renamed with a "revert_" prefix and moved back to the source folder.`)) {
            return;
        }

        // Cancel any pending deferred ingest for this batch
        cancelIngest(batchId);

        patchBatch(batchId, { status: 'reverting' });

        let failed = 0;
        for (const file of targets) {
            try {
                // Rename with revert_ prefix + original name, move back to source
                const revertName = `revert_${file.name}`;
                await namerApi.updateFile(file.id, revertName, batch.sourceFolderId, batch.destFolderId || undefined);
                patchFile(batchId, file.id, { revert: 'done', revertError: undefined });
            } catch (err) {
                failed++;
                logger.error('namer-batch', `Failed to revert ${file.name}`, { error: errMessage(err) });
                patchFile(batchId, file.id, { revert: 'failed', revertError: errMessage(err) });
            }
        }

        // "Reverted" only when every moved file made it back; otherwise the
        // failures stay visible with a Retry revert action
        patchBatch(batchId, { status: failed === 0 ? 'reverted' : 'revert-failed' });

        // Reverted files reappear in the source list (hiddenSourceFileIds)
        if (batch.sourceFolderId) {
            setTimeout(() => loadFiles(), 1500); // Small delay for Drive propagation
        }
    }, [batches, cancelIngest, loadFiles, patchBatch, patchFile]);

    // ==========================================================
    // Render
    // ==========================================================
    const pendingCount = files.filter(f => f.status === 'pending').length;
    const schemaNames = settings?.schemas ? Object.keys(settings.schemas) : [];

    // ─── Validation warnings ───────────────────────────────────
    const validationWarnings: string[] = [];
    if (!selectedSchema) validationWarnings.push('No asset type selected — choose a naming template above');
    if (files.length > 0 && !destFolderId) validationWarnings.push('No destination folder set');
    // Passthrough skips naming-field validation entirely
    const missingRequired = isPassthrough ? [] : schemaFields
        .filter(f => f.required && !f.value)
        .map(f => f.label);
    if (missingRequired.length > 0) validationWarnings.push(`Required naming fields empty: ${missingRequired.join(', ')}`);
    const canExecute = pendingCount > 0 && !!destFolderId && !!selectedSchema && missingRequired.length === 0 && !enqueueing;

    if (settingsLoading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="w-6 h-6 rounded-full border-2 animate-spin"
                    style={{ borderColor: 'var(--ram-border)', borderTopColor: 'var(--ram-accent)' }} />
            </div>
        );
    }

    return (
        <div className="flex flex-col min-h-full">
            {/* ──────────────────────────────────────────── */}
            {/* Collapsible Setup Section                     */}
            {/* ──────────────────────────────────────────── */}

            {/* ──────────────────────────────────────────── */}
            {/* Setup header bar (always visible)             */}
            {/* ──────────────────────────────────────────── */}
            <div
                className="flex-shrink-0 namer-setup-header"
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '10px 16px',
                    borderBottom: '2px solid var(--ram-border)',
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(0,0,0,0.15) 100%)',
                    minHeight: '48px',
                }}
            >
                {/* Toggle button — large and obvious */}
                <button
                    onClick={() => setSetupCollapsed(!setupCollapsed)}
                    className="namer-setup-toggle"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '5px 14px',
                        borderRadius: '6px',
                        border: '1px solid var(--ram-border)',
                        background: setupCollapsed ? 'var(--ram-accent-muted)' : 'var(--ram-bg-tertiary)',
                        color: setupCollapsed ? 'var(--ram-accent)' : 'var(--ram-text-secondary)',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        flexShrink: 0,
                    }}
                >
                    <svg
                        width="12" height="12" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="2.5"
                        style={{
                            transition: 'transform 0.2s ease',
                            transform: setupCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                        }}
                    >
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                    {setupCollapsed ? 'Show Setup' : 'Hide Setup'}
                </button>

                {/* Section title */}
                <h2 style={{
                    fontSize: '15px',
                    fontWeight: 700,
                    color: 'var(--ram-text-primary)',
                    margin: 0,
                    letterSpacing: '-0.01em',
                }}>
                    Setup
                </h2>

                {/* Context pills (shown when collapsed to retain context) */}
                {setupCollapsed && (
                    <>
                        {/* Asset type pill */}
                        {selectedSchema ? (
                            <span style={{
                                fontSize: '11px',
                                fontWeight: 600,
                                padding: '3px 10px',
                                borderRadius: '12px',
                                background: 'var(--ram-accent-muted)',
                                color: 'var(--ram-accent)',
                                whiteSpace: 'nowrap',
                            }}>
                                {isPassthrough ? 'Passthrough' : selectedSchema}
                            </span>
                        ) : (
                            <span style={{ fontSize: '11px', color: 'var(--ram-text-tertiary)', fontStyle: 'italic' }}>
                                No template
                            </span>
                        )}

                        {/* Folder context */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--ram-text-tertiary)', minWidth: 0 }}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                            </svg>
                            <span className="truncate" style={{ maxWidth: '120px' }}>
                                {sourceFolderName || '—'}
                            </span>
                            <span style={{ flexShrink: 0 }}>→</span>
                            <span className="truncate" style={{ maxWidth: '120px' }}>
                                {destFolderName || '—'}
                            </span>
                        </div>

                        {/* AI badge */}
                        <span style={{
                            fontSize: '10px',
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: '10px',
                            background: aiEnabled ? 'rgba(45, 212, 191, 0.1)' : 'var(--ram-bg-tertiary)',
                            color: aiEnabled ? 'var(--ram-teal)' : 'var(--ram-text-tertiary)',
                            border: `1px solid ${aiEnabled ? 'rgba(45, 212, 191, 0.3)' : 'var(--ram-border)'}`,
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                        }}>
                            AI {aiEnabled ? 'On' : 'Off'}
                        </span>

                        {/* Label count */}
                        {selectedLabelIds.length > 0 && (
                            <span style={{
                                fontSize: '10px',
                                fontWeight: 600,
                                padding: '2px 8px',
                                borderRadius: '10px',
                                background: 'rgba(168, 85, 247, 0.1)',
                                color: '#a855f7',
                                border: '1px solid rgba(168, 85, 247, 0.3)',
                                whiteSpace: 'nowrap',
                                flexShrink: 0,
                            }}>
                                {selectedLabelIds.length} label{selectedLabelIds.length !== 1 ? 's' : ''}
                            </span>
                        )}
                    </>
                )}


                <div style={{ flex: 1 }} />

                {/* Settings (always accessible) */}
                <button
                    onClick={() => setSettingsOpen(true)}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '5px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--ram-border)',
                        background: 'var(--ram-bg-tertiary)',
                        color: 'var(--ram-text-secondary)',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        flexShrink: 0,
                        transition: 'background 0.15s',
                    }}
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    Settings
                </button>
            </div>

            {/* ──────────────────────────────────────────── */}
            {/* Expanded setup sections (below Setup bar)    */}
            {/* ──────────────────────────────────────────── */}
            {!setupCollapsed && (
                <>
                    {/* ── Source & Destination ──────────────────── */}
                    <div className="flex-shrink-0" style={{ borderBottom: '1px solid var(--ram-border)' }}>
                        <div className="px-6 pt-3 pb-2">
                            <h3 style={{
                                fontSize: '12px',
                                fontWeight: 600,
                                color: 'var(--ram-text-tertiary)',
                                margin: 0,
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                            }}>
                                Source &amp; Destination
                            </h3>
                        </div>

                        {/* Folder pickers: Source, Destination, Load Files */}
                        <div className="px-6 pb-3">
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '12px', alignItems: 'end', marginBottom: '10px' }}>
                                <FolderPicker
                                    label="Source Folder"
                                    folderId={sourceFolderId}
                                    folderName={sourceFolderName}
                                    onSelect={(id: string, name: string) => {
                                        if (id !== sourceFolderId) {
                                            // The listed files must always belong to the source
                                            // folder: batches move files out of sourceFolderId, so
                                            // a stale list would target the wrong parent.
                                            loadSeqRef.current++;
                                            setFiles([]);
                                            setFilesError(null);
                                            setFilesLoading(false);
                                        }
                                        setSourceFolderId(id);
                                        setSourceFolderName(name);
                                    }}
                                />
                                <FolderPicker
                                    label="Destination Folder"
                                    folderId={destFolderId}
                                    folderName={destFolderName}
                                    onSelect={(id: string, name: string) => {
                                        // Numbering continues within a destination; a new one
                                        // starts over (the confirm-time check still skips taken names)
                                        if (id !== destFolderId) setCounter(1);
                                        setDestFolderId(id);
                                        setDestFolderName(name);
                                    }}
                                />
                                <button
                                    onClick={loadFiles}
                                    disabled={!sourceFolderId || filesLoading}
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: '8px',
                                        padding: '9px 32px',
                                        borderRadius: '8px',
                                        border: sourceFolderId && !filesLoading
                                            ? '1.5px solid rgba(255, 255, 255, 0.6)'
                                            : '1.5px solid var(--ram-border)',
                                        background: sourceFolderId && !filesLoading
                                            ? 'rgba(45, 212, 191, 0.12)'
                                            : 'var(--ram-bg-tertiary)',
                                        color: sourceFolderId && !filesLoading
                                            ? '#fff'
                                            : 'var(--ram-text-tertiary)',
                                        fontSize: '13px',
                                        fontWeight: 700,
                                        cursor: sourceFolderId && !filesLoading ? 'pointer' : 'not-allowed',
                                        opacity: sourceFolderId ? 1 : 0.5,
                                        flexShrink: 0,
                                        transition: 'all 0.15s',
                                        boxShadow: sourceFolderId && !filesLoading
                                            ? '0 2px 12px rgba(255, 255, 255, 0.15), 0 0 0 1px rgba(255, 255, 255, 0.1)'
                                            : 'none',
                                        whiteSpace: 'nowrap',
                                        letterSpacing: '0.02em',
                                        marginBottom: '1px',
                                    }}
                                >
                                    {filesLoading ? (
                                        <>
                                            <div className="w-3 h-3 rounded-full border-2 animate-spin"
                                                style={{ borderColor: 'transparent', borderTopColor: 'currentColor' }} />
                                            Loading…
                                        </>
                                    ) : (
                                        <>
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                                <polyline points="17 8 12 3 7 8" />
                                                <line x1="12" y1="3" x2="12" y2="15" />
                                            </svg>
                                            Load Files
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* ── Naming Template ───────────────────────── */}
                    <div className="flex-shrink-0" style={{
                        borderBottom: '2px solid var(--ram-border)',
                        background: 'rgba(0,0,0,0.15)',
                    }}>
                        {/* Sub-header */}
                        <div className="px-6 pt-3 pb-2" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <h3 style={{
                                fontSize: '12px',
                                fontWeight: 600,
                                color: 'var(--ram-text-tertiary)',
                                margin: 0,
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                                marginRight: 'auto',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                            }}>
                                Naming Template
                                <span
                                    className="namer-info-tip"
                                    style={{
                                        position: 'relative',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        width: '14px',
                                        height: '14px',
                                        borderRadius: '50%',
                                        border: '1px solid var(--ram-border)',
                                        fontSize: '9px',
                                        fontWeight: 700,
                                        color: 'var(--ram-text-tertiary)',
                                        cursor: 'pointer',
                                        flexShrink: 0,
                                        transition: 'border-color 0.15s, color 0.15s',
                                    }}
                                >
                                    ?
                                    <style>{`
                                        .namer-info-tip::after {
                                            content: 'Configure template fields and schemas in Settings';
                                            position: absolute;
                                            left: calc(100% + 8px);
                                            top: 50%;
                                            transform: translateY(-50%);
                                            white-space: nowrap;
                                            padding: 5px 10px;
                                            border-radius: 6px;
                                            background: var(--ram-bg-tertiary);
                                            border: 1px solid var(--ram-border);
                                            color: var(--ram-text-secondary);
                                            font-size: 11px;
                                            font-weight: 500;
                                            pointer-events: none;
                                            opacity: 0;
                                            transition: opacity 0.1s;
                                            z-index: 10;
                                        }
                                        .namer-info-tip:hover::after {
                                            opacity: 1;
                                        }
                                        .namer-info-tip:hover {
                                            border-color: var(--ram-text-secondary);
                                            color: var(--ram-text-secondary);
                                        }
                                    `}</style>
                                </span>
                            </h3>
                        </div>

                        {/* Asset Type + AI toggle */}
                        <div className="px-6 pb-4" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <SchemaSelector
                                schemas={schemaNames}
                                selected={selectedSchema}
                                onSelect={setSelectedSchema}
                            />

                            <button
                                onClick={() => setAiEnabled(!aiEnabled)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    padding: '5px 14px',
                                    borderRadius: '20px',
                                    border: `1px solid ${aiEnabled ? 'var(--ram-teal)' : 'var(--ram-border)'}`,
                                    background: aiEnabled ? 'rgba(45, 212, 191, 0.1)' : 'var(--ram-bg-secondary)',
                                    color: aiEnabled ? 'var(--ram-teal)' : 'var(--ram-text-secondary)',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    transition: 'all 0.15s',
                                }}
                            >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                                    <path d="M2 17l10 5 10-5" />
                                    <path d="M2 12l10 5 10-5" />
                                </svg>
                                AI {aiEnabled ? 'On' : 'Off'}
                            </button>
                        </div>

                        {/* Passthrough indicator + preview */}
                        {isPassthrough && (
                            <div className="px-6 pb-4" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '10px',
                                    padding: '10px 14px',
                                    borderRadius: '8px',
                                    background: 'rgba(45, 212, 191, 0.06)',
                                    border: '1px solid rgba(45, 212, 191, 0.2)',
                                }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ram-teal)" strokeWidth="2">
                                        <path d="M5 12h14" />
                                        <path d="M12 5l7 7-7 7" />
                                    </svg>
                                    <div>
                                        <p style={{
                                            fontSize: '13px',
                                            fontWeight: 600,
                                            color: 'var(--ram-teal)',
                                            margin: 0,
                                        }}>
                                            Keep Original Names
                                        </p>
                                        <p style={{
                                            fontSize: '11px',
                                            color: 'var(--ram-text-tertiary)',
                                            margin: '2px 0 0',
                                        }}>
                                            Files will be moved and enriched with metadata without renaming
                                        </p>
                                    </div>
                                </div>

                                {/* Preview bar — matches NamingBuilder style (amber) */}
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    padding: '10px 14px',
                                    borderRadius: '8px',
                                    background: 'rgba(255,255,255,0.03)',
                                    border: '1px solid rgba(232, 160, 72, 0.25)',
                                }}>
                                    <span style={{
                                        fontSize: '11px',
                                        fontWeight: 700,
                                        color: 'var(--ram-text-secondary)',
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.5px',
                                        flexShrink: 0,
                                    }}>
                                        Preview:
                                    </span>
                                    <span style={{
                                        fontFamily: 'monospace',
                                        fontSize: '13px',
                                        color: 'var(--ram-accent)',
                                        fontWeight: 600,
                                    }}>
                                        original_filename.ext
                                    </span>
                                    <span style={{
                                        fontSize: '12px',
                                        color: 'var(--ram-text-tertiary)',
                                    }}>
                                        →
                                    </span>
                                    <span style={{
                                        fontFamily: 'monospace',
                                        fontSize: '13px',
                                        color: 'var(--ram-accent)',
                                        fontWeight: 600,
                                        fontStyle: 'italic',
                                    }}>
                                        original_filename.ext
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Template fields (shown when non-passthrough asset type selected) */}
                        {selectedSchema && !isPassthrough && schemaFields.length > 0 && settings && (
                            <div className="px-6 pb-4">
                                <NamingBuilder
                                    fields={schemaFields}
                                    onChange={setSchemaFields}
                                    dropdowns={settings.dropdowns}
                                    counter={counter}
                                    onCounterChange={setCounter}
                                />
                            </div>
                        )}

                        {/* Prompt when no asset type selected */}
                        {!selectedSchema && (
                            <div className="px-6 pb-4">
                                <p style={{
                                    fontSize: '12px',
                                    color: 'var(--ram-text-tertiary)',
                                    margin: 0,
                                    fontStyle: 'italic',
                                }}>
                                    Select an asset type to configure template fields.
                                </p>
                            </div>
                        )}
                    </div>

                    {/* ── Labels ────────────────────────────────── */}
                    <div className="flex-shrink-0 px-6 py-3 flex items-center gap-3" style={{
                        borderBottom: '2px solid var(--ram-border)',
                        background: 'rgba(255,255,255,0.015)',
                    }}>
                        <LabelSelector
                            labels={labels}
                            selectedLabelIds={selectedLabelIds}
                            onSelectedChange={setSelectedLabelIds}
                            fieldValues={labelFieldValues}
                            onFieldValuesChange={setLabelFieldValues}
                        />
                    </div>
                </>
            )}

            {/* ──────────────────────────────────────────── */}
            {/* File preview area                            */}
            {/* ──────────────────────────────────────────── */}
            <div>
                {filesLoading ? (
                    <div className="flex items-center justify-center py-20">
                        <div className="w-6 h-6 rounded-full border-2 animate-spin"
                            style={{ borderColor: 'var(--ram-border)', borderTopColor: 'var(--ram-accent)' }} />
                    </div>
                ) : files.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ram-text-tertiary)" strokeWidth="1">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                        <p className="text-sm" style={{ color: 'var(--ram-text-tertiary)' }}>
                            {filesError
                                ? `Couldn't load files: ${filesError}`
                                : !sourceFolderId
                                    ? 'Select a source folder and click Load Files'
                                    : loadedFolderId === sourceFolderId
                                        ? 'No media files found in this folder'
                                        : 'Click Load Files to list this folder'}
                        </p>
                    </div>
                ) : (
                    <>
                        {/* Validation warnings banner */}
                        {validationWarnings.length > 0 && (
                            <div className="px-6 pb-2">
                                <div style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '4px',
                                    padding: '8px 12px',
                                    borderRadius: '6px',
                                    background: 'rgba(251, 191, 36, 0.08)',
                                    border: '1px solid rgba(251, 191, 36, 0.25)',
                                }}>
                                    {validationWarnings.map((w, i) => (
                                        <div key={i} style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                            fontSize: '12px',
                                            color: '#fbbf24',
                                        }}>
                                            <span>⚠️</span>
                                            <span>{w}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        <FilePreviewTable
                            key={loadCount} // remount per load — resets filter/search state
                            files={namedFiles}
                            onToggleExclude={toggleExclude}
                            onSelectAll={selectAll}
                            onDeselectAll={deselectAll}
                            onReloadFiles={loadFiles}
                            onExecute={() => setShowConfirmModal(true)}
                            canExecute={canExecute}
                            isProcessing={isProcessing}
                            onSelectFiltered={selectFiltered}
                            onDeselectFiltered={deselectFiltered}
                            onSetRange={setRangeStatus}
                            viewMode={previewView}
                            onViewModeChange={changePreviewView}
                            tileSize={tileSize}
                            onTileSizeChange={changeTileSize}
                        />

                    </>
                )}
            </div>

            {/* ──────────────────────────────────────────── */}
            {/* Processing Queue (inline collapsible bottom)  */}
            {/* ──────────────────────────────────────────── */}
            {batches.length > 0 && (
                <div style={{
                    borderTop: '2px solid var(--ram-border)',
                    display: 'flex',
                    flexDirection: 'column',
                }}>
                    {/* Queue header bar (always visible when batches exist) */}
                    <div
                        className="namer-queue-toggle"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            width: '100%',
                            padding: '10px 16px',
                            background: isProcessing
                                ? 'linear-gradient(90deg, rgba(45, 212, 191, 0.08) 0%, rgba(45, 212, 191, 0.03) 100%)'
                                : 'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(0,0,0,0.15) 100%)',
                            flexShrink: 0,
                            transition: 'background 0.15s',
                        }}
                    >
                        {/* Activity indicator */}
                        {isProcessing ? (
                            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
                                style={{ borderColor: 'transparent', borderTopColor: 'var(--ram-teal)' }} />
                        ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ram-green, #34d399)" strokeWidth="2.5" className="flex-shrink-0">
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                        )}

                        {/* Section title */}
                        <span style={{
                            fontSize: '14px',
                            fontWeight: 700,
                            color: isProcessing ? 'var(--ram-teal)' : 'var(--ram-text-primary)',
                        }}>
                            Processing Queue
                        </span>

                        {/* Batch count badge */}
                        <span style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: '10px',
                            background: isProcessing ? 'rgba(45, 212, 191, 0.15)' : 'var(--ram-accent-muted)',
                            color: isProcessing ? 'var(--ram-teal)' : 'var(--ram-accent)',
                        }}>
                            {batches.length} batch{batches.length !== 1 ? 'es' : ''}
                        </span>

                        {isProcessing && (
                            <span style={{
                                fontSize: '11px',
                                fontWeight: 600,
                                color: 'var(--ram-teal)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '5px',
                            }}>
                                <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--ram-teal)' }} />
                                Active
                            </span>
                        )}

                        <div style={{ flex: 1 }} />

                        {/* Sync All to Library — right side of header, when 2+ pending ingests */}
                        {(pendingIngests?.filter(p => p.status === 'pending').length ?? 0) >= 2 && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    pendingIngests?.filter(p => p.status === 'pending').forEach(p => triggerNow(p.batchId));
                                }}
                                style={{
                                    fontSize: '11px',
                                    padding: '4px 10px',
                                    borderRadius: '6px',
                                    background: 'rgba(45, 212, 191, 0.12)',
                                    color: 'var(--ram-teal)',
                                    border: '1px solid rgba(45, 212, 191, 0.3)',
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '5px',
                                    flexShrink: 0,
                                    transition: 'color 0.15s, border-color 0.15s',
                                }}
                            >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="16 16 12 12 8 16" />
                                    <line x1="12" y1="12" x2="12" y2="21" />
                                    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
                                </svg>
                                Sync All to Library
                            </button>
                        )}

                        {/* Clear Completed — right side of header */}
                        {batches.some(isClearable) && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setBatches(prev => prev.filter(b => !isClearable(b)));
                                }}
                                style={{
                                    fontSize: '11px',
                                    padding: '4px 10px',
                                    borderRadius: '6px',
                                    background: 'var(--ram-bg-tertiary)',
                                    color: 'var(--ram-text-tertiary)',
                                    border: '1px solid var(--ram-border)',
                                    cursor: 'pointer',
                                    fontWeight: 500,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '5px',
                                    flexShrink: 0,
                                    transition: 'color 0.15s, border-color 0.15s',
                                }}
                            >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                                Clear Completed
                            </button>
                        )}
                    </div>

                    {/* Queue content — always visible, scrollable */}
                    <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid var(--ram-border)' }}>
                        <NamerQueue
                            batches={batches}
                            onClearCompleted={() => setBatches(prev => prev.filter(b => !isClearable(b)))}
                            onRevertBatch={revertBatch}
                            onRetryFailed={retryFailed}
                            onCancelBatch={cancelBatch}
                            pendingIngests={pendingIngests}
                            onCancelIngest={cancelIngest}
                            onTriggerIngestNow={triggerNow}
                            onRetryIngest={retryIngest}
                        />
                    </div>
                </div>
            )}

            {/* Settings panel */}
            {settingsOpen && settings && (
                <NamerSettingsPanel
                    settings={settings}
                    onSave={async (updated: Partial<NamerSettings>) => {
                        await namerApi.updateSettings(updated);
                        setSettings(prev => prev ? { ...prev, ...updated } : prev);
                    }}
                    onClose={() => setSettingsOpen(false)}
                />
            )}

            {/* Batch confirmation modal */}
            {showConfirmModal && (
                <BatchConfirmModal
                    pendingCount={pendingCount}
                    aiEnabled={aiEnabled}
                    selectedSchema={selectedSchema}
                    schemaFields={schemaFields}
                    labels={labels}
                    selectedLabelIds={selectedLabelIds}
                    labelFieldValues={labelFieldValues}
                    destFolderName={destFolderName}
                    counterStart={counter}
                    onConfirm={() => {
                        setShowConfirmModal(false);
                        void enqueueBatch();
                    }}
                    onCancel={() => setShowConfirmModal(false)}
                />
            )}
        </div>
    );
}
