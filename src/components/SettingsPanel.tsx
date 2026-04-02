'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface SyncLog {
    id: string;
    started_at: string;
    finished_at: string;
    duration_secs: number;
    assets_found: number;
    assets_upserted: number;
    upsert_errors: number;
    thumbnails_uploaded: number;
    thumbnail_errors: number;
    soft_deleted: number;
    restored: number;
    purged: number;
    re_embedded: number;
    skipped_by_folder: number;
    skipped_by_ignore: number;
    ignored_folders: { name: string; path: string; tagged?: boolean }[];
    master_folders: string[];
    status: 'success' | 'partial' | 'failed';
    error_message: string | null;
}

interface Stats {
    total: number;
    photos: number;
    videos: number;
    embedded: number;
    withOrganic: number;
    withPaid: number;
    trashCount: number;
}

interface SettingsData {
    latestSync: SyncLog | null;
    nextSync: string | null;
    avgDuration: number | null;
    stats: Stats;
}

interface WorkflowStep {
    name: string;
    status: string;        // queued | in_progress | completed
    conclusion: string | null;
}

interface SyncProgress {
    step: string;
    detail: string;
    pct: number | null;
    updated_at: string;
}

interface WorkflowStatus {
    found: boolean;
    run_id?: number;
    status?: string;       // queued | in_progress | completed
    conclusion?: string | null; // success | failure | cancelled
    html_url?: string;
    steps?: WorkflowStep[];
    sync_progress?: SyncProgress | null;
}

// Map GitHub Actions step names to display labels
const WORKFLOW_STEP_DISPLAY: Record<string, { label: string; icon: string }> = {
    'Checkout': { label: 'Checkout', icon: '📋' },
    'Authenticate to Google Cloud (WIF)': { label: 'Authenticating', icon: '🔑' },
    'Setup Node.js': { label: 'Setup Node', icon: '⚙️' },
    'Install dependencies': { label: 'Installing', icon: '📦' },
    'Run sync': { label: 'Syncing', icon: '🔄' },
};

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function timeUntil(dateStr: string): string {
    const diff = new Date(dateStr).getTime() - Date.now();
    if (diff <= 0) return 'overdue';
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (hours > 0) return `in ${hours}h ${mins}m`;
    return `in ${mins}m`;
}

function formatDuration(secs: number): string {
    if (secs < 60) return `${secs.toFixed(1)}s`;
    const mins = Math.floor(secs / 60);
    const remainder = Math.round(secs % 60);
    return `${mins}m ${remainder}s`;
}

