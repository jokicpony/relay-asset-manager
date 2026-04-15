'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import * as namerApi from '@/lib/namer/namer-api';
import { logger } from '@/lib/logger';
import type {
    NamerFile,
    NamerFilePreview,
    NamerSettings,
    NamingSchema,
    SchemaField,
    DriveLabel,
    BatchConfig,
    AIMetadata,
} from '@/lib/namer/types';
import { PASSTHROUGH_SCHEMA_KEY } from '@/lib/namer/types';
import SchemaSelector from './SchemaSelector';
import FolderPicker from './FolderPicker';
import NamingBuilder from './NamingBuilder';
import LabelSelector from './LabelSelector';
import FilePreviewTable from './FilePreviewTable';
import NamerQueue from './NamerQueue';
import type { BatchInfo } from './NamerQueue';
import NamerSettingsPanel from './NamerSettings';
import BatchConfirmModal from './BatchConfirmModal';
import { useDeferredIngest } from '@/hooks/useDeferredIngest';

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
    const [batches, setBatches] = useState<BatchInfo[]>([]);;
    const [isProcessing, setIsProcessing] = useState(false);
    const processingRef = useRef(false);
    const batchFileIdsRef = useRef<Set<string>>(new Set());

    // Keep batchFileIdsRef in sync so loadFiles can filter without re-creating
    useEffect(() => {
        const ids = new Set<string>();
        for (const b of batches) {
            for (const f of b.files) ids.add(f.id);
        }
        batchFileIdsRef.current = ids;
    }, [batches]);

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
        if (schema) {
            const today = new Date();
            const yyyymmdd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
            setSchemaFields(schema.fields.map(f => ({
                ...f,
                // Date fields: auto-populate with today and ensure editable
                value: f.type === 'date' && !f.value ? yyyymmdd : f.value,
                frozen: f.type === 'date' ? false : f.frozen,
            })));
            setAiEnabled(schema.aiEnabled ?? true);
        }
    }, [selectedSchema, settings]);

    // ==========================================================
    // Load files from source folder
    // ==========================================================
    const loadFiles = useCallback(async () => {
        if (!sourceFolderId) return;
        setFilesLoading(true);
        try {
            const raw = await namerApi.listFiles(sourceFolderId);
            // Filter out files already tracked in any batch (processing, completed, etc.)
            const knownIds = batchFileIdsRef.current;
            const fresh = raw.filter(f => !knownIds.has(f.id));
            const previews: NamerFilePreview[] = fresh.map(f => ({
                ...f,
                originalName: f.name,
                proposedName: f.name, // Will be updated by naming builder
                status: 'pending',
            }));
            setFiles(previews);
            setLoadCount(c => c + 1);
            setCounter(1); // Reset counter for new folder
        } catch (err) {
            logger.error('namer', 'Failed to load files', { error: err instanceof Error ? err.message : String(err) });
        } finally {
            setFilesLoading(false);
        }
    }, [sourceFolderId]);

    // Files load on explicit "Load Files" button click — no auto-load

    // ==========================================================
    // Generate proposed names based on schema fields
    // ==========================================================
    const buildName = useCallback((file: NamerFilePreview, index: number): string => {
        // Passthrough — keep original filename unchanged
        if (isPassthrough) return file.originalName;
        if (schemaFields.length === 0) return file.originalName;

        const parts: string[] = [];
        for (const field of schemaFields) {
            if (field.type === 'counter') {
                const num = counter + index;
                parts.push(String(num).padStart(3, '0'));
            } else if (field.value) {
                parts.push(field.value.replace(/\s+/g, '-'));
            }
        }

        if (parts.length === 0) return file.originalName;

        // Preserve original extension
        const ext = file.originalName.includes('.')
            ? file.originalName.substring(file.originalName.lastIndexOf('.'))
            : '';

        return parts.join('_') + ext;
    }, [schemaFields, counter, isPassthrough]);

    // Update proposed names when fields change
    useEffect(() => {
        if (files.length === 0) return;
        setFiles(prev => {
            const pendingFiles = prev.filter(f => f.status === 'pending' || f.status === 'excluded');
            let idx = 0;
            return prev.map(f => {
                if (f.status === 'pending') {
                    const proposedName = buildName(f, idx);
                    idx++;
                    return { ...f, proposedName };
                }
                if (f.status === 'excluded') {
                    return f; // Don't count excluded files in the index
                }
                return f;
            });
        });
    }, [buildName, files.length]);

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

    // ==========================================================
    // Enqueue batch — creates batch and returns immediately
    // ==========================================================
    const enqueueBatch = useCallback(() => {
        const pendingFiles = files.filter(f => f.status === 'pending');
        if (pendingFiles.length === 0 || !destFolderId) return;

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

        const batch: BatchInfo = {
            id: batchId,
            files: pendingFiles.map(f => ({
                id: f.id,
                name: f.name,
                proposedName: f.proposedName,
                status: 'queued',
                finalName: null as string | null,
                imageMediaMetadata: f.imageMediaMetadata,
                videoMediaMetadata: f.videoMediaMetadata,
            })),
            progress: { completed: 0, total: pendingFiles.length, errors: 0 },
            status: 'queued' as const,
            timestamp: Date.now(),
            labelsSummary: labelParts.length > 0 ? `Content Tags (${labelParts.join(' | ')})` : undefined,
            sourceFolderId: sourceFolderId,
            destFolderId: destFolderId,
            // Snapshot the current settings so they're preserved even if the user
            // changes labels/AI/schema between queueing and processing
            _snapshot: {
                selectedLabelIds: [...selectedLabelIds],
                labelFieldValues: JSON.parse(JSON.stringify(labelFieldValues)),
                aiEnabled,
                labels: labels,
                settings,
            },
        };

        setBatches(prev => [...prev, batch]);

        // Eagerly add file IDs so loadFiles filters them out, then reload
        for (const f of batch.files) batchFileIdsRef.current.add(f.id);
        if (sourceFolderId) loadFiles();
    }, [files, destFolderId, sourceFolderId, selectedLabelIds, labelFieldValues, labels, aiEnabled, settings, loadFiles]);

    // ==========================================================
    // Process one batch — runs the file-by-file processing loop
    // ==========================================================
    const processOneBatch = useCallback(async (batch: BatchInfo) => {
        const batchId = batch.id;
        const batchDestFolderId = batch.destFolderId;
        const batchSourceFolderId = batch.sourceFolderId;

        // Pull settings from snapshot (or fallback to current)
        const snap = (batch as any)._snapshot || {};
        const batchLabelIds: string[] = snap.selectedLabelIds || selectedLabelIds;
        const batchLabelFieldValues = snap.labelFieldValues || labelFieldValues;
        const batchAiEnabled: boolean = snap.aiEnabled ?? aiEnabled;
        const batchLabels: typeof labels = snap.labels || labels;
        const batchSettings = snap.settings || settings;

        // Build labelParts from snapshot for semantic description
        const labelParts: string[] = [];
        for (const labelId of batchLabelIds) {
            const label = batchLabels.find((l: any) => l.id === labelId);
            const fv = batchLabelFieldValues[labelId] || {};
            const fieldItems = Object.entries(fv)
                .filter(([, v]: any) => Array.isArray(v.value) ? v.value.length > 0 : !!v.value)
                .map(([fId, v]: any) => {
                    const field = label?.fields?.find((f: any) => f.id === fId);
                    const name = field?.properties?.displayName || fId;
                    const rawValues = Array.isArray(v.value) ? v.value : [v.value];
                    let val: string;
                    if (field?.selectionOptions?.choices) {
                        val = rawValues.map((id: string) => {
                            const choice = field.selectionOptions!.choices.find((c: any) => c.id === id);
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
        setBatches(prev => prev.map(b => b.id === batchId ? { ...b, status: 'processing' } : b));

        // Fetch existing names in destination for duplicate checking
        let existingNames: Set<string>;
        try {
            existingNames = await namerApi.listFileNames(batchDestFolderId);
        } catch {
            existingNames = new Set();
        }

        for (let i = 0; i < batch.files.length; i++) {
            const file = batch.files[i];

            // Update batch: mark file as processing
            setBatches(prev => prev.map(b => {
                if (b.id !== batchId) return b;
                return {
                    ...b,
                    files: b.files.map(f => f.id === file.id ? { ...f, status: 'processing' } : f),
                };
            }));

            try {
                // Duplicate check
                let finalName = file.proposedName;
                if (existingNames.has(finalName)) {
                    let version = 2;
                    const dotIdx = finalName.lastIndexOf('.');
                    const baseName = dotIdx !== -1 ? finalName.substring(0, dotIdx) : finalName;
                    const extension = dotIdx !== -1 ? finalName.substring(dotIdx) : '';
                    while (existingNames.has(`${baseName}_v${version}${extension}`)) version++;
                    finalName = `${baseName}_v${version}${extension}`;
                }
                existingNames.add(finalName);

                // 1. Rename + Move
                await namerApi.updateFile(file.id, finalName, batchDestFolderId, batchSourceFolderId || undefined);

                // 2. Apply labels (with throttle to avoid Drive Labels API rate limits)
                for (const labelId of batchLabelIds) {
                    try {
                        const fv = batchLabelFieldValues[labelId] || {};
                        const fieldCount = Object.keys(fv).length;
                        const fieldSummary = Object.entries(fv).map(([fId, v]) =>
                            `${fId}=${JSON.stringify(v)}`
                        ).join(', ');
                        const result = await namerApi.applyLabel(file.id, labelId, fv as Record<string, import('@/lib/namer/types').LabelFieldValue>);
                        await new Promise(r => setTimeout(r, 500));
                    } catch (labelErr: unknown) {
                        const errMsg = labelErr instanceof Error ? labelErr.message : String(labelErr);
                        logger.error('namer-batch', `Label ${labelId} failed on ${file.name}`, { error: errMsg });
                    }
                }

                // 3. Orientation label
                let orientationValue: 'Horizontal' | 'Vertical' | 'Square' | undefined;
                const meta = file.imageMediaMetadata || file.videoMediaMetadata;
                if (meta?.width && meta?.height) {
                    try {
                        const ratio = meta.width / meta.height;
                        orientationValue = ratio > 1.05 ? 'Horizontal' : ratio < 0.95 ? 'Vertical' : 'Square';
                        await namerApi.setAppProperties(file.id, {
                            orientation: orientationValue,
                            width: String(meta.width),
                            height: String(meta.height),
                        });

                        const contentTagsLabel = batchLabels.find((l: any) =>
                            l.properties?.title?.toLowerCase() === 'content tags'
                        );
                        if (contentTagsLabel?.fields) {
                            const orientField = contentTagsLabel.fields.find(
                                (f: any) => f.properties?.displayName?.toLowerCase() === 'orientation'
                                    && f.selectionOptions?.choices && f.selectionOptions.choices.length > 0
                            );
                            if (orientField?.selectionOptions?.choices) {
                                const choice = orientField.selectionOptions.choices.find(
                                    (c: any) => c.properties?.displayName?.toLowerCase() === orientationValue!.toLowerCase()
                                );
                                if (choice) {
                                    await namerApi.applyLabel(file.id, contentTagsLabel.id, {
                                        [orientField.id]: { value: choice.id, type: 'selection' },
                                    });
                                    await new Promise(r => setTimeout(r, 500));
                                }
                            }
                        }
                    } catch (oErr) {
                        logger.error('namer-batch', `Orientation failed on ${file.name}`, { error: oErr instanceof Error ? oErr.message : String(oErr) });
                    }
                }

                // Inter-file delay
                if (i < batch.files.length - 1) {
                    await new Promise(r => setTimeout(r, 500));
                }

                // 4. AI Analysis (photos only)
                let aiMetadata: AIMetadata | null = null;
                const isPhoto = file.name?.match(/\.(jpg|jpeg|png|webp|gif|tiff|heic|heif)$/i);
                if (isPhoto && batchAiEnabled && batchSettings?.aiSettings) {
                    try {
                        setBatches(prev => prev.map(b => {
                            if (b.id !== batchId) return b;
                            return {
                                ...b,
                                files: b.files.map(f => f.id === file.id ? { ...f, status: 'analyzing' } : f),
                            };
                        }));

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

                        const delayMs = batchSettings.aiSettings.delayMs || 500;
                        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

                    } catch (aiErr) {
                        logger.error('namer-batch', `AI analysis failed on ${file.name}`, { error: aiErr instanceof Error ? aiErr.message : String(aiErr) });
                    }
                }

                // 5. Build semantic description
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

                    const nameNoExt = finalName.includes('.') ? finalName.substring(0, finalName.lastIndexOf('.')) : finalName;
                    const nameParts = nameNoExt.split('_').filter(p => !/^\d+$/.test(p)).map(p => p.replace(/-/g, ' '));
                    descParts.push(nameParts.join(', '));

                    if (aiMetadata?.label_csv) descParts.push(`Keywords: ${aiMetadata.label_csv}`);
                    if (labelParts.length > 0) descParts.push(`Labels: ${labelParts.join('; ')}`);

                    await namerApi.setDescription(file.id, descParts.join(' — '));
                } catch (descErr) {
                    logger.error('namer-batch', `Description failed on ${file.name}`, { error: descErr instanceof Error ? descErr.message : String(descErr) });
                }

                // Mark success
                setBatches(prev => prev.map(b => {
                    if (b.id !== batchId) return b;
                    const updatedFiles = b.files.map(f => f.id === file.id ? { ...f, status: 'success', finalName, orientation: orientationValue } : f);
                    const completed = updatedFiles.filter(f => f.status === 'success' || f.status === 'error').length;
                    return { ...b, files: updatedFiles, progress: { ...b.progress, completed } };
                }));

            } catch (err) {
                logger.error('namer-batch', `Failed to process ${file.name}`, { error: err instanceof Error ? err.message : String(err) });
                setBatches(prev => prev.map(b => {
                    if (b.id !== batchId) return b;
                    const updatedFiles = b.files.map(f => f.id === file.id ? { ...f, status: 'error' } : f);
                    const completed = updatedFiles.filter(f => f.status === 'success' || f.status === 'error').length;
                    const errors = updatedFiles.filter(f => f.status === 'error').length;
                    return { ...b, files: updatedFiles, progress: { ...b.progress, completed, errors } };
                }));
            }
        }

        // Mark batch complete
        setBatches(prev => prev.map(b => b.id === batchId ? { ...b, status: 'completed' } : b));

        // Schedule deferred ingest into DAM
        setBatches(prev => {
            const completedBatch = prev.find(b => b.id === batchId);
            if (completedBatch) {
                const successIds = completedBatch.files
                    .filter(f => f.status === 'success')
                    .map(f => f.id);
                if (successIds.length > 0) {
                    scheduleIngest(batchId, successIds, batchDestFolderId);
                }
            }
            return prev;
        });
    }, [selectedLabelIds, labelFieldValues, labels, aiEnabled, settings, scheduleIngest]);

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
    // Revert batch
    // ==========================================================
    const revertBatch = useCallback(async (batchId: string) => {
        const batch = batches.find(b => b.id === batchId);
        if (!batch || batch.status !== 'completed') return;

        // Cancel any pending deferred ingest for this batch
        cancelIngest(batchId);

        // Mark reverting
        setBatches(prev => prev.map(b => b.id === batchId ? { ...b, status: 'reverting' } : b));

        const successFiles = batch.files.filter(f => f.status === 'success' && f.finalName);

        for (const file of successFiles) {
            try {
                // Rename with revert_ prefix + original name, move back to source
                const revertName = `revert_${file.name}`;
                await namerApi.updateFile(file.id, revertName, batch.sourceFolderId, batch.destFolderId || undefined);
            } catch (err) {
                logger.error('namer-batch', `Failed to revert ${file.name}`, { error: err instanceof Error ? err.message : String(err) });
            }
        }

        // Mark reverted
        setBatches(prev => prev.map(b => b.id === batchId ? { ...b, status: 'reverted' } : b));

        // Remove reverted file IDs from the filter so they reappear in the file list
        for (const f of batch.files) batchFileIdsRef.current.delete(f.id);
        if (batch.sourceFolderId) {
            setTimeout(() => loadFiles(), 1500); // Small delay for Drive propagation
        }
    }, [batches, cancelIngest, loadFiles]);

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
    const canExecute = pendingCount > 0 && !!destFolderId && !!selectedSchema && missingRequired.length === 0;

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
                                    onSelect={(id: string, name: string) => { setSourceFolderId(id); setSourceFolderName(name); }}
                                />
                                <FolderPicker
                                    label="Destination Folder"
                                    folderId={destFolderId}
                                    folderName={destFolderName}
                                    onSelect={(id: string, name: string) => { setDestFolderId(id); setDestFolderName(name); }}
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
                            {sourceFolderId ? 'No media files found in this folder' : 'Select a source folder and click Load Files'}
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
                            files={files}
                            onToggleExclude={toggleExclude}
                            onSelectAll={selectAll}
                            onDeselectAll={deselectAll}
                            onReloadFiles={loadFiles}
                            onExecute={() => setShowConfirmModal(true)}
                            canExecute={canExecute}
                            isProcessing={isProcessing}
                            loadId={loadCount}
                            onSelectFiltered={selectFiltered}
                            onDeselectFiltered={deselectFiltered}
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
                        {batches.some(b => b.status === 'completed' || b.status === 'reverted') && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setBatches(prev => prev.filter(b => b.status !== 'completed' && b.status !== 'reverted'));
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
                            onClearCompleted={() => setBatches(prev => prev.filter(b => b.status !== 'completed' && b.status !== 'reverted'))}
                            onRevertBatch={revertBatch}
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
                    onConfirm={() => {
                        setShowConfirmModal(false);
                        enqueueBatch();
                    }}
                    onCancel={() => setShowConfirmModal(false)}
                />
            )}
        </div>
    );
}
