'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Settings → Recent activity: the last scheduled syncs and in-app ingests
 * from sync_logs, newest first, with any failure details. The traceable
 * record for "what went wrong and when" in either ingestion path.
 */

interface Problem { step: string; message: string; count?: number }

interface ActivityEntry {
    id: string;
    source: 'cron' | 'ingest';
    status: 'success' | 'partial' | 'failed';
    started_at: string;
    finished_at: string;
    duration_secs: number | null;
    assets_found: number;
    assets_upserted: number;
    thumbnails_uploaded: number | null;
    thumbnail_errors: number | null;
    soft_deleted: number;
    restored: number;
    re_embedded: number;
    error_message: string | null;
    details: {
        run_url?: string | null;
        trigger?: string | null;
        user?: string | null;
        problems?: Problem[];
        errors?: string[];
        skipped?: { fileId: string; reason: string }[];
        last_progress?: { step?: string; detail?: string } | null;
    } | null;
}

const STATUS_STYLE = {
    success: { label: 'OK', color: 'var(--ram-green)', bg: 'var(--ram-green-bg)' },
    partial: { label: 'Partial', color: 'var(--ram-amber)', bg: 'var(--ram-amber-bg)' },
    failed: { label: 'Failed', color: 'var(--ram-red)', bg: 'var(--ram-red-bg)' },
} as const;

function when(iso: string): string {
    const d = new Date(iso);
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function summary(e: ActivityEntry): string {
    if (e.source === 'ingest') {
        return `Namer ingest · ${e.assets_upserted}/${e.assets_found} files`
            + (e.details?.user ? ` · ${e.details.user}` : '');
    }
    const trigger = e.details?.trigger === 'workflow_dispatch' ? 'Manual sync' : 'Scheduled sync';
    const bits = [`${e.assets_upserted} assets`];
    if (e.soft_deleted) bits.push(`${e.soft_deleted} trashed`);
    if (e.restored) bits.push(`${e.restored} restored`);
    if (e.re_embedded) bits.push(`${e.re_embedded} embedded`);
    return `${trigger} · ${bits.join(' · ')}`;
}

export default function SyncActivity() {
    const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            const res = await fetch('/api/sync/activity?limit=20', { cache: 'no-store' });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setEntries(body.entries);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load activity');
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (error) {
        return (
            <div style={{ fontSize: 12, color: 'var(--ram-red)' }}>
                Couldn&apos;t load activity: {error}{' '}
                <button onClick={load} style={{ background: 'none', border: 'none', color: 'var(--ram-accent)', cursor: 'pointer', textDecoration: 'underline', fontSize: 12 }}>
                    Retry
                </button>
            </div>
        );
    }
    if (!entries) {
        return <div style={{ fontSize: 12, color: 'var(--ram-text-tertiary)' }}>Loading activity…</div>;
    }
    if (entries.length === 0) {
        return <div style={{ fontSize: 12, color: 'var(--ram-text-tertiary)' }}>No activity recorded yet.</div>;
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {entries.map((e) => {
                const style = STATUS_STYLE[e.status] ?? STATUS_STYLE.failed;
                const open = openId === e.id;
                const d = e.details ?? {};
                const hasDetail = Boolean(e.error_message || d.problems?.length || d.errors?.length || d.skipped?.length || d.run_url);
                return (
                    <div key={e.id} style={{ background: 'var(--ram-bg-tertiary)', borderRadius: 8, border: '1px solid var(--ram-border)' }}>
                        <button
                            onClick={() => hasDetail && setOpenId(open ? null : e.id)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px',
                                background: 'none', border: 'none', textAlign: 'left', cursor: hasDetail ? 'pointer' : 'default',
                                color: 'var(--ram-text-secondary)', fontSize: 12,
                            }}
                        >
                            <span style={{
                                flexShrink: 0, fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
                                color: style.color, background: style.bg, minWidth: 48, textAlign: 'center',
                            }}>{style.label}</span>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {summary(e)}
                                {e.status !== 'success' && e.error_message && (
                                    <span style={{ color: 'var(--ram-text-tertiary)' }}> — {e.error_message}</span>
                                )}
                            </span>
                            <span style={{ flexShrink: 0, color: 'var(--ram-text-tertiary)', fontSize: 11 }}>{when(e.finished_at)}</span>
                        </button>

                        {open && (
                            <div style={{ padding: '0 12px 10px 70px', fontSize: 11, color: 'var(--ram-text-secondary)', lineHeight: 1.6 }}>
                                {e.error_message && <div style={{ whiteSpace: 'pre-wrap' }}>{e.error_message}</div>}
                                {d.problems?.map((p, i) => (
                                    <div key={`p${i}`}>• <strong>{p.step}</strong>: {p.message}</div>
                                ))}
                                {d.errors?.slice(0, 20).map((msg, i) => (
                                    <div key={`e${i}`} style={{ color: 'var(--ram-red)' }}>• {msg}</div>
                                ))}
                                {d.skipped?.slice(0, 20).map((s, i) => (
                                    <div key={`s${i}`}>• skipped {s.fileId}: {s.reason}</div>
                                ))}
                                {((d.errors?.length ?? 0) > 20 || (d.skipped?.length ?? 0) > 20) && (
                                    <div style={{ color: 'var(--ram-text-tertiary)' }}>…more in the full record</div>
                                )}
                                {d.last_progress?.step && (
                                    <div>Last step reached: {d.last_progress.step}{d.last_progress.detail ? ` — ${d.last_progress.detail}` : ''}</div>
                                )}
                                <div style={{ color: 'var(--ram-text-tertiary)' }}>
                                    {new Date(e.started_at).toLocaleString()}
                                    {e.duration_secs ? ` · ${Math.round(e.duration_secs)}s` : ''}
                                    {d.run_url && (
                                        <> · <a href={d.run_url} target="_blank" rel="noreferrer" style={{ color: 'var(--ram-accent)' }}>GitHub log ↗</a></>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