export default function SettingsPanel({ onClose, onSyncComplete }: { onClose: () => void; onSyncComplete?: () => void }) {
    const [data, setData] = useState<SettingsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [syncComplete, setSyncComplete] = useState(false);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
    const [workflowUrl, setWorkflowUrl] = useState<string | null>(null);
    const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // DB-backed config state
    const [config, setConfig] = useState<{ sharedDriveId: string; syncFolders: string[]; driveLabelId: string; namerLabelIds: string[]; semanticSimilarityThreshold: number; rightsLabelConfig?: { fieldIds: { organicRights: string; organicExpiration: string; paidRights: string; paidExpiration: string }; choiceMap: Record<string, string> } } | null>(null);
    const [editingField, setEditingField] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');
    const [saving, setSaving] = useState(false);
    const [configExpanded, setConfigExpanded] = useState(false);
    const [thresholdValue, setThresholdValue] = useState(0.3);
    // Chip UI state for array fields
    const [chipAddValue, setChipAddValue] = useState('');
    const [pendingDelete, setPendingDelete] = useState<{ key: string; index: number } | null>(null);
    // Rights Label Config editing state
    const [editingRightsField, setEditingRightsField] = useState<string | null>(null);
    const [rightsFieldEditValue, setRightsFieldEditValue] = useState('');
    const [newChoiceKey, setNewChoiceKey] = useState('');
    const [newChoiceValue, setNewChoiceValue] = useState('unlimited');

    const fetchSettings = useCallback(async () => {
        try {
            const [settingsRes, configRes] = await Promise.all([
                fetch('/api/settings'),
                fetch('/api/settings/config'),
            ]);
            if (settingsRes.ok) {
                const json = await settingsRes.json();
                setData(json);
            }
            if (configRes.ok) {
                const configJson = await configRes.json();
                setConfig(configJson);
                if (configJson.semanticSimilarityThreshold !== undefined) {
                    setThresholdValue(configJson.semanticSimilarityThreshold);
                }
            }
        } catch { /* silent */ }
        setLoading(false);
    }, []);

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    // Clean up polling on unmount
    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

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

    const handleSync = async () => {
        setSyncing(true);
        setSyncComplete(false);
        setSyncError(null);
        setWorkflowSteps([]);
        setWorkflowUrl(null);
        setSyncProgress(null);

        try {
            // Trigger the GitHub Actions workflow
            const triggerRes = await fetch('/api/sync/trigger', { method: 'POST' });
            const triggerData = await triggerRes.json();
            if (!triggerRes.ok) {
                throw new Error(triggerData.error || 'Failed to trigger sync');
            }

            const { triggered_at } = triggerData;

            // Poll for workflow status
            let runId: number | null = null;
            let pollErrors = 0;

            pollRef.current = setInterval(async () => {
                try {
                    const params = runId
                        ? `?run_id=${runId}`
                        : `?triggered_at=${encodeURIComponent(triggered_at)}`;

                    const statusRes = await fetch(`/api/sync/workflow-status${params}`);
                    const statusData = await statusRes.json();

                    // Surface API-level errors (expired token, permission issues)
                    if (!statusRes.ok || statusData.error) {
                        if (pollRef.current) clearInterval(pollRef.current);
                        pollRef.current = null;
                        setSyncError(statusData.error || `Status check failed (${statusRes.status})`);
                        setSyncing(false);
                        return;
                    }

                    if (!statusData.found) {
                        // Run hasn't appeared yet — give GitHub a moment
                        pollErrors = 0;
                        return;
                    }

                    pollErrors = 0;

                    // Cache run_id for faster subsequent polls
                    if (statusData.run_id && !runId) {
                        runId = statusData.run_id;
                    }

                    if (statusData.html_url) setWorkflowUrl(statusData.html_url);
                    if (statusData.steps) setWorkflowSteps(statusData.steps);
                    if (statusData.sync_progress) setSyncProgress(statusData.sync_progress);

                    // Check for completion
                    if (statusData.status === 'completed') {
                        if (pollRef.current) clearInterval(pollRef.current);
                        pollRef.current = null;

                        if (statusData.conclusion === 'success') {
                            setSyncComplete(true);
                            // Refresh settings to pick up new sync_logs entry
                            await fetchSettings();
                            onSyncComplete?.();
                        } else {
                            const failedStep = (statusData.steps || []).find(
                                (s: WorkflowStep) => s.conclusion === 'failure'
                            );
                            const detail = failedStep
                                ? `Step "${failedStep.name}" failed`
                                : `Workflow ${statusData.conclusion || 'failed'}`;
                            setSyncError(`${detail}. Check GitHub Actions for logs.`);
                            setWorkflowUrl(statusData.html_url || null);
                        }
                        setSyncing(false);
                    }
                } catch {
                    // Network error during polling — tolerate a few before giving up
                    pollErrors++;
                    if (pollErrors >= 5) {
                        if (pollRef.current) clearInterval(pollRef.current);
                        pollRef.current = null;
                        setSyncError('Lost connection while monitoring sync. The workflow may still be running — check GitHub Actions.');
                        setSyncing(false);
                    }
                }
            }, 5000);
        } catch (err: any) {
            setSyncError(err.message);
            setSyncing(false);
        }
    };

    // Calculate progress from workflow steps
    const completedSteps = workflowSteps.filter(s => s.status === 'completed').length;
    const totalSteps = workflowSteps.length || 1;
    const overallPct = syncing
        ? Math.round((completedSteps / totalSteps) * 100)
        : syncComplete ? 100 : 0;

    const statusBadge = (status: string) => {
        if (status === 'success') return { text: 'Healthy', color: 'var(--ram-green)', bg: 'var(--ram-green-bg)' };
        if (status === 'partial') return { text: 'Partial', color: 'var(--ram-amber)', bg: 'var(--ram-amber-bg)' };
        return { text: 'Failed', color: 'var(--ram-red)', bg: 'var(--ram-red-bg)' };
    };

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
                    maxWidth: 560,
                    maxHeight: '85vh',
                    overflow: 'auto',
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
                }}>
                    <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>⚙️ Sync & Settings</h2>
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
                            transition: 'color 0.15s',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ram-text-primary)')}
                        onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ram-text-tertiary)')}
                    >
                        ✕
                    </button>
                </div>

                {loading ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--ram-text-tertiary)' }}>
                        Loading sync data...
                    </div>
                ) : (
                    <div style={{ padding: '0 24px 24px' }}>
                        {/* ── Section 1: Sync Health ── */}
                        <SectionHeader title="Sync Health" />

                        {data?.latestSync ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                {/* Status + Timing */}
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 12,
                                    padding: '12px 16px',
                                    background: 'var(--ram-bg-tertiary)',
                                    borderRadius: 10,
                                }}>
                                    {(() => {
                                        const badge = statusBadge(data.latestSync.status);
                                        return (
                                            <span style={{
                                                padding: '3px 10px',
                                                borderRadius: 20,
                                                fontSize: 12,
                                                fontWeight: 600,
                                                color: badge.color,
                                                background: badge.bg,
                                            }}>
                                                {badge.text}
                                            </span>
                                        );
                                    })()}
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 13, color: 'var(--ram-text-primary)' }}>
                                            Last sync: <strong>{timeAgo(data.latestSync.finished_at)}</strong>
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--ram-text-tertiary)', marginTop: 2 }}>
                                            Duration: {formatDuration(data.latestSync.duration_secs)}
                                        </div>
                                    </div>
                                    {data.nextSync && (
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{ fontSize: 11, color: 'var(--ram-text-tertiary)' }}>Next auto-sync</div>
                                            <div style={{ fontSize: 13, color: 'var(--ram-accent)', fontWeight: 500 }}>
                                                {timeUntil(data.nextSync)}
                                            </div>
                                            <div style={{ fontSize: 10, color: 'var(--ram-text-tertiary)', marginTop: 1 }}>
                                                syncs every 6h
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Error details (when partial or failed) */}
                                {data.latestSync.status !== 'success' && data.latestSync.error_message && (
                                    <div style={{
                                        padding: '8px 12px',
                                        background: 'var(--ram-red-bg, rgba(239, 68, 68, 0.08))',
                                        border: '1px solid rgba(239, 68, 68, 0.2)',
                                        borderRadius: 8,
                                        fontSize: 11,
                                        color: 'var(--ram-red, #f87171)',
                                        lineHeight: 1.5,
                                        wordBreak: 'break-word',
                                    }}>
                                        <strong>Error:</strong> {data.latestSync.error_message}
                                    </div>
                                )}

                                {/* Upsert error detail */}
                                {data.latestSync.upsert_errors > 0 && (
                                    <div style={{
                                        padding: '8px 12px',
                                        background: 'var(--ram-red-bg, rgba(239, 68, 68, 0.08))',
                                        border: '1px solid rgba(239, 68, 68, 0.2)',
                                        borderRadius: 8,
                                        fontSize: 11,
                                        color: 'var(--ram-red, #f87171)',
                                        lineHeight: 1.5,
                                    }}>
                                        <strong>⚠️ {data.latestSync.upsert_errors} upsert error(s)</strong>
                                        <span style={{ color: 'var(--ram-text-tertiary)', marginLeft: 4 }}>
                                            — batches failed to write to database
                                        </span>
                                    </div>
                                )}

                                {/* Sync Stats Grid */}
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(3, 1fr)',
                                    gap: 8,
                                }}>
                                    <StatChip label="Assets Found" value={data.latestSync.assets_found} />
                                    <StatChip label="Upserted" value={data.latestSync.assets_upserted} />
                                    <StatChip
                                        label="Errors"
                                        value={data.latestSync.upsert_errors}
                                        alert={data.latestSync.upsert_errors > 0}
                                    />
                                    <StatChip label="Soft Deleted" value={data.latestSync.soft_deleted} />
                                    <StatChip label="Restored" value={data.latestSync.restored} />
                                    <StatChip label="Purged" value={data.latestSync.purged} />
                                    <StatChip label="Re-embedded" value={data.latestSync.re_embedded} />
                                    <StatChip label="Folder-skipped" value={data.latestSync.skipped_by_folder} />
                                    <StatChip label="Tag-ignored" value={data.latestSync.skipped_by_ignore} />
                                </div>
                            </div>
                        ) : (
                            <div style={{
                                padding: '16px',
                                background: 'var(--ram-bg-tertiary)',
                                borderRadius: 10,
                                color: 'var(--ram-text-tertiary)',
                                fontSize: 13,
                                textAlign: 'center',
                            }}>
                                No sync has been recorded yet. Run your first sync below.
                            </div>
                        )}

                        {/* Sync Now Button + Progress */}
                        <div style={{ marginTop: 12 }}>
                            {!syncing ? (
                                <>
                                    <button
                                        onClick={handleSync}
                                        style={{
                                            width: '100%',
                                            padding: '10px 16px',
                                            borderRadius: 8,
                                            border: 'none',
                                            background: syncComplete
                                                ? 'var(--ram-green-bg)'
                                                : 'linear-gradient(135deg, var(--ram-accent), #d4922a)',
                                            color: syncComplete ? 'var(--ram-green)' : '#0c0e12',
                                            fontWeight: 600,
                                            fontSize: 13,
                                            cursor: 'pointer',
                                            transition: 'all 0.2s',
                                        }}
                                    >
                                        {syncComplete ? '✅ Sync Complete — Run Again' : '🔄 Sync Now'}
                                    </button>
                                    {syncError && (
                                        <div style={{
                                            marginTop: 8,
                                            padding: '10px 14px',
                                            background: 'var(--ram-red-bg)',
                                            border: '1px solid rgba(239, 68, 68, 0.25)',
                                            borderRadius: 8,
                                            fontSize: 12,
                                            color: 'var(--ram-red)',
                                            lineHeight: 1.5,
                                        }}>
                                            <div style={{ fontWeight: 600, marginBottom: 4 }}>Sync failed</div>
                                            <div style={{ fontSize: 11, color: 'var(--ram-text-secondary)' }}>
                                                {syncError}
                                            </div>
                                            {workflowUrl && (
                                                <a
                                                    href={workflowUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    style={{
                                                        display: 'inline-block',
                                                        marginTop: 6,
                                                        fontSize: 11,
                                                        color: 'var(--ram-accent)',
                                                        textDecoration: 'none',
                                                    }}
                                                >
                                                    View workflow logs ↗
                                                </a>
                                            )}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div style={{
                                    padding: '12px 16px',
                                    background: 'var(--ram-bg-tertiary)',
                                    borderRadius: 10,
                                }}>
                                    {/* Progress Bar */}
                                    <div style={{
                                        height: 6,
                                        background: 'var(--ram-bg-hover)',
                                        borderRadius: 3,
                                        overflow: 'hidden',
                                        marginBottom: 10,
                                    }}>
                                        <div style={{
                                            height: '100%',
                                            width: `${overallPct}%`,
                                            background: 'linear-gradient(90deg, var(--ram-accent), #d4922a)',
                                            borderRadius: 3,
                                            transition: 'width 0.5s ease',
                                        }} />
                                    </div>

                                    {/* Workflow Step Indicators */}
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                        {workflowSteps.length > 0 ? (
                                            workflowSteps.map((step, i) => {
                                                const display = WORKFLOW_STEP_DISPLAY[step.name] || { label: step.name, icon: '⚙️' };
                                                const isDone = step.status === 'completed' && step.conclusion === 'success';
                                                const isFailed = step.status === 'completed' && step.conclusion !== 'success';
                                                const isActive = step.status === 'in_progress';
                                                return (
                                                    <span
                                                        key={i}
                                                        style={{
                                                            padding: '3px 8px',
                                                            borderRadius: 6,
                                                            fontSize: 11,
                                                            fontWeight: isActive ? 600 : 400,
                                                            color: isFailed
                                                                ? 'var(--ram-red)'
                                                                : isDone
                                                                    ? 'var(--ram-green)'
                                                                    : isActive
                                                                        ? 'var(--ram-accent)'
                                                                        : 'var(--ram-text-tertiary)',
                                                            background: isActive
                                                                ? 'var(--ram-accent-muted)'
                                                                : isDone
                                                                    ? 'var(--ram-green-bg)'
                                                                    : isFailed
                                                                        ? 'var(--ram-red-bg)'
                                                                        : 'transparent',
                                                            transition: 'all 0.3s',
                                                        }}
                                                    >
                                                        {display.icon} {display.label}
                                                    </span>
                                                );
                                            })
                                        ) : (
                                            <span style={{ fontSize: 11, color: 'var(--ram-text-tertiary)' }}>
                                                🚀 Workflow queued — waiting for runner...
                                            </span>
                                        )}
                                    </div>

                                    {/* Live sync progress — from scripts/sync.ts writing to Supabase */}
                                    {syncProgress && (
                                        <div style={{
                                            marginTop: 10,
                                            padding: '8px 12px',
                                            background: 'var(--ram-bg-hover)',
                                            borderRadius: 8,
                                            borderLeft: '3px solid var(--ram-accent)',
                                        }}>
                                            <div style={{
                                                fontSize: 11,
                                                fontWeight: 600,
                                                color: 'var(--ram-accent)',
                                                marginBottom: 4,
                                                textTransform: 'capitalize',
                                            }}>
                                                {syncProgress.step === 'done' ? '✅ Complete' : `🔄 ${syncProgress.step}`}
                                            </div>
                                            <div style={{
                                                fontSize: 11,
                                                color: 'var(--ram-text-secondary)',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 8,
                                            }}>
                                                <span style={{ flex: 1 }}>{syncProgress.detail}</span>
                                                {syncProgress.pct != null && syncProgress.pct < 100 && (
                                                    <span style={{
                                                        fontSize: 11,
                                                        fontWeight: 600,
                                                        color: 'var(--ram-accent)',
                                                        fontVariantNumeric: 'tabular-nums',
                                                    }}>
                                                        {syncProgress.pct}%
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Estimated time */}
                                    {data?.avgDuration && (
                                        <div style={{
                                            marginTop: 8,
                                            fontSize: 11,
                                            color: 'var(--ram-text-tertiary)',
                                        }}>
                                            Est. {formatDuration(data.avgDuration)} total
                                        </div>
                                    )}

                                    {/* GitHub Actions link */}
                                    {workflowUrl && (
                                        <div style={{ marginTop: 6 }}>
                                            <a
                                                href={workflowUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                style={{
                                                    fontSize: 11,
                                                    color: 'var(--ram-accent)',
                                                    textDecoration: 'none',
                                                }}
                                            >
                                                View in GitHub Actions ↗
                                            </a>
                                        </div>
                                    )}

                                    {/* Safe to close note */}
                                    <div style={{
                                        marginTop: 6,
                                        fontSize: 10,
                                        color: 'var(--ram-text-tertiary)',
                                        fontStyle: 'italic',
                                    }}>
                                        Sync runs in GitHub Actions — safe to close this page
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ── Section 2: Master Folders ── */}
                        <SectionHeader title="Master Folders" />
                        <div style={{
                            padding: '12px 16px',
                            background: 'var(--ram-bg-tertiary)',
                            borderRadius: 10,
                        }}>
                            {data?.latestSync?.master_folders && data.latestSync.master_folders.length > 0 ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                    {data.latestSync.master_folders.map((folder, i) => (
                                        <span
                                            key={i}
                                            style={{
                                                padding: '4px 10px',
                                                borderRadius: 6,
                                                fontSize: 12,
                                                background: 'var(--ram-accent-muted)',
                                                color: 'var(--ram-accent)',
                                                fontWeight: 500,
                                            }}
                                        >
                                            📁 {folder}
                                        </span>
                                    ))}
                                </div>
                            ) : (
                                <div style={{ fontSize: 12, color: 'var(--ram-text-tertiary)' }}>
                                    No master folders configured. Set SYNC_FOLDERS in .env.local.
                                </div>
                            )}
                            <div style={{
                                marginTop: 8,
                                fontSize: 11,
                                color: 'var(--ram-text-tertiary)',
                                fontStyle: 'italic',
                            }}>
                                Managed in Advanced Configuration below
                            </div>
                        </div>


                        {/* ── Section 3: Ignored Folders ── */}
                        <SectionHeader title="Ignored Folders" />
                        <div style={{
                            padding: '12px 16px',
                            background: 'var(--ram-bg-tertiary)',
                            borderRadius: 10,
                        }}>
                            {data?.latestSync?.ignored_folders && data.latestSync.ignored_folders.length > 0 ? (
                                <IgnoredFolderTree folders={data.latestSync.ignored_folders} />
                            ) : (
                                <div style={{ fontSize: 12, color: 'var(--ram-text-tertiary)' }}>
                                    No folders ignored. Add <code style={{
                                        background: 'var(--ram-bg-hover)',
                                        padding: '1px 5px',
                                        borderRadius: 3,
                                        fontSize: 11,
                                    }}>[relay-ignore]</code> to any folder&apos;s description in Google Drive.
                                </div>
                            )}
                            <div style={{
                                marginTop: 8,
                                fontSize: 11,
                                color: 'var(--ram-text-tertiary)',
                                fontStyle: 'italic',
                            }}>
                                Add <code style={{
                                    background: 'var(--ram-bg-hover)',
                                    padding: '1px 4px',
                                    borderRadius: 3,
                                    fontSize: 10,
                                }}>[relay-ignore]</code> to a folder&apos;s description in Google Drive to exclude it
                            </div>
                        </div>

                        {/* ── Section 4: Library Stats ── */}
                        <SectionHeader title="Library Stats" />
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(2, 1fr)',
                            gap: 8,
                        }}>
                            <StatChip label="Total Assets" value={data?.stats.total ?? 0} large />
                            <StatChip label="Photos" value={data?.stats.photos ?? 0} large />
                            <StatChip label="Videos" value={data?.stats.videos ?? 0} large />
                            <StatChip
                                label="Embedded"
                                value={`${data?.stats.embedded ?? 0} / ${data?.stats.total ?? 0}`}
                                large
                            />
                            <StatChip
                                label="Organic Rights"
                                value={`${data?.stats.withOrganic ?? 0}`}
                                large
                            />
                            <StatChip
                                label="Paid Rights"
                                value={`${data?.stats.withPaid ?? 0}`}
                                large
                            />
                            {(data?.stats.trashCount ?? 0) > 0 && (
                                <StatChip
                                    label="Pending Deletion"
                                    value={data?.stats.trashCount ?? 0}
                                    alert
                                    large
                                />
                            )}
                        </div>

                        {/* ── Section 5: Semantic Search ── */}
                        <SectionHeader title="Semantic Search" />
                        <div style={{
                            padding: '14px 16px',
                            background: 'var(--ram-bg-tertiary)',
                            borderRadius: 10,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <div>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ram-text-primary)' }}>
                                        Similarity Threshold
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--ram-text-tertiary)', marginTop: 2 }}>
                                        Higher = stricter matching, fewer results
                                    </div>
                                </div>
                                <span style={{
                                    fontFamily: 'monospace',
                                    fontSize: 14,
                                    fontWeight: 700,
                                    color: 'var(--ram-accent)',
                                    minWidth: 36,
                                    textAlign: 'right',
                                }}>
                                    {thresholdValue.toFixed(2)}
                                </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontSize: 10, color: 'var(--ram-text-tertiary)' }}>0.0</span>
                                <input
                                    type="range"
                                    min="0"
                                    max="0.8"
                                    step="0.05"
                                    value={thresholdValue}
                                    onChange={async (e) => {
                                        const val = parseFloat(e.target.value);
                                        setThresholdValue(val);
                                        try {
                                            await fetch('/api/settings/config', {
                                                method: 'PUT',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ key: 'semantic_similarity_threshold', value: val }),
                                            });
                                        } catch { /* silent */ }
                                    }}
                                    style={{
                                        flex: 1,
                                        accentColor: 'var(--ram-accent)',
                                        cursor: 'pointer',
                                    }}
                                />
                                <span style={{ fontSize: 10, color: 'var(--ram-text-tertiary)' }}>0.8</span>
                            </div>
                            <div style={{
                                fontSize: 11,
                                color: 'var(--ram-text-tertiary)',
                                fontStyle: 'italic',
                                marginTop: 2,
                            }}>
                                Recommended: 0.30 · Results below this score are excluded from semantic searches
                            </div>
                        </div>

                        {/* ── Advanced Configuration (collapsible, bottom) ── */}
                        <div style={{ marginTop: 24, borderTop: '1px solid var(--ram-border)', paddingTop: 16 }}>
                            <button
                                onClick={() => setConfigExpanded(!configExpanded)}
                                style={{
                                    width: '100%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    padding: '8px 0',
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    color: 'var(--ram-text-tertiary)',
                                    fontSize: 12,
                                    fontWeight: 500,
                                    transition: 'color 0.15s',
                                }}
                                onMouseEnter={e => e.currentTarget.style.color = 'var(--ram-text-secondary)'}
                                onMouseLeave={e => e.currentTarget.style.color = 'var(--ram-text-tertiary)'}
                            >
                                <svg
                                    width="10" height="10" viewBox="0 0 24 24" fill="none"
                                    stroke="currentColor" strokeWidth="3"
                                    strokeLinecap="round" strokeLinejoin="round"
                                    style={{
                                        transition: 'transform 0.2s',
                                        transform: configExpanded ? 'rotate(90deg)' : 'rotate(0)',
                                    }}
                                >
                                    <polyline points="9 18 15 12 9 6" />
                                </svg>
                                <span>🔧 Advanced Configuration</span>
                            </button>

                            {configExpanded && (
                                <div style={{ marginTop: 8 }}>
                                    {/* Warning banner */}
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: 10,
                                        padding: '10px 14px',
                                        borderRadius: 10,
                                        background: 'rgba(239, 68, 68, 0.08)',
                                        border: '1px solid rgba(239, 68, 68, 0.25)',
                                        marginBottom: 12,
                                    }}>
                                        <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>⚠️</span>
                                        <div style={{ fontSize: 11, color: 'var(--ram-red, #f87171)', lineHeight: 1.5 }}>
                                            <strong>Do not edit unless you have a specific reason.</strong>{' '}
                                            Changing these values incorrectly can break syncing, folder discovery,
                                            and label-based permissions across the entire application.
                                        </div>
                                    </div>

                                    {/* Config fields */}
                                    {(() => {
                                        const maskId = (val: string) => {
                                            if (!val || val.length <= 12) return val;
                                            return `${val.slice(0, 4)}${'•'.repeat(6)}${val.slice(-4)}`;
                                        };

                                        const saveConfigField = async (key: string, value: unknown) => {
                                            setSaving(true);
                                            try {
                                                const res = await fetch('/api/settings/config', {
                                                    method: 'PUT',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ key, value }),
                                                });
                                                if (res.ok) {
                                                    setEditingField(null);
                                                    const configRes = await fetch('/api/settings/config');
                                                    if (configRes.ok) setConfig(await configRes.json());
                                                }
                                            } catch { /* silent */ }
                                            setSaving(false);
                                        };

                                        const singleFields = [
                                            { key: 'shared_drive_id', label: 'Shared Drive ID', value: config?.sharedDriveId ?? '', sensitive: true },
                                        ];

                                        const arrayFields = [
                                            { key: 'sync_folders', label: 'Sync Folders', items: config?.syncFolders ?? [], sensitive: false },
                                        ];

                                        return (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                {/* ── Single-value fields ── */}
                                                {singleFields.map(({ key, label, value, sensitive }) => (
                                                    <div key={key} style={{ padding: '10px 14px', background: 'var(--ram-bg-tertiary)', borderRadius: 10, border: '1px solid var(--ram-border)' }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: editingField === key ? 8 : 0 }}>
                                                            <div>
                                                                <div style={{ fontSize: 11, color: 'var(--ram-text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
                                                                {editingField !== key && (
                                                                    <div style={{ fontSize: 12, color: 'var(--ram-text-secondary)', marginTop: 2, wordBreak: 'break-all', fontFamily: 'monospace' }}>
                                                                        {(sensitive ? maskId(value) : value) || <span style={{ color: 'var(--ram-text-tertiary)', fontStyle: 'italic' }}>Not set</span>}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            {editingField !== key && (
                                                                <button onClick={() => { setEditingField(key); setEditValue(value); }}
                                                                    style={{ background: 'none', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--ram-red,#f87171)', fontSize: 10, padding: '2px 8px', borderRadius: 5, cursor: 'pointer', opacity: 0.7, transition: 'all 0.15s' }}
                                                                    onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.6)'; }}
                                                                    onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'; }}
                                                                >Edit</button>
                                                            )}
                                                        </div>
                                                        {editingField === key && (
                                                            <div style={{ display: 'flex', gap: 6 }}>
                                                                <input type="text" value={editValue} onChange={e => setEditValue(e.target.value)}
                                                                    style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.3)', background: 'var(--ram-bg-primary)', color: 'var(--ram-text-primary)', fontSize: 12, fontFamily: 'monospace', outline: 'none' }}
                                                                    onFocus={e => e.currentTarget.style.borderColor = 'rgba(239,68,68,0.6)'}
                                                                    onBlur={e => e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'}
                                                                    autoFocus
                                                                />
                                                                <button disabled={saving} onClick={() => saveConfigField(key, editValue)}
                                                                    style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--ram-red,#f87171)', color: '#fff', fontSize: 11, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1 }}
                                                                >{saving ? '...' : 'Save'}</button>
                                                                <button onClick={() => setEditingField(null)}
                                                                    style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--ram-border)', background: 'none', color: 'var(--ram-text-secondary)', fontSize: 11, cursor: 'pointer' }}
                                                                >Cancel</button>
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}

                                                {/* ── Array/chip fields ── */}
                                                {arrayFields.map(({ key, label, items, sensitive }) => (
                                                    <div key={key} style={{ padding: '10px 14px', background: 'var(--ram-bg-tertiary)', borderRadius: 10, border: '1px solid var(--ram-border)' }}>
                                                        <div style={{ fontSize: 11, color: 'var(--ram-text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>{label}</div>

                                                        {/* Chips */}
                                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                                                            {items.length === 0 && <span style={{ fontSize: 12, color: 'var(--ram-text-tertiary)', fontStyle: 'italic' }}>None configured</span>}
                                                            {items.map((item, idx) => (
                                                                <div key={idx} style={{
                                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                                    padding: '3px 8px 3px 10px', borderRadius: 6,
                                                                    background: 'var(--ram-bg-hover)', border: '1px solid var(--ram-border)',
                                                                    fontSize: 12, fontFamily: 'monospace', color: 'var(--ram-text-secondary)',
                                                                }}>
                                                                    <span>{sensitive ? maskId(item) : item}</span>
                                                                    {pendingDelete?.key === key && pendingDelete?.index === idx ? (
                                                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 4 }}>
                                                                            <button onClick={async () => { await saveConfigField(key, items.filter((_, i) => i !== idx)); setPendingDelete(null); }}
                                                                                style={{ background: 'var(--ram-red,#f87171)', border: 'none', color: '#fff', fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, cursor: 'pointer' }}
                                                                            >Remove</button>
                                                                            <button onClick={() => setPendingDelete(null)}
                                                                                style={{ background: 'none', border: 'none', color: 'var(--ram-text-tertiary)', fontSize: 9, padding: '1px 4px', cursor: 'pointer' }}
                                                                            >✕</button>
                                                                        </span>
                                                                    ) : (
                                                                        <button onClick={() => setPendingDelete({ key, index: idx })} title="Remove"
                                                                            style={{ background: 'none', border: 'none', color: 'var(--ram-text-tertiary)', fontSize: 12, cursor: 'pointer', padding: '0 2px', lineHeight: 1, transition: 'color 0.15s' }}
                                                                            onMouseEnter={e => e.currentTarget.style.color = 'var(--ram-red,#f87171)'}
                                                                            onMouseLeave={e => e.currentTarget.style.color = 'var(--ram-text-tertiary)'}
                                                                        >×</button>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>

                                                        {/* Add new chip */}
                                                        {editingField === key ? (
                                                            <div style={{ display: 'flex', gap: 6 }}>
                                                                <input type="text" value={chipAddValue} onChange={e => setChipAddValue(e.target.value)}
                                                                    placeholder={sensitive ? 'Paste ID...' : 'Enter value...'}
                                                                    onKeyDown={async e => {
                                                                        if (e.key === 'Enter' && chipAddValue.trim()) { await saveConfigField(key, [...items, chipAddValue.trim()]); setChipAddValue(''); }
                                                                        else if (e.key === 'Escape') { setEditingField(null); setChipAddValue(''); }
                                                                    }}
                                                                    style={{ flex: 1, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--ram-border)', background: 'var(--ram-bg-primary)', color: 'var(--ram-text-primary)', fontSize: 12, fontFamily: 'monospace', outline: 'none' }}
                                                                    onFocus={e => e.currentTarget.style.borderColor = 'var(--ram-accent)'}
                                                                    onBlur={e => e.currentTarget.style.borderColor = 'var(--ram-border)'}
                                                                    autoFocus
                                                                />
                                                                <button disabled={saving || !chipAddValue.trim()}
                                                                    onClick={async () => { if (chipAddValue.trim()) { await saveConfigField(key, [...items, chipAddValue.trim()]); setChipAddValue(''); } }}
                                                                    style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: chipAddValue.trim() ? 'var(--ram-accent)' : 'var(--ram-bg-hover)', color: chipAddValue.trim() ? '#0c0e12' : 'var(--ram-text-tertiary)', fontSize: 11, fontWeight: 600, cursor: chipAddValue.trim() ? 'pointer' : 'default', transition: 'all 0.15s' }}
                                                                >Add</button>
                                                                <button onClick={() => { setEditingField(null); setChipAddValue(''); }}
                                                                    style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--ram-border)', background: 'none', color: 'var(--ram-text-secondary)', fontSize: 11, cursor: 'pointer' }}
                                                                >Done</button>
                                                            </div>
                                                        ) : (
                                                            <button onClick={() => { setEditingField(key); setChipAddValue(''); }}
                                                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 6, border: '1px dashed var(--ram-border)', background: 'none', color: 'var(--ram-text-tertiary)', fontSize: 11, cursor: 'pointer', transition: 'all 0.15s' }}
                                                                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--ram-accent)'; e.currentTarget.style.color = 'var(--ram-accent)'; }}
                                                                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--ram-border)'; e.currentTarget.style.color = 'var(--ram-text-tertiary)'; }}
                                                            ><span style={{ fontSize: 14, lineHeight: 1 }}>+</span> Add</button>
                                                        )}
                                                    </div>
                                                ))}

                                    {/* ── Google Drive Labels ── */}
                                    <div style={{ marginTop: 12, padding: '14px', background: 'var(--ram-bg-tertiary)', borderRadius: 10, border: '1px solid var(--ram-border)' }}>
                                        <div style={{ fontSize: 11, color: 'var(--ram-text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Google Drive Labels</div>
                                        <div style={{ fontSize: 10, color: 'var(--ram-text-tertiary)', marginBottom: 12, lineHeight: 1.5 }}>
                                            Configure how the app reads rights and compliance data from Google Drive Labels.
                                            Discover your label and field IDs via <code style={{ background: 'var(--ram-bg-hover)', padding: '1px 4px', borderRadius: 3, fontSize: 10 }}>/api/namer/labels</code>
                                        </div>

                                        {/* Rights Label ID */}
                                        <div style={{ marginBottom: 12 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: editingField === 'drive_label_id' ? 8 : 0 }}>
                                                <div>
                                                    <div style={{ fontSize: 10, color: 'var(--ram-text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Rights Label ID</div>
                                                    {editingField !== 'drive_label_id' && (
                                                        <div style={{ fontSize: 12, color: 'var(--ram-text-secondary)', marginTop: 2, wordBreak: 'break-all', fontFamily: 'monospace' }}>
                                                            {(config?.driveLabelId ? maskId(config.driveLabelId) : '') || <span style={{ color: 'var(--ram-text-tertiary)', fontStyle: 'italic' }}>Not set</span>}
                                                        </div>
                                                    )}
                                                </div>
                                                {editingField !== 'drive_label_id' && (
                                                    <button onClick={() => { setEditingField('drive_label_id'); setEditValue(config?.driveLabelId ?? ''); }}
                                                        style={{ background: 'none', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--ram-red,#f87171)', fontSize: 10, padding: '2px 8px', borderRadius: 5, cursor: 'pointer', opacity: 0.7, transition: 'all 0.15s' }}
                                                        onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.6)'; }}
                                                        onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'; }}
                                                    >Edit</button>
                                                )}
                                            </div>
                                            {editingField === 'drive_label_id' && (
                                                <div style={{ display: 'flex', gap: 6 }}>
                                                    <input type="text" value={editValue} onChange={e => setEditValue(e.target.value)}
                                                        style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.3)', background: 'var(--ram-bg-primary)', color: 'var(--ram-text-primary)', fontSize: 12, fontFamily: 'monospace', outline: 'none' }}
                                                        onFocus={e => e.currentTarget.style.borderColor = 'rgba(239,68,68,0.6)'}
                                                        onBlur={e => e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'}
                                                        autoFocus
                                                    />
                                                    <button disabled={saving} onClick={() => saveConfigField('drive_label_id', editValue)}
                                                        style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--ram-red,#f87171)', color: '#fff', fontSize: 11, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1 }}
                                                    >{saving ? '...' : 'Save'}</button>
                                                    <button onClick={() => setEditingField(null)}
                                                        style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--ram-border)', background: 'none', color: 'var(--ram-text-secondary)', fontSize: 11, cursor: 'pointer' }}
                                                    >Cancel</button>
                                                </div>
                                            )}
                                        </div>

                                        <div style={{ borderTop: '1px solid var(--ram-border)', paddingTop: 12, marginBottom: 12 }}>
                                        {(() => {
                                            const rc = config?.rightsLabelConfig ?? { fieldIds: { organicRights: '', organicExpiration: '', paidRights: '', paidExpiration: '' }, choiceMap: {} };
                                            const fieldIdEntries = [
                                                { key: 'organicRights', label: 'Organic Rights' },
                                                { key: 'organicExpiration', label: 'Organic Expiration' },
                                                { key: 'paidRights', label: 'Paid Rights' },
                                                { key: 'paidExpiration', label: 'Paid Expiration' },
                                            ] as const;

                                            const saveRightsConfig = async (updated: typeof rc) => {
                                                setSaving(true);
                                                try {
                                                    const res = await fetch('/api/settings/config', {
                                                        method: 'PUT',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ key: 'rights_label_config', value: updated }),
                                                    });
                                                    if (res.ok) {
                                                        setEditingRightsField(null);
                                                        const configRes = await fetch('/api/settings/config');
                                                        if (configRes.ok) setConfig(await configRes.json());
                                                    }
                                                } catch { /* silent */ }
                                                setSaving(false);
                                            };

                                            return (
                                                <>
                                                    {/* Field IDs */}
                                                    <div style={{ fontSize: 10, color: 'var(--ram-text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Field Mappings</div>
                                                    <div style={{ fontSize: 10, color: 'var(--ram-text-tertiary)', marginBottom: 8, lineHeight: 1.5 }}>
                                                        <strong style={{ color: 'var(--ram-text-secondary)' }}>Rights</strong> and <strong style={{ color: 'var(--ram-text-secondary)' }}>Paid Rights</strong> are <em>Selection</em> fields — their values map through Choice Mappings below.
                                                        <strong style={{ color: 'var(--ram-text-secondary)' }}> Expiration</strong> fields are <em>Date</em> type — read directly.
                                                    </div>
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                        {fieldIdEntries.map(({ key, label }) => {
                                                            const val = rc.fieldIds[key] || '';
                                                            const isEditing = editingRightsField === key;
                                                            return (
                                                                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                                    <div style={{ width: 120, fontSize: 11, color: 'var(--ram-text-secondary)', flexShrink: 0 }}>{label}</div>
                                                                    {isEditing ? (
                                                                        <div style={{ display: 'flex', gap: 4, flex: 1 }}>
                                                                            <input type="text" value={rightsFieldEditValue}
                                                                                onChange={e => setRightsFieldEditValue(e.target.value)}
                                                                                onKeyDown={e => {
                                                                                    if (e.key === 'Enter') {
                                                                                        const updated = { ...rc, fieldIds: { ...rc.fieldIds, [key]: rightsFieldEditValue.trim() } };
                                                                                        saveRightsConfig(updated);
                                                                                    } else if (e.key === 'Escape') setEditingRightsField(null);
                                                                                }}
                                                                                style={{ flex: 1, padding: '4px 8px', borderRadius: 5, border: '1px solid var(--ram-border)', background: 'var(--ram-bg-primary)', color: 'var(--ram-text-primary)', fontSize: 11, fontFamily: 'monospace', outline: 'none' }}
                                                                                autoFocus
                                                                            />
                                                                            <button disabled={saving}
                                                                                onClick={() => saveRightsConfig({ ...rc, fieldIds: { ...rc.fieldIds, [key]: rightsFieldEditValue.trim() } })}
                                                                                style={{ padding: '4px 8px', borderRadius: 5, border: 'none', background: 'var(--ram-accent)', color: '#0c0e12', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}
                                                                            >{saving ? '...' : '✓'}</button>
                                                                            <button onClick={() => setEditingRightsField(null)}
                                                                                style={{ padding: '4px 6px', borderRadius: 5, border: '1px solid var(--ram-border)', background: 'none', color: 'var(--ram-text-tertiary)', fontSize: 10, cursor: 'pointer' }}
                                                                            >✕</button>
                                                                        </div>
                                                                    ) : (
                                                                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                                                                            <span style={{ fontSize: 11, fontFamily: 'monospace', color: val ? 'var(--ram-text-secondary)' : 'var(--ram-text-tertiary)', fontStyle: val ? 'normal' : 'italic', wordBreak: 'break-all' }}>
                                                                                {val || 'Not set'}
                                                                            </span>
                                                                            <button onClick={() => { setEditingRightsField(key); setRightsFieldEditValue(val); }}
                                                                                style={{ background: 'none', border: '1px solid var(--ram-border)', color: 'var(--ram-text-tertiary)', fontSize: 9, padding: '1px 6px', borderRadius: 4, cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s' }}
                                                                                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--ram-accent)'; e.currentTarget.style.color = 'var(--ram-accent)'; }}
                                                                                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--ram-border)'; e.currentTarget.style.color = 'var(--ram-text-tertiary)'; }}
                                                                            >Edit</button>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>

                                                    {/* Choice Map */}
                                                    <div style={{ marginTop: 14, borderTop: '1px solid var(--ram-border)', paddingTop: 10 }}>
                                                        <div style={{ fontSize: 10, color: 'var(--ram-text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Choice Mappings</div>
                                                        <div style={{ fontSize: 10, color: 'var(--ram-text-tertiary)', marginBottom: 8, lineHeight: 1.5 }}>
                                                            Map each dropdown Choice ID to: <strong style={{ color: 'var(--ram-green)' }}>unlimited</strong>, <strong style={{ color: 'var(--ram-amber)' }}>limited</strong>, or <strong style={{ color: 'var(--ram-red)' }}>expired</strong>.
                                                        </div>
                                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                            {Object.entries(rc.choiceMap).length === 0 && (
                                                                <span style={{ fontSize: 11, color: 'var(--ram-text-tertiary)', fontStyle: 'italic' }}>No mappings configured</span>
                                                            )}
                                                            {Object.entries(rc.choiceMap).map(([choiceId, displayVal]) => (
                                                                <div key={choiceId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                                                                    <code style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--ram-text-secondary)', background: 'var(--ram-bg-hover)', padding: '2px 6px', borderRadius: 4, minWidth: 80 }}>{choiceId}</code>
                                                                    <span style={{ color: 'var(--ram-text-tertiary)' }}>→</span>
                                                                    <span style={{
                                                                        padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                                                                        color: displayVal === 'unlimited' ? 'var(--ram-green)' : displayVal === 'limited' ? 'var(--ram-amber)' : displayVal === 'expired' ? 'var(--ram-red)' : 'var(--ram-text-secondary)',
                                                                        background: displayVal === 'unlimited' ? 'var(--ram-green-bg)' : displayVal === 'limited' ? 'var(--ram-amber-bg)' : displayVal === 'expired' ? 'var(--ram-red-bg)' : 'var(--ram-bg-hover)',
                                                                    }}>{displayVal}</span>
                                                                    <button onClick={() => {
                                                                        const newMap = { ...rc.choiceMap };
                                                                        delete newMap[choiceId];
                                                                        saveRightsConfig({ ...rc, choiceMap: newMap });
                                                                    }}
                                                                        style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--ram-text-tertiary)', fontSize: 12, cursor: 'pointer', padding: '0 2px', transition: 'color 0.15s' }}
                                                                        onMouseEnter={e => e.currentTarget.style.color = 'var(--ram-red,#f87171)'}
                                                                        onMouseLeave={e => e.currentTarget.style.color = 'var(--ram-text-tertiary)'}
                                                                    >×</button>
                                                                </div>
                                                            ))}
                                                        </div>

                                                        {/* Add new choice mapping */}
                                                        <div style={{ display: 'flex', gap: 4, marginTop: 8, alignItems: 'center' }}>
                                                            <input type="text" value={newChoiceKey} onChange={e => setNewChoiceKey(e.target.value)}
                                                                placeholder="Choice ID"
                                                                style={{ width: 100, padding: '4px 8px', borderRadius: 5, border: '1px solid var(--ram-border)', background: 'var(--ram-bg-primary)', color: 'var(--ram-text-primary)', fontSize: 10, fontFamily: 'monospace', outline: 'none' }}
                                                            />
                                                            <span style={{ color: 'var(--ram-text-tertiary)', fontSize: 11 }}>→</span>
                                                            <select value={newChoiceValue} onChange={e => setNewChoiceValue(e.target.value)}
                                                                style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid var(--ram-border)', background: 'var(--ram-bg-primary)', color: 'var(--ram-text-primary)', fontSize: 10, outline: 'none', cursor: 'pointer' }}
                                                            >
                                                                <option value="unlimited">unlimited</option>
                                                                <option value="limited">limited</option>
                                                                <option value="expired">expired</option>
                                                            </select>
                                                            <button disabled={!newChoiceKey.trim() || saving}
                                                                onClick={() => {
                                                                    if (newChoiceKey.trim()) {
                                                                        saveRightsConfig({ ...rc, choiceMap: { ...rc.choiceMap, [newChoiceKey.trim()]: newChoiceValue } });
                                                                        setNewChoiceKey('');
                                                                    }
                                                                }}
                                                                style={{ padding: '4px 8px', borderRadius: 5, border: 'none', background: newChoiceKey.trim() ? 'var(--ram-accent)' : 'var(--ram-bg-hover)', color: newChoiceKey.trim() ? '#0c0e12' : 'var(--ram-text-tertiary)', fontSize: 10, fontWeight: 600, cursor: newChoiceKey.trim() ? 'pointer' : 'default', transition: 'all 0.15s' }}
                                                            >Add</button>
                                                        </div>
                                                    </div>
                                                </>
                                            );
                                        })()}
                                        </div>

                                        {/* Additional Namer Labels */}
                                        <div style={{ borderTop: '1px solid var(--ram-border)', paddingTop: 12 }}>
                                            <div style={{ fontSize: 10, color: 'var(--ram-text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>Additional Namer Labels</div>
                                            <div style={{ fontSize: 10, color: 'var(--ram-text-tertiary)', marginBottom: 8, lineHeight: 1.5 }}>
                                                The Rights Label above is always included. Add extra labels here if the Namer should read additional label data (e.g. Content Tags).
                                            </div>
                                            {(() => {
                                                // Filter out the rights label from the display — it's always included implicitly
                                                const rightsId = config?.driveLabelId ?? '';
                                                const extraLabels = (config?.namerLabelIds ?? []).filter(id => id !== rightsId);

                                                return (
                                                    <>
                                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                                                            {extraLabels.length === 0 && <span style={{ fontSize: 12, color: 'var(--ram-text-tertiary)', fontStyle: 'italic' }}>None — only the Rights Label is used</span>}
                                                            {extraLabels.map((item, idx) => (
                                                                <div key={idx} style={{
                                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                                    padding: '3px 8px 3px 10px', borderRadius: 6,
                                                                    background: 'var(--ram-bg-hover)', border: '1px solid var(--ram-border)',
                                                                    fontSize: 12, fontFamily: 'monospace', color: 'var(--ram-text-secondary)',
                                                                }}>
                                                                    <span>{maskId(item)}</span>
                                                                    {pendingDelete?.key === 'namer_label_ids' && pendingDelete?.index === idx ? (
                                                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 4 }}>
                                                                            <button onClick={async () => {
                                                                                const updated = [...extraLabels.filter((_, i) => i !== idx)];
                                                                                // Save full list: rights label + remaining extras
                                                                                await saveConfigField('namer_label_ids', rightsId ? [rightsId, ...updated] : updated);
                                                                                setPendingDelete(null);
                                                                            }}
                                                                                style={{ background: 'var(--ram-red,#f87171)', border: 'none', color: '#fff', fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, cursor: 'pointer' }}
                                                                            >Remove</button>
                                                                            <button onClick={() => setPendingDelete(null)}
                                                                                style={{ background: 'none', border: 'none', color: 'var(--ram-text-tertiary)', fontSize: 9, padding: '1px 4px', cursor: 'pointer' }}
                                                                            >✕</button>
                                                                        </span>
                                                                    ) : (
                                                                        <button onClick={() => setPendingDelete({ key: 'namer_label_ids', index: idx })} title="Remove"
                                                                            style={{ background: 'none', border: 'none', color: 'var(--ram-text-tertiary)', fontSize: 12, cursor: 'pointer', padding: '0 2px', lineHeight: 1, transition: 'color 0.15s' }}
                                                                            onMouseEnter={e => e.currentTarget.style.color = 'var(--ram-red,#f87171)'}
                                                                            onMouseLeave={e => e.currentTarget.style.color = 'var(--ram-text-tertiary)'}
                                                                        >×</button>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>

                                                        {editingField === 'namer_label_ids' ? (
                                                            <div style={{ display: 'flex', gap: 6 }}>
                                                                <input type="text" value={chipAddValue} onChange={e => setChipAddValue(e.target.value)}
                                                                    placeholder="Paste label ID..."
                                                                    onKeyDown={async e => {
                                                                        if (e.key === 'Enter' && chipAddValue.trim()) {
                                                                            const allIds = rightsId ? [rightsId, ...extraLabels, chipAddValue.trim()] : [...extraLabels, chipAddValue.trim()];
                                                                            await saveConfigField('namer_label_ids', allIds);
                                                                            setChipAddValue('');
                                                                        } else if (e.key === 'Escape') { setEditingField(null); setChipAddValue(''); }
                                                                    }}
                                                                    style={{ flex: 1, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--ram-border)', background: 'var(--ram-bg-primary)', color: 'var(--ram-text-primary)', fontSize: 12, fontFamily: 'monospace', outline: 'none' }}
                                                                    onFocus={e => e.currentTarget.style.borderColor = 'var(--ram-accent)'}
                                                                    onBlur={e => e.currentTarget.style.borderColor = 'var(--ram-border)'}
                                                                    autoFocus
                                                                />
                                                                <button disabled={saving || !chipAddValue.trim()}
                                                                    onClick={async () => {
                                                                        if (chipAddValue.trim()) {
                                                                            const allIds = rightsId ? [rightsId, ...extraLabels, chipAddValue.trim()] : [...extraLabels, chipAddValue.trim()];
                                                                            await saveConfigField('namer_label_ids', allIds);
                                                                            setChipAddValue('');
                                                                        }
                                                                    }}
                                                                    style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: chipAddValue.trim() ? 'var(--ram-accent)' : 'var(--ram-bg-hover)', color: chipAddValue.trim() ? '#0c0e12' : 'var(--ram-text-tertiary)', fontSize: 11, fontWeight: 600, cursor: chipAddValue.trim() ? 'pointer' : 'default', transition: 'all 0.15s' }}
                                                                >Add</button>
                                                                <button onClick={() => { setEditingField(null); setChipAddValue(''); }}
                                                                    style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--ram-border)', background: 'none', color: 'var(--ram-text-secondary)', fontSize: 11, cursor: 'pointer' }}
                                                                >Done</button>
                                                            </div>
                                                        ) : (
                                                            <button onClick={() => { setEditingField('namer_label_ids'); setChipAddValue(''); }}
                                                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 6, border: '1px dashed var(--ram-border)', background: 'none', color: 'var(--ram-text-tertiary)', fontSize: 11, cursor: 'pointer', transition: 'all 0.15s' }}
                                                                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--ram-accent)'; e.currentTarget.style.color = 'var(--ram-accent)'; }}
                                                                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--ram-border)'; e.currentTarget.style.color = 'var(--ram-text-tertiary)'; }}
                                                            ><span style={{ fontSize: 14, lineHeight: 1 }}>+</span> Add</button>
                                                        )}
                                                    </>
                                                );
                                            })()}
                                        </div>
                                    </div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function SectionHeader({ title }: { title: string }) {
    return (
        <div style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ram-text-secondary)',
            marginTop: 20,
            marginBottom: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
        }}>
            {title}
        </div>
    );
}

function StatChip({
    label,
    value,
    alert = false,
    large = false,
}: {
    label: string;
    value: number | string;
    alert?: boolean;
    large?: boolean;
}) {
    return (
        <div style={{
            padding: large ? '10px 14px' : '8px 12px',
            background: alert ? 'var(--ram-red-bg)' : 'var(--ram-bg-tertiary)',
            borderRadius: 8,
            textAlign: 'center',
        }}>
            <div style={{
                fontSize: large ? 18 : 16,
                fontWeight: 700,
                color: alert ? 'var(--ram-red)' : 'var(--ram-text-primary)',
                fontVariantNumeric: 'tabular-nums',
            }}>
                {typeof value === 'number' ? value.toLocaleString() : value}
            </div>
            <div style={{
                fontSize: 11,
                color: 'var(--ram-text-tertiary)',
                marginTop: 2,
            }}>
                {label}
            </div>
        </div>
    );
}

/**
 * Build a tree from ignored folders. Root nodes = folders with `tagged: true`
 * (directly have [relay-ignore]). Children = inherited subfolders whose path
 * starts with a tagged folder's path.
 */
function buildIgnoredTree(folders: { name: string; path: string; tagged?: boolean }[]) {
    // Separate root-tagged folders from cascade-inherited ones
    const roots = folders.filter(f => f.tagged);
    const inherited = folders.filter(f => !f.tagged);

    // For each root, find children whose path starts with the root's path
    const tree: { root: { name: string; path: string }; children: { name: string; path: string }[] }[] = [];

    for (const root of roots) {
        const children = inherited.filter(f => f.path.startsWith(root.path + '/'));
        tree.push({ root, children });
    }

    // Sort roots alphabetically
    tree.sort((a, b) => a.root.path.localeCompare(b.root.path));

    return tree;
}

function IgnoredFolderTree({ folders }: { folders: { name: string; path: string; tagged?: boolean }[] }) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const tree = buildIgnoredTree(folders);

    const toggle = (key: string) => {
        setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {tree.map(({ root, children }) => {
                const isOpen = expanded[root.path] ?? false;
                const hasChildren = children.length > 0;
                return (
                    <div key={root.path}>
                        {/* Root node — the directly tagged folder */}
                        <button
                            onClick={() => hasChildren && toggle(root.path)}
                            style={{
                                width: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '6px 4px',
                                background: 'none',
                                border: 'none',
                                cursor: hasChildren ? 'pointer' : 'default',
                                borderRadius: 6,
                                transition: 'background 0.15s',
                            }}
                            onMouseEnter={e => hasChildren && (e.currentTarget.style.background = 'var(--ram-bg-hover)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                        >
                            {hasChildren ? (
                                <svg
                                    width="10" height="10" viewBox="0 0 24 24" fill="none"
                                    stroke="var(--ram-text-tertiary)" strokeWidth="3"
                                    strokeLinecap="round" strokeLinejoin="round"
                                    style={{
                                        transition: 'transform 0.2s',
                                        transform: isOpen ? 'rotate(90deg)' : 'rotate(0)',
                                        flexShrink: 0,
                                    }}
                                >
                                    <polyline points="9 18 15 12 9 6" />
                                </svg>
                            ) : (
                                <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <span style={{ fontSize: 13 }}>🚫</span>
                            <span style={{
                                fontSize: 12,
                                color: 'var(--ram-text-primary)',
                                fontWeight: 500,
                                flex: 1,
                                textAlign: 'left',
                            }}>
                                {root.name}
                            </span>
                            {hasChildren && (
                                <span style={{
                                    fontSize: 10,
                                    padding: '1px 6px',
                                    borderRadius: 10,
                                    background: 'var(--ram-bg-hover)',
                                    color: 'var(--ram-text-tertiary)',
                                    fontWeight: 600,
                                }}>
                                    +{children.length}
                                </span>
                            )}
                        </button>

                        {/* Folder path shown below the name */}
                        <div style={{
                            fontSize: 10,
                            color: 'var(--ram-text-tertiary)',
                            paddingLeft: 40,
                            marginTop: -4,
                            marginBottom: 4,
                            wordBreak: 'break-all',
                        }}>
                            {root.path}
                        </div>

                        {/* Subfolders — visible when expanded */}
                        {isOpen && children.length > 0 && (
                            <div style={{
                                marginLeft: 20,
                                borderLeft: '1px solid var(--ram-border)',
                                paddingLeft: 10,
                                marginBottom: 6,
                            }}>
                                {children.map((folder, i) => {
                                    // Show the relative path from the root
                                    const relativePath = folder.path.slice(root.path.length + 1);
                                    return (
                                        <div
                                            key={i}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'flex-start',
                                                gap: 6,
                                                padding: '3px 0',
                                            }}
                                        >
                                            <span style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }}>📂</span>
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{
                                                    fontSize: 11,
                                                    color: 'var(--ram-text-secondary)',
                                                }}>
                                                    {relativePath || folder.name}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
