/**
 * Pure helpers over the namer's client-side batch queue (see types.ts
 * BatchInfo). Kept out of the components so the rules — what counts as
 * processed, what's retryable, what stays hidden from the source list — are
 * testable and shared by NamerView and NamerQueue.
 */

import type { BatchFile, BatchInfo } from './types';

/** The rename/move landed — the file now lives in the destination. */
export function isMoved(file: BatchFile): boolean {
    return file.doneSteps?.includes('move') ?? false;
}

/**
 * "Retry failed" candidates: the move failed, or it landed but a later step
 * (labels, orientation, AI, description) didn't. Reverted files are out.
 */
export function isRetryable(file: BatchFile): boolean {
    if (file.revert === 'done') return false;
    return file.status === 'error' || (file.status === 'success' && (file.warnings?.length ?? 0) > 0);
}

/**
 * The status a still-queued file takes when its batch is cancelled. Files
 * re-queued by "Retry failed" go back to what they were — an already-moved
 * file stays a success (with its warnings, so it stays retryable), a failed
 * one stays failed — and only never-attempted files become 'cancelled'.
 */
export function statusOnCancel(file: BatchFile): BatchFile['status'] {
    if (isMoved(file)) return 'success';
    if (file.error) return 'error';
    return 'cancelled';
}

/** Moved files whose revert hasn't succeeded yet. */
export function revertTargets(batch: BatchInfo): BatchFile[] {
    return batch.files.filter(f => isMoved(f) && f.revert !== 'done');
}

/** Progress counters derived from file statuses (never tracked separately). */
export function batchProgress(files: BatchFile[]): BatchInfo['progress'] {
    let completed = 0;
    let errors = 0;
    for (const f of files) {
        if (f.status === 'success' || f.status === 'error' || f.status === 'cancelled') completed++;
        if (f.status === 'error') errors++;
    }
    return { completed, total: files.length, errors };
}

/**
 * File IDs to keep out of the source-folder list. A file stays hidden while a
 * batch owns it — queued, in flight, moved, or failed-but-retryable from the
 * queue (showing it too would invite processing it twice). It reappears when
 * it was cancelled before starting, reverted back to the source, never moved
 * in a batch that's being reverted (no longer retryable), or its batch is
 * cleared from the queue.
 */
export function hiddenSourceFileIds(batches: BatchInfo[]): Set<string> {
    const ids = new Set<string>();
    for (const b of batches) {
        if (b.status === 'reverted') continue;
        const reverting = b.status === 'reverting' || b.status === 'revert-failed';
        for (const f of b.files) {
            if (f.status === 'cancelled' || f.revert === 'done') continue;
            if (reverting && !isMoved(f)) continue;
            ids.add(f.id);
        }
    }
    return ids;
}
